/**
 * The command kernel's module-level helpers, moved verbatim from kernel.js (#862).
 * kernel.js re-exports the ones it exported before.
 */
import { UNUSED_CLOCK } from "../../personas/_shared/require-clock.js";
import { createAllocatorPersona } from "../../personas/allocator/persona.js";
import { createConfiguratorPersona } from "../../personas/configurator/persona.js";
import { createCore } from "../../../../core-ts/src/index.ts";
// CR.7 / WP-5 — the vocabulary comes from CONTRACTS, not from the Orchestrator's alias of
// it. `prompt-contract.js` only renamed these (P5.1 D1: one value, three names), so the
// boundary crossing died with the hop rather than being republished. Aliased on import so
// the call sites below are untouched.
import { AFFINITY_KINDS as ALLOWED_AFFINITIES, AFFINITY_EXPRESSIONS as ALLOWED_AFFINITY_EXPRESSIONS, MOTIVATION_KINDS as ALLOWED_MOTIVATIONS } from "../../contracts/domain-constants.js";
import { DEFAULT_LLM_BASE_URL, LLM_REPAIR_TEXT, appendLlmPromptSuffix, buildLlmRepairPromptTemplate } from "../../contracts/domain-constants.js";
// M9: the SCHEMAS alias table below, and the two ActionSequence sites M8 relocated, all
// read from contracts/artifacts.ts. The table stays — short keys are what this file's call
// sites use — but its VALUES have one origin now instead of eighteen.
import { ACTOR_LOADOUT_SCHEMA, AFFINITY_PRESET_SCHEMA, AFFINITY_SUMMARY_SCHEMA, BUDGET_ARTIFACT_SCHEMA, BUDGET_RECEIPT_ARTIFACT_SCHEMA, CAPTURED_INPUT_SCHEMA, EFFECT_SCHEMA, EXECUTION_POLICY_SCHEMA, INITIAL_STATE_SCHEMA, INTENT_ENVELOPE_SCHEMA, PLAN_ARTIFACT_SCHEMA, PRICE_LIST_SCHEMA, RUN_SUMMARY_SCHEMA, SIM_CONFIG_SCHEMA, SOLVER_REQUEST_SCHEMA, SOLVER_RESULT_SCHEMA, TELEMETRY_RECORD_SCHEMA, TICK_FRAME_SCHEMA } from "../../contracts/artifacts.ts";

// CR.7 / WP-5 — level geometry, artifact assembly and affinity resolution are Configurator
// law; this file is glue. They came off three persona internals and now come off the public
// surface, retiring three allowlist rows. Local names unchanged, so call sites are untouched.
export const {
  generateGridLayoutFromInput,
  buildInteriorBarrierActors,
  buildResourceEnclosureBarrierActorsForResources,
  buildSimConfigArtifact,
  buildInitialStateArtifact,
  resolveAffinityEffects,
  completeObjectPlacement,
  assembleMovementStamina,
} = createConfiguratorPersona({ clock: UNUSED_CLOCK });

// #300 — the questions `agon solve --dir` can ask about a built level, one per adopted domain.
export const SOLVE_QUESTIONS = Object.freeze(["place-objects", "budget-fit"]);

export const SCHEMAS = Object.freeze({
  intent: INTENT_ENVELOPE_SCHEMA,
  plan: PLAN_ARTIFACT_SCHEMA,
  budgetReceipt: BUDGET_RECEIPT_ARTIFACT_SCHEMA,
  budgetArtifact: BUDGET_ARTIFACT_SCHEMA,
  budgetReceiptArtifact: BUDGET_RECEIPT_ARTIFACT_SCHEMA,
  priceList: PRICE_LIST_SCHEMA,
  simConfig: SIM_CONFIG_SCHEMA,
  initialState: INITIAL_STATE_SCHEMA,
  executionPolicy: EXECUTION_POLICY_SCHEMA,
  solverRequest: SOLVER_REQUEST_SCHEMA,
  solverResult: SOLVER_RESULT_SCHEMA,
  tickFrame: TICK_FRAME_SCHEMA,
  effect: EFFECT_SCHEMA,
  telemetry: TELEMETRY_RECORD_SCHEMA,
  runSummary: RUN_SUMMARY_SCHEMA,
  affinityPreset: AFFINITY_PRESET_SCHEMA,
  actorLoadout: ACTOR_LOADOUT_SCHEMA,
  affinitySummary: AFFINITY_SUMMARY_SCHEMA,
  capturedInput: CAPTURED_INPUT_SCHEMA,
});

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalize the opt-in world-state checkpoint list used by adapter callers.
 *
 * The runtime owns validation because direct command-kernel callers and the CLI
 * must observe the same contract. The returned array is safe to use as the
 * exact set of post-step capture boundaries.
 */
