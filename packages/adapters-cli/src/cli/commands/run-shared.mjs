/**
 * Helpers the run, scenario, inspection and play commands share: from-run artifact resolution, run summaries, dry-run checks.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeWorldStateCheckpoints } from "../../../../runtime/src/commands/kernel.js";
import { summarizeSolverDecisions } from "../../../../runtime/src/commands/solver-host.js";
import { applyActorOverrides, applyTileOverrides, barrierSpecsFromTileOverrides, normalizeArgList, resolveVitalDefaults } from "../../../../runtime/src/commands/run-helpers.js";
// M9: this file's whole schema vocabulary — the SCHEMAS alias table below, the four
// schema constants it already imported, and the scattered literals in between —
// now has one origin.
import { AFFINITY_PRESET_SCHEMA_VERSIONS, GAMEPLAY_BUNDLE_SCHEMA } from "../../../../runtime/src/contracts/artifacts.ts";
import { DEFAULT_TICKS, SCHEMAS, assertSchema, buildDryRunSuccess, defaultRunCommandOutDir, defaultRunDir, deriveActorIds, deriveRoomIds, isNonEmptyString, makeId, readJson, readJsonIfExists, resolvePath, writeJson } from "./shared.mjs";

const FROM_RUN_STAGE_PRIORITY = Object.freeze([
  "llm-plan",
  "build",
  "configurator",
  "create",
  "configure",
  "room-plan",
  "hazard-plan",
  "resource-plan",
  "delver-plan",
  "warden-plan",
  "run",
]);

export function compareFromRunStagePriority(left, right) {
  const leftIndex = FROM_RUN_STAGE_PRIORITY.indexOf(left);
  const rightIndex = FROM_RUN_STAGE_PRIORITY.indexOf(right);
  const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft - normalizedRight;
  }
  return left.localeCompare(right);
}

export async function resolveFromRunArtifactPaths(runId) {
  if (!isNonEmptyString(runId)) {
    throw new Error("--from-run requires a non-empty run id.");
  }

  const runDir = defaultRunDir(runId);
  if (!existsSync(runDir)) {
    throw new Error(`--from-run could not find artifacts for run ${runId} under ${runDir}.`);
  }

  const dirents = await readdir(runDir, { withFileTypes: true });
  const candidateDirs = [
    runDir,
    ...dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runDir, entry.name))
      .sort((left, right) => compareFromRunStagePriority(left.slice(runDir.length + 1), right.slice(runDir.length + 1))),
  ];

  for (const candidateDir of candidateDirs) {
    const simConfigPath = join(candidateDir, "sim-config.json");
    const initialStatePath = join(candidateDir, "initial-state.json");
    if (existsSync(simConfigPath) && existsSync(initialStatePath)) {
      return { runDir, sourceDir: candidateDir, simConfigPath, initialStatePath };
    }
  }

  let simConfigPath = null;
  let initialStatePath = null;
  for (const candidateDir of candidateDirs) {
    if (!simConfigPath) {
      const candidate = join(candidateDir, "sim-config.json");
      if (existsSync(candidate)) {
        simConfigPath = candidate;
      }
    }
    if (!initialStatePath) {
      const candidate = join(candidateDir, "initial-state.json");
      if (existsSync(candidate)) {
        initialStatePath = candidate;
      }
    }
  }

  if (!simConfigPath || !initialStatePath) {
    throw new Error(`--from-run requires sim-config.json and initial-state.json under ${runDir}.`);
  }

  return {
    runDir,
    sourceDir: dirname(simConfigPath) === dirname(initialStatePath) ? dirname(simConfigPath) : runDir,
    simConfigPath,
    initialStatePath,
  };
}

// M8: GAMEPLAY_BUNDLE_SCHEMA now comes from contracts/artifacts.ts. It was declared
// here AND in ui-web/src/phaser-surface-ingestion.js — the writer and the reader of the
// same bundle, each with its own origin.

// Assemble a post-run agon/GameplayBundle by merging the resolved
// SimConfig/InitialState artifacts that `run` writes with the tick frames it
// recorded. Matches the shape produced by
// packages/runtime/src/runner/core-facade.js compileScenarioPlaybackBundle
// ({ schema, schemaVersion, meta, artifacts: [simConfig, initialState], spec, tickFrames })
// so a game client can consume it unchanged. Unlike compileScenarioPlaybackBundle (which re-runs the
// simulation itself), this reuses the tick frames already produced by `run`
// rather than re-executing the sim.
function buildGameplayBundleFromRunArtifacts({
  runId,
  createdAt,
  simConfig,
  initialState,
  tickFrames,
  runtimeBudgetReceipt = null,
  spec,
} = {}) {
  if (!simConfig || !initialState || !Array.isArray(tickFrames)) {
    return null;
  }
  return {
    schema: GAMEPLAY_BUNDLE_SCHEMA,
    schemaVersion: 1,
    meta: {
      id: runId || simConfig?.meta?.runId || initialState?.meta?.runId || "run",
      runId: runId || simConfig?.meta?.runId || initialState?.meta?.runId || "run",
      createdAt: createdAt || new Date().toISOString(),
      producedBy: "cli-run",
    },
    artifacts: [simConfig, initialState, ...(runtimeBudgetReceipt ? [runtimeBudgetReceipt] : [])],
    ...(spec ? { spec } : {}),
    tickFrames,
  };
}

export async function summarizeRunOutput({ outDir, args, pricingReport } = {}) {
  const runSummary = await readJsonIfExists(join(outDir, "run-summary.json"));
  const resolvedSimConfigPath = join(outDir, "resolved-sim-config.json");
  const resolvedInitialStatePath = join(outDir, "resolved-initial-state.json");
  const simConfig = await readJsonIfExists(
    existsSync(resolvedSimConfigPath) ? resolvedSimConfigPath : resolvePath(args["sim-config"])
  );
  const initialState = await readJsonIfExists(
    existsSync(resolvedInitialStatePath) ? resolvedInitialStatePath : resolvePath(args["initial-state"])
  );
  const artifactPaths = {
    tick_frames: join(outDir, "tick-frames.json"),
    effects_log: join(outDir, "effects-log.json"),
    runtime_budget_receipt: join(outDir, "runtime-budget-receipt.json"),
    runtime_decision_captures: join(outDir, "runtime-decision-captures.json"),
    run_summary: join(outDir, "run-summary.json"),
    action_log: join(outDir, "action-log.json"),
  };
  const affinitySummaryPath = join(outDir, "affinity-summary.json");
  if (existsSync(affinitySummaryPath)) {
    artifactPaths.affinity_summary = affinitySummaryPath;
  }
  if (existsSync(resolvedSimConfigPath)) {
    artifactPaths.resolved_sim_config = resolvedSimConfigPath;
  }
  if (existsSync(resolvedInitialStatePath)) {
    artifactPaths.resolved_initial_state = resolvedInitialStatePath;
  }
  // #278: overrides are re-priced by the Allocator, which writes its receipt with the resolved level.
  if (pricingReport) {
    artifactPaths.price_list = join(outDir, "price-list.json");
    artifactPaths.budget_receipt = join(outDir, "budget-receipt.json");
  }

  // M7 gap 3: stitch a post-run agon/GameplayBundle from the artifacts
  // this run just (re)wrote, so a client can load the whole run from one file.
  const runId = runSummary?.meta?.runId || simConfig?.meta?.runId || initialState?.meta?.runId || "";
  const tickFrames = await readJsonIfExists(artifactPaths.tick_frames);
  const runtimeBudgetReceipt = await readJsonIfExists(artifactPaths.runtime_budget_receipt);
  // When the run's inputs came from an agon_create outDir, that directory holds
  // the pre-run preview bundle.json ({ spec, schemas, artifacts } — no
  // schema/schemaVersion/tickFrames). Carry its spec/schemas and any artifacts
  // that the run does not supersede (e.g. ResourceBundleArtifact) into the
  // post-run bundle, and upgrade that sibling bundle.json in place so the
  // create outDir also ends up holding a loadable playback bundle.
  const sourceSimConfigPath = resolvePath(args["sim-config"]);
  const createBundlePath = sourceSimConfigPath ? join(dirname(sourceSimConfigPath), "bundle.json") : null;
  // Only stitch when the run's inputs came from an authored create outDir
  // (identified by its pre-run bundle.json sibling). Fixture-driven runs stay
  // bundle-free so CLI run output remains artifact-for-artifact equivalent to
  // a game client's run output.
  // Read unconditionally: when --out-dir is run in place (the same directory
  // as --sim-config, a natural choice with nothing in the CLI docs against
  // it), createBundlePath equals the run's own bundle.json path, but the read
  // still happens before that same path is overwritten below — there is no
  // race to guard against, so skipping the read here just as silently dropped
  // every run's tick frames from the bundle the UI loads.
  const createBundle = createBundlePath ? await readJsonIfExists(createBundlePath) : null;
  const bundle = createBundle && typeof createBundle === "object"
    ? buildGameplayBundleFromRunArtifacts({
      runId,
      createdAt: runSummary?.meta?.createdAt,
      simConfig,
      initialState,
      tickFrames: Array.isArray(tickFrames) ? tickFrames : null,
      runtimeBudgetReceipt,
      spec: createBundle.spec,
    })
    : null;
  if (bundle) {
    const SUPERSEDED_BY_RUN = new Set([
      simConfig?.schema,
      initialState?.schema,
    ]);
    const carriedArtifacts = Array.isArray(createBundle.artifacts)
      ? createBundle.artifacts.filter((artifact) => artifact?.schema && !SUPERSEDED_BY_RUN.has(artifact.schema))
      : [];
    if (carriedArtifacts.length > 0) {
      bundle.artifacts = [...bundle.artifacts, ...carriedArtifacts];
    }
    if (createBundle.schemas !== undefined) {
      bundle.schemas = createBundle.schemas;
    }
    const bundlePath = join(outDir, "bundle.json");
    await writeJson(bundlePath, bundle);
    artifactPaths.bundle = bundlePath;
    await writeJson(createBundlePath, bundle);
    artifactPaths.create_bundle = createBundlePath;
  }

  return {
    ok: true,
    command: "run",
    runId,
    outDir,
    actorIds: deriveActorIds(initialState),
    roomIds: deriveRoomIds(simConfig),
    artifactPaths,
    ticks: runSummary?.metrics?.ticks,
    ...(pricingReport ? { pricingReport } : {}),
  };
}

export async function summarizeInspectOutput({ outDir, runtimeBudgetReceiptPath = null, buildDir = null } = {}) {
  const inspectSummary = await readJsonIfExists(join(outDir, "inspect-summary.json"));
  const runtimeBudgetReceipt = await readJsonIfExists(runtimeBudgetReceiptPath);
  const runtimeBudget = runtimeBudgetReceipt && typeof runtimeBudgetReceipt === "object"
    ? {
      unit: runtimeBudgetReceipt.unit,
      rows: runtimeBudgetReceipt.rows,
      actorTotals: runtimeBudgetReceipt.actorTotals,
      unattributedUnits: runtimeBudgetReceipt.unattributedUnits,
      totalUnits: runtimeBudgetReceipt.totalUnits,
    }
    : null;
  const summary = {
    ok: true,
    command: "inspect",
    runId: inspectSummary?.meta?.runId || "",
    outDir,
    actorIds: [],
    roomIds: [],
    artifactPaths: {
      inspect_summary: join(outDir, "inspect-summary.json"),
    },
    ticks: inspectSummary?.data?.ticks,
  };
  if (runtimeBudgetReceiptPath && runtimeBudget) {
    summary.artifactPaths.runtime_budget_receipt = runtimeBudgetReceiptPath;
    summary.runtimeBudget = runtimeBudget;
  }
  // #299: the build that made this level, and which of its decisions the solver made.
  const buildTelemetry = buildDir ? await readJsonIfExists(join(buildDir, "telemetry.json")) : null;
  if (buildTelemetry) {
    summary.artifactPaths.build_telemetry = join(buildDir, "telemetry.json");
    summary.solverDecisions = summarizeSolverDecisions(buildTelemetry.data?.solverDecisions) || "none recorded";
  }
  return summary;
}

export async function validateRunDryRun(args) {
  const simConfigPath = resolvePath(args["sim-config"]);
  const initialStatePath = resolvePath(args["initial-state"]);
  const executionPolicyPath = resolvePath(args["execution-policy"]);
  const actionsPath = resolvePath(args.actions);
  const affinityPresetsPath = resolvePath(args["affinity-presets"]);
  const affinityLoadoutsPath = resolvePath(args["affinity-loadouts"]);
  const affinitySummaryArg = args["affinity-summary"];
  const ticks = args.ticks !== undefined ? Number(args.ticks) : DEFAULT_TICKS;
  const seed = args.seed !== undefined ? Number(args.seed) : 0;

  if (!simConfigPath || !initialStatePath) {
    throw new Error("run requires --sim-config and --initial-state.");
  }
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new Error("run requires a valid --ticks value.");
  }
  const worldStateCheckpoints = normalizeWorldStateCheckpoints(args["world-state-checkpoints"], { ticks });
  if (!Number.isFinite(seed)) {
    throw new Error("run requires a valid --seed value.");
  }

  const simConfig = await readJson(simConfigPath);
  assertSchema(simConfig, SCHEMAS.simConfig);
  const initialState = await readJson(initialStatePath);
  assertSchema(initialState, SCHEMAS.initialState);
  const runId = args["run-id"]
    || simConfig?.meta?.runId
    || initialState?.meta?.runId
    || makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("run", runId);

  if (executionPolicyPath) {
    const executionPolicy = await readJson(executionPolicyPath);
    assertSchema(executionPolicy, SCHEMAS.executionPolicy);
  }

  const wantsAffinitySummary = affinitySummaryArg !== undefined || (affinityPresetsPath && affinityLoadoutsPath);
  if (wantsAffinitySummary && (!affinityPresetsPath || !affinityLoadoutsPath)) {
    throw new Error("Affinity summary requires --affinity-presets and --affinity-loadouts.");
  }
  if (affinityPresetsPath) {
    const affinityPresets = await readJson(affinityPresetsPath);
    assertSchema(affinityPresets, SCHEMAS.affinityPreset, AFFINITY_PRESET_SCHEMA_VERSIONS);
  }
  if (affinityLoadoutsPath) {
    const affinityLoadouts = await readJson(affinityLoadoutsPath);
    assertSchema(affinityLoadouts, SCHEMAS.actorLoadout);
  }

  if (actionsPath) {
    const actionLog = await readJson(actionsPath);
    if (!Array.isArray(actionLog.actions)) {
      throw new Error("actions file must include an actions array.");
    }
  }

  const actorSpecs = normalizeArgList(args.actor);
  const vitalSpecs = normalizeArgList(args.vital);
  const vitalDefaultSpecs = normalizeArgList(args["vital-default"]);
  const tileWalls = normalizeArgList(args["tile-wall"]);
  const tileBarriers = normalizeArgList(args["tile-barrier"]);
  const tileFloors = normalizeArgList(args["tile-floor"]);
  const vitalDefaults = resolveVitalDefaults(vitalDefaultSpecs);
  const barrierSpecs = barrierSpecsFromTileOverrides(tileBarriers);

  const resolvedSimConfig = JSON.parse(JSON.stringify(simConfig));
  const resolvedInitialState = JSON.parse(JSON.stringify(initialState));
  applyTileOverrides(resolvedSimConfig, {
    walls: tileWalls,
    floors: tileFloors,
  });
  applyActorOverrides(resolvedInitialState, resolvedSimConfig, {
    actorSpecs: [...actorSpecs, ...barrierSpecs],
    vitalSpecs,
    vitalDefaults,
  });

  return buildDryRunSuccess({
    command: "run",
    runId,
    outDir,
    actorIds: deriveActorIds(resolvedInitialState),
    roomIds: deriveRoomIds(resolvedSimConfig),
    extra: {
      ticks,
      worldStateCheckpoints,
    },
  });
}
