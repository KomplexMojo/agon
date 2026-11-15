/**
 * `agon play`, `play-session`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchCommand, playAsciiInteractive, playAsciiScripted, playSessionScripted, watchAsciiInteractive, watchAsciiScripted } from "../play-ascii.mjs";
import { resolveRunDir as resolveTickRunDir } from "../../tick-session.mjs";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { emitJsonStdout, isNonEmptyString, parseActorStrategy, parsePositiveIntStrict, resolvePath, usage } from "./shared.mjs";
import { resolveFromRunArtifactPaths } from "./run-shared.mjs";

/**
 * `--keys` (terminal characters) followed by `--logical-keys` (a JSON array of key names such as
 * ["ArrowUp","Enter","Escape","d"]) as one terminal key string (#811).
 */
async function resolveKeys(args) {
  const keys = args.keys === true ? "" : args.keys;
  if (args["logical-keys"] === undefined) return keys;
  let names;
  try { names = JSON.parse(args["logical-keys"]); } catch { names = null; }
  if (!Array.isArray(names)) throw new Error("--logical-keys needs a JSON array of key names.");
  const { terminalKeysForLogicalKeys } = await import("../../../../ui-ascii/src/keymap.js");
  return (keys ?? "") + terminalKeysForLogicalKeys(names);
}

/**
 * `agon play`: the level a create/run produced, in the terminal UI. Which level
 * is the only thing decided here; the UI program does the rest.
 */
export async function playCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const allowed = new Set(["_", "dir", "from-run", "sim-config", "initial-state", "level", "keys", "logical-keys", "json", "color", "no-color", "no-fog", "record", "replay", "watch", "tick", "realtime", "web", "port", "lan", "debug"]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`play does not support: ${unknown.map((key) => `--${key}`).join(", ")}`);
  if (args.watch) {
    await watchRunCommand(args);
    return;
  }
  if (args.tick !== undefined) throw new Error("play --tick needs --watch.");
  const source = await resolvePlaySource(args);

  const color = args["no-color"] ? false : args.color ? true : undefined;
  const fog = !args["no-fog"];
  // parseArgs reads a bare `--keys ""` as a flag.
  const keys = await resolveKeys(args);
  // #204: record the played commands, or re-run a recorded game first.
  const capture = {
    recordPath: isNonEmptyString(args.record) ? resolvePath(args.record) : undefined,
    replayPath: isNonEmptyString(args.replay) ? resolvePath(args.replay) : undefined,
  };
  if ((args.record !== undefined && !capture.recordPath) || (args.replay !== undefined && !capture.replayPath)) {
    throw new Error("play --record and --replay each need a file path.");
  }
  // #291: real time is for a person at the keyboard, so only interactive play takes it.
  if (args.realtime !== undefined && (keys !== undefined || args.json)) {
    throw new Error("play --realtime is for interactive play; drop --keys/--json.");
  }
  if (args.web && (keys !== undefined || args.json)) throw new Error("play --web is for play in a browser; drop --keys/--json.");
  if ((args.port !== undefined || args.lan || args.debug) && !args.web) throw new Error("play --port, --lan and --debug need --web.");
  if (keys === undefined && !args.json) {
    process.exitCode = await playAsciiInteractive({ source, color, fog, realtime: args.realtime, web: Boolean(args.web), port: args.port, lan: Boolean(args.lan), debug: Boolean(args.debug), ...capture });
    return;
  }
  const result = playAsciiScripted({ source, keys: keys ?? "", color: color === true, fog, ...capture });
  if (!result.ok) throw new Error(result.error);
  if (args.json) {
    emitJsonStdout({ ...result, command: "play", source, launch: launchCommand(source) });
  } else {
    for (const warning of result.warnings || []) console.error(`warning: ${warning}`);
    console.log(result.screen);
  }
}

/** The level `play` and `play-session start` name: one of --dir, --from-run, --sim-config/--initial-state, --level. */
async function resolvePlaySource(args, command = "play") {
  const named = ["dir", "from-run", "level"].filter((key) => args[key] !== undefined);
  if (args["sim-config"] !== undefined || args["initial-state"] !== undefined) named.push("sim-config");
  if (named.length > 1) throw new Error(`${command} takes one level source: --dir, --from-run, --sim-config/--initial-state, or --level.`);
  if (isNonEmptyString(args.dir)) return { dir: resolvePath(args.dir) };
  if (args["from-run"] !== undefined) {
    const resolved = await resolveFromRunArtifactPaths(args["from-run"]);
    return { simConfigPath: resolved.simConfigPath, initialStatePath: resolved.initialStatePath };
  }
  if (args["sim-config"] !== undefined || args["initial-state"] !== undefined) {
    if (!isNonEmptyString(args["sim-config"]) || !isNonEmptyString(args["initial-state"])) {
      throw new Error(`${command} needs --sim-config and --initial-state together.`);
    }
    return { simConfigPath: resolvePath(args["sim-config"]), initialStatePath: resolvePath(args["initial-state"]) };
  }
  return isNonEmptyString(args.level) ? { level: args.level } : {};
}

