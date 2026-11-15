/**
 * The command kernel's `llmPlan`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { UNUSED_CLOCK } from "../../personas/_shared/require-clock.js";
import { orchestrateBuild } from "../../build/orchestrate-build.js";
import { buildBuildTelemetryRecord } from "../../build/telemetry.js";
import { filterSchemaCatalogEntries } from "../../contracts/schema-catalog.js";
import { createDirectorPersona } from "../../personas/director/persona.js";
import { createConfiguratorPersona } from "../../personas/configurator/persona.js";
// CR.4 M4b: the LLM session now runs as an Orchestrator ROUND — the persona returns
// `llm_request` effects and this host dispatches them through ports/effects.js, so the
// IO happens in the adapter instead of inline inside the persona. Drop-in replacement:
// same arguments, same result shape (proven by the differential in
// tests/runtime/llm-host-loop.test.js).
import { runLlmSessionHosted } from "../llm-host.js";
import { runLlmBudgetLoop } from "../../personas/orchestrator/persona.js";
// CR.7 / WP-5 — the vocabulary comes from CONTRACTS, not from the Orchestrator's alias of
// it. `prompt-contract.js` only renamed these (P5.1 D1: one value, three names), so the
// boundary crossing died with the hop rather than being republished. Aliased on import so
// the call sites below are untouched.
import { AFFINITY_EXPRESSIONS as ALLOWED_AFFINITY_EXPRESSIONS } from "../../contracts/domain-constants.js";
// Genuinely Orchestrator law — the prompt contract itself — so taken from its barrel.
import { deriveAllowedOptionsFromCatalog, normalizeSummary } from "../../personas/orchestrator/persona.js";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, buildLlmActorConfigPromptTemplate, buildLlmCatalogRepairPromptTemplate, buildLlmConstraintSection } from "../../contracts/domain-constants.js";
import { SCHEMAS, appendJsonOnlyInstruction, buildArtifactRefs, buildBuildArtifacts, buildBuildManifestEntries, buildCapturedInputPath, buildRepairPrompt, buildSummaryPoolWeights, collectBuildOutputArtifactRecords, countInstances, deriveAllowedPairs, formatAllowedPairs, injectBudgetTokens, isNonEmptyString, readEnv, resolveScenarioAssetPath, summarizeMissingSelections } from "./helpers.js";

export function createLlmPlanCommands(ctx) {
  const { allowNetworkRequests, createLlmAdapter, cwd, defaultLlmPlanOutDir, dirname, exists, host, hostLayoutBudgetFit, hostObjectPlacement, isLlmBudgetLoopEnabled, isLlmLiveEnabled, isLlmStrictEnabled, isLocalBaseUrl, join, log, makeId, nowIso, readJson, readText, resolvePath, writeJson } = ctx;

  async function llmPlan(args) {
    const scenarioPath = resolvePath(args.scenario);
    const textRaw = args.text;
    const promptRaw = args.prompt;
    const catalogOverride = resolvePath(args.catalog);
    const goalOverride = args.goal;
    const budgetTokensRaw = args["budget-tokens"];
    const model = args.model || readEnv(host.env, "AGON_LLM_MODEL") || DEFAULT_LLM_MODEL;
    const baseUrl = args["base-url"] || readEnv(host.env, "AGON_LLM_BASE_URL") || DEFAULT_LLM_BASE_URL;
    const promptInput = isNonEmptyString(promptRaw)
      ? promptRaw
      : isNonEmptyString(textRaw)
        ? textRaw
        : undefined;
    const fixturePath = resolvePath(args.fixture)
      || (!scenarioPath && isNonEmptyString(textRaw)
        // #862: the host names its default fixture (the CLI: the repository's summary fixture).
        ? (typeof host.defaultLlmFixturePath === "function" ? host.defaultLlmFixturePath() : null)
        : null);
    const runId = args["run-id"] || makeId("run");
    const createdAt = args["created-at"] || nowIso();
    const outDir = resolvePath(args["out-dir"]) || defaultLlmPlanOutDir(runId);
    const emitIntermediates = Boolean(args["emit-intermediates"]);

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
    const scenarioBaseDir = scenarioPath ? dirname(scenarioPath) : cwd();
    const catalogPath = catalogOverride
      || (scenario ? resolveScenarioAssetPath(scenario.catalogPath, scenarioBaseDir, resolvePath, exists) : null);
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
    // #299: every solver-hosted decision this plan's build makes, in the order it was made.
    const solverDecisions = [];

    const goal = isNonEmptyString(goalOverride)
      ? goalOverride
      : scenario?.goal || promptInput || "LLM planning request";
    const resolvedBudgetTokens = budgetTokens !== undefined ? budgetTokens : scenario?.budgetTokens;
    if (!Number.isFinite(resolvedBudgetTokens) || resolvedBudgetTokens <= 0) {
      throw new Error("llm-plan requires --budget-tokens or scenario.budgetTokens > 0.");
    }
    const prompt = injectBudgetTokens(
      promptInput,
      resolvedBudgetTokens,
    );
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
    const llmFormat = readEnv(host.env, "AGON_LLM_FORMAT");

    const liveEnabled = isLlmLiveEnabled();
    const adapterFlowEnabled = liveEnabled || Boolean(fixturePath);
    let capture = null;
    let captures = [];
    let summary = null;
    let mappedSelections;
    let loopTrace = null;
    let budgetAllocation = null;
    let budgetPoolWeights = null;
    let budgetPoolBudgets = null;
    let budgetPoolPolicy = null;

    // Open the Director's build round (P2.1b). Translation — pool mapping and
    // BuildSpec assembly — runs through the persona controller, not direct
    // imports of its internals. The IntentEnvelope is synthesized here at the
    // CLI boundary (its intended origin per the artifact contract); the
    // Director structures it into a PlanArtifact. beginBuild must precede the
    // first mapPool/assembleBuildSpec, which are FSM-gated behind a plan.
    const director = createDirectorPersona({ clock: () => createdAt });
    const intentEnvelope = {
      schema: SCHEMAS.intent,
      schemaVersion: 1,
      meta: { id: `intent_${runId}`, runId, createdAt, producedBy: "cli" },
      source: "cli",
      intent: { goal: isNonEmptyString(goal) ? goal : `build ${runId}` },
    };
    director.beginBuild(intentEnvelope, { runId });

    if (adapterFlowEnabled) {
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
        // Z7.1: the host owns adapter construction. A fixture/non-capable adapter is still
        // useful here: the Allocator detects the missing domain and takes its characterized
        // fallback, while AGON_SOLVER_ENGINE=z3-real exposes the hybrid search path.
        const fitLayout = await hostLayoutBudgetFit(director, createdAt, (decision) => solverDecisions.push(decision));
        const loopResult = await runLlmBudgetLoop({
        // CR.4 M5b: the loop no longer performs LLM IO; glue supplies the runner.
        runSession: runLlmSessionHosted,
        // M5b.2a′: pool mapping is the Director's decision. This round is already open
        // above (beginBuild), which is what the FSM gate on mapPool requires.
        // M5b.2b: the same already-open round answers the three Allocator pricing
        // questions too. Deliberately NOT beginDirectorBuildCapabilities() — that opens a
        // round, and this root already has one. A second round for the same build is the
        // defect the gate exists to catch, not a convenience.
        mapPool: director.mapPool,
        buildCardSet: director.buildCardSet,
        resolveTileCosts: director.resolveTileCosts,
        allocateBudget: director.allocateBudget,
        evaluateSelectionSpend: director.evaluateSelectionSpend,
        fitLayout,
        evaluateLayoutSpend: director.evaluateLayoutSpend,
        assessFeasibility: director.assessFeasibility,
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
          normalizeMotivations: createConfiguratorPersona({ clock: UNUSED_CLOCK }).normalizeMotivations,
        });
        captures = loopResult.captures || [];
        loopTrace = loopResult.trace || null;
        budgetAllocation = loopResult.budgetAllocation || null;
        budgetPoolWeights = loopResult.poolWeights || null;
        budgetPoolBudgets = loopResult.poolBudgets || null;
        budgetPoolPolicy = loopResult.poolPolicy || poolPolicy || null;
        if (!loopResult.ok) {
          if (captures.length > 0) {
            for (let i = 0; i < captures.length; i += 1) {
              const artifact = captures[i];
              const capturePath = buildCapturedInputPath("llm", i, artifact?.meta?.id);
              await writeJson(join(outDir, capturePath), artifact);
            }
          }
          throw new Error(`llm-plan budget loop failed: ${JSON.stringify(loopResult.errors || [])}`);
        }
        summary = loopResult.summary;
        mappedSelections = loopResult.selections;
      } else {
        let session = await runLlmSessionHosted({
          adapter,
          model,
          baseUrl,
          prompt: isNonEmptyString(finalPrompt) ? finalPrompt : undefined,
          // CR.7 / WP-5: the session attaches a cardSet to its summary, and that is the
          // Director's translation. Uses THIS round's director, deliberately not
          // beginDirectorBuildCapabilities() — see the budget-loop note above.
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
          if (session.capture) {
            const capturePath = buildCapturedInputPath("llm", 0, session.capture.meta?.id);
            await writeJson(join(outDir, capturePath), session.capture);
          }
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
            // CR.7 / WP-5: the session attaches a cardSet to its summary, and that is the
            // Director's translation. Uses THIS round's director, deliberately not
            // beginDirectorBuildCapabilities() — see the budget-loop note above.
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
            if (session.capture) {
              const capturePath = buildCapturedInputPath("llm", 0, session.capture.meta?.id);
              await writeJson(join(outDir, capturePath), session.capture);
            }
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
                + (finalMissing ? ` Unmatched picks: ${finalMissing}` : "")
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
      const summaryPath = resolveScenarioAssetPath(scenario.summaryPath, scenarioBaseDir, resolvePath, exists);
      if (!summaryPath) {
        throw new Error("llm-plan requires scenario.summaryPath when AGON_LLM_LIVE is off.");
      }
      const summaryFixture = await readJson(summaryPath);
      const normalized = normalizeSummary(summaryFixture);
      if (!normalized.ok) {
        throw new Error(`llm-plan summary fixture invalid: ${normalized.errors.map((err) => err.code).join(", ")}`);
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
        : buildSummaryPoolWeights(summaryForSpec);
      if (poolWeights.length > 0) {
        summaryForSpec = { ...summaryForSpec, poolWeights };
      }
    }

    const buildSpecResult = director.assembleBuildSpec({
      summary: summaryForSpec,
      catalog,
      selections: mappedSelections || undefined,
      runId,
      createdAt,
      source: "cli-llm-plan",
    });
    if (!buildSpecResult.ok) {
      throw new Error(`llm-plan build spec failed: ${buildSpecResult.errors.join("\n")}`);
    }

    const capturedInputsForBuild = captures.length > 0 ? captures : capture ? [capture] : undefined;
    const placeObjects = await hostObjectPlacement(buildSpecResult.spec.meta.createdAt, (decision) => solverDecisions.push(decision));
    const buildResult = await orchestrateBuild({
      spec: buildSpecResult.spec,
      producedBy: "cli-llm-plan",
      capturedInputs: capturedInputsForBuild,
      placeObjects,
      solverDecisions,
      // #280: the plan this build persists is the one this round drafted.
      directorRound: director.currentRound(),
    });

    await writeJson(join(outDir, "spec.json"), buildResult.spec);

    const capturedInputs = Array.isArray(buildResult.capturedInputs) ? buildResult.capturedInputs : [];
    const persistedArtifacts = collectBuildOutputArtifactRecords(buildResult, {
      includeBudgetAllocation: budgetAllocation,
      capturedInputs,
      emitIntermediates,
    });
    for (const entry of persistedArtifacts) {
      await writeJson(join(outDir, entry.path), entry.artifact);
    }

    const bundleArtifacts = buildBuildArtifacts(buildResult, {
      includeBudgetAllocation: budgetAllocation,
      capturedInputs,
      emitIntermediates,
    });

    const manifestEntries = buildBuildManifestEntries(buildResult, {
      includeBudgetAllocation: budgetAllocation,
      capturedInputs,
      emitIntermediates,
    });

    const schemaEntries = filterSchemaCatalogEntries({
      schemaRefs: [
        { schema: buildResult.spec.schema, schemaVersion: buildResult.spec.schemaVersion },
        ...manifestEntries,
      ],
    });

    const bundle = {
      spec: buildResult.spec,
      schemas: schemaEntries,
      artifacts: bundleArtifacts,
    };
    await writeJson(join(outDir, "bundle.json"), bundle);

    const manifest = {
      specPath: "spec.json",
      correlation: {
        runId: buildResult.spec.meta.runId,
        source: buildResult.spec.meta.source,
        correlationId: buildResult.spec.meta.correlationId,
      },
      schemas: schemaEntries,
      artifacts: manifestEntries,
    };
    if (!manifest.correlation.correlationId) {
      delete manifest.correlation.correlationId;
    }
    await writeJson(join(outDir, "manifest.json"), manifest);

    const telemetry = buildBuildTelemetryRecord({
      spec: buildResult.spec,
      status: "success",
      artifactRefs: buildArtifactRefs(manifestEntries),
      producedBy: "cli-llm-plan",
      clock: () => buildResult.spec.meta.createdAt,
      data: {
        solverDecisions,
        ...(loopTrace ? {
        llm: {
          budgetLoop: true,
          trace: loopTrace,
          budgetAllocation: budgetAllocation
            ? {
              pools: budgetAllocation.pools,
              weights: budgetPoolWeights || undefined,
              policy: budgetPoolPolicy || budgetAllocation.policy,
              totals: budgetPoolBudgets || undefined,
            }
            : undefined,
        },
      } : {}),
      },
    });
    await writeJson(join(outDir, "telemetry.json"), telemetry);

    log(`llm-plan: wrote ${outDir}`);
    return { outDir };
  }

  return { llmPlan };
}
