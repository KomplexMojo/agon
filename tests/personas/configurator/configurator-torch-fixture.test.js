/**
 * #906 — the torch fixture: a small light emit below the viability floor, priced by the
 * Allocator through the ordinary hazard path and far cheaper than a floored field hazard.
 */
"use strict";

const assert = require("node:assert/strict");

test("a torch holds a small mana pool and regen below its own upkeep, so it can go dark", async () => {
  const { composeTorchFixture } = await import("../../../packages/runtime/src/personas/configurator/torch.js");
  const { ACTOR_VIABILITY_FLOOR } = await import("../../../packages/runtime/src/contracts/domain-constants.js");
  const torch = composeTorchFixture("t1", "wall", 1);
  assert.equal(torch.affinity, "light");
  assert.equal(torch.expression, "emit");
  assert.equal(torch.fixture, "wall");
  assert.ok(torch.vitals.mana.max < ACTOR_VIABILITY_FLOOR.mana.max, "below the actor floor by design");
  assert.ok(torch.vitals.mana.regen < torch.vitals.mana.max, "regen cannot sustain the field");
  assert.ok(torch.vitals.mana.max > 0 && torch.vitals.mana.regen > 0, "non-zero: everything costs something");
});

test("a torch carries fewer vital points than a floored field hazard of the same range", async () => {
  const { composeTorchFixture } = await import("../../../packages/runtime/src/personas/configurator/torch.js");
  const { composeFieldHazard } = await import("../../../packages/runtime/src/personas/configurator/minefield.js");
  const points = (hazard) => Object.values(hazard.vitals).reduce((sum, vital) => sum + vital.max + vital.regen, 0);
  assert.ok(points(composeTorchFixture("t", "standing", 1)) < points(composeFieldHazard("h", "light", 1)));
});

test("a torch rejects an unknown role", async () => {
  const { composeTorchFixture } = await import("../../../packages/runtime/src/personas/configurator/torch.js");
  assert.throws(() => composeTorchFixture("t", "ceiling"), /role must be one of/);
});

function roomLayout() {
  const width = 12;
  const height = 10;
  const rooms = [{ id: "R1", x: 2, y: 2, width: 7, height: 6 }];
  const terrain = Array.from({ length: width * height }, () => "wall");
  for (let y = 2; y < 8; y += 1) for (let x = 2; x < 9; x += 1) terrain[y * width + x] = "floor";
  return { width, height, terrain, rooms, entryRoomId: "R1", exitRoomId: "R1" };
}

test("the torch tactic seats wall torches on the room edge and standing torches inside it", async () => {
  const { createConfiguratorPersona } = await import("../../../packages/runtime/src/personas/configurator/controller.js");
  const persona = createConfiguratorPersona({ clock: () => "2026-11-21T00:00:00.000Z" });
  const { hazards, placement, report } = persona.compileTactics({
    tactics: [{ tactic: "torch", params: { wall: 2, standing: 1, room: "R1" } }], layout: roomLayout(), actors: [], resources: [], seed: 0 });
  assert.equal(report[0].applied, true, report[0].note);
  assert.equal(hazards.length, 3);
  const room = roomLayout().rooms[0];
  for (const hazard of hazards) {
    const cell = placement.find((constraint) => constraint.subject.ref === hazard.id).near.target.cells[0];
    const edge = cell.x === room.x || cell.y === room.y || cell.x === room.x + room.width - 1 || cell.y === room.y + room.height - 1;
    assert.equal(edge, hazard.fixture === "wall", `${hazard.id} (${hazard.fixture}) at ${cell.x},${cell.y}`);
  }
});

test("a room too small for the torch count says so", async () => {
  const { createConfiguratorPersona } = await import("../../../packages/runtime/src/personas/configurator/controller.js");
  const persona = createConfiguratorPersona({ clock: () => "2026-11-21T00:00:00.000Z" });
  const { report } = persona.compileTactics({
    tactics: [{ tactic: "torch", params: { wall: 40, room: "R1" } }], layout: roomLayout(), actors: [], resources: [], seed: 0 });
  assert.equal(report[0].applied, true);
  assert.match(report[0].note, /holds \d+ of 40 wall torches/);
});

test("the torch tactic rejects an unknown param", async () => {
  const { readTorchParams } = await import("../../../packages/runtime/src/personas/configurator/torch.js");
  assert.throws(() => readTorchParams({ bogus: 1 }), /unknown param/);
});

test("applyTorchActivation gives fixtures a dormancy and leaves other actors and an absent mode alone", async () => {
  const { applyTorchActivation } = await import("../../../packages/runtime/src/personas/configurator/torch.js");
  const layout = { data: { rooms: [{ id: "R1", x: 2, y: 2, width: 5, height: 4 }] } };
  const initialState = { actors: [
    { id: "t", position: { x: 3, y: 3 }, fixture: "wall" },
    { id: "out", position: { x: 9, y: 9 }, fixture: "standing" },
    { id: "h", position: { x: 4, y: 4 } },
  ] };
  assert.equal(applyTorchActivation({ initialState, layout }), initialState, "no mode: unchanged");
  const room = applyTorchActivation({ initialState, layout, mode: "room_enter" }).actors;
  assert.deepEqual(room[0].dormant, { mode: "room_enter", area: { x: 2, y: 2, width: 5, height: 4 } });
  assert.equal(room[1].dormant, undefined, "a torch outside every room stays always on");
  assert.equal(room[2].dormant, undefined);
  assert.deepEqual(applyTorchActivation({ initialState, layout, mode: "proximity", radius: 4 }).actors[0].dormant, { mode: "proximity", radius: 4 });
  assert.throws(() => applyTorchActivation({ initialState, layout, mode: "x" }), /must be one of/);
});
