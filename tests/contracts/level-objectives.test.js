/**
 * #867 — level objectives contract: a closed vocabulary checked for shape; a level without
 * `objectives` asks for `reach_exit` alone, so every older level reads as it did.
 */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  DEFAULT_OBJECTIVES, OBJECTIVE_KINDS, levelObjectives, validateObjectives,
} = require("../../packages/runtime/src/contracts/objectives.js");

const FIXTURES = join(__dirname, "../fixtures/artifacts");
const read = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

test("the fixture with one objective of every kind is valid", () => {
  const config = read("sim-config-artifact-v1-objectives.json");
  assert.deepEqual(validateObjectives(config.objectives), []);
  assert.deepEqual([...new Set(config.objectives.map((o) => o.kind))].sort(), [...OBJECTIVE_KINDS].sort());
});

test("a level that names no objectives asks for reach_exit alone", () => {
  const config = read("sim-config-artifact-v1-basic.json");
  assert.equal(config.objectives, undefined);
  assert.equal(levelObjectives(config), DEFAULT_OBJECTIVES);
  assert.deepEqual(DEFAULT_OBJECTIVES.map((o) => [o.kind, o.required]), [["reach_exit", true]]);
  assert.deepEqual(validateObjectives(DEFAULT_OBJECTIVES), []);
});

test("an unknown kind is refused", () => {
  const errors = validateObjectives(read("invalid/sim-config-artifact-v1-objective-unknown-kind.json").objectives);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /kind "find_treasure" is not one of/);
});

test("survive for fewer than one tick is refused", () => {
  const errors = validateObjectives(read("invalid/sim-config-artifact-v1-objective-survive-zero.json").objectives);
  assert.deepEqual(errors, ["objectives[0].params.ticks must be a whole number of at least 1"]);
});

test("shape refusals name the field", () => {
  const one = (objective) => validateObjectives([objective, { id: "out", kind: "reach_exit", params: {}, required: true }]);
  assert.match(one({ id: "d", kind: "defeat", params: {}, required: true })[0], /exactly one of actorIds or role/);
  assert.match(one({ id: "d", kind: "defeat", params: { actorIds: ["a"], role: "warden" }, required: true })[0], /exactly one/);
  assert.match(one({ id: "c", kind: "collect", params: { count: 1, holdingKind: "gold" }, required: false })[0], /holdingKind must be one of/);
  assert.match(one({ id: "e", kind: "escort", params: {}, required: true })[0], /actorId must be an actor id/);
  assert.match(one({ id: "x", kind: "reach_exit", params: { far: 1 }, required: true })[0], /far is not a reach_exit param/);
  assert.match(one({ id: "out", kind: "survive", params: { ticks: 3 }, required: true })[0], /"out" is used twice/);
  assert.match(one({ id: "s", kind: "survive", params: { ticks: 3 } })[0], /required must be true or false/);
});

test("a list needs a required objective, and within needs something to time", () => {
  assert.match(validateObjectives([])[0], /at least one objective/);
  assert.deepEqual(validateObjectives([{ id: "s", kind: "survive", params: { ticks: 2 }, required: false }]),
    ["objectives need at least one required objective"]);
  assert.deepEqual(validateObjectives([{ id: "w", kind: "within", params: { ticks: 2 }, required: true }]),
    ["a within objective needs another required objective to time"]);
  assert.deepEqual(validateObjectives([
    { id: "w1", kind: "within", params: { ticks: 2 }, required: true },
    { id: "w2", kind: "within", params: { ticks: 3 }, required: true },
    { id: "out", kind: "reach_exit", params: {}, required: true },
  ]), ["objectives may hold at most one within"]);
});

// ## TODO: Test Permutations
// - defeat.actorIds with a blank id
// - collect with count as a string
// - an objective that is an array, null, or a number
