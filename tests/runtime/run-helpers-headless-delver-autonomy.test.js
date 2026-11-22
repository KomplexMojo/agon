/**
 * Headless `agon run` remaps delver `user_controlled` to computer autonomy by default.
 */
"use strict";

const assert = require("node:assert/strict");

test("strips user_controlled and adds goal_oriented when exploring remains", async () => {
  const { applyHeadlessDelverAutonomy } = await import("../../packages/runtime/src/commands/run-helpers.js");
  const initialState = {
    actors: [
      { id: "hero", category: "delver", motivations: ["user_controlled", "exploring"] },
      { id: "guard", category: "warden", motivations: ["user_controlled", "defending"] },
    ],
  };

  const result = applyHeadlessDelverAutonomy(initialState);

  assert.equal(result.applied, true);
  assert.deepEqual(result.remapped, [{
    actorId: "hero",
    from: ["user_controlled", "exploring"],
    to: ["exploring", "goal_oriented"],
  }]);
  assert.deepEqual(initialState.actors[0].motivations, ["exploring", "goal_oriented"]);
  assert.deepEqual(initialState.actors[1].motivations, ["user_controlled", "defending"]);
});

test("adds exploring+goal_oriented when only user_controlled remains", async () => {
  const { applyHeadlessDelverAutonomy } = await import("../../packages/runtime/src/commands/run-helpers.js");
  const initialState = {
    presentation: { lone: { category: "delver" } },
    actors: [{ id: "lone", motivations: ["user_controlled"] }],
  };

  const result = applyHeadlessDelverAutonomy(initialState);

  assert.equal(result.applied, true);
  assert.deepEqual(initialState.actors[0].motivations, ["goal_oriented", "exploring"]);
  assert.equal(result.remapped[0].actorId, "lone");
});

test("preservePlayerControl and scripted actions skip the remap", async () => {
  const { applyHeadlessDelverAutonomy } = await import("../../packages/runtime/src/commands/run-helpers.js");
  const base = () => ({
    actors: [{ id: "hero", category: "delver", motivations: ["user_controlled", "exploring"] }],
  });

  const preserved = applyHeadlessDelverAutonomy(base(), { preservePlayerControl: true });
  assert.equal(preserved.applied, false);
  assert.deepEqual(preserved.initialState.actors[0].motivations, ["user_controlled", "exploring"]);

  const scripted = applyHeadlessDelverAutonomy(base(), { hasActions: true });
  assert.equal(scripted.applied, false);
  assert.deepEqual(scripted.initialState.actors[0].motivations, ["user_controlled", "exploring"]);
});

test("leaves delvers that already think for themselves alone", async () => {
  const { applyHeadlessDelverAutonomy } = await import("../../packages/runtime/src/commands/run-helpers.js");
  const initialState = {
    actors: [
      { id: "scout", category: "delver", motivations: ["exploring", "goal_oriented"] },
      { id: "hero", category: "delver", motivations: ["user_controlled", "attacking", "strategy_focused"] },
    ],
  };

  const result = applyHeadlessDelverAutonomy(initialState);

  assert.equal(result.applied, true);
  assert.deepEqual(initialState.actors[0].motivations, ["exploring", "goal_oriented"]);
  assert.deepEqual(initialState.actors[1].motivations, ["attacking", "strategy_focused"]);
  assert.equal(result.remapped.length, 1);
  assert.equal(result.remapped[0].actorId, "hero");
});

// ## TODO: Test Permutations
// - presentation.category resolves delver when actor.category is missing
// - ai_controlled is not stripped (authored AI seat stays)
// - friendly+user_controlled without exploring still gets exploring added