export function normalizeWorldStateCheckpoints(value, { ticks } = {}) {
  if (value === undefined || value === null || value === false) return [];
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? value.split(",").map((entry) => entry.trim())
      : null;
  if (!entries || entries.length === 0) {
    throw new Error("--world-state-checkpoints requires a non-empty comma-separated list.");
  }
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new Error("--world-state-checkpoints requires --ticks to be a non-negative integer.");
  }

  const checkpoints = entries.map((entry) => {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) return entry;
    if (typeof entry === "string" && /^(?:0|[1-9][0-9]*)$/.test(entry)) return Number(entry);
    throw new Error("--world-state-checkpoints must contain only non-negative integers.");
  });
  const seen = new Set();
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (seen.has(checkpoint)) {
      throw new Error(`--world-state-checkpoints must not contain duplicate tick ${checkpoint}.`);
    }
    if (index > 0 && checkpoint < checkpoints[index - 1]) {
      throw new Error("--world-state-checkpoints must be strictly ascending.");
    }
    if (checkpoint > ticks) {
      throw new Error(`--world-state-checkpoints tick ${checkpoint} cannot exceed --ticks ${ticks}.`);
    }
    seen.add(checkpoint);
  }
  return checkpoints;
}

export function worldStateCheckpointFilename(tick) {
  return `tick-${String(tick).padStart(6, "0")}.json`;
}

// CR.1 — pool weights are the Allocator's. This was a hand-maintained copy of its
// DEFAULT_BUDGET_POOLS, byte-identical but free to diverge: a real duplicate, not an
// alias, and one CR.1's own inventory missed (found by running the G2 guard as a
// census). Read from the Allocator's public surface instead.
export const SUMMARY_POOL_WEIGHT_DEFAULTS = Object.freeze(
  Object.fromEntries(
    createAllocatorPersona({ clock: UNUSED_CLOCK })
      .pricing.defaultPoolWeights()
      .map((pool) => [pool.id, pool.weight]),
  ),
);

export function buildSummaryPoolWeights(summary = {}) {
  const cards = Array.isArray(summary.cardSet)
    ? summary.cardSet
    : Array.isArray(summary.cards) ? summary.cards : [];
  const layout = summary.layout && typeof summary.layout === "object" ? summary.layout : null;
  const layoutHasRoomSpend = layout
    && (
      Number.isInteger(layout.floorTiles)
      || Number.isInteger(layout.hallwayTiles)
      || (Array.isArray(layout.hazards) && layout.hazards.length > 0)
    );
  const rooms = [
    ...(Array.isArray(summary.rooms) ? summary.rooms : []),
    ...cards.filter((entry) => entry?.type === "room" || entry?.source === "room"),
  ];
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
  const weights = [];
  if (rooms.length > 0 || layoutHasRoomSpend) {
    weights.push({ id: "rooms", weight: SUMMARY_POOL_WEIGHT_DEFAULTS.rooms });
  }
  if (hazards.length > 0) weights.push({ id: "hazards", weight: SUMMARY_POOL_WEIGHT_DEFAULTS.hazards });
  if (wardens.length > 0) weights.push({ id: "wardens", weight: SUMMARY_POOL_WEIGHT_DEFAULTS.wardens });
  if (resources.length > 0) weights.push({ id: "resources", weight: SUMMARY_POOL_WEIGHT_DEFAULTS.resources });
  if (delvers.length > 0) weights.push({ id: "delver", weight: SUMMARY_POOL_WEIGHT_DEFAULTS.delver });
  return weights;
}

export function sanitizeFileSegment(value) {
  const raw = String(value || "").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "capture";
}

