/**
 * #864 annotator/turn-events: the Annotator derives `move` and `vital` entries from what the tick
 * applied (`battle.moves`, `battle.vitalChanges`), stamped by it like every other battle-log entry.
 * The session only filters and forwards them (tests/runtime/play-session-turn-events.test.js).
 */
const assert = require("node:assert/strict");

const CLOCK = () => "2026-11-16T00:00:00.000Z";
const PERSONAS = "../../../packages/runtime/src/personas/";

async function entriesFor(battle) {
  const { createAnnotatorPersona } = await import(`${PERSONAS}annotator/persona.js`);
  const annotator = createAnnotatorPersona({ clock: CLOCK });
  const result = annotator.advance({ phase: "emit", event: "observe", tick: battle.tick,
    payload: { runId: "r", observations: [{ tick: battle.tick, effects: [], battle }] } });
  return result.telemetry.battleLog;
}

test("a move is logged with where it started and ended, and whether it was a sprint", async () => {
  const entries = await entriesFor({ tick: 2, casts: [], lifecycles: {}, exitedActorIds: [],
    moves: [{ actorId: "a", from: { x: 1, y: 1 }, to: { x: 3, y: 1 }, sprint: true }] });
  assert.deepEqual(entries, [{ schema: "agon/BattleLogEntry", schemaVersion: 1,
    meta: { id: "battlelog_2_0", runId: "r", createdAt: CLOCK(), producedBy: "annotator" },
    tick: 2, event: "move", sourceId: "a", from: { x: 1, y: 1 }, to: { x: 3, y: 1 }, sprint: true }]);
});

test("each vital change is logged in numbers, with the part regen gave back; no change, no entry", async () => {
  const entries = await entriesFor({ tick: 4, casts: [], lifecycles: {}, exitedActorIds: [],
    vitalChanges: [
      { actorId: "a", vital: "health", hit: -5, regen: 1 },
      { actorId: "b", vital: "mana", hit: 0, regen: 3 },
      { actorId: "c", vital: "stamina", hit: 0, regen: 0 },
    ] });
  assert.deepEqual(entries.map(({ event, targetId, vital, delta, regen }) => ({ event, targetId, vital, delta, regen })), [
    { event: "vital", targetId: "a", vital: "health", delta: -4, regen: 1 },
    { event: "vital", targetId: "b", vital: "mana", delta: 3, regen: 3 },
  ]);
  assert.ok(entries.every((entry) => entry.meta.producedBy === "annotator"));
});

test("a tick's entries come in turn-event order: move, cast, field, vital, take, defeat, exit", async () => {
  const entries = await entriesFor({
    tick: 5,
    moves: [{ actorId: "a", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, sprint: false }],
    casts: [{ sourceId: "a", targetId: "b", kind: "decay", expression: "push" }],
    vitalChanges: [{ actorId: "b", vital: "health", hit: -9, regen: 0 }],
    takes: [{ actorId: "a", targetId: "c" }],
    lifecycles: { b: "defeated" },
    exitedActorIds: ["z"],
  });
  assert.deepEqual(entries.map((entry) => entry.event), ["move", "cast", "vital", "take", "defeat", "exit"]);
});

// ## TODO: Test Permutations
// - a move with no `from` in the facts (malformed observation) is skipped, not thrown on
// - several moves in one tick keep the order core accepted them in
// - vital changes for an exited actor still log
