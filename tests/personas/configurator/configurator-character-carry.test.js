const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * #868 step 1 — the Configurator writes the player's character down as it leaves a level and seats
 * it in the next. Holdings carry, vitals refill, a one-level grant comes back off, and the seat keeps
 * the next level's own id, position and motivations. The seated level loads and plays.
 */

const FIXTURES = join(__dirname, "../../fixtures/artifacts");
const read = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const META = { id: "carry-1", runId: "run-carry", createdAt: "2026-11-16T00:00:00.000Z" };

async function load() {
  const { createConfiguratorPersona } = await import("../../../packages/runtime/src/personas/configurator/persona.js");
  const { UNUSED_CLOCK } = await import("../../../packages/runtime/src/personas/_shared/require-clock.js");
  const { createPlaySession } = await import("../../../packages/runtime/src/runner/play-session.js");
  const { buildUnifiedLevel, viableVitals } = await import("../../fixtures/ui-ascii/unified-level.mjs");
  return { configurator: createConfiguratorPersona({ clock: UNUSED_CLOCK }), createPlaySession, buildUnifiedLevel, viableVitals };
}

const LEFT = {
  id: "hero", position: { x: 7, y: 3 }, alignment: "external", lifecycle: "exited", defeatVital: "health",
  vitals: { health: { current: 2, max: 16, regen: 1 }, mana: { current: 0, max: 13, regen: 2 }, stamina: { current: 5, max: 12, regen: 2 } },
  capabilities: { canMove: true, canCast: true, canEquip: true, canTake: true, canExit: true, blocksMovement: true, blocksSight: false },
  motivations: ["user_controlled"], affinitySlots: 3,
  affinities: [{ kind: "fire", expression: "push", stacks: 3 }, { kind: "dark", expression: "emit", stacks: 1, intensity: 2 }],
  activeAffinityKey: "fire:push", equippedAffinityKeys: ["fire:push", "dark:emit"], holdings: [], watching: ["w1"], soaked: 2,
};

test("the character as it leaves: holdings and ceilings carry, damage and level state do not", async () => {
  const { configurator } = await load();
  const state = configurator.characterStateFromActor({ actor: LEFT, meta: META, fromLevel: { simConfigId: "a", initialStateId: "b" } });
  assert.equal(state.schema, "agon/CharacterState");
  assert.equal(state.meta.producedBy, "configurator");
  assert.equal(state.actorId, "hero");
  assert.deepEqual(state.character.vitals, { health: { max: 16, regen: 1 }, mana: { max: 13, regen: 2 }, stamina: { max: 12, regen: 2 } });
  assert.deepEqual(state.character.equippedAffinityKeys, ["fire:push", "dark:emit"]);
  assert.equal(state.character.affinities.length, 2);
  assert.equal(state.character.affinitySlots, 3);
  for (const field of ["watching", "soaked", "position", "lifecycle"]) assert.equal(state.character[field], undefined, field);
});

test("a grant that lasts one level comes back off", async () => {
  const { configurator } = await load();
  const state = configurator.characterStateFromActor({ actor: LEFT, meta: META,
    levelGrants: [{ vitals: [{ key: "health", delta: 4 }, { key: "mana", delta: 3, regen: 1 }] }] });
  assert.deepEqual(state.character.vitals.health, { max: 12, regen: 1 });
  assert.deepEqual(state.character.vitals.mana, { max: 10, regen: 1 });
});

test("fixtures: the basic one is valid, equipping an unheld affinity is refused", async () => {
  const { configurator } = await load();
  assert.deepEqual(configurator.validateCharacterState(read("character-state-v1-basic.json")), []);
  assert.match(configurator.validateCharacterState(read("invalid/character-state-v1-equips-unheld.json")).join(), /water:pull, which it does not hold/);
});

test("seated in the next level: its id, place and motivations, the character's kit, vitals full; it plays", async () => {
  const { configurator, createPlaySession, buildUnifiedLevel, viableVitals } = await load();
  const level = buildUnifiedLevel({ id: "next", tiles: ["######", "S...E#", "######"], actors: [
    { category: "delver", id: "delver-1", position: { x: 1, y: 1 }, vitals: viableVitals(), motivations: ["user_controlled"] },
  ] });
  const characterState = read("character-state-v1-basic.json");
  const seated = configurator.seatArrivingCharacter({ initialState: level.initialState, characterState, seatId: "delver-1" });
  const seat = seated.actors.find((actor) => actor.id === "delver-1");
  assert.deepEqual(seat.position, { x: 1, y: 1 });
  assert.deepEqual(seat.motivations, ["user_controlled"]);
  assert.deepEqual(seat.vitals.health, { current: 14, max: 14, regen: 1 });
  assert.equal(seat.activeAffinityKey, "fire:push");
  assert.deepEqual(seat.affinities.map((entry) => `${entry.kind}:${entry.expression}:${entry.stacks}`), ["fire:push:3", "dark:emit:1"]);
  assert.notEqual(level.initialState.actors[0].vitals.health.max, 14, "the level's own artifact is not changed");
  const session = await createPlaySession({ simConfig: level.simConfig, initialState: seated });
  assert.equal(session.view().player.vitals.find((vital) => vital.key === "health").max, 14);
  assert.throws(() => configurator.seatArrivingCharacter({ initialState: level.initialState, characterState, seatId: "nobody" }), /no actor "nobody"/);
});

/**
 * ## TODO: Test Permutations
 *
 * - a durability-defeat character arriving in a health-defeat seat
 * - equippedAffinityStacks / Intensity below what is held survive the trip
 * - a level grant larger than the max it raised (floored at 1)
 * - seating keeps the seat's escortOf / minionOf bonds
 * - a character with no equipped affinity (activeAffinityKey null)
 */
