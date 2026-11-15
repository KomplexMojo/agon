/**
 * The command kernel's `inspect`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { summarizeRuntimeDecisions, summarizeRuntimeDecisionCaptures } from "../run-helpers.js";
import { SCHEMAS } from "./helpers.js";

export function createInspectCommands(ctx) {
  const { createMeta, defaultRunCommandOutDir, exists, join, log, makeId, readJson, resolvePath, warn, writeJson } = ctx;

  async function inspect(args) {
    const tickFramesPath = resolvePath(args["tick-frames"]);
    const effectsLogPath = resolvePath(args["effects-log"]);
    const outDirOverride = resolvePath(args["out-dir"]);

    let frames = [];
    const warnings = [];
    if (!tickFramesPath || !exists(tickFramesPath)) {
      warnings.push("missing_tick_frames");
      warn("inspect: missing --tick-frames (summary will be empty)");
    } else {
      frames = await readJson(tickFramesPath);
    }

    const phaseCounts = {};
    let totalEmitted = 0;
    let fulfilled = 0;
    let deferred = 0;
    let maxTick = 0;

    for (const frame of frames) {
      maxTick = Math.max(maxTick, frame.tick || 0);
      const phaseKey = frame.phaseDetail || frame.phase || "unknown";
      phaseCounts[phaseKey] = (phaseCounts[phaseKey] || 0) + 1;
      if (Array.isArray(frame.emittedEffects)) {
        totalEmitted += frame.emittedEffects.length;
      }
      if (Array.isArray(frame.fulfilledEffects)) {
        for (const record of frame.fulfilledEffects) {
          if (record.status === "fulfilled") {
            fulfilled += 1;
          } else if (record.status === "deferred") {
            deferred += 1;
          }
        }
      }
    }

    const runId = frames[0]?.meta?.runId || makeId("run");
    const outDir = outDirOverride || defaultRunCommandOutDir("inspect", runId);
    const effectsLog = effectsLogPath ? await readJson(effectsLogPath) : null;
    const summary = {
      schema: SCHEMAS.telemetry,
      schemaVersion: 1,
      meta: createMeta({ producedBy: "cli-inspect", runId }),
      scope: "run",
      data: {
        frames: frames.length,
        ticks: maxTick,
        phaseCounts,
        effects: {
          emitted: totalEmitted,
          fulfilled,
          deferred,
          logEntries: Array.isArray(effectsLog) ? effectsLog.length : 0,
        },
        runtimeDecisions: summarizeRuntimeDecisions(frames),
        runtimeDecisionCaptures: summarizeRuntimeDecisionCaptures(frames),
        warnings,
      },
    };

    await writeJson(join(outDir, "inspect-summary.json"), summary);
    log(`inspect: wrote ${outDir}`);
    return { outDir };
  }

  return { inspect };
}
