/**
 * #864: `result.events` is what happened in the call's ticks as data. The Annotator derives each
 * entry; the session filters with the same reader rule as the cues and the battle log. Vital
 * numbers reach only the seat's own side (Darren, 2026-11-15).
 */
const assert = require("node:assert/strict");
const { createPlaySession, replayPlaySession } = require("../../packages/runtime/src/runner/play-session.js");
const { TURN_EVENT_KINDS } = require("../../packages/runtime/src/contracts/turn-events.js");
const { buildUnifiedLevel, viableVitals } = require("../fixtures/ui-ascii/unified-level.mjs");

const duel = () => buildUnifiedLevel({
  id: "duel",
  tiles: ["#####", "#..##", "#...E", "#####"],
  actors: [
    { category: "delver", id: "delver_1", position: { x: 1, y: 1 }, motivations: ["user_controlled"],
      vitals: viableVitals({ mana: 200 }), affinities: [{ kind: "decay", expression: "push", stacks: 3, intensity: 2 }] },
    { category: "warden", id: "warden_1", position: { x: 2, y: 1 }, motivations: ["stationary"],
      vitals: viableVitals(), affinities: [{ kind: "fire", expression: "push", stacks: 1 }] },
  ],
});
const arena = () => buildUnifiedLevel({
  id: "arena",
  tiles: ["#########", "#.......#", "#.......#", "#.......E", "#########"],
  actors: [
    { category: "delver", id: "delver_1", position: { x: 1, y: 1 }, motivations: ["user_controlled"], vitals: viableVitals() },
    { category: "warden", id: "warden_1", position: { x: 7, y: 2 }, motivations: ["random"], vitals: viableVitals() },
  ],
});
const move = (direction) => ({ kind: "move", params: { direction } });
const equip = (affinityKey) => ({ kind: "equip_affinity", params: { affinityKey } });
const cast = (targetId) => ({ kind: "cast_affinity", params: { targetId } });

test("a move produces one move event with where it started and ended", async () => {
  const session = await createPlaySession(duel());
  const result = await session.act(move("south"));
  const moves = result.events.filter((event) => event.event === "move" && event.sourceId === "delver_1");
  assert.deepEqual(moves.map(({ from, to, sprint }) => ({ from, to, sprint })),
    [{ from: { x: 1, y: 1 }, to: { x: 1, y: 2 }, sprint: false }]);
  assert.ok(result.events.every((event) => TURN_EVENT_KINDS.includes(event.event)));
  assert.ok(result.events.every((event, index, all) => index === 0 || event.seq > all[index - 1].seq), "in run order");
});

test("a cast that strikes yields a cast event; vital numbers only for the seat's own side", async () => {
  const session = await createPlaySession(duel());
  await session.act(equip("decay:push"));
  const result = await session.act(cast("warden_1"));
  const hit = result.events.find((event) => event.event === "cast" && event.sourceId === "delver_1");
  assert.equal(hit.struck, true);
  assert.equal(hit.targetId, "warden_1");
  assert.ok(hit.condition, "our side's hit keeps its hurt words (#692)");
  const vitals = result.events.filter((event) => event.event === "vital");
  assert.ok(vitals.some((event) => event.targetId === "delver_1"), "the seat's own vitals, in numbers");
  assert.ok(vitals.every((event) => event.targetId === "delver_1"), "no numbers about the warden it struck");
});

test("a hostile field hurting the seat yields the field event and the seat's vital delta", async () => {
  const level = buildUnifiedLevel({
    id: "burn", tiles: ["#####", "#...#", "#...E", "#####"],
    actors: [
      { category: "delver", id: "delver_1", position: { x: 1, y: 1 }, motivations: ["user_controlled"], vitals: viableVitals() },
      { category: "hazard", id: "brazier", position: { x: 2, y: 1 },
        vitals: { durability: { current: 10, max: 10, regen: 1 }, mana: { current: 30, max: 30, regen: 3 } },
        affinities: [{ kind: "fire", expression: "emit", stacks: 1 }], activeAffinityKey: "fire:emit" },
    ],
  });
  const session = await createPlaySession(level);
  const { events } = await session.act({ kind: "wait" });
  const field = events.find((event) => event.event === "field" && event.targetId === "delver_1");
  assert.ok(field, "the brazier's fire starts hurting the seat");
  assert.equal(field.sourceId, "brazier");
  assert.ok(events.some((event) => event.event === "vital" && event.targetId === "delver_1" && event.delta - event.regen < 0),
    "what it took from the seat, in numbers");
  assert.ok(!events.some((event) => event.event === "vital" && event.targetId === "brazier"), "none about the brazier");
});