export function sanitizeFileName(value) {
  const raw = String(value || "");
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "capture";
}

export function buildSpecMeta(spec, producedBy, suffix) {
  return {
    id: `${spec.meta.id}_${suffix}`,
    runId: spec.meta.runId,
    createdAt: spec.meta.createdAt,
    producedBy,
    correlationId: spec.meta.correlationId,
    note: spec.meta.note,
  };
}

export function assertSchema(artifact, expectedSchema, acceptedVersions = [1]) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error(`Expected ${expectedSchema} artifact.`);
  }
  if (artifact.schema !== expectedSchema) {
    throw new Error(`Expected schema ${expectedSchema}, got ${artifact.schema || "missing"}.`);
  }
  if (!acceptedVersions.includes(artifact.schemaVersion)) {
    throw new Error(`Expected schemaVersion ${acceptedVersions.join(" or ")} for ${expectedSchema}.`);
  }
}

export function addManifestEntry(entries, artifact, path) {
  if (!artifact || typeof artifact !== "object") {
    return;
  }
  const id = artifact.meta?.id;
  if (!id) {
    return;
  }
  entries.push({
    id,
    schema: artifact.schema,
    schemaVersion: artifact.schemaVersion,
    path,
  });
}

export function buildArtifactRefs(entries) {
  return entries.map((entry) => ({
    id: entry.id,
    schema: entry.schema,
    schemaVersion: entry.schemaVersion,
  }));
}

export function buildCapturedInputPath(adapter, index, outputRefId) {
  if (isNonEmptyString(outputRefId)) {
    return `${sanitizeFileName(outputRefId)}.json`;
  }
  const safeAdapter = sanitizeFileSegment(adapter);
  return `captured-input-${safeAdapter}-${index + 1}.json`;
}

export function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

export function unwrapCodeFence(text) {
  if (!text) return text;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : text;
}

