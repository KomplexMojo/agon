/**
 * The command kernel's `run` and `manualMove`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { UNUSED_CLOCK } from "../../personas/_shared/require-clock.js";
import { buildManualMoveAction } from "../manual-movement.js";
import { createAllocatorPersona } from "../../personas/allocator/persona.js";
import { createConfiguratorPersona } from "../../personas/configurator/persona.js";
import { createRuntime } from "../../runner/runtime.js";
import { applyActorOverrides, applyHeadlessDelverAutonomy, applyTileOverrides, barrierSpecsFromTileOverrides, baseVitalsFromActors, createDeterministicClock, summarizeRuntimeDecisionCaptures, normalizeArgList, resolveClockSeed, resolveVitalDefaults } from "../run-helpers.js";
// M9: the SCHEMAS alias table below, and the two ActionSequence sites M8 relocated, all
// read from contracts/artifacts.ts. The table stays — short keys are what this file's call
// sites use — but its VALUES have one origin now instead of eighteen.
import { ACTION_SEQUENCE_SCHEMA, AFFINITY_PRESET_SCHEMA_VERSIONS } from "../../contracts/artifacts.ts";
import { SCHEMAS, assertSchema, buildAffinityEffectsFromInitialState, createCommandRuntimeCore, normalizeWorldStateCheckpoints, resolveAffinityEffects, worldStateCheckpointFilename } from "./helpers.js";

export function createRunCommands(ctx) {
  const { createMeta, defaultRunCommandOutDir, dirname, exists, join, log, makeId, readJson, resolvePath, toRef, writeJson } = ctx;

  async function run(args) {
    const commandLog = typeof args?.log === "function" ? args.log : log;
    const onTickProgress = typeof args?.onTickProgress === "function" ? args.onTickProgress : null;
    const simConfigPath = resolvePath(args["sim-config"]);
    const initialStatePath = resolvePath(args["initial-state"]);
    const executionPolicyPath = resolvePath(args["execution-policy"]);
    const actionsPath = resolvePath(args.actions);
    const affinityPresetsPath = resolvePath(args["affinity-presets"]);
    const affinityLoadoutsPath = resolvePath(args["affinity-loadouts"]);
    const affinitySummaryArg = args["affinity-summary"];
    const ticks = args.ticks !== undefined ? Number(args.ticks) : 1;
    const seed = args.seed !== undefined ? Number(args.seed) : 0;

    if (!simConfigPath || !initialStatePath) {
      throw new Error("run requires --sim-config and --initial-state.");
    }
    if (!Number.isFinite(ticks) || ticks < 0) {
      throw new Error("run requires a valid --ticks value.");
    }
    if (!Number.isFinite(seed)) {
      throw new Error("run requires a valid --seed value.");
    }
    const worldStateCheckpoints = normalizeWorldStateCheckpoints(args["world-state-checkpoints"], { ticks });
    const pendingWorldStateCheckpoints = new Set(worldStateCheckpoints);
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

    let affinityPresets = null;
    let affinityLoadouts = null;
    const wantsAffinitySummary = affinitySummaryArg !== undefined || (affinityPresetsPath && affinityLoadoutsPath);
    if (wantsAffinitySummary && (!affinityPresetsPath || !affinityLoadoutsPath)) {
      throw new Error("Affinity summary requires --affinity-presets and --affinity-loadouts.");
    }
    if (affinityPresetsPath) {
      affinityPresets = await readJson(affinityPresetsPath);
      assertSchema(affinityPresets, SCHEMAS.affinityPreset, AFFINITY_PRESET_SCHEMA_VERSIONS);
    }
    if (affinityLoadoutsPath) {
      affinityLoadouts = await readJson(affinityLoadoutsPath);
      assertSchema(affinityLoadouts, SCHEMAS.actorLoadout);
    }

    // #149 — action-log.json/run-summary.json/world-state.json used to stamp meta.id/createdAt via
    // createMeta()'s wall-clock (Date.now()/Math.random()), while every other artifact this command
    // writes (tick-frames.json, effects-log.json, runtime-decision-captures.json) is timestamped by
    // this same seeded clock. Two runs of byte-identical input then produced byte-identical
    // simulation output but different meta stamps on these three files, breaking reproducibility the
    // simulation itself already has. Constructed here (moved up from below) so it can seed all three.
    const clock = createDeterministicClock(resolveClockSeed(simConfig, initialState));
    function deterministicRunArtifactMeta(tag, producedBy, { note, stampClock = clock } = {}) {
      return {
        id: `artifact_${runId}_${tag}`,
        runId,
        createdAt: stampClock(),
        producedBy,
        correlationId: undefined,
        note,
      };
    }

    let actionLog = null;
    if (actionsPath) {
      actionLog = await readJson(actionsPath);
      if (!Array.isArray(actionLog.actions)) {
        throw new Error("actions file must include an actions array.");
      }
      actionLog.schema = actionLog.schema || ACTION_SEQUENCE_SCHEMA;
      actionLog.schemaVersion = actionLog.schemaVersion || 1;
      actionLog.meta = actionLog.meta || deterministicRunArtifactMeta("actionlog", "cli-run");
      actionLog.simConfigRef = actionLog.simConfigRef || toRef(simConfig);
      actionLog.initialStateRef = actionLog.initialStateRef || toRef(initialState);
    } else {
      actionLog = {
        schema: ACTION_SEQUENCE_SCHEMA,
        schemaVersion: 1,
        meta: deterministicRunArtifactMeta("actionlog", "cli-run"),
        simConfigRef: toRef(simConfig),
        initialStateRef: toRef(initialState),
        actions: [],
      };
    }

    const actorSpecs = normalizeArgList(args.actor);
    const vitalSpecs = normalizeArgList(args.vital);
    const vitalDefaultSpecs = normalizeArgList(args["vital-default"]);
    const tileWalls = normalizeArgList(args["tile-wall"]);
    const tileBarriers = normalizeArgList(args["tile-barrier"]);
    const tileFloors = normalizeArgList(args["tile-floor"]);
    const vitalDefaults = resolveVitalDefaults(vitalDefaultSpecs);
    const barrierSpecs = barrierSpecsFromTileOverrides(tileBarriers);

    const tileOverrideResult = applyTileOverrides(simConfig, {
      walls: tileWalls,
      floors: tileFloors,
    });
    const actorOverrideResult = applyActorOverrides(initialState, simConfig, {
      actorSpecs: [...actorSpecs, ...barrierSpecs],
      vitalSpecs,
      vitalDefaults,
    });
    const overridesApplied = tileOverrideResult.mutated || actorOverrideResult.mutated;
    // Headless default: delvers authored `user_controlled` get computer autonomy so the run
    // plays without a seated player. Opt out with --preserve-player-control; skipped when
    // --actions already scripts turns. Interactive play / play-session are unchanged.
    const headlessAutonomy = applyHeadlessDelverAutonomy(initialState, {
      preservePlayerControl: args["preserve-player-control"] === true,
      hasActions: Boolean(actionsPath),
    });
    if (headlessAutonomy.applied) {
      const ids = headlessAutonomy.remapped.map((entry) => entry.actorId).join(", ");
      commandLog(`run: headless delver autonomy for ${ids}`);
    }
    // #278: an overridden level is priced again by the Allocator, against the budget of the
    // receipt `agon create` wrote beside it. The run plays as overridden either way.
    let overridePricing = null;
    if (overridesApplied) {
      const levelDir = dirname(simConfigPath);
      const readJsonIfExists = async (path) => (await exists(path) ? readJson(path) : null);
      const levelReceipt = await readJsonIfExists(join(levelDir, "budget-receipt.json"));
      const ownReceipt = levelReceipt?.meta?.id && levelReceipt.meta.id === simConfig.budgetReceiptRef?.id ? levelReceipt : null;
      const levelPriceList = ownReceipt ? await readJsonIfExists(join(levelDir, "price-list.json")) : null;
      const pricingMeta = (prefix) => ({
        id: `${prefix}_${runId}_overrides`,
        runId,
        createdAt: simConfig.meta?.createdAt || initialState.meta?.createdAt,
        producedBy: "cli-run",
      });
      overridePricing = createAllocatorPersona({ clock: UNUSED_CLOCK }).priceLevelOverrides({
        simConfig,
        initialState,
        levelReceipt: ownReceipt,
        priceList: levelPriceList?.meta?.id && levelPriceList.meta.id === ownReceipt?.priceListRef?.id ? levelPriceList : undefined,
        budgetMeta: pricingMeta("budget"),
        proposalMeta: pricingMeta("spend_proposal"),
        receiptMeta: pricingMeta("budget_receipt"),
        normalizeMotivations: createConfiguratorPersona({ clock: UNUSED_CLOCK }).normalizeMotivations,
      });
      simConfig.budgetReceiptRef = toRef(overridePricing.receipt);
      overridePricing.report.forEach(({ message }) => commandLog(`run: ${message}`));
    }

    const affinitySummaryPath = wantsAffinitySummary
      ? (typeof affinitySummaryArg === "string" ? resolvePath(affinitySummaryArg) : join(outDir, "affinity-summary.json"))
      : null;
    let affinitySummary = null;
    if (wantsAffinitySummary) {
      const resolved = resolveAffinityEffects({
        presets: affinityPresets?.presets,
        loadouts: affinityLoadouts?.loadouts,
        baseVitalsByActorId: baseVitalsFromActors(initialState?.actors),
        hazards: [],
      });
      affinitySummary = {
        schema: SCHEMAS.affinitySummary,
        schemaVersion: 2,
        // #150 — same wall-clock non-determinism #149 fixed for action-log/run-summary/world-state;
        // confirmed here via a two-run diff (see the fix commit) since no test previously exercised
        // this artifact at all, wantsAffinitySummary being a rarer flag combination.
        meta: deterministicRunArtifactMeta("affinitysummary", "cli-run"),
        presetsRef: toRef(affinityPresets),
        loadoutsRef: toRef(affinityLoadouts),
        simConfigRef: toRef(simConfig),
        initialStateRef: toRef(initialState),
        actors: resolved.actors,
        hazards: resolved.hazards,
      };
    }

    const core = createCommandRuntimeCore();
    const runtime = createRuntime({ core, adapters: {}, runId, clock });
    // AM.5/F13 — an actor's affinities must reach the OBSERVATION, or the Actor
    // persona cannot see what it holds and never expresses it. The observation's
    // affinity list is built from this payload (core-ts mvp-movement
    // buildAffinitiesAndAbilities); `run` passed nothing, so every actor looked
    // affinity-less to the persona that decides what to do with one.
    const affinityEffects = buildAffinityEffectsFromInitialState(initialState);
    await runtime.init({ seed, simConfig, initialState, clock, affinityEffects });

    const simConfigRef = toRef(simConfig);
    // #189 — checkpoints get the same seeded stamps as every other run artifact, from a
    // clock of their own: `clock` times every tick frame, so drawing from it here would
    // make requesting checkpoints shift the timestamps of everything else the run writes.
    const checkpointClock = createDeterministicClock(resolveClockSeed(simConfig, initialState));
    async function captureWorldStateCheckpoint(expectedTick) {
      if (!pendingWorldStateCheckpoints.has(expectedTick)) return;
      const checkpoint = runtime.captureWorldState({
        meta: deterministicRunArtifactMeta(
          `worldstate_${worldStateCheckpointFilename(expectedTick).replace(/\.json$/, "")}`,
          "annotator",
          { note: `world-state checkpoint at tick ${expectedTick}`, stampClock: checkpointClock },
        ),
        simConfigRef,
      });
      if (checkpoint.tick !== expectedTick) {
        throw new Error(
          `World-state checkpoint boundary mismatch: requested tick ${expectedTick}, captured ${checkpoint.tick}.`,
        );
      }
      await writeJson(
        join(outDir, "world-state-checkpoints", worldStateCheckpointFilename(expectedTick)),
        checkpoint,
      );
      pendingWorldStateCheckpoints.delete(expectedTick);
    }

    await captureWorldStateCheckpoint(0);
    for (let i = 0; i < ticks; i += 1) {
      const effectCountBeforeStep = runtime.getEffectLog().length;
      await runtime.step();
      await captureWorldStateCheckpoint(i + 1);
      if (onTickProgress) {
        const effectCountAfterStep = runtime.getEffectLog().length;
        await onTickProgress({
          progress: true,
          tick: i + 1,
          phase: "emit",
          effectsEmitted: effectCountAfterStep - effectCountBeforeStep,
        });
      }
    }

    const tickFrames = runtime.getTickFrames();
    const effectLog = runtime.getEffectLog();
    const runtimeBudgetReceiptMeta = deterministicRunArtifactMeta("runtimebudgetreceipt", "allocator");
    const runtimeBudgetReceipt = runtime.issueRuntimeBudgetReceipt({
      meta: {
        id: runtimeBudgetReceiptMeta.id,
        runId: runtimeBudgetReceiptMeta.runId,
        createdAt: runtimeBudgetReceiptMeta.createdAt,
        producedBy: runtimeBudgetReceiptMeta.producedBy,
      },
    });
    const runtimeDecisionCaptures = summarizeRuntimeDecisionCaptures(tickFrames).captures;
    // P3.2: the Annotator owns the run summary (artifacts.ts: "Run-level summary
    // emitted by Annotator at end of run"). It derives a REAL outcome from the
    // collected frames/effects — this was hardcoded "unknown" on every run before.
    // CR.8: this used to be `createAnnotatorPersona({ clock: UNUSED_CLOCK }).summarizeRun(...)`
    // — a fresh, idle instance minted purely to sign the artifact, while the Annotator that
    // recorded every tick frame was discarded. The runtime now delegates to that real
    // instance, which refuses to summarize a run it did not observe.
    const runSummary = runtime.summarizeRun({
      tickFrames,
      effectLog,
      ticksRequested: ticks,
      meta: deterministicRunArtifactMeta("runsummary", "annotator"),
      simConfigRef: toRef(simConfig),
    });

    // P5.5 — the chartered post-run step, after the run and after the summary: effects the
    // run could not satisfy deterministically are coordinated by the Orchestrator, and what
    // came back is captured for future deterministic runs. Before this they were marked
    // `deferred`, counted by `agon inspect`, and dropped.
    //
    // Written only when there was something to coordinate. `null` means the run deferred
    // nothing, and a file recording an empty settlement would read as "all coordinated" —
    // the same conflation the round itself refuses.
    const deferredCoordination = runtime.coordinateDeferredEffects({
      meta: createMeta({ producedBy: "orchestrator", runId }),
    });

    // AM.0b — what the world looked like when the run ended (closes F11).
    //
    // Every other output below records a DECISION. Without this one, nothing on
    // disk says where anything ended up, so no CLI or MCP caller — and no test
    // at this seam — can tell a run in which every actor moved from one in which
    // core refused every move. The Annotator derives it; this writes it, through
    // the injected host `writeJson` like every other artifact, so the runtime
    // still performs no IO of its own.
    const worldState = runtime.captureWorldState({
      meta: deterministicRunArtifactMeta("worldstate", "annotator"),
      simConfigRef,
    });
    await writeJson(join(outDir, "world-state.json"), worldState);

    await writeJson(join(outDir, "tick-frames.json"), tickFrames);
    await writeJson(join(outDir, "effects-log.json"), effectLog);
    await writeJson(join(outDir, "runtime-budget-receipt.json"), runtimeBudgetReceipt);
    await writeJson(join(outDir, "runtime-decision-captures.json"), runtimeDecisionCaptures);
    if (deferredCoordination) {
      await writeJson(join(outDir, "deferred-coordination.json"), deferredCoordination);
    }
    await writeJson(join(outDir, "run-summary.json"), runSummary);
    await writeJson(join(outDir, "action-log.json"), actionLog);
    if (affinitySummary && affinitySummaryPath) {
      await writeJson(affinitySummaryPath, affinitySummary);
    }
    if (overridesApplied || headlessAutonomy.applied) {
      await writeJson(join(outDir, "resolved-initial-state.json"), initialState);
    }
    if (overridesApplied) {
      await writeJson(join(outDir, "resolved-sim-config.json"), simConfig);
      await writeJson(join(outDir, "price-list.json"), overridePricing.priceList);
      await writeJson(join(outDir, "budget-receipt.json"), overridePricing.receipt);
    }

    if (onTickProgress) {
      await onTickProgress({
        progress: true,
        done: true,
        totalTicks: ticks,
      });
    }

    commandLog(`run: wrote ${outDir}`);
    return {
      outDir,
      runtimeBudgetReceipt,
      ...(overridePricing ? { pricingReport: overridePricing.report } : {}),
      ...(headlessAutonomy.applied ? { headlessDelverAutonomy: headlessAutonomy.remapped } : {}),
    };
  }
  async function manualMove(args = {}) {
    return buildManualMoveAction({
      action: args.action,
      actorId: args.actorId,
      viewerActorId: args.viewerActorId,
      observation: args.observation,
      controllableActorIds: args.controllableActorIds,
    });
  }

  return { run, manualMove };
}
