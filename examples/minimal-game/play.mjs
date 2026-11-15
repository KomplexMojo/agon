#!/usr/bin/env node
/**
 * The smallest complete game on Agon (#869): author a level, play it, draw it as text.
 * Imports only the published entries of @agon-engine/engine, the way a game outside this
 * repository would. See README.md and docs/building-a-game.md, sections 2 to 4.
 *
 *   node examples/minimal-game/play.mjs              keys: w a s d move, . waits, q quits
 *   node examples/minimal-game/play.mjs --script "d,d,s,."   the same keys, without a terminal
 */
import { createInterface } from "node:readline";
import { authorLevel } from "@agon-engine/engine/authoring";
import { createPlaySession, rejectionMessage } from "@agon-engine/engine/client";

// 2. Get a level: the same arguments as `agon create` in the guide. The Allocator prices it.
const { buildResult } = await authorLevel([
  "--room", "size=small;count=1",
  "--delver", "count=1;affinity=fire;motivation=user_controlled",
  "--warden", "count=1;affinity=dark;motivation=defending",
  "--run-id", "minimal-game",
  "--created-at", "2026-11-15T00:00:00.000Z",
]);

// 3. Play it: one command is one tick; every other actor decides through its own persona.
const session = await createPlaySession({ simConfig: buildResult.simConfig, initialState: buildResult.initialState });

const KEYS = { w: "north", a: "west", s: "south", d: "east" };

// 4. Draw it: the view is data; this client prints the board rows and the player's vitals.
function draw() {
  const view = session.view();
  console.log(view.rows.join("\n"));
  const vitals = (view.player?.vitals ?? []).map((vital) => `${vital.key} ${vital.current}/${vital.max}`).join("  ");
  console.log(`tick ${view.tick}  ${vitals}`);
}

/** One key: a move, a wait, or quit. Returns false when the game should stop. */
async function press(key) {
  if (key === "q") return false;
  const command = KEYS[key] ? { kind: "move", params: { direction: KEYS[key] } } : key === "." ? { kind: "wait" } : null;
  if (!command) {
    console.log(`Unknown key "${key}". Use w a s d, . or q.`);
    return true;
  }
  const result = await session.act(command);
  for (const rejected of result.rejected) console.log(rejectionMessage(rejected.reason));
  draw();
  const { exited, defeated } = session.status();
  return !exited && !defeated;
}

function finish() {
  const { exited, defeated, tick } = session.status();
  console.log(exited ? `You left the level on tick ${tick}.` : defeated ? `You were defeated on tick ${tick}.` : `You stopped on tick ${tick}.`);
}

const scriptAt = process.argv.indexOf("--script");
draw();
if (scriptAt > 0) {
  for (const key of String(process.argv[scriptAt + 1] ?? "").split(",").map((k) => k.trim()).filter(Boolean)) {
    if (!(await press(key))) break;
  }
  finish();
} else {
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  lines.prompt();
  for await (const line of lines) {
    if (!(await press(line.trim()))) break;
    lines.prompt();
  }
  lines.close();
  finish();
}
