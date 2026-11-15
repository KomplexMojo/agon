/**
 * `agon run`, `replay`, `inspect`, `narrate`, `tick`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRunDir as resolveTickRunDir, readMaxTick, readCursor, writeCursor, renderAscii, readTickFrame, buildVisualizationSnapshot, validateVisualizationMode } from "../../tick-session.mjs";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { SCHEMAS, assertSchema, buildDryRunFailure, commandKernel, createMeta, defaultOutDir, emitJsonStdout, isNonEmptyString, makeId, readJson, readJsonIfExists, resolvePath, toRef, usage, writeJson } from "./shared.mjs";
import { resolveFromRunArtifactPaths, summarizeInspectOutput, summarizeRunOutput, validateRunDryRun } from "./run-shared.mjs";

async function resolveRunInputArgs(args, { commandName }) {
  const fromRunId = args["from-run"];
  if (!isNonEmptyString(fromRunId)) {
    return { ...args };
  }
  if (args["sim-config"] || args["initial-state"]) {
    throw new Error(`${commandName} does not allow --from-run together with --sim-config or --initial-state.`);
  }
  const resolved = await resolveFromRunArtifactPaths(fromRunId);
  return {
    ...args,
    "sim-config": resolved.simConfigPath,
    "initial-state": resolved.initialStatePath,
  };
}

function emitJsonStderr(payload) {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

async function summarizeNarrateOutput({ outDir } = {}) {
  const narrative = await readJsonIfExists(join(outDir, "narrative.json"));
  return {
    ok: true,
    command: "narrate",
    runId: narrative?.meta?.runId || "",
    outDir,
    actorIds: Array.isArray(narrative?.cast) ? narrative.cast.map((entry) => entry.id) : [],
    roomIds: [],
    artifactPaths: {
      narrative: join(outDir, "narrative.json"),
    },
    ticks: narrative?.source?.ticks ?? (Array.isArray(narrative?.turns) ? narrative.turns.length : undefined),
  };
}

function humanizeToken(value) {
  return String(value || "").replaceAll("_", " ").trim();
}

function formatNarrativeValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => formatNarrativeValue(entry)).join(", ");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

function formatNarrativeDetails(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  const entries = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${humanizeToken(key)}=${formatNarrativeValue(value)}`);
  return entries.length > 0 ? ` (${entries.join(", ")})` : "";
}

function buildNarrativeCast(initialState) {
  return Array.isArray(initialState?.actors)
    ? initialState.actors.map((actor) => ({
      id: actor.id,
      label: isNonEmptyString(actor?.archetype) ? `${actor.archetype} ${actor.id}` : actor.id,
      kind: actor.kind,
      archetype: actor.archetype,
    }))
    : [];
}

function buildNarrativeActorLabelLookup(cast) {
  return new Map(cast.map((entry) => [entry.id, entry.label]));
}

function getNarrativeActorLabel(actorId, actorLabels) {
  return actorLabels.get(actorId) || actorId || "system";
}

function describeNarrativeAction(action, actorLabels) {
  const subject = getNarrativeActorLabel(action?.actorId, actorLabels);
  return `${subject} chose ${humanizeToken(action?.kind || "action")}${formatNarrativeDetails(action?.params)}.`;
}

function describeNarrativePreCoreRejection(record, actorLabels) {
  const action = record?.action || {};
  const subject = getNarrativeActorLabel(action.actorId, actorLabels);
  const reason = isNonEmptyString(record?.reason) ? record.reason.trim() : "rejected before core execution";
  return `${subject} could not ${humanizeToken(action.kind || "act")}: ${reason}.`;
}

function describeNarrativeEvent(event, actorLabels) {
  const subject = getNarrativeActorLabel(event?.actorId, actorLabels);
  if (event?.kind === "action_applied" && isNonEmptyString(event?.data?.action)) {
    return `${subject} completed ${humanizeToken(event.data.action)}.`;
  }
  if (event?.kind === "actor_moved") {
    const destination = event?.data?.to || event?.data?.position;
    if (destination && typeof destination === "object") {
      return `${subject} moved to ${formatNarrativeValue(destination)}.`;
    }
  }
  if (event?.kind === "actor_blocked") {
    return `${subject} was blocked${formatNarrativeDetails(event?.data)}.`;
  }
  if (event?.kind === "state_changed" && isNonEmptyString(event?.data?.state)) {
    return `${subject} changed state to ${event.data.state}.`;
  }
  return `${subject} triggered ${humanizeToken(event?.kind || "event")}${formatNarrativeDetails(event?.data)}.`;
}

function describeNarrativeEffect(effect) {
  const source = isNonEmptyString(effect?.personaRef) ? effect.personaRef : "runtime";
  return `${source} emitted ${humanizeToken(effect?.kind || "effect")}${formatNarrativeDetails(effect?.data)}.`;
}

function describeNarrativeFulfillment(record) {
  const kind = humanizeToken(record?.effect?.kind || "effect");
  const status = record?.status || "processed";
  const reason = isNonEmptyString(record?.reason) ? `: ${record.reason.trim()}` : "";
  const result = record?.result && typeof record.result === "object"
    ? ` ${formatNarrativeDetails(record.result).trim()}`
    : "";
  return `${kind} was ${status}${reason}${result}.`;
}

function buildNarrativeTurns(frames, actorLabels) {
  const grouped = new Map();
  for (const frame of frames) {
    const tick = Number.isFinite(frame?.tick) ? frame.tick : 0;
    if (!grouped.has(tick)) {
      grouped.set(tick, []);
    }
    grouped.get(tick).push(frame);
  }

  return Array.from(grouped.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([tick, tickFrames]) => {
      const lines = [];
      let actions = 0;
      let events = 0;
      let effects = 0;
      const phases = new Set();

      for (const frame of tickFrames) {
        phases.add(frame?.phaseDetail || frame?.phase || "unknown");

        for (const action of Array.isArray(frame?.acceptedActions) ? frame.acceptedActions : []) {
          actions += 1;
          lines.push(describeNarrativeAction(action, actorLabels));
        }
        for (const record of Array.isArray(frame?.preCoreRejections) ? frame.preCoreRejections : []) {
          actions += 1;
          lines.push(describeNarrativePreCoreRejection(record, actorLabels));
        }
        for (const event of Array.isArray(frame?.emittedEvents) ? frame.emittedEvents : []) {
          events += 1;
          lines.push(describeNarrativeEvent(event, actorLabels));
        }
        for (const effect of Array.isArray(frame?.emittedEffects) ? frame.emittedEffects : []) {
          effects += 1;
          lines.push(describeNarrativeEffect(effect));
        }
        for (const record of Array.isArray(frame?.fulfilledEffects) ? frame.fulfilledEffects : []) {
          effects += 1;
          lines.push(describeNarrativeFulfillment(record));
        }
      }

      const phaseSummary = Array.from(phases).join(", ");
      const summary = `Observed ${tickFrames.length} frame${tickFrames.length === 1 ? "" : "s"} during ${phaseSummary}; ${actions} action${actions === 1 ? "" : "s"}, ${events} event${events === 1 ? "" : "s"}, ${effects} effect${effects === 1 ? "" : "s"}.`;
      return {
        tick,
        title: `Turn ${tick}`,
        summary,
        lines: lines.length > 0 ? lines : ["No notable actions were recorded."],
        stats: {
          frames: tickFrames.length,
          actions,
          events,
          effects,
        },
      };
    });
}

function buildNarrativeStory(turns) {
  return turns.map((turn) => [
    `${turn.title}: ${turn.summary}`,
    ...turn.lines.map((line) => `- ${line}`),
  ].join("\n")).join("\n\n");
}

function createNarrativeArtifact({ initialState, frames, runId } = {}) {
  const cast = buildNarrativeCast(initialState);
  const actorLabels = buildNarrativeActorLabelLookup(cast);
  const turns = buildNarrativeTurns(frames, actorLabels);
  const story = buildNarrativeStory(turns);
  return {
    schema: SCHEMAS.narrative,
    schemaVersion: 1,
    meta: createMeta({ producedBy: "cli-narrate", runId }),
    source: {
      initialStateRef: toRef(initialState) || undefined,
      frames: frames.length,
      ticks: turns.length,
    },
    cast,
    summary: `Generated ${turns.length} turn${turns.length === 1 ? "" : "s"} from ${frames.length} tick frame${frames.length === 1 ? "" : "s"}.`,
    story,
    turns,
  };
}

export async function runCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const resolvedArgs = await resolveRunInputArgs(args, { commandName: "run" });
  if (args["dry-run"]) {
    try {
      emitJsonStdout(await validateRunDryRun(resolvedArgs));
    } catch (error) {
      emitJsonStdout(buildDryRunFailure({
        command: "run",
        runId: resolvedArgs["run-id"] || "",
        outDir: resolvePath(resolvedArgs["out-dir"]),
        error,
      }));
    }
    return;
  }
  const progressEnabled = args.progress === true;
  const kernelArgs = progressEnabled
    ? {
        ...resolvedArgs,
        log: () => {},
        onTickProgress: (payload) => emitJsonStderr(payload),
      }
    : resolvedArgs;
  const result = await commandKernel.run(kernelArgs);
  emitJsonStdout(await summarizeRunOutput({ outDir: result.outDir, args: resolvedArgs, pricingReport: result.pricingReport }));
}

export async function replayCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  await commandKernel.replay(args);
}

export async function inspectCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await commandKernel.inspect(args);
  const tickFramesPath = resolvePath(args["tick-frames"]);
  emitJsonStdout(await summarizeInspectOutput({
    outDir: result.outDir,
    runtimeBudgetReceiptPath: tickFramesPath ? join(dirname(tickFramesPath), "runtime-budget-receipt.json") : null,
    buildDir: resolvePath(args["build-dir"]),
  }));
}

export async function narrateCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const tickFramesPath = resolvePath(args["tick-frames"]);
  const initialStatePath = resolvePath(args["initial-state"]);
  if (!tickFramesPath || !initialStatePath) {
    throw new Error("narrate requires --tick-frames and --initial-state.");
  }

  const [frames, initialState] = await Promise.all([
    readJson(tickFramesPath),
    readJson(initialStatePath),
  ]);
  assertSchema(initialState, SCHEMAS.initialState);
  if (!Array.isArray(frames)) {
    throw new Error("narrate expects --tick-frames to contain a JSON array.");
  }
  frames.forEach((frame) => assertSchema(frame, SCHEMAS.tickFrame));

  const runId = initialState?.meta?.runId || frames[0]?.meta?.runId || makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("narrate", runId);
  const narrative = createNarrativeArtifact({ initialState, frames, runId });
  await writeJson(join(outDir, "narrative.json"), narrative);
  emitJsonStdout(await summarizeNarrateOutput({ outDir }));
}

export async function tickCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(usage());
    return;
  }

  const validSubcommands = ["forward", "backward", "state"];
  if (!validSubcommands.includes(subcommand)) {
    throw new Error(`Unknown tick subcommand: ${subcommand}. Expected: forward, backward, state`);
  }

  const args = parseArgs(rest);
  const runId = args["run-id"];
  if (!runId) {
    throw new Error("tick requires --run-id <id>");
  }

  const vizMode = args["visualization"];
  if (vizMode !== undefined) {
    const check = validateVisualizationMode(vizMode);
    if (!check.ok) {
      emitJsonStdout({ ok: false, command: "tick", action: subcommand, runId, error: check.error });
      process.exit(1);
    }
  }

  const runDir = resolveTickRunDir(runId);
  if (!existsSync(runDir)) {
    throw new Error(`run directory not found: ${runDir}`);
  }

  const maxTick = await readMaxTick(runDir);
  if (maxTick === null) {
    throw new Error(`run directory not found or missing tick-frames.json for run: ${runId}`);
  }

  const stored = await readCursor(runDir);
  const currentTick = stored !== null ? stored.tick : 0;

  if (subcommand === "forward") {
    if (currentTick >= maxTick) {
      emitJsonStdout({
        ok: false,
        command: "tick",
        action: "forward",
        runId,
        tick: currentTick,
        maxTick,
        error: `cannot advance past max tick ${maxTick}`,
      });
      process.exit(1);
    }
    const newTick = currentTick + 1;
    await writeCursor(runDir, runId, newTick, maxTick);
    const result = {
      ok: true,
      command: "tick",
      action: "forward",
      runId,
      previousTick: currentTick,
      tick: newTick,
      maxTick,
    };
    if (vizMode) {
      result.visualization = await buildVisualizationSnapshot(runDir, runId, newTick, vizMode);
    }
    emitJsonStdout(result);
    return;
  }

  if (subcommand === "backward") {
    if (currentTick <= 0) {
      emitJsonStdout({
        ok: false,
        command: "tick",
        action: "backward",
        runId,
        tick: 0,
        maxTick,
        error: "cannot rewind past tick 0",
      });
      process.exit(1);
    }
    const newTick = currentTick - 1;
    await writeCursor(runDir, runId, newTick, maxTick);
    const result = {
      ok: true,
      command: "tick",
      action: "backward",
      runId,
      previousTick: currentTick,
      tick: newTick,
      maxTick,
    };
    if (vizMode) {
      result.visualization = await buildVisualizationSnapshot(runDir, runId, newTick, vizMode);
    }
    emitJsonStdout(result);
    return;
  }

  // subcommand === "state"
  const [ascii, tickFrame] = await Promise.all([renderAscii(runDir, currentTick), readTickFrame(runDir, currentTick)]);
  const stateResult = {
    ok: true,
    command: "tick",
    action: "state",
    runId,
    tick: currentTick,
    maxTick,
    ascii,
    tickFrame,
  };
  if (vizMode) {
    stateResult.visualization = await buildVisualizationSnapshot(runDir, runId, currentTick, vizMode);
  }
  emitJsonStdout(stateResult);
}