export function extractJsonObject(text) {
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
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
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

export function appendJsonOnlyInstruction(promptText) {
  return appendLlmPromptSuffix(promptText);
}

export function deriveAllowedPairs(catalog) {
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

export function formatAllowedPairs(pairs) {
  return pairs.map((pair) => `(${pair.motivation}, ${pair.affinity})`).join(", ");
}

export function countInstances(selections, kind) {
  return selections
    .filter((sel) => sel.kind === kind && Array.isArray(sel.instances))
    .reduce((sum, sel) => sum + sel.instances.length, 0);
}

export function summarizeMissingSelections(selections) {
  return selections
    .filter((sel) => !sel.applied)
    .map((sel) => `${sel.kind}:${sel.requested?.motivation || "?"}/${sel.requested?.affinity || "?"}`)
    .join(", ");
}

export function injectBudgetTokens(prompt, budgetTokens) {
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

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export function resolveScenarioAssetPath(rawPath, baseDir, resolvePath, exists) {
  if (!rawPath) {
    return null;
  }
  const primary = resolvePath(rawPath);
  if (primary && exists(primary)) {
    return primary;
  }
  if (!baseDir) {
    return primary;
  }
  const fallback = resolvePath(rawPath, baseDir);
  if (fallback && exists(fallback)) {
    return fallback;
  }
  return primary || fallback;
}

export function buildRepairPrompt({ basePrompt, errors, responseText, allowedOptions, allowedPairsText }) {
  const extracted = extractJsonObject(responseText) || responseText;
  const affinities = allowedOptions?.affinities?.length ? allowedOptions.affinities : ALLOWED_AFFINITIES;
  const motivations = allowedOptions?.motivations?.length ? allowedOptions.motivations : ALLOWED_MOTIVATIONS;
  const expressions = ALLOWED_AFFINITY_EXPRESSIONS;
  return buildLlmRepairPromptTemplate({
    basePrompt,
    errors,
    responseText: extracted,
    affinities,
    affinityExpressions: expressions,
    motivations,
    allowedPairsText,
    phaseRequirement: LLM_REPAIR_TEXT.phaseActorsRequirement,
    extraLines: [
      LLM_REPAIR_TEXT.tokenHintRule,
      LLM_REPAIR_TEXT.exampleAffinityEntry,
    ],
  });
}

export function readEnv(env, key) {
  if (!env || typeof env !== "object") {
    return undefined;
  }
  return env[key];
}

export function toBooleanGate(value) {
  return value === true || value === "1" || value === "true";
}

export function resolveBoolGate(fnOrValue, fallback = false) {
  if (typeof fnOrValue === "function") {
    return Boolean(fnOrValue());
  }
  if (fnOrValue === undefined) {
    return fallback;
  }
  return Boolean(fnOrValue);
}

export function requireHostFunction(host, name) {
  const fn = host?.[name];
  if (typeof fn !== "function") {
    throw new Error(`command kernel host missing function: ${name}`);
  }
  return fn;
}

/**
 * AM.5/F13 — build the observation's affinity payload from the initial state.
 *
 * Reshapes what the actor already carries (`affinities: [{kind, expression,
 * stacks}]`) into the `affinityStacks` map the observation builder reads. A run
 * that already has a richer resolved-effects payload keeps it: this only fills
 * the gap for actors whose affinity would otherwise be invisible to the Actor.
 *
 * Kept in glue on purpose — it is a shape translation between two records that
 * already exist, deciding nothing. What an affinity DOES stays with core and the
 * Moderator; what it COSTS stays with the Configurator and the Allocator.
 */
export function buildAffinityEffectsFromInitialState(initialState) {
  const actors = Array.isArray(initialState?.actors) ? initialState.actors : [];
  const entries = [];
  for (const actor of actors) {
    if (!actor?.id) continue;
    if (Array.isArray(actor.resolvedEffects) && actor.resolvedEffects.length > 0) {
      entries.push({ actorId: actor.id, resolvedEffects: actor.resolvedEffects });
      continue;
    }
    const affinities = Array.isArray(actor.affinities) ? actor.affinities : [];
    if (affinities.length === 0) continue;
    const affinityStacks = {};
    for (const affinity of affinities) {
      const kind = typeof affinity?.kind === "string" ? affinity.kind.trim().toLowerCase() : "";
      if (!kind) continue;
      const expression = typeof affinity?.expression === "string" && affinity.expression.trim()
        ? affinity.expression.trim().toLowerCase()
        : "push";
      const stacks = Number.isInteger(affinity?.stacks) && affinity.stacks > 0 ? affinity.stacks : 1;
      affinityStacks[`${kind}:${expression}`] = stacks;
    }
    if (Object.keys(affinityStacks).length > 0) {
      entries.push({ actorId: actor.id, affinityStacks });
    }
  }
  return entries.length > 0 ? { actors: entries } : null;
}

export function createCommandRuntimeCore() {
  // Expose the FULL core surface. This used to be a hand-picked subset, but
  // the runtime's capability checks (canReadObservation, canApplyActorPlacements,
  // applyActionsToCore, ...) silently degrade to legacy single-actor paths when
  // a probed function is missing — the subset caused two such silent
  // degradations as the runtime grew. The command kernel has no reason to see
  // less of the core than the playback runtime does.
  return createCore();
}

export async function captureAdapterPayload({ capture, index, baseDir, spec, producedBy, allowNetwork, host }) {
  const readText = requireHostFunction(host, "readText");
  const resolvePath = requireHostFunction(host, "resolvePath");
  const createIpfsAdapter = requireHostFunction(host, "createIpfsAdapter");
  const createBlockchainAdapter = requireHostFunction(host, "createBlockchainAdapter");
  const createLlmAdapter = requireHostFunction(host, "createLlmAdapter");
  const isLocalBaseUrl = requireHostFunction(host, "isLocalBaseUrl");

  if (!capture || typeof capture !== "object") {
    throw new Error("build capture requires an object entry.");
  }
  const adapterRaw = capture.adapter;
  if (!isNonEmptyString(adapterRaw)) {
    throw new Error("build capture requires adapter name.");
  }

  const adapterKey = adapterRaw.toLowerCase();
  const request = isObject(capture.request) ? capture.request : {};
  const outputRef = capture.outputRef;
  if (outputRef) {
    if (outputRef.schema !== SCHEMAS.capturedInput) {
      throw new Error(`capture outputRef schema must be ${SCHEMAS.capturedInput}.`);
    }
    if (outputRef.schemaVersion !== 1) {
      throw new Error("capture outputRef schemaVersion must be 1.");
    }
  }

  const suffix = `capture_${sanitizeFileSegment(adapterKey)}_${index + 1}`;
  const meta = buildSpecMeta(spec, producedBy, suffix);
  if (outputRef?.id) {
    meta.id = outputRef.id;
  }

  const source = {
    adapter: adapterRaw,
    requestId: isNonEmptyString(request.requestId) ? request.requestId : undefined,
    request,
  };

  let payload;
  let contentType = capture.contentType || request.contentType;

  if (adapterKey === "ipfs") {
    const cid = request.cid;
    if (!isNonEmptyString(cid)) {
      throw new Error("ipfs capture requires request.cid.");
    }
    const path = request.path || "";
    const gatewayUrl = request.gatewayUrl || "https://ipfs.io/ipfs";
    const wantJson = request.json !== undefined
      ? Boolean(request.json)
      : contentType === "application/json";
    const fixturePath = resolvePath(capture.fixturePath || request.fixturePath, baseDir);

    let fetchFn;
    if (fixturePath) {
      const fixtureText = await readText(fixturePath);
      fetchFn = async () => ({ ok: true, text: async () => fixtureText });
    } else if (!allowNetwork) {
      throw new Error("ipfs capture requires fixturePath unless AGON_ALLOW_NETWORK=1.");
    }

    const adapter = createIpfsAdapter({ gatewayUrl, fetchFn });
    payload = wantJson ? await adapter.fetchJson(cid, path) : await adapter.fetchText(cid, path);
    contentType = contentType || (wantJson ? "application/json" : "text/plain");
  } else if (adapterKey === "blockchain") {
    const rpcUrl = request.rpcUrl;
    if (!isNonEmptyString(rpcUrl)) {
      throw new Error("blockchain capture requires request.rpcUrl.");
    }
    const address = request.address;
    const fixtureChainIdPath = resolvePath(request.fixtureChainIdPath, baseDir);
    const fixtureBalancePath = resolvePath(request.fixtureBalancePath, baseDir);

    if ((!fixtureChainIdPath || (address && !fixtureBalancePath)) && !allowNetwork) {
      throw new Error("blockchain capture requires fixtures unless AGON_ALLOW_NETWORK=1.");
    }

    let fetchFn;
    if (fixtureChainIdPath || fixtureBalancePath) {
      const chainFixture = fixtureChainIdPath ? JSON.parse(await readText(fixtureChainIdPath)) : null;
      const balanceFixture = fixtureBalancePath ? JSON.parse(await readText(fixtureBalancePath)) : null;
      fetchFn = async (_url, options) => {
        const body = JSON.parse(options?.body || "{}");
        if (body.method === "eth_chainId" && chainFixture) {
          return { ok: true, json: async () => chainFixture };
        }
        if (body.method === "eth_getBalance" && balanceFixture) {
          return { ok: true, json: async () => balanceFixture };
        }
        return { ok: false, status: 500, statusText: "Missing fixture" };
      };
    }

    const adapter = createBlockchainAdapter({ rpcUrl, fetchFn });
    payload = { rpcUrl };
    payload.chainId = await adapter.getChainId();
    if (address) {
      payload.address = address;
      payload.balance = await adapter.getBalance(address);
    }
    contentType = contentType || "application/json";
  } else if (adapterKey === "llm" || adapterKey === "ollama") {
    const model = request.model;
    const prompt = request.prompt;
    if (!isNonEmptyString(model) || !isNonEmptyString(prompt)) {
      throw new Error("llm capture requires request.model and request.prompt.");
    }
    const baseUrl = request.baseUrl || request.base_url || DEFAULT_LLM_BASE_URL;
    const fixturePath = resolvePath(capture.fixturePath || request.fixturePath, baseDir);

    let fetchFn;
    if (fixturePath) {
      const fixtureJson = JSON.parse(await readText(fixturePath));
      fetchFn = async () => ({ ok: true, json: async () => fixtureJson });
    } else if (!allowNetwork && !isLocalBaseUrl(baseUrl)) {
      throw new Error("llm capture requires fixturePath unless AGON_ALLOW_NETWORK=1.");
    }

    const options = isObject(request.options) ? request.options : undefined;
    const adapter = createLlmAdapter({ baseUrl, fetchFn });
    payload = await adapter.generate({
      model,
      prompt,
      options,
      stream: Boolean(request.stream),
    });
    contentType = contentType || "application/json";
  } else {
    throw new Error(`unknown capture adapter ${adapterRaw}`);
  }

  const artifact = {
    schema: SCHEMAS.capturedInput,
    schemaVersion: 1,
    meta,
    source,
    contentType: contentType || "application/json",
    payload,
  };

  return {
    artifact,
    path: buildCapturedInputPath(adapterKey, index, outputRef?.id),
  };
}

export function collectBuildOutputArtifactRecords(
  buildResult,
  {
    requestArtifact = null,
    includeBudgetAllocation = null,
    capturedInputs = [],
    emitIntermediates = false,
    includeAffinitySummary = false,
  } = {},
) {
  const records = [
    { artifact: requestArtifact, path: "request.json", persistedByDefault: false },
    { artifact: buildResult.intent, path: "intent.json", persistedByDefault: false },
    { artifact: buildResult.plan, path: "plan.json", persistedByDefault: false },
    { artifact: buildResult.budget?.budget, path: "budget.json", persistedByDefault: true },
    { artifact: buildResult.budget?.priceList, path: "price-list.json", persistedByDefault: true },
    { artifact: buildResult.budgetReceipt, path: "budget-receipt.json", persistedByDefault: true },
    { artifact: includeBudgetAllocation, path: "budget-allocation.json", persistedByDefault: false },
    { artifact: buildResult.spendProposal, path: "spend-proposal.json", persistedByDefault: true },
    { artifact: buildResult.solverRequest, path: "solver-request.json", persistedByDefault: false },
    { artifact: buildResult.solverResult, path: "solver-result.json", persistedByDefault: false },
    { artifact: buildResult.simConfig, path: "sim-config.json", persistedByDefault: true },
    { artifact: buildResult.initialState, path: "initial-state.json", persistedByDefault: true },
    {
      artifact: includeAffinitySummary ? buildResult.affinitySummary : null,
      path: "affinity-summary.json",
      persistedByDefault: false,
    },
    { artifact: buildResult.resourceBundle, path: "resource-bundle.json", persistedByDefault: true },
  ];

  capturedInputs.forEach((entry, index) => {
    const artifact = entry?.artifact || entry;
    records.push({
      artifact,
      path: entry?.path || buildCapturedInputPath("llm", index, artifact?.meta?.id),
      persistedByDefault: false,
    });
  });

  return records.filter(({ artifact, persistedByDefault }) => (
    artifact && (persistedByDefault || emitIntermediates)
  ));
}

export function buildBuildArtifacts(
  buildResult,
  {
    requestArtifact = null,
    includeBudgetAllocation = null,
    capturedInputs = [],
    emitIntermediates = false,
    includeAffinitySummary = false,
  } = {},
) {
  const records = collectBuildOutputArtifactRecords(buildResult, {
    requestArtifact,
    includeBudgetAllocation,
    capturedInputs,
    emitIntermediates,
    includeAffinitySummary,
  });
  const artifacts = [];
  records.forEach((entry) => {
    artifacts.push(entry.artifact);
  });

  artifacts.sort((a, b) => {
    if (a.schema === b.schema) {
      return a.meta.id.localeCompare(b.meta.id);
    }
    return a.schema.localeCompare(b.schema);
  });

  return artifacts;
}

export function buildBuildManifestEntries(
  buildResult,
  {
    requestArtifact = null,
    includeBudgetAllocation = null,
    capturedInputs = [],
    emitIntermediates = false,
    includeAffinitySummary = false,
  } = {},
) {
  const records = collectBuildOutputArtifactRecords(buildResult, {
    requestArtifact,
    includeBudgetAllocation,
    capturedInputs,
    emitIntermediates,
    includeAffinitySummary,
  });
  const entries = [];
  records.forEach((entry) => {
    addManifestEntry(entries, entry.artifact, entry.path);
  });

  entries.sort((a, b) => {
    if (a.schema === b.schema) {
      return a.id.localeCompare(b.id);
    }
    return a.schema.localeCompare(b.schema);
  });

  return entries;
}