export const PLAY_SESSIONS_DIR = "artifacts/play-sessions";
const PLAY_SESSION_ACTIONS = new Set(["start", "act", "view", "legal", "switch", "order", "advance", "tick", "end"]);

/**
 * `agon play-session`: a game that lasts across calls, for a caller that is not at a
 * terminal (the MCP tools). The game lives in artifacts/play-sessions/<name>.json as a
 * player capture, so it survives a restart and replays exactly; each call re-runs it,
 * applies this call's seat change, commands and keys, and saves it again. The UI
 * program does the playing; this only names the file and the level.
 *   start   a new game on a level          act     commands and/or keys
 *   view    the board, nothing played      switch  seat another party member (free)
 *   legal   like view; read `legal`, the commands the seat can try now (#653)
 *   order   give --actor a new --strategy (a turn)
 *   advance let the world run --ticks n, or --until orders_done|contact
 *   tick    one tick commanding several ai_controlled actors: --actor-commands '{"W1":{...},"H2":{...}}' (#680)
 *   end     the final board; removes the file
 * `--save <path>` copies the game out after any call; `start --load <path>` begins from such a copy.
 * It also writes artifacts/play-sessions/hud.txt, one line about the seated actor,
 * for a status line to show. AGON_PLAY_SESSIONS_DIR moves both.
 */
export async function playSessionCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const action = args._[0];
  if (!PLAY_SESSION_ACTIONS.has(action)) {
    throw new Error(`play-session needs an action: ${[...PLAY_SESSION_ACTIONS].join(", ")}.`);
  }
  const allowed = new Set(["_", "session", "dir", "from-run", "sim-config", "initial-state", "level", "keys", "logical-keys", "commands", "actor", "json", "color", "no-fog", "save", "load", "strategy", "ticks", "until", "actor-commands"]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`play-session does not support: ${unknown.map((key) => `--${key}`).join(", ")}`);
  const name = args.session === undefined ? "game" : String(args.session);
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) {
    throw new Error(`play-session --session must be a plain name (letters, digits, - _ .), got ${name}`);
  }
  // AGON_PLAY_SESSIONS_DIR moves the saves (tests keep theirs apart with it).
  const sessionsDir = resolvePath(process.env.AGON_PLAY_SESSIONS_DIR || PLAY_SESSIONS_DIR);
  const sessionPath = join(sessionsDir, `${name}.json`);
  const exists = existsSync(sessionPath);
  const levelNamed = ["dir", "from-run", "sim-config", "initial-state", "level"].some((key) => args[key] !== undefined);
  if (action === "start" && exists) throw new Error(`play-session "${name}" is already running; act on it, or end it first.`);
  if (action !== "start" && !exists) throw new Error(`No play-session "${name}"; start one with play-session start.`);
  if (action !== "start" && levelNamed) throw new Error(`play-session ${action} continues "${name}" on its own level; level options go with start.`);
  if ((action === "view" || action === "legal" || action === "end") && (args.keys !== undefined || args.commands !== undefined || args.actor !== undefined)) {
    throw new Error(`play-session ${action} plays nothing; use act (or switch) for keys, commands and --actor.`);
  }
  if (action === "switch" && args.actor === undefined) throw new Error("play-session switch needs --actor <id or label>.");
  if (action === "order" && (args.actor === undefined || args.strategy === undefined)) {
    throw new Error("play-session order needs --actor <id or label> and --strategy <goals, JSON or a .json file>.");
  }
  if (action === "tick" && (args["actor-commands"] === undefined || args.commands !== undefined || args.keys !== undefined || args.actor !== undefined)) {
    throw new Error("play-session tick needs --actor-commands <JSON object of { actorId: command }> and takes no --commands, --keys or --actor.");
  }
  if (args["actor-commands"] !== undefined && action !== "tick") throw new Error("play-session --actor-commands goes with tick.");
  if (args.strategy !== undefined && action !== "order") throw new Error("play-session --strategy goes with order.");
  if ((args.ticks !== undefined || args.until !== undefined) && action !== "advance") {
    throw new Error("play-session --ticks and --until go with advance.");
  }
  if (args.load !== undefined && (action !== "start" || levelNamed)) {
    throw new Error("play-session --load goes with start, in place of a level: the saved game names its own level.");
  }
  if (args.save !== undefined && !isNonEmptyString(args.save)) throw new Error("play-session --save needs a file path.");

  let commands;
  if (args.commands !== undefined) {
    try {
      commands = JSON.parse(String(args.commands));
    } catch {
      throw new Error("play-session --commands needs a JSON array.");
    }
    if (!Array.isArray(commands)) throw new Error("play-session --commands needs a JSON array.");
  }
  let actor = Array.isArray(args.actor) ? args.actor.at(-1) : args.actor;
  const keys = await resolveKeys(args);
  // An order and an advance are structured commands the game plays; the order's --actor
  // names who takes it, not a seat change.
  if (action === "order") {
    commands = [{ kind: "order", actorId: String(actor), strategy: parseActorStrategy(String(args.strategy), "order", 1) }];
    actor = undefined;
  }
  if (action === "tick") {
    let actorCommands;
    try {
      actorCommands = JSON.parse(String(args["actor-commands"]));
    } catch {
      throw new Error("play-session --actor-commands needs a JSON object of { actorId: command }.");
    }
    if (!actorCommands || typeof actorCommands !== "object" || Array.isArray(actorCommands) || Object.keys(actorCommands).length === 0) {
      throw new Error("play-session --actor-commands needs a JSON object of { actorId: command } with at least one entry.");
    }
    commands = [{ kind: "tick", actorCommands }];
  }
  if (action === "advance") {
    const ticks = args.ticks === undefined ? (args.until === undefined ? 1 : 50) : parsePositiveIntStrict(args.ticks, "play-session --ticks");
    commands = [...(commands ?? []), { kind: "advance", ticks, ...(args.until === undefined ? {} : { until: String(args.until) }) }];
  }
  const source = action === "start" && args.load === undefined ? await resolvePlaySource(args, "play-session start") : {};
  await mkdir(sessionsDir, { recursive: true });
  if (args.load !== undefined) {
    // A saved game: a session save, or any player capture that names its level.
    const loadPath = resolvePath(String(args.load));
    const saved = JSON.parse(readFileSync(loadPath, "utf8"));
    const request = saved?.source?.request;
    if (!request?.source && !request?.level) {
      throw new Error(`${args.load} does not say which level it was played on; start on that level and play it again.`);
    }
    copyFileSync(loadPath, sessionPath);
  }
  const result = playSessionScripted({
    sessionPath, source, keys: keys ?? "", commands, actor, color: args.color === true, fog: !args["no-fog"],
  });
  if (!result.ok) throw new Error(result.error);
  if (result.hud) await writeFile(join(sessionsDir, "hud.txt"), `${result.hud}\n`);
  let saved;
  if (args.save !== undefined) {
    saved = resolvePath(String(args.save));
    await mkdir(dirname(saved), { recursive: true });
    copyFileSync(sessionPath, saved);
  }
  if (action === "end") {
    rmSync(sessionPath, { force: true });
    rmSync(join(sessionsDir, "hud.txt"), { force: true });
  }
  const payload = { ...result, command: "play-session", action, name, ...(saved ? { saved } : {}), ...(action === "end" ? { ended: true } : {}) };
  emitJsonStdout(payload);
}