test("with fog, events about an actor out of sight are absent", async () => {
  const fogged = await createPlaySession({ ...arena(), fog: true });
  const open = await createPlaySession(arena());
  let seenWithoutFog = false;
  for (let i = 0; i < 4; i += 1) {
    const hidden = await fogged.act({ kind: "wait" });
    const shown = await open.act({ kind: "wait" });
    assert.ok(!hidden.events.some((event) => event.sourceId === "warden_1" || event.targetId === "warden_1"),
      "the warden, six tiles off in an unlit level");
    seenWithoutFog ||= shown.events.some((event) => event.event === "move" && event.sourceId === "warden_1");
  }
  assert.ok(seenWithoutFog, "without fog the same warden's moves are events");
});

test("events and cues of one result describe the same ticks", async () => {
  const session = await createPlaySession(duel());
  await session.act(equip("decay:push"));
  const result = await session.act(cast("warden_1"));
  const ticks = (list) => [...new Set(list.map((item) => item.tick))];
  assert.ok(result.cues.length > 0);
  assert.deepEqual(ticks(result.cues).filter((tick) => !ticks(result.events).includes(tick)), []);
  const cueEvents = result.events.filter((event) => ["cast", "field", "take", "defeat", "exit"].includes(event.event));
  assert.equal(cueEvents.length, result.cues.length, "every cue has its event");
});

test("replaying a capture yields the same events as the run", async () => {
  const level = duel();
  const session = await createPlaySession(level);
  await session.act(move("south"));
  await session.act(equip("decay:push"));
  await session.act(cast("warden_1"));
  await session.act(move("north"));
  const replay = await replayPlaySession({ ...level, capturedInput: session.captureInput({ meta: { id: "c", runId: "r", createdAt: "2026-11-16T00:00:00.000Z" } }) });
  assert.ok(session.eventsSince(0).length > 0);
  assert.deepEqual(replay.eventsSince(0), session.eventsSince(0));
});

// ## TODO: Test Permutations
// - a sprint move reports sprint: true and a two-step `to`
// - a move from an unseen cell into sight carries `to` but no `from`
// - a party member's vital event is read after switching seat to another member
// - the game controller's frame().events matches the session result of the last key

test("#898: the player and every actor in view carry facing and moved, from their last step", async () => {
  const session = await createPlaySession(arena());
  const start = session.view();
  assert.equal(start.player.facing, "south", "before any step: the default pose");
  assert.equal(start.player.moved, false);
  await session.act(move("east"));
  let view = session.view();
  assert.equal(view.player.facing, "east");
  assert.equal(view.player.moved, true);
  await session.act({ kind: "wait" });
  view = session.view();
  assert.equal(view.player.facing, "east", "standing still keeps the last facing");
  assert.equal(view.player.moved, false);
  await session.act(move("south"));
  assert.equal(session.view().player.facing, "south");
  await session.act(move("northwest"));
  assert.equal(session.view().player.facing, "west", "a perfect diagonal takes the horizontal axis");
});

test("#898: facingOfStep takes the dominant axis, horizontal on a tie, and null for no step", () => {
  const { facingOfStep, FACINGS, DEFAULT_FACING } = require("../../packages/runtime/src/contracts/facing.js");
  assert.equal(facingOfStep(1, 0), "east");
  assert.equal(facingOfStep(-1, 0), "west");
  assert.equal(facingOfStep(0, 1), "south");
  assert.equal(facingOfStep(0, -1), "north");
  assert.equal(facingOfStep(2, -1), "east");
  assert.equal(facingOfStep(-1, 2), "south");
  assert.equal(facingOfStep(1, 1), "east");
  assert.equal(facingOfStep(-1, -1), "west");
  assert.equal(facingOfStep(0, 0), null);
  assert.ok(FACINGS.includes(DEFAULT_FACING));
});

test("#898: every mover's facing follows its last move event, warden included, and the draw model carries it", async () => {
  const { facingOfStep } = require("../../packages/runtime/src/contracts/facing.js");
  const { buildBoardDrawModel } = await import("../../packages/runtime/src/render/board-draw-model.js");
  const session = await createPlaySession(arena());
  const last = new Map();
  for (let i = 0; i < 8; i += 1) {
    const result = await session.act(i % 2 === 0 ? move("east") : { kind: "wait" });
    for (const event of result.events) {
      if (event.event === "move" && event.from) last.set(event.sourceId, facingOfStep(event.to.x - event.from.x, event.to.y - event.from.y));
    }
    const view = session.view();
    const model = buildBoardDrawModel(view);
    for (const entity of model.entities) {
      assert.ok(["north", "east", "south", "west"].includes(entity.facing));
      assert.equal(typeof entity.moved, "boolean");
      if (last.has(entity.id)) assert.equal(entity.facing, last.get(entity.id), `${entity.id} faces its last step`);
    }
  }
  assert.ok(last.has("delver_1"));
});
