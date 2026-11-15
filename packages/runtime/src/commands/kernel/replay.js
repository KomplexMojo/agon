/**
 * The command kernel's `replay`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { createRuntime } from "../../runner/runtime.js";
import { compareFrameSummaries, compareRuntimeDecisionCaptureSummaries, compareRuntimeDecisionSummaries, createDeterministicClock, resolveClockSeed, summarizeFrame } from "../run-helpers.js";
import { SCHEMAS, assertSchema, createCommandRuntimeCore } from "./helpers.js";

export function createReplayCommands(ctx) {
  const { defaultRunCommandOutDir, join, log, makeId, readJson, resolvePath, writeJson } = ctx;

  async function replay(args) {
    const simConfigPath = resolvePath(args["sim-config"]);
    const initialStatePath = resolvePath(args["initial-state"]);
    const executionPolicyPath = resolvePath(args["execution-policy"]);
    const tickFramesPath = resolvePath(args["tick-frames"]);
    const runId = makeId("replay");
    const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("replay", runId);
    const seed = args.seed !== undefined ? Number(args.seed) : 0;

    if (!simConfigPath || !initialStatePath || !tickFramesPath) {
      throw new Error("replay requires --sim-config, --initial-state, and --tick-frames.");
    }
    if (!Number.isFinite(seed)) {
      throw new Error("replay requires a valid --seed value.");
    }
    const simConfig = await readJson(simConfigPath);
    assertSchema(simConfig, SCHEMAS.simConfig);
    const initialState = await readJson(initialStatePath);
    assertSchema(initialState, SCHEMAS.initialState);
    if (executionPolicyPath) {
      const executionPolicy = await readJson(executionPolicyPath);
      assertSchema(executionPolicy, SCHEMAS.executionPolicy);
    }

    const expectedFrames = await readJson(tickFramesPath);
    const expectedSummaries = expectedFrames.map(summarizeFrame);
    const ticks = args.ticks !== undefined
      ? Number(args.ticks)
      : Math.max(0, ...expectedSummaries.map((frame) => frame.tick));
    if (!Number.isFinite(ticks) || ticks < 0) {
      throw new Error("replay requires a valid --ticks value.");
    }

    const clock = createDeterministicClock(resolveClockSeed(simConfig, initialState));
    const core = createCommandRuntimeCore();
    const runtime = createRuntime({ core, adapters: {}, runId, clock });
    await runtime.init({ seed, simConfig, initialState, clock });
    for (let i = 0; i < ticks; i += 1) {
      await runtime.step();
    }

    const actualFrames = runtime.getTickFrames();
    const actualSummaries = actualFrames.map(summarizeFrame);
    const frameComparison = compareFrameSummaries(expectedSummaries, actualSummaries);
    const runtimeDecisionComparison = compareRuntimeDecisionSummaries(expectedFrames, actualFrames);
    const runtimeDecisionCaptureComparison = compareRuntimeDecisionCaptureSummaries(expectedFrames, actualFrames);

    const summary = {
      match: frameComparison.match && runtimeDecisionComparison.match && runtimeDecisionCaptureComparison.match,
      expectedFrames: frameComparison.expectedFrames,
      actualFrames: frameComparison.actualFrames,
      mismatches: frameComparison.mismatches,
      firstMismatch: frameComparison.firstMismatch,
      runtimeDecisions: runtimeDecisionComparison,
      runtimeDecisionCaptures: runtimeDecisionCaptureComparison,
    };

    await writeJson(join(outDir, "replay-summary.json"), summary);
    await writeJson(join(outDir, "replay-tick-frames.json"), actualFrames);

    log(`replay: wrote ${outDir}`);
    return { outDir };
  }

  return { replay };
}