/**
 * `agon play --watch`: a recorded run in the terminal UI, tick by tick. The run is
 * an `agon run` output directory (`--dir`) or a run id under artifacts/runs (`--from-run`).
 */
async function watchRunCommand(args) {
  const extra = ["sim-config", "initial-state", "level", "no-fog", "record", "replay"].filter((key) => args[key] !== undefined);
  if (extra.length > 0) {
    throw new Error(`play --watch shows a recorded run as it happened; it does not take ${extra.map((key) => `--${key}`).join(", ")}.`);
  }
  if (isNonEmptyString(args.dir) === (args["from-run"] !== undefined)) {
    throw new Error("play --watch takes one run: --dir <agon run output directory> or --from-run <runId>.");
  }
  const runDir = isNonEmptyString(args.dir) ? resolvePath(args.dir) : resolveTickRunDir(String(args["from-run"]));
  let tick;
  if (args.tick !== undefined) {
    if (!/^\d+$/.test(String(args.tick))) throw new Error(`play --tick needs a whole number, got ${args.tick}`);
    tick = Number(args.tick);
  }
  const color = args["no-color"] ? false : args.color ? true : undefined;
  const keys = await resolveKeys(args);
  if (keys === undefined && !args.json) {
    process.exitCode = await watchAsciiInteractive({ runDir, tick, color });
    return;
  }
  const result = watchAsciiScripted({ runDir, tick, keys: keys ?? "", color: color === true });
  if (!result.ok) throw new Error(result.error);
  if (args.json) {
    emitJsonStdout({ ...result, command: "play", watch: true, runDir, launch: launchCommand({ dir: runDir }, { watch: true, tick: result.tick }) });
  } else {
    console.log(result.screen);
  }
}
