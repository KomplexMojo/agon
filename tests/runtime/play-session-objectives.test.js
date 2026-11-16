/**
 * #867 step 3 — the play session reports the level's objectives and the run's outcome, as the
 * Moderator judges them. A level with no objectives reads "playing" until the seat leaves (won) or
 * falls (lost), exactly as `exited` / `defeated` already say; a replay reaches the same verdict.
 */
const assert = require("node:assert/strict");

const { createPlaySession, replayPlaySession } = require("../../packages/runtime/src/runner/play-session.js");
const { buildUnifiedLevel, viableVitals } = require("../fixtures/ui-ascii/unified-level.mjs");

const MAZE = [
  "#########",
  "S...#...#",
  "#...#.#.#",
  "#.#...#.#",
  "#.###.#.#",
  "#...#...#",
  "#.#.#.###",
  "#...#...E",
  "#########",
];
const PLAYER = { category: "delver", id: "actor_mvp", position: { x: 2, y: 1 }, vitals: viableVitals(), motivations: ["user_controlled"] };
const PATH_TO_EXIT = ["east", "south", "south", "east", "east", "south", "south", "south", "south", "east", "east", "east"];
const CAPTURE_META = { id: "capture-objectives", runId: "run-objectives", createdAt: "2026-11-16T00:00:00.000Z" };

function level(objectives) {
  const built = buildUnifiedLevel({ id: "mvp_maze", tiles: MAZE, actors: [PLAYER] });
  return objectives ? { ...built, simConfig: { ...built.simConfig, objectives } } : built;
}

const move = (direction) => ({ kind: "move", params: { direction } });

async function walkOut(session) {
  for (const direction of PATH_TO_EXIT) await session.act(move(direction));
  return session.act({ kind: "wait" });
}

test("no objectives: reach_exit, playing until the seat leaves, then won", async () => {
  const session = await createPlaySession(level());
  const start = session.status();
  assert.equal(start.outcome, "playing");
  assert.deepEqual(start.objectives, [{ id: "reach_exit", kind: "reach_exit", required: true, state: "open" }]);
  assert.equal(session.view().status.outcome, "playing", "the view carries the same report");
  const last = await walkOut(session);
  assert.equal(last.status.exited, true);
  assert.equal(last.status.outcome, "won");
  assert.equal(last.status.objectives[0].state, "met");
});

test("survive: met at the mark, so the run is won while the seat stays put", async () => {
  const session = await createPlaySession(level([{ id: "hold", kind: "survive", params: { ticks: 3 }, required: true }]));
  await session.act({ kind: "wait" });
  assert.deepEqual(session.status().objectives[0].progress, { done: 1, of: 3 });
  assert.equal(session.status().outcome, "playing");
  await session.act({ kind: "wait" });
  const third = await session.act({ kind: "wait" });
  assert.equal(third.status.outcome, "won");
  assert.equal(third.status.exited, false, "the existing fields keep their meaning");
});

test("within: the deadline passing with the exit unreached loses the run", async () => {
  const session = await createPlaySession(level([
    { id: "reach_exit", kind: "reach_exit", params: {}, required: true },
    { id: "quick", kind: "within", params: { ticks: 2 }, required: true },
  ]));
  for (let i = 0; i < 3; i += 1) await session.act({ kind: "wait" });
  const status = session.status();
  assert.equal(status.outcome, "lost");
  assert.equal(status.objectives.find((objective) => objective.id === "quick").state, "failed");
  assert.equal(status.defeated, false);
});

test("a replay reaches the same objectives and outcome", async () => {
  const built = level([
    { id: "reach_exit", kind: "reach_exit", params: {}, required: true },
    { id: "quick", kind: "within", params: { ticks: 40 }, required: true },
  ]);
  const played = await createPlaySession(built);
  await walkOut(played);
  assert.equal(played.status().outcome, "won");
  const capture = JSON.parse(JSON.stringify(played.captureInput({ meta: CAPTURE_META })));
  const replayed = await replayPlaySession({ ...built, capturedInput: capture });
  assert.deepEqual(replayed.status(), played.status());
});

/**
 * ## TODO: Test Permutations
 *
 * - defeat by role where a hazard falls to the seat's cast (progress counts it)
 * - collect when the party takes from a resource, with and without holdingKind
 * - escort with an escorting companion that reaches the exit
 * - switching the seat to another party member keeps judging the level's player
 * - resume from a save reports the same outcome as the session that saved it
 * - fog on: progress counts never reveal where an unseen target stands
 */
