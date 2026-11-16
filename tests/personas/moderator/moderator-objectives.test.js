const assert = require("node:assert/strict");

/**
 * #867 step 2 — the Moderator judges a level's objectives from facts (tick, who was defeated or
 * left and when, what the party took). One case per kind for open, met and failed, plus the
 * default: a level without objectives is won on exit and lost on defeat, exactly as before.
 */

function load() {
  return import("../../../packages/runtime/src/personas/moderator/controller.js");
}

const SEAT = "delver";
const level = (objectives) => ({ objectives });
const stateOf = (result, id) => result.objectives.find((objective) => objective.id === id).state;

test("default level: playing, won on exit, lost on defeat", async () => {
  const { evaluateLevelObjectives } = await load();
  const base = { simConfig: {}, seatId: SEAT };
  const playing = evaluateLevelObjectives({ ...base, tick: 3 });
  assert.equal(playing.outcome, "playing");
  assert.deepEqual(playing.objectives, [{ id: "reach_exit", kind: "reach_exit", required: true, state: "open" }]);
  assert.equal(evaluateLevelObjectives({ ...base, tick: 9, exitedAt: { [SEAT]: 9 } }).outcome, "won");
  const lost = evaluateLevelObjectives({ ...base, tick: 4, defeatedAt: { [SEAT]: 4 } });
  assert.equal(lost.outcome, "lost");
  assert.equal(stateOf(lost, "reach_exit"), "failed");
});

test("defeat by role: open with progress, met when every target is down", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([{ id: "slay", kind: "defeat", params: { role: "warden" }, required: true }]);
  const roles = { w1: "warden", w2: "warden", h1: "hazard" };
  const open = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 5, roles, defeatedAt: { w1: 3, h1: 2 } });
  assert.equal(stateOf(open, "slay"), "open");
  assert.deepEqual(open.objectives[0].progress, { done: 1, of: 2 });
  assert.equal(open.outcome, "playing");
  const met = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 8, roles, defeatedAt: { w1: 3, w2: 8 } });
  assert.equal(stateOf(met, "slay"), "met");
  assert.equal(met.outcome, "won");
  const failed = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 6, roles, defeatedAt: { [SEAT]: 6 } });
  assert.equal(failed.outcome, "lost", "the seat's defeat loses whatever is open");
});

test("defeat by named actors", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([{ id: "boss", kind: "defeat", params: { actorIds: ["ogre"] }, required: true }]);
  assert.equal(stateOf(evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 2 }), "boss"), "open");
  assert.equal(evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 7, defeatedAt: { ogre: 7 } }).outcome, "won");
});

test("survive: open before the mark, met at it, failed when the seat falls first", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([{ id: "hold", kind: "survive", params: { ticks: 10 }, required: true }]);
  const open = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 4 });
  assert.equal(stateOf(open, "hold"), "open");
  assert.deepEqual(open.objectives[0].progress, { done: 4, of: 10 });
  assert.equal(evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 10 }).outcome, "won");
  const failed = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 6, defeatedAt: { [SEAT]: 6 } });
  assert.equal(stateOf(failed, "hold"), "failed");
  assert.equal(failed.outcome, "lost");
});

test("collect: counts the party's takes, filtered by holding kind", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([{ id: "loot", kind: "collect", params: { count: 2, holdingKind: "vital" }, required: true }]);
  const takes = [{ tick: 2, holdingKind: "vital" }, { tick: 3, holdingKind: "affinity" }];
  const open = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 3, takes });
  assert.equal(stateOf(open, "loot"), "open");
  assert.deepEqual(open.objectives[0].progress, { done: 1, of: 2 });
  const met = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 5, takes: [...takes, { tick: 5, holdingKind: "vital" }] });
  assert.equal(stateOf(met, "loot"), "met");
  assert.equal(met.outcome, "won");
  const failed = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 4, takes, exitedAt: { [SEAT]: 4 } });
  assert.equal(failed.outcome, "lost", "leaving with a required objective open ends the run lost");
});

test("escort: met when the companion leaves, failed when it is defeated", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([{ id: "guide", kind: "escort", params: { actorId: "pilgrim" }, required: true }]);
  assert.equal(evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 3 }).outcome, "playing");
  assert.equal(evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 8, exitedAt: { pilgrim: 8 } }).outcome, "won");
  const failed = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 5, defeatedAt: { pilgrim: 5 } });
  assert.equal(stateOf(failed, "guide"), "failed");
  assert.equal(failed.outcome, "lost");
});

test("within: met when the rest is met in time, failed once the deadline passes", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([
    { id: "reach_exit", kind: "reach_exit", params: {}, required: true },
    { id: "quick", kind: "within", params: { ticks: 20 }, required: true },
  ]);
  const open = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 12 });
  assert.equal(stateOf(open, "quick"), "open");
  assert.equal(open.outcome, "playing");
  const met = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 18, exitedAt: { [SEAT]: 18 } });
  assert.equal(stateOf(met, "quick"), "met");
  assert.equal(met.outcome, "won");
  const failed = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 21 });
  assert.equal(stateOf(failed, "quick"), "failed");
  assert.equal(failed.outcome, "lost");
});

test("optional objectives are reported but never decide the outcome", async () => {
  const { evaluateLevelObjectives } = await load();
  const simConfig = level([
    { id: "reach_exit", kind: "reach_exit", params: {}, required: true },
    { id: "bonus", kind: "collect", params: { count: 3 }, required: false },
  ]);
  const result = evaluateLevelObjectives({ simConfig, seatId: SEAT, tick: 9, exitedAt: { [SEAT]: 9 }, takes: [{ tick: 4 }] });
  assert.equal(result.outcome, "won");
  assert.equal(stateOf(result, "bonus"), "open");
});

test("the same facts always give the same verdict (replay)", async () => {
  const { evaluateLevelObjectives } = await load();
  const args = {
    simConfig: level([{ id: "slay", kind: "defeat", params: { role: "warden" }, required: true }]),
    seatId: SEAT, tick: 6, roles: { w1: "warden" }, defeatedAt: { w1: 6 },
  };
  assert.deepEqual(evaluateLevelObjectives(args), evaluateLevelObjectives(structuredClone(args)));
});

/**
 * ## TODO: Test Permutations
 *
 * - defeat by role when no actor holds the role (stays open, progress 0 of 0)
 * - survive when the seat exits before the mark (met early)
 * - survive when the seat is defeated after the mark (already met)
 * - collect with count larger than all takes and no holdingKind filter
 * - within around a defeat objective met exactly on the deadline tick
 * - escort when the companion leaves on the same tick the seat is defeated
 * - several required objectives where one fails while another is met
 */
