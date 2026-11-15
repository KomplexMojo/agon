/**
 * `agon scenario`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLlmAdapter } from "../../adapters/llm/index.js";
import { orchestrateBuild } from "../../../../runtime/src/build/orchestrate-build.js";
// CR.7 / WP-5 — the vocabulary comes from CONTRACTS, not from the Orchestrator's alias of
// it. `prompt-contract.js` only renamed these (P5.1 D1: one value, three names), so the
// boundary crossing died with the hop rather than being republished. Aliased on import so
// the call sites below are untouched.
import { AFFINITY_KINDS as ALLOWED_AFFINITIES, AFFINITY_EXPRESSIONS as ALLOWED_AFFINITY_EXPRESSIONS, MOTIVATION_KINDS as ALLOWED_MOTIVATIONS } from "../../../../runtime/src/contracts/domain-constants.js";
// Genuinely Orchestrator law — the prompt contract itself — so taken from its barrel.
import { deriveAllowedOptionsFromCatalog, normalizeSummary } from "../../../../runtime/src/personas/orchestrator/persona.js";
// CR.4 M5: the LLM session runs as an Orchestrator round; this host dispatches its
// `llm_request` effects through ports/effects.js so the IO happens in the adapter.
// Drop-in for runLlmSession (differential: tests/runtime/llm-host-loop.test.js).
import { runLlmSessionHosted } from "../../../../runtime/src/commands/llm-host.js";
import { beginDirectorRound, directorBuildCapabilities } from "../../../../runtime/src/commands/director-round.js";
import { runLlmBudgetLoop } from "../../../../runtime/src/personas/orchestrator/persona.js";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, LLM_REPAIR_TEXT, appendLlmPromptSuffix, buildLlmActorConfigPromptTemplate, buildLlmCatalogRepairPromptTemplate, buildLlmConstraintSection, buildLlmRepairPromptTemplate } from "../../../../runtime/src/contracts/domain-constants.js";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { allowNetworkRequests, buildDryRunBudgetEstimate, buildDryRunFailure, buildDryRunSuccess, buildPoolWeightsForAuthoredKinds, commandKernel, configurator, defaultRunDir, deriveActorIds, deriveRoomIds, emitJsonStdout, isLlmBudgetLoopEnabled, isLlmLiveEnabled, isLlmStrictEnabled, isLocalBaseUrl, isNonEmptyString, makeId, readJson, readText, resolveDefaultLlmFixturePath, resolvePath, summarizeBuildLikeOutput, usage } from "./shared.mjs";
import { resolveFromRunArtifactPaths, summarizeInspectOutput, summarizeRunOutput, validateRunDryRun } from "./run-shared.mjs";

// D8.3 — the Director refuses to derive level geometry from room cards; it asks the
// Configurator. Taken from the PUBLIC persona barrel, so no boundary is crossed.
const configuratorRoomGeometry = Object.freeze({
  deriveRoomLayout: configurator.deriveRoomLayout,
  buildRoomDesign: configurator.buildRoomDesign,
});

function prefixArtifactPaths(paths, prefix) {
  return Object.fromEntries(
    Object.entries(paths || {}).map(([key, value]) => [`${prefix}${key}`, value])
  );
}

function buildScenarioSummary({
  runId,
  outDir,
  llmPlanSummary,
  sourceArtifactPaths,
  runSummary,
  inspectSummary,
} = {}) {
  return {
    ok: true,
    command: "scenario",
    runId,
    outDir,
    actorIds: Array.isArray(runSummary?.actorIds) ? runSummary.actorIds : [],
    roomIds: Array.isArray(runSummary?.roomIds) ? runSummary.roomIds : [],
    artifactPaths: {
      ...prefixArtifactPaths(llmPlanSummary?.artifactPaths, "llm_plan_"),
      ...(sourceArtifactPaths || {}),
      ...prefixArtifactPaths(runSummary?.artifactPaths, ""),
      ...prefixArtifactPaths(inspectSummary?.artifactPaths, ""),
    },
    ticks: inspectSummary?.ticks ?? runSummary?.ticks,
  };
}

function unwrapCodeFence(text) {
  if (!text) return text;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : text;
}

function extractJsonObject(text) {
  if (!text) return null;
  const cleaned = unwrapCodeFence(text).trim();
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    return cleaned;
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }
  return null;
}

function appendJsonOnlyInstruction(promptText) {
  return appendLlmPromptSuffix(promptText);
}

function deriveAllowedPairs(catalog) {
  const entries = Array.isArray(catalog?.entries)
    ? catalog.entries
    : Array.isArray(catalog)
      ? catalog
      : [];
  const pairs = new Map();
  entries.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const { motivation, affinity } = entry;
    if (typeof motivation !== "string" || typeof affinity !== "string") return;
    const key = `${motivation}|${affinity}`;
    if (!pairs.has(key)) {
      pairs.set(key, { motivation, affinity });
    }
  });
  return Array.from(pairs.values()).sort(
    (a, b) => a.motivation.localeCompare(b.motivation) || a.affinity.localeCompare(b.affinity),
  );
}

function formatAllowedPairs(pairs) {
  return pairs.map((pair) => `(${pair.motivation}, ${pair.affinity})`).join(", ");
}

function countInstances(selections, kind) {
  return selections
    .filter((sel) => sel.kind === kind && Array.isArray(sel.instances))
    .reduce((sum, sel) => sum + sel.instances.length, 0);
}

function summarizeMissingSelections(selections) {
  return selections
    .filter((sel) => !sel.applied)
    .map((sel) => `${sel.kind}:${sel.requested?.motivation || "?"}/${sel.requested?.affinity || "?"}`)
    .join(", ");
}

function injectBudgetTokens(prompt, budgetTokens) {
  if (!isNonEmptyString(prompt)) {
    return prompt;
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    return prompt;
  }
  if (prompt.includes("Budget tokens:")) {
    return prompt;
  }
  return `Budget tokens: ${budgetTokens}\n${prompt}`;
}

function resolveScenarioAssetPath(rawPath, baseDir) {
  if (!rawPath) {
    return null;
  }
  const primary = resolvePath(rawPath);
  if (primary && existsSync(primary)) {
    return primary;
  }
  if (!baseDir) {
    return primary;
  }
  const fallback = resolvePath(rawPath, baseDir);
  if (fallback && existsSync(fallback)) {
    return fallback;
  }
  return primary || fallback;
}

function buildRepairPrompt({ basePrompt, errors, responseText, allowedOptions, allowedPairsText }) {
  const extracted = extractJsonObject(responseText) || responseText;
  const affinities = allowedOptions?.affinities?.length ? allowedOptions.affinities : ALLOWED_AFFINITIES;
  const motivations = allowedOptions?.motivations?.length ? allowedOptions.motivations : ALLOWED_MOTIVATIONS;
  return buildLlmRepairPromptTemplate({
    basePrompt,
    errors,
    responseText: extracted,
    affinities,
    affinityExpressions: ALLOWED_AFFINITY_EXPRESSIONS,
    motivations,
    allowedPairsText,
    phaseRequirement: LLM_REPAIR_TEXT.phaseActorsRequirement,
    extraLines: [
      LLM_REPAIR_TEXT.tokenHintRule,
      LLM_REPAIR_TEXT.exampleAffinityEntry,
    ],
  });
}

function assertAllowedScenarioArgs(args) {
  const allowed = new Set([
    "text",
    "from-run",
    "sim-config",
    "initial-state",
    "catalog",
    "model",
    "goal",
    "budget-tokens",
    "base-url",
    "fixture",
    "budget-loop",
    "budget-pool",
    "budget-reserve",
    "ticks",
    "seed",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
    "dry-run",
  ]);
  const unknown = [];
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help") {
      continue;
    }
    if (!allowed.has(key)) {
      unknown.push(`--${key}`);
    }
  }
  if (Array.isArray(args._) && args._.length > 0) {
    unknown.push(...args._);
  }
  if (unknown.length > 0) {
    throw new Error(`scenario only accepts --text, --from-run, --catalog, --model, --goal, --budget-tokens, --base-url, --fixture, --budget-loop, --budget-pool, --budget-reserve, --ticks, --seed, --out-dir, --run-id, --created-at, --emit-intermediates, and --dry-run. Unknown: ${unknown.join(", ")}`);
  }
}

function buildPoolWeightsForSummary(summary = {}) {
  const cards = Array.isArray(summary.cardSet)
    ? summary.cardSet
    : Array.isArray(summary.cards) ? summary.cards : [];
  const layout = summary.layout && typeof summary.layout === "object" ? summary.layout : null;
  const rooms = [
    ...(Array.isArray(summary.rooms) ? summary.rooms : []),
    ...cards.filter((entry) => entry?.type === "room" || entry?.source === "room"),
  ];
  const floorTiles = layout && Number.isInteger(layout.floorTiles) ? [layout] : [];
  const placedHazards = layout && Array.isArray(layout.placedHazards) ? layout.placedHazards : [];
  const hazards = [
    ...(Array.isArray(summary.hazards) ? summary.hazards : []),
    ...cards.filter((entry) => entry?.type === "hazard" || entry?.source === "hazard"),
  ];
  const resources = [
    ...(Array.isArray(summary.resources) ? summary.resources : []),
    ...cards.filter((entry) => entry?.type === "resource" || entry?.source === "resource"),
  ];
  const actorCards = cards.filter((entry) => entry?.type === "delver" || entry?.type === "warden");
  const actorEntries = Array.isArray(summary.actors) ? summary.actors : [];
  const delvers = [
    ...actorCards.filter((entry) => entry.type === "delver"),
    ...actorEntries.filter((entry) => {
      const role = String(entry?.actorType || entry?.type || entry?.role || entry?.motivation || "").toLowerCase();
      return role.includes("delver") || role.includes("attack");
    }),
  ];
  const wardens = [
    ...actorCards.filter((entry) => entry.type === "warden"),
    ...actorEntries.filter((entry) => {
      const role = String(entry?.actorType || entry?.type || entry?.role || entry?.motivation || "").toLowerCase();
      return role.includes("warden") || role.includes("defend") || role.includes("stationary");
    }),
  ];
  return buildPoolWeightsForAuthoredKinds({ rooms, floorTiles, placedHazards, hazards, resources, delvers, wardens });
}

// The level a scenario replays instead of planning one from --text: an explicit
// --sim-config/--initial-state pair (what the MCP server passes for a run it remembers),
// or the files `--from-run <runId>` finds under artifacts/runs/<runId>.
async function resolveScenarioLevelSource(args) {
  const hasSimConfig = isNonEmptyString(args["sim-config"]);
  const hasInitialState = isNonEmptyString(args["initial-state"]);
  if (hasSimConfig || hasInitialState) {
    if (!hasSimConfig || !hasInitialState) {
      throw new Error("scenario requires --sim-config and --initial-state together.");
    }
    if (isNonEmptyString(args.text) || isNonEmptyString(args["from-run"])) {
      throw new Error("scenario does not allow --sim-config/--initial-state together with --text or --from-run.");
    }
    return {
      simConfigPath: resolvePath(args["sim-config"]),
      initialStatePath: resolvePath(args["initial-state"]),
    };
  }
  if (isNonEmptyString(args["from-run"])) {
    return resolveFromRunArtifactPaths(args["from-run"]);
  }
  return null;
}

async function validateScenarioDryRun(args) {
  const fromRunId = args["from-run"];
  if (isNonEmptyString(fromRunId) && isNonEmptyString(args.text)) {
    throw new Error("scenario does not allow --text together with --from-run.");
  }
  const resolvedFromRun = await resolveScenarioLevelSource(args);
  if (resolvedFromRun) {
    const runId = args["run-id"] || fromRunId || makeId("run");
    const outDir = resolvePath(args["out-dir"]) || defaultRunDir(runId);
    const runValidation = await validateRunDryRun({
      "sim-config": resolvedFromRun.simConfigPath,
      "initial-state": resolvedFromRun.initialStatePath,
      ticks: args.ticks,
      seed: args.seed,
      "run-id": runId,
      "out-dir": join(outDir, "run"),
      actor: args.actor,
      vital: args.vital,
      "vital-default": args["vital-default"],
      "tile-wall": args["tile-wall"],
      "tile-barrier": args["tile-barrier"],
      "tile-floor": args["tile-floor"],
      actions: args.actions,
      "execution-policy": args["execution-policy"],
      "affinity-presets": args["affinity-presets"],
      "affinity-loadouts": args["affinity-loadouts"],
      "affinity-summary": args["affinity-summary"],
    });
    return {
      ...runValidation,
      command: "scenario",
      outDir,
      artifactPaths: {
        source_sim_config: resolvedFromRun.simConfigPath,
        source_initial_state: resolvedFromRun.initialStatePath,
      },
    };
  }

  const scenarioPath = resolvePath(args.scenario);
  const textRaw = args.text;
  const promptRaw = args.prompt;
  const catalogOverride = resolvePath(args.catalog);
  const goalOverride = args.goal;
  const budgetTokensRaw = args["budget-tokens"];
  const model = args.model || process.env.AGON_LLM_MODEL || DEFAULT_LLM_MODEL;
  const baseUrl = args["base-url"] || process.env.AGON_LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
  const promptInput = isNonEmptyString(promptRaw)
    ? promptRaw
    : isNonEmptyString(textRaw)
      ? textRaw
      : undefined;
  const fixturePath = resolvePath(args.fixture)
    || (!scenarioPath && isNonEmptyString(textRaw)
      ? resolveDefaultLlmFixturePath({ resolvePath, exists: existsSync, cwd: () => process.cwd() })
      : null);
  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunDir(runId);

  if (!scenarioPath && !catalogOverride) {
    throw new Error("llm-plan requires --scenario or --catalog.");
  }
  if (!scenarioPath && !isNonEmptyString(promptInput)) {
    throw new Error("llm-plan requires --text or --prompt when --scenario is omitted.");
  }

  let budgetTokens;
  if (budgetTokensRaw !== undefined) {
    budgetTokens = Number(budgetTokensRaw);
    if (!Number.isFinite(budgetTokens)) {
      throw new Error("llm-plan requires --budget-tokens to be a number.");
    }
  }

  const budgetReserveRaw = args["budget-reserve"];
  let budgetReserveTokens;
  if (budgetReserveRaw !== undefined) {
    budgetReserveTokens = Number(budgetReserveRaw);
    if (!Number.isFinite(budgetReserveTokens) || budgetReserveTokens < 0) {
      throw new Error("llm-plan requires --budget-reserve to be a non-negative number.");
    }
  }

  const budgetPoolRaw = args["budget-pool"];
  const budgetPools = [];
  if (budgetPoolRaw !== undefined) {
    const entries = Array.isArray(budgetPoolRaw) ? budgetPoolRaw : [budgetPoolRaw];
    entries.forEach((entry) => {
      if (typeof entry !== "string" || !entry.includes("=")) {
        throw new Error("llm-plan --budget-pool must be in id=weight form.");
      }
      const [idRaw, weightRaw] = entry.split("=");
      const id = idRaw.trim();
      const weight = Number(weightRaw);
      if (!id) {
        throw new Error("llm-plan --budget-pool requires a non-empty id.");
      }
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`llm-plan --budget-pool weight must be >= 0 for ${id}.`);
      }
      budgetPools.push({ id, weight });
    });
  }

  const scenario = scenarioPath ? await readJson(scenarioPath) : null;
  const scenarioBaseDir = scenarioPath ? dirname(scenarioPath) : process.cwd();
  const catalogPath = catalogOverride
    || (scenario ? resolveScenarioAssetPath(scenario.catalogPath, scenarioBaseDir) : null);
  if (!catalogPath) {
    if (scenario) {
      throw new Error("llm-plan requires scenario.catalogPath or --catalog.");
    }
    throw new Error("llm-plan requires --catalog when --scenario is omitted.");
  }
  const catalog = await readJson(catalogPath);
  const allowedOptions = deriveAllowedOptionsFromCatalog(catalog);
  const allowedPairs = deriveAllowedPairs(catalog);
  const allowedPairsText = allowedPairs.length > 0 ? formatAllowedPairs(allowedPairs) : "";
  const budgetLoopEnabled = Boolean(args["budget-loop"]) || isLlmBudgetLoopEnabled();

  const goal = isNonEmptyString(goalOverride)
    ? goalOverride
    : scenario?.goal || promptInput || "LLM planning request";
  const resolvedBudgetTokens = budgetTokens !== undefined ? budgetTokens : scenario?.budgetTokens;
  if (!Number.isFinite(resolvedBudgetTokens) || resolvedBudgetTokens <= 0) {
    throw new Error("llm-plan requires --budget-tokens or scenario.budgetTokens > 0.");
  }

  const prompt = injectBudgetTokens(promptInput, resolvedBudgetTokens);
  const notes = [
    scenario?.notes,
    "Include at least one actor; counts must be > 0.",
    allowedPairsText ? `Allowed profiles (motivation, affinity): ${allowedPairsText}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const basePrompt = isNonEmptyString(prompt)
    ? prompt
    : buildLlmActorConfigPromptTemplate({
      goal,
      notes,
      budgetTokens: resolvedBudgetTokens,
      affinities: allowedOptions.affinities,
      affinityExpressions: ALLOWED_AFFINITY_EXPRESSIONS,
      motivations: allowedOptions.motivations,
    });
  const constraintLines = buildLlmConstraintSection({ allowedPairsText });
  const finalPrompt = appendJsonOnlyInstruction(`${basePrompt}\n\n${constraintLines}`);
  const llmFormat = process.env.AGON_LLM_FORMAT;

  let capture = null;
  let captures = [];
  let summary = null;
  let mappedSelections;
  let budgetPoolWeights = null;

  // CR.7 / WP-5 (2026-08-12) — ONE Director round for the whole llm-plan build.
  //
  // Each branch below used to open its own (the loop branch via
  // beginDirectorBuildCapabilities, the direct branch via beginDirectorRound), and the
  // BuildSpec was then assembled OUTSIDE both by importing `director/buildspec-assembler.js`
  // — this file's last allowlist row, and an artifact produced with no round. Hoisting the
  // round is what lets the assembly be `director.assembleBuildSpec`, which is FSM-gated and
  // CLOSES the round. The third path (a scenario or summary fixture, no LLM at all) reaches
  // the same assembly, so it needs the round too.
  const director = beginDirectorRound({ runId, createdAt, goal, producedBy: "cli" });

  if (isLlmLiveEnabled() || Boolean(fixturePath)) {
    if (!fixturePath && !allowNetworkRequests() && !isLocalBaseUrl(baseUrl)) {
      throw new Error("llm-plan requires --fixture unless AGON_ALLOW_NETWORK=1 or base URL is local.");
    }

    let fetchFn;
    if (fixturePath) {
      const fixtureJson = JSON.parse(await readText(fixturePath));
      const responses = Array.isArray(fixtureJson)
        ? fixtureJson
        : Array.isArray(fixtureJson?.responses)
          ? fixtureJson.responses
          : [fixtureJson];
      let fixtureIndex = 0;
      fetchFn = async () => {
        if (responses.length > 1 && fixtureIndex >= responses.length) {
          return { ok: false, status: 500, statusText: "Missing fixture response" };
        }
        const payload = responses[Math.min(fixtureIndex, responses.length - 1)];
        fixtureIndex += 1;
        return { ok: true, json: async () => payload };
      };
    }

    const adapter = createLlmAdapter({ baseUrl, fetchFn });
    const repairPromptBuilder = ({ errors, responseText }) => buildRepairPrompt({
      basePrompt: finalPrompt,
      errors,
      responseText,
      allowedOptions,
      allowedPairsText,
    });

    if (budgetLoopEnabled) {
      const poolPolicy = Number.isFinite(budgetReserveTokens) ? { reserveTokens: budgetReserveTokens } : undefined;
      const loopResult = await runLlmBudgetLoop({
        // CR.4 M5b: the loop no longer performs LLM IO; glue supplies the runner.
        runSession: runLlmSessionHosted,
        // M5b.2a′: pool mapping is the Director's decision, and mapPool is FSM-gated
        // behind an open build round. This root had no Director at all until now.
        // M5b.2b: the same round also answers the three Allocator pricing questions the
        // loop used to compute inline.
        // 2026-08-12: taken from the round opened above rather than opening one here —
        // the BuildSpec assembly below runs on that same round and closes it.
        ...directorBuildCapabilities(director),
        // #296: the budget fit goes to the host's solver, as `agon llm-plan`'s does.
        fitLayout: await commandKernel.hostLayoutBudgetFit(director, createdAt),
        adapter,
        model,
        baseUrl,
        catalog,
        goal,
        notes,
        budgetTokens: resolvedBudgetTokens,
        poolWeights: budgetPools.length > 0 ? budgetPools : undefined,
        poolPolicy,
        strict: isLlmStrictEnabled(),
        format: isNonEmptyString(llmFormat) ? llmFormat : undefined,
        runId,
        clock: () => createdAt,
        producedBy: "orchestrator",
      });
      if (!loopResult.ok) {
        throw new Error(`llm-plan budget loop failed: ${JSON.stringify(loopResult.errors || [])}`);
      }
      captures = loopResult.captures || [];
      summary = loopResult.summary;
      mappedSelections = loopResult.selections;
      budgetPoolWeights = loopResult.poolWeights || null;
    } else {
      // D8 follow-up 2026-08-08 — the non-loop branch mapped summaries onto the catalog by
      // importing `director/pool-mapper.js`, so this file kept an allowlist row that the
      // budget-loop branch three lines above had already retired. Same defect as M5b.2a′:
      // an artifact produced with no round. `mapPool` is FSM-gated, so the round is the
      // substance, not the import. The round itself is now opened once above.
      let session = await runLlmSessionHosted({
        adapter,
        model,
        baseUrl,
        prompt: isNonEmptyString(finalPrompt) ? finalPrompt : undefined,
        // CR.7 / WP-5: a cardSet is the Director's translation, injected rather than
        // imported. Uses the round opened just above.
        buildCardSet: director.buildCardSet,
        goal,
        budgetTokens: resolvedBudgetTokens,
        strict: isLlmStrictEnabled(),
        repairPromptBuilder,
        requireSummary: { minRooms: 1, minActors: 1 },
        runId,
        clock: () => createdAt,
        producedBy: "orchestrator",
        format: isNonEmptyString(llmFormat) ? llmFormat : undefined,
      });
      if (!session.ok) {
        throw new Error(`llm-plan session failed: ${JSON.stringify(session.errors || [])}`);
      }
      summary = session.summary;
      capture = session.capture;

      let mapped = director.mapPool({ summary, catalog });
      let actorInstances = countInstances(mapped.selections, "actor");
      if (actorInstances === 0) {
        const missingSelections = summarizeMissingSelections(mapped.selections);
        const catalogRepairPrompt = buildLlmCatalogRepairPromptTemplate({
          basePrompt,
          allowedPairsText,
          missingSelections,
        });
        session = await runLlmSessionHosted({
          adapter,
          model,
          baseUrl,
          prompt: catalogRepairPrompt,
          // CR.7 / WP-5: a cardSet is the Director's translation, injected rather than
          // imported. Uses the round opened just above.
          buildCardSet: director.buildCardSet,
          goal,
          budgetTokens: resolvedBudgetTokens,
          strict: isLlmStrictEnabled(),
          repairPromptBuilder,
          requireSummary: { minRooms: 1, minActors: 1 },
          runId,
          clock: () => createdAt,
          producedBy: "orchestrator",
          format: isNonEmptyString(llmFormat) ? llmFormat : undefined,
        });
        if (!session.ok) {
          throw new Error(`llm-plan session failed: ${JSON.stringify(session.errors || [])}`);
        }
        summary = session.summary;
        capture = session.capture;
        mapped = director.mapPool({ summary, catalog });
        actorInstances = countInstances(mapped.selections, "actor");
        if (actorInstances === 0) {
          const finalMissing = summarizeMissingSelections(mapped.selections);
          throw new Error(
            `llm-plan summary did not match catalog entries (actors=${actorInstances}).`
            + (finalMissing ? ` Unmatched picks: ${finalMissing}` : ""),
          );
        }
      }
      mappedSelections = mapped.selections;
    }
  } else {
    if (isNonEmptyString(prompt)) {
      throw new Error("llm-plan requires AGON_LLM_LIVE=1 when using --prompt.");
    }
    if (!scenario) {
      throw new Error("llm-plan requires AGON_LLM_LIVE=1 when --scenario is omitted.");
    }
    const summaryPath = resolveScenarioAssetPath(scenario.summaryPath, scenarioBaseDir);
    if (!summaryPath) {
      throw new Error("llm-plan requires scenario.summaryPath when AGON_LLM_LIVE is off.");
    }
    const summaryFixture = await readJson(summaryPath);
    const normalized = normalizeSummary(summaryFixture);
    if (!normalized.ok) {
      throw new Error(`llm-plan summary fixture invalid: ${normalized.errors.map((entry) => entry.code).join(", ")}`);
    }
    summary = normalized.value;
  }

  let summaryForSpec = summary;
  if (!scenario) {
    summaryForSpec = { ...summary };
    if (isNonEmptyString(goal)) {
      summaryForSpec.goal = goal;
    }
    if (Number.isFinite(resolvedBudgetTokens)) {
      summaryForSpec.budgetTokens = resolvedBudgetTokens;
    }
  }
  if (!Array.isArray(summaryForSpec?.poolWeights) || summaryForSpec.poolWeights.length === 0) {
    const poolWeights = Array.isArray(budgetPoolWeights) && budgetPoolWeights.length > 0
      ? budgetPoolWeights
      : buildPoolWeightsForSummary(summaryForSpec);
    if (poolWeights.length > 0) {
      summaryForSpec = { ...summaryForSpec, poolWeights };
    }
  }

  // CR.7 / WP-5 — assembled BY the round opened at the top of this function, not by
  // reaching past it into `buildspec-assembler.js`. `roomGeometry` stays explicit: the
  // round's Director has no Configurator injected, so its own `roomGeometry()` is
  // `undefined` and a summary with room cards would be refused. Same pair either way.
  const buildSpecResult = director.assembleBuildSpec({
    summary: summaryForSpec,
    catalog,
    roomGeometry: configuratorRoomGeometry,
    selections: mappedSelections || undefined,
    runId,
    createdAt,
    source: "cli-llm-plan",
  });
  if (!buildSpecResult.ok) {
    throw new Error(`llm-plan build spec failed: ${buildSpecResult.errors.join("\n")}`);
  }
  const capturedInputsForBuild = captures.length > 0 ? captures : capture ? [capture] : undefined;
  const buildResult = await orchestrateBuild({
    spec: buildSpecResult.spec,
    producedBy: "cli-llm-plan",
    capturedInputs: capturedInputsForBuild,
    // #280: the plan this build persists is the one this round drafted.
    directorRound: director.currentRound(),
    placeObjects: await commandKernel.hostObjectPlacement(buildSpecResult.spec.meta.createdAt),
  });

  return buildDryRunSuccess({
    command: "scenario",
    runId,
    outDir,
    actorIds: deriveActorIds(buildResult.initialState),
    roomIds: deriveRoomIds(buildResult.simConfig),
    budgetEstimate: buildDryRunBudgetEstimate({
      budgetReceipt: buildResult.budgetReceipt,
      spendProposal: buildResult.spendProposal,
      budgetTokens: resolvedBudgetTokens,
    }),
    extra: {
      ticks: args.ticks !== undefined ? Number(args.ticks) : undefined,
    },
  });
}

export async function scenarioCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  assertAllowedScenarioArgs(args);
  const fromRunId = args["from-run"];
  const hasFromRun = isNonEmptyString(fromRunId);
  const hasLevelFiles = isNonEmptyString(args["sim-config"]) || isNonEmptyString(args["initial-state"]);
  if (!hasFromRun && !hasLevelFiles && !isNonEmptyString(args.text)) {
    throw new Error("scenario requires --text, --from-run, or --sim-config with --initial-state.");
  }
  if (hasFromRun && isNonEmptyString(args.text)) {
    throw new Error("scenario does not allow --text together with --from-run.");
  }
  if (args["dry-run"]) {
    try {
      emitJsonStdout(await validateScenarioDryRun(args));
    } catch (error) {
      emitJsonStdout(buildDryRunFailure({
        command: "scenario",
        runId: args["run-id"] || "",
        outDir: resolvePath(args["out-dir"]),
        error,
      }));
    }
    return;
  }

  const runId = args["run-id"] || fromRunId || makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultRunDir(runId);
  const runOutDir = join(outDir, "run");
  const inspectOutDir = join(outDir, "inspect");
  let llmPlanResult = null;
  let llmPlanSummary = null;
  let sourceArtifactPaths = null;
  let runArgs;

  const resolvedFromRun = await resolveScenarioLevelSource(args);
  if (resolvedFromRun) {
    runArgs = {
      "sim-config": resolvedFromRun.simConfigPath,
      "initial-state": resolvedFromRun.initialStatePath,
      ticks: args.ticks,
      seed: args.seed,
      "run-id": runId,
      "out-dir": runOutDir,
    };
    sourceArtifactPaths = {
      source_sim_config: resolvedFromRun.simConfigPath,
      source_initial_state: resolvedFromRun.initialStatePath,
    };
  } else {
    const llmPlanOutDir = join(outDir, "llm-plan");
    const llmPlanArgs = {
      text: args.text,
      catalog: args.catalog,
      model: args.model,
      goal: args.goal,
      "budget-tokens": args["budget-tokens"],
      "base-url": args["base-url"],
      fixture: args.fixture,
      "budget-loop": args["budget-loop"],
      "budget-pool": args["budget-pool"],
      "budget-reserve": args["budget-reserve"],
      "run-id": runId,
      "created-at": args["created-at"],
      "emit-intermediates": args["emit-intermediates"],
      "out-dir": llmPlanOutDir,
    };
    llmPlanResult = await commandKernel.llmPlan(llmPlanArgs);

    const simConfigPath = join(llmPlanResult.outDir, "sim-config.json");
    const initialStatePath = join(llmPlanResult.outDir, "initial-state.json");
    if (!existsSync(simConfigPath) || !existsSync(initialStatePath)) {
      throw new Error("scenario requires llm-plan to produce sim-config.json and initial-state.json.");
    }

    runArgs = {
      "sim-config": simConfigPath,
      "initial-state": initialStatePath,
      ticks: args.ticks,
      seed: args.seed,
      "run-id": runId,
      "out-dir": runOutDir,
    };
  }
  const runResult = await commandKernel.run(runArgs);

  const inspectResult = await commandKernel.inspect({
    "tick-frames": join(runResult.outDir, "tick-frames.json"),
    "effects-log": join(runResult.outDir, "effects-log.json"),
    "out-dir": inspectOutDir,
  });

  const [runSummary, inspectSummary] = await Promise.all([
    summarizeRunOutput({
      outDir: runResult.outDir,
      args: runArgs,
      pricingReport: runResult.pricingReport,
    }),
    summarizeInspectOutput({
      outDir: inspectResult.outDir,
      runtimeBudgetReceiptPath: join(runResult.outDir, "runtime-budget-receipt.json"),
    }),
  ]);
  if (llmPlanResult) {
    llmPlanSummary = await summarizeBuildLikeOutput({
      command: "llm-plan",
      outDir: llmPlanResult.outDir,
    });
  }

  emitJsonStdout(buildScenarioSummary({
    runId,
    outDir,
    llmPlanSummary,
    sourceArtifactPaths,
    runSummary,
    inspectSummary,
  }));
}
