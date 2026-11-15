/**
 * `agon show`, `diff`, `runs`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { summarizeSolverDecisions } from "../../../../runtime/src/commands/solver-host.js";
import { summarizeFrame } from "../../../../runtime/src/commands/run-helpers.js";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { DEFAULT_ARTIFACTS_DIR, DEFAULT_RUNS_DIR, SCHEMAS, assertSchema, defaultRunDir, deriveActorIds, deriveRoomIds, emitJsonStdout, isNonEmptyString, readJson, readJsonIfExists, usage } from "./shared.mjs";
import { compareFromRunStagePriority, resolveFromRunArtifactPaths } from "./run-shared.mjs";

function normalizeCommandOutDirEntries(commandOutDirs) {
  if (commandOutDirs instanceof Map) {
    return Array.from(commandOutDirs.entries()).map(([command, outDir]) => ({ command, outDir }));
  }
  if (Array.isArray(commandOutDirs)) {
    return commandOutDirs
      .map((entry) => ({
        command: entry?.command,
        outDir: entry?.outDir,
      }));
  }
  if (commandOutDirs && typeof commandOutDirs === "object") {
    return Object.entries(commandOutDirs).map(([command, outDir]) => ({ command, outDir }));
  }
  return [];
}

function deriveCommonAncestor(paths) {
  const normalized = paths
    .map((value) => (isNonEmptyString(value) ? resolve(value) : ""))
    .filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  const splitPaths = normalized.map((value) => value.split(sep).filter(Boolean));
  const prefix = [];
  const first = splitPaths[0];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (!splitPaths.every((parts) => parts[index] === segment)) {
      break;
    }
    prefix.push(segment);
  }
  if (prefix.length === 0) {
    return dirname(normalized[0]);
  }
  const absolutePrefix = `${sep}${prefix.join(sep)}`;
  return absolutePrefix || sep;
}

function deriveRememberedRunDir(entries) {
  const outDirs = entries
    .map((entry) => entry?.outDir)
    .filter((value) => isNonEmptyString(value));
  if (outDirs.length === 0) {
    return "";
  }
  if (outDirs.length === 1) {
    return outDirs[0];
  }
  return deriveCommonAncestor(outDirs);
}

export async function resolveFromRunArtifactPathsFromCommandOutDirs({
  runId,
  commandOutDirs,
} = {}) {
  if (!isNonEmptyString(runId)) {
    throw new Error("--from-run requires a non-empty run id.");
  }
  const entries = normalizeCommandOutDirEntries(commandOutDirs)
    .filter((entry) => isNonEmptyString(entry.command) && isNonEmptyString(entry.outDir))
    .sort((left, right) => compareFromRunStagePriority(left.command, right.command));
  if (entries.length === 0) {
    throw new Error(`--from-run could not find remembered artifacts for run ${runId}.`);
  }

  const runDir = deriveRememberedRunDir(entries);
  for (const entry of entries) {
    const simConfigPath = join(entry.outDir, "sim-config.json");
    const initialStatePath = join(entry.outDir, "initial-state.json");
    if (existsSync(simConfigPath) && existsSync(initialStatePath)) {
      return {
        runDir,
        sourceDir: entry.outDir,
        simConfigPath,
        initialStatePath,
      };
    }
  }

  let simConfigPath = null;
  let initialStatePath = null;
  for (const entry of entries) {
    if (!simConfigPath) {
      const candidate = join(entry.outDir, "sim-config.json");
      if (existsSync(candidate)) {
        simConfigPath = candidate;
      }
    }
    if (!initialStatePath) {
      const candidate = join(entry.outDir, "initial-state.json");
      if (existsSync(candidate)) {
        initialStatePath = candidate;
      }
    }
  }

  if (!simConfigPath || !initialStatePath) {
    throw new Error(`--from-run requires sim-config.json and initial-state.json for remembered run ${runId}.`);
  }

  return {
    runDir,
    sourceDir: dirname(simConfigPath) === dirname(initialStatePath) ? dirname(simConfigPath) : runDir,
    simConfigPath,
    initialStatePath,
  };
}

const RUN_INDEX_INPUT_FILES = Object.freeze([
  ["request", "request.json"],
  ["spec", "spec.json"],
  ["sim_config", "sim-config.json"],
  ["initial_state", "initial-state.json"],
  ["resolved_sim_config", "resolved-sim-config.json"],
  ["resolved_initial_state", "resolved-initial-state.json"],
  ["action_log", "action-log.json"],
]);

const RUN_INDEX_OUTPUT_FILES = Object.freeze([
  ["intent", "intent.json"],
  ["plan", "plan.json"],
  ["budget", "budget.json"],
  ["price_list", "price-list.json"],
  ["budget_receipt", "budget-receipt.json"],
  ["solver_request", "solver-request.json"],
  ["solver_result", "solver-result.json"],
  ["sim_config", "sim-config.json"],
  ["initial_state", "initial-state.json"],
  ["resource_bundle", "resource-bundle.json"],
  ["bundle", "bundle.json"],
  ["manifest", "manifest.json"],
  ["telemetry", "telemetry.json"],
  ["run_summary", "run-summary.json"],
  ["tick_frames", "tick-frames.json"],
  ["effects_log", "effects-log.json"],
  ["runtime_budget_receipt", "runtime-budget-receipt.json"],
  ["runtime_decision_captures", "runtime-decision-captures.json"],
  ["inspect_summary", "inspect-summary.json"],
  ["narrative", "narrative.json"],
  ["affinity_summary", "affinity-summary.json"],
]);

async function listDirectoryNames(path) {
  if (!path || !existsSync(path)) {
    return [];
  }
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

// A `run` outDir holds no sim-config.json / initial-state.json of its own: the level it
// played is embedded in that run's GameplayBundle. Readers that need the level (show, diff)
// fall back to the bundle so every run made with `run --from-run` stays describable.
async function readEmbeddedBundleArtifact(outDir, schema) {
  const bundle = await readJsonIfExists(join(outDir, "bundle.json"));
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : [];
  return artifacts.find((artifact) => artifact?.schema === schema) || null;
}

async function readLevelArtifactsForOutDir(outDir) {
  const simConfig = await readJsonIfExists(join(outDir, "sim-config.json"))
    || await readEmbeddedBundleArtifact(outDir, SCHEMAS.simConfig);
  const initialState = await readJsonIfExists(join(outDir, "initial-state.json"))
    || await readEmbeddedBundleArtifact(outDir, SCHEMAS.initialState);
  return { simConfig, initialState };
}

function toRunIndexArtifactRecord({ key, outDir, fileName, payload } = {}) {
  const record = {
    key,
    path: join(outDir, fileName),
  };
  if (payload?.schema) {
    record.schema = payload.schema;
  }
  if (payload?.schemaVersion !== undefined) {
    record.schemaVersion = payload.schemaVersion;
  }
  if (payload?.meta?.id) {
    record.id = payload.meta.id;
  }
  if (payload?.meta?.createdAt) {
    record.createdAt = payload.meta.createdAt;
  }
  return record;
}

async function collectRunIndexArtifactRecords(outDir, entries) {
  const records = [];
  for (const [key, fileName] of entries) {
    const payload = await readJsonIfExists(join(outDir, fileName));
    if (!payload) {
      continue;
    }
    records.push(toRunIndexArtifactRecord({ key, outDir, fileName, payload }));
  }
  return records;
}

function deriveRunIndexStatus({ telemetry, runSummary, outputCount } = {}) {
  if (isNonEmptyString(telemetry?.data?.status)) {
    return telemetry.data.status;
  }
  if (isNonEmptyString(runSummary?.outcome) && runSummary.outcome !== "unknown") {
    return runSummary.outcome;
  }
  if (outputCount > 0) {
    return "success";
  }
  return "incomplete";
}

function deriveRunStatus(commands) {
  const statuses = Array.from(new Set(commands.map((entry) => entry.status).filter(isNonEmptyString)));
  if (statuses.length === 0) {
    return "unknown";
  }
  if (statuses.length === 1) {
    return statuses[0];
  }
  return "mixed";
}

function deriveBudgetSpend(budgetReceipt) {
  if (!budgetReceipt || budgetReceipt.schema !== SCHEMAS.budgetReceiptArtifact) {
    return undefined;
  }
  const summary = {
    status: budgetReceipt.status,
    totalCost: budgetReceipt.totalCost,
    remaining: budgetReceipt.remaining,
  };
  if (budgetReceipt.scenarioSpendReport && typeof budgetReceipt.scenarioSpendReport === "object") {
    summary.scenarioSpendReport = budgetReceipt.scenarioSpendReport;
  }
  return summary;
}

const DIFF_STAGE_PRIORITY = Object.freeze([
  "run",
  "replay",
  "scenario",
  "inspect",
  "build",
  "create",
  "configure",
  "llm-plan",
]);

function compareDiffStagePriority(left, right) {
  const leftIndex = DIFF_STAGE_PRIORITY.indexOf(left);
  const rightIndex = DIFF_STAGE_PRIORITY.indexOf(right);
  const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft - normalizedRight;
  }
  return left.localeCompare(right);
}

function deriveTickCount(runSummary, tickFrames) {
  if (Number.isFinite(runSummary?.metrics?.ticks)) {
    return runSummary.metrics.ticks;
  }
  return Array.isArray(tickFrames)
    ? tickFrames.reduce((maxTick, frame) => Math.max(maxTick, Number.isFinite(frame?.tick) ? frame.tick : 0), 0)
    : 0;
}

function deriveEffectCount(runSummary, tickFrames) {
  if (Number.isFinite(runSummary?.metrics?.effects)) {
    return runSummary.metrics.effects;
  }
  return Array.isArray(tickFrames)
    ? tickFrames.reduce(
      (total, frame) => total + (Array.isArray(frame?.emittedEffects) ? frame.emittedEffects.length : 0),
      0,
    )
    : 0;
}

function buildActorRecordMap(initialState) {
  const actors = Array.isArray(initialState?.actors) ? initialState.actors : [];
  return new Map(
    actors
      .filter((actor) => isNonEmptyString(actor?.id))
      .map((actor) => [actor.id, actor]),
  );
}

function addActorDamage(damageByActorId, actorId, amount) {
  if (!isNonEmptyString(actorId) || !Number.isFinite(amount)) {
    return;
  }
  damageByActorId.set(actorId, (damageByActorId.get(actorId) || 0) + amount);
}

function recordEventDamage(damageByActorId, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const targetActorId = data.targetActorId || data.targetId || event.targetActorId || event.targetId || event.actorId;
  const damage = Number.isFinite(data.damage)
    ? data.damage
    : Number.isFinite(data.amount) && String(event.kind || "").toLowerCase().includes("damage")
      ? data.amount
      : null;
  if (Number.isFinite(damage)) {
    addActorDamage(damageByActorId, targetActorId, damage);
  }
}

function recordEffectDamage(damageByActorId, effect, result) {
  if ((!effect || typeof effect !== "object") && (!result || typeof result !== "object")) {
    return;
  }
  const effectData = effect?.data && typeof effect.data === "object" ? effect.data : {};
  const resultData = result && typeof result === "object" ? result : {};
  const kind = String(effect?.kind || resultData.kind || "").toLowerCase();
  const targetActorId = (
    effectData.targetActorId
    || effectData.targetId
    || resultData.targetActorId
    || resultData.targetId
    || effect?.actorId
    || resultData.actorId
  );
  const damage = Number.isFinite(effectData.damage)
    ? effectData.damage
    : Number.isFinite(effectData.amount) && kind.includes("damage")
      ? effectData.amount
      : Number.isFinite(resultData.damage)
        ? resultData.damage
        : Number.isFinite(resultData.amount) && kind.includes("damage")
          ? resultData.amount
          : null;
  if (Number.isFinite(damage)) {
    addActorDamage(damageByActorId, targetActorId, damage);
  }
}

function deriveDamageSummary(tickFrames) {
  const damageByActorId = new Map();
  if (!Array.isArray(tickFrames)) {
    return { total: 0, byActorId: damageByActorId };
  }
  tickFrames.forEach((frame) => {
    (Array.isArray(frame?.emittedEvents) ? frame.emittedEvents : []).forEach((event) => {
      recordEventDamage(damageByActorId, event);
    });
    (Array.isArray(frame?.emittedEffects) ? frame.emittedEffects : []).forEach((effect) => {
      recordEffectDamage(damageByActorId, effect, effect?.data);
    });
    (Array.isArray(frame?.fulfilledEffects) ? frame.fulfilledEffects : []).forEach((record) => {
      recordEffectDamage(damageByActorId, record?.effect, record?.result);
      (Array.isArray(record?.result?.events) ? record.result.events : []).forEach((event) => {
        recordEventDamage(damageByActorId, event);
      });
    });
  });
  const total = Array.from(damageByActorId.values()).reduce((sum, value) => sum + value, 0);
  return { total, byActorId: damageByActorId };
}

function normalizeDiffFrameSummary(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }
  return summarizeFrame(frame);
}

function findFirstFrameDivergence(tickFramesA, tickFramesB) {
  const normalizedA = Array.isArray(tickFramesA) ? tickFramesA.map(normalizeDiffFrameSummary) : [];
  const normalizedB = Array.isArray(tickFramesB) ? tickFramesB.map(normalizeDiffFrameSummary) : [];
  const max = Math.max(normalizedA.length, normalizedB.length);
  for (let index = 0; index < max; index += 1) {
    const frameA = normalizedA[index] || null;
    const frameB = normalizedB[index] || null;
    if (!frameA || !frameB) {
      return {
        index,
        reason: !frameA ? "missing_run_a_frame" : "missing_run_b_frame",
        tick: frameA?.tick ?? frameB?.tick ?? null,
        frameA,
        frameB,
      };
    }
    if (JSON.stringify(frameA) !== JSON.stringify(frameB)) {
      return {
        index,
        reason: "frame_mismatch",
        tick: frameA.tick ?? frameB.tick ?? null,
        frameA,
        frameB,
      };
    }
  }
  return null;
}

// Resolves a run's directories either from disk (artifacts/runs/<runId>/<command>) or, when
// commandOutDirs is given, from the MCP server's remembered per-command outDirs.
async function resolveDiffRunCommandEntries(runId, commandOutDirs) {
  if (commandOutDirs) {
    const entries = normalizeCommandOutDirEntries(commandOutDirs)
      .filter((entry) => isNonEmptyString(entry.command) && isNonEmptyString(entry.outDir));
    if (entries.length === 0) {
      throw new Error(`Run directory not found for remembered run: ${runId}`);
    }
    return { runDir: deriveRememberedRunDir(entries), entries, remembered: true };
  }
  const runDir = defaultRunDir(runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }
  const entries = (await listDirectoryNames(runDir)).map((command) => ({ command, outDir: join(runDir, command) }));
  return { runDir, entries, remembered: false };
}

// The level a run played: sim-config.json / initial-state.json files when a stage wrote
// them (create, build, llm-plan ...), else the copies embedded in the compared stage's
// GameplayBundle, which is all a `run --from-run` directory carries.
async function resolveDiffLevelArtifacts({ runId, entries, remembered, compareDir }) {
  let fileLookupError = null;
  try {
    const sourcePaths = remembered
      ? await resolveFromRunArtifactPathsFromCommandOutDirs({ runId, commandOutDirs: entries })
      : await resolveFromRunArtifactPaths(runId);
    return {
      sourceDir: sourcePaths.sourceDir,
      simConfig: await readJson(sourcePaths.simConfigPath),
      initialState: await readJson(sourcePaths.initialStatePath),
    };
  } catch (error) {
    fileLookupError = error;
  }
  const simConfig = await readEmbeddedBundleArtifact(compareDir, SCHEMAS.simConfig);
  const initialState = await readEmbeddedBundleArtifact(compareDir, SCHEMAS.initialState);
  if (!simConfig || !initialState) {
    throw fileLookupError;
  }
  return { sourceDir: compareDir, simConfig, initialState };
}

async function resolveDiffRunArtifacts(runId, commandOutDirs = null) {
  if (!isNonEmptyString(runId)) {
    throw new Error("diff requires non-empty run ids.");
  }
  const { runDir, entries, remembered } = await resolveDiffRunCommandEntries(runId, commandOutDirs);
  const candidateEntries = [...entries].sort((left, right) => compareDiffStagePriority(left.command, right.command));
  let compareDir = null;
  let compareCommand = "";

  for (const entry of candidateEntries) {
    if (existsSync(join(entry.outDir, "tick-frames.json")) || existsSync(join(entry.outDir, "run-summary.json"))) {
      compareDir = entry.outDir;
      compareCommand = entry.command;
      break;
    }
  }

  if (!compareDir) {
    throw new Error(`diff could not find tick-frames.json or run-summary.json for run ${runId} under ${runDir}.`);
  }

  const level = await resolveDiffLevelArtifacts({ runId, entries, remembered, compareDir });
  const { simConfig, initialState } = level;
  const [runSummary, tickFrames] = await Promise.all([
    readJsonIfExists(join(compareDir, "run-summary.json")),
    readJsonIfExists(join(compareDir, "tick-frames.json")),
  ]);
  assertSchema(simConfig, SCHEMAS.simConfig);
  assertSchema(initialState, SCHEMAS.initialState);
  if (runSummary) {
    assertSchema(runSummary, SCHEMAS.runSummary);
  }
  if (tickFrames && !Array.isArray(tickFrames)) {
    throw new Error(`diff expects tick-frames.json for run ${runId} to contain a JSON array.`);
  }
  (Array.isArray(tickFrames) ? tickFrames : []).forEach((frame) => assertSchema(frame, SCHEMAS.tickFrame));

  return {
    runId,
    runDir,
    sourceDir: level.sourceDir,
    compareDir,
    compareCommand,
    simConfig,
    initialState,
    runSummary,
    tickFrames: Array.isArray(tickFrames) ? tickFrames : [],
    ticks: deriveTickCount(runSummary, tickFrames),
    effects: deriveEffectCount(runSummary, tickFrames),
    damage: deriveDamageSummary(tickFrames),
    actorRecords: buildActorRecordMap(initialState),
  };
}

function buildActorDiffRecords(runA, runB) {
  const actorIds = Array.from(new Set([
    ...runA.actorRecords.keys(),
    ...runB.actorRecords.keys(),
    ...runA.damage.byActorId.keys(),
    ...runB.damage.byActorId.keys(),
  ])).sort((left, right) => left.localeCompare(right));

  return actorIds.map((actorId) => {
    const actorA = runA.actorRecords.get(actorId) || null;
    const actorB = runB.actorRecords.get(actorId) || null;
    const damageA = runA.damage.byActorId.get(actorId) || 0;
    const damageB = runB.damage.byActorId.get(actorId) || 0;
    return {
      id: actorId,
      presentInA: Boolean(actorA),
      presentInB: Boolean(actorB),
      kindA: actorA?.kind,
      kindB: actorB?.kind,
      vitalsA: actorA?.vitals || null,
      vitalsB: actorB?.vitals || null,
      damageReceivedA: damageA,
      damageReceivedB: damageB,
      damageDelta: damageB - damageA,
    };
  });
}

// commandOutDirsA/B: the MCP server's remembered outDirs for a run made in its session;
// omitted, a run is read from artifacts/runs/<runId>.
export async function summarizeRunDiff({ runA, runB, commandOutDirsA = null, commandOutDirsB = null } = {}) {
  const [resolvedA, resolvedB] = await Promise.all([
    resolveDiffRunArtifacts(runA, commandOutDirsA),
    resolveDiffRunArtifacts(runB, commandOutDirsB),
  ]);
  const divergence = findFirstFrameDivergence(resolvedA.tickFrames, resolvedB.tickFrames);
  return {
    ok: true,
    command: "diff",
    runA: resolvedA.runId,
    runB: resolvedB.runId,
    sourceA: {
      runDir: resolvedA.runDir,
      sourceDir: resolvedA.sourceDir,
      compareDir: resolvedA.compareDir,
      command: resolvedA.compareCommand,
    },
    sourceB: {
      runDir: resolvedB.runDir,
      sourceDir: resolvedB.sourceDir,
      compareDir: resolvedB.compareDir,
      command: resolvedB.compareCommand,
    },
    ticks: {
      a: resolvedA.ticks,
      b: resolvedB.ticks,
      delta: resolvedB.ticks - resolvedA.ticks,
    },
    effects: {
      a: resolvedA.effects,
      b: resolvedB.effects,
      delta: resolvedB.effects - resolvedA.effects,
    },
    damage: {
      a: resolvedA.damage.total,
      b: resolvedB.damage.total,
      delta: resolvedB.damage.total - resolvedA.damage.total,
    },
    actors: buildActorDiffRecords(resolvedA, resolvedB),
    divergesAtTick: divergence?.tick ?? null,
    divergence,
  };
}

async function summarizeRunIndexCommand({ runId, command, outDir } = {}) {
  const request = await readJsonIfExists(join(outDir, "request.json"));
  const spec = await readJsonIfExists(join(outDir, "spec.json"));
  const { simConfig, initialState } = await readLevelArtifactsForOutDir(outDir);
  const telemetry = await readJsonIfExists(join(outDir, "telemetry.json"));
  const runSummary = await readJsonIfExists(join(outDir, "run-summary.json"));
  const budgetReceipt = await readJsonIfExists(join(outDir, "budget-receipt.json"));
  const inputs = await collectRunIndexArtifactRecords(outDir, RUN_INDEX_INPUT_FILES);
  const outputs = await collectRunIndexArtifactRecords(outDir, RUN_INDEX_OUTPUT_FILES);
  const createdAt = (
    spec?.meta?.createdAt
    || request?.meta?.createdAt
    || telemetry?.meta?.createdAt
    || runSummary?.meta?.createdAt
    || ""
  );
  return {
    command,
    runId,
    status: deriveRunIndexStatus({ telemetry, runSummary, outputCount: outputs.length }),
    outDir,
    createdAt,
    source: (
      spec?.meta?.source
      || telemetry?.data?.source
      || request?.meta?.producedBy
      || runSummary?.meta?.producedBy
      || ""
    ),
    actorIds: deriveActorIds(initialState),
    roomIds: deriveRoomIds(simConfig),
    ticks: runSummary?.metrics?.ticks,
    budgetSpend: deriveBudgetSpend(budgetReceipt),
    ...(Array.isArray(telemetry?.data?.solverDecisions)
      ? { solverDecisions: summarizeSolverDecisions(telemetry.data.solverDecisions) || "none recorded" }
      : {}),
    inputs,
    outputs,
  };
}

async function summarizeRunShow({ runId } = {}) {
  if (!isNonEmptyString(runId)) {
    throw new Error("show requires --run-id <id>.");
  }
  const runDir = defaultRunDir(runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const commandNames = await listDirectoryNames(runDir);
  const commands = [];
  for (const command of commandNames) {
    commands.push(await summarizeRunIndexCommand({
      runId,
      command,
      outDir: join(runDir, command),
    }));
  }
  commands.sort((a, b) => a.command.localeCompare(b.command));

  const actorIds = Array.from(new Set(commands.flatMap((entry) => entry.actorIds || [])))
    .sort((a, b) => a.localeCompare(b));
  const roomIds = Array.from(new Set(commands.flatMap((entry) => entry.roomIds || [])))
    .sort((a, b) => a.localeCompare(b));
  const artifactPaths = Array.from(new Set(commands.flatMap((entry) => [
    ...(entry.inputs || []).map((record) => record.path),
    ...(entry.outputs || []).map((record) => record.path),
  ]))).sort((a, b) => a.localeCompare(b));
  const budgetSpend = commands.find((entry) => entry.budgetSpend)?.budgetSpend;

  return {
    ok: true,
    command: "show",
    runId,
    runDir,
    status: deriveRunStatus(commands),
    commandCount: commands.length,
    actorIds,
    roomIds,
    actorCount: actorIds.length,
    roomCount: roomIds.length,
    budgetSpend,
    artifactPaths,
    commands,
  };
}

export async function summarizeRunShowFromCommandOutDirs({
  runId,
  commandOutDirs,
} = {}) {
  if (!isNonEmptyString(runId)) {
    throw new Error("show requires --run-id <id>.");
  }
  const entries = normalizeCommandOutDirEntries(commandOutDirs)
    .filter((entry) => isNonEmptyString(entry.command) && isNonEmptyString(entry.outDir));
  if (entries.length === 0) {
    throw new Error(`Run directory not found for remembered run: ${runId}`);
  }

  const commands = [];
  for (const entry of entries) {
    commands.push(await summarizeRunIndexCommand({
      runId,
      command: entry.command,
      outDir: entry.outDir,
    }));
  }
  commands.sort((a, b) => a.command.localeCompare(b.command));

  const actorIds = Array.from(new Set(commands.flatMap((entry) => entry.actorIds || [])))
    .sort((a, b) => a.localeCompare(b));
  const roomIds = Array.from(new Set(commands.flatMap((entry) => entry.roomIds || [])))
    .sort((a, b) => a.localeCompare(b));
  const artifactPaths = Array.from(new Set(commands.flatMap((entry) => [
    ...(entry.inputs || []).map((record) => record.path),
    ...(entry.outputs || []).map((record) => record.path),
  ]))).sort((a, b) => a.localeCompare(b));
  const budgetSpend = commands.find((entry) => entry.budgetSpend)?.budgetSpend;

  return {
    ok: true,
    command: "show",
    runId,
    runDir: deriveRememberedRunDir(entries),
    status: deriveRunStatus(commands),
    commandCount: commands.length,
    actorIds,
    roomIds,
    actorCount: actorIds.length,
    roomCount: roomIds.length,
    budgetSpend,
    artifactPaths,
    commands,
  };
}

async function summarizeRunsIndex({ rootDir } = {}) {
  const runIds = await listDirectoryNames(rootDir);
  const runs = [];
  for (const runId of runIds) {
    const runDir = join(rootDir, runId);
    const commandNames = await listDirectoryNames(runDir);
    const commands = [];
    for (const command of commandNames) {
      commands.push(await summarizeRunIndexCommand({
        runId,
        command,
        outDir: join(runDir, command),
      }));
    }
    commands.sort((a, b) => {
      const aTime = Date.parse(a.createdAt || "");
      const bTime = Date.parse(b.createdAt || "");
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return a.command.localeCompare(b.command);
    });
    runs.push({
      runId,
      status: deriveRunStatus(commands),
      commandCount: commands.length,
      commands,
    });
  }
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  return {
    ok: true,
    command: "runs",
    action: "list",
    rootDir,
    runs,
  };
}

export async function showCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!isNonEmptyString(args["run-id"])) {
    throw new Error("show requires --run-id <id>.");
  }
  const unknown = [];
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || key === "run-id") {
      continue;
    }
    unknown.push(`--${key}`);
  }
  if (Array.isArray(args._) && args._.length > 0) {
    unknown.push(...args._);
  }
  if (unknown.length > 0) {
    throw new Error(`show only accepts --run-id. Unknown: ${unknown.join(", ")}`);
  }
  emitJsonStdout(await summarizeRunShow({ runId: args["run-id"] }));
}

export async function diffCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!isNonEmptyString(args["run-a"]) || !isNonEmptyString(args["run-b"])) {
    throw new Error("diff requires --run-a <id> and --run-b <id>.");
  }
  const unknown = [];
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || key === "run-a" || key === "run-b") {
      continue;
    }
    unknown.push(`--${key}`);
  }
  if (Array.isArray(args._) && args._.length > 0) {
    unknown.push(...args._);
  }
  if (unknown.length > 0) {
    throw new Error(`diff only accepts --run-a and --run-b. Unknown: ${unknown.join(", ")}`);
  }
  emitJsonStdout(await summarizeRunDiff({ runA: args["run-a"], runB: args["run-b"] }));
}

export async function runsCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(usage());
    return;
  }
  if (subcommand !== "list") {
    throw new Error(`Unknown runs subcommand: ${subcommand}`);
  }
  if (rest.length > 0) {
    const args = parseArgs(rest);
    if (!args.help && args._.length > 0) {
      throw new Error("runs list does not accept positional arguments.");
    }
    if (Object.keys(args).some((key) => key !== "_" && key !== "help")) {
      throw new Error("runs list does not accept options.");
    }
  }
  const rootDir = resolve(process.cwd(), DEFAULT_ARTIFACTS_DIR, DEFAULT_RUNS_DIR);
  emitJsonStdout(await summarizeRunsIndex({ rootDir }));
}
