/**
 * #868 step 3 — carrying the player's character from one level to the next, through the session
 * and the game controller. A player who leaves has a CharacterState (permanent loot carries, a
 * one-level grant does not, vitals refill); the next level seats it and reports the Allocator's
 * price of it; a capture replays only with the character it started with; and a controller with
 * carry off plays every level exactly as authored.
 */
const assert = require("node:assert/strict");

const { createPlaySession, replayPlaySession } = require("../../packages/runtime/src/runner/play-session.js");
const { createGameController } = require("../../packages/runtime/src/controls/game-controller.js");
const { buildUnifiedLevel, viableVitals } = require("../fixtures/ui-ascii/unified-level.mjs");

const TILES = ["#######", "S....E#", "##.####", "#######"];
const PLAYER = { category: "delver", id: "hero", position: { x: 1, y: 1 }, vitals: viableVitals(), motivations: ["user_controlled"],
  affinities: [{ kind: "fire", expression: "push", stacks: 1 }], activeAffinityKey: "fire:push" };
const CHEST = {
  category: "resource", id: "chest", position: { x: 2, y: 2 },
  vitals: { durability: { current: 1, max: 1, regen: 0 } },
  holdings: [
    { id: "elixir", kind: "vital", permanenceMode: "permanent", claimedBy: null, vitals: [{ key: "health", delta: 5 }] },
    { id: "draught", kind: "vital", permanenceMode: "level", claimedBy: null, vitals: [{ key: "mana", delta: 4 }] },
  ],
};
const META = { id: "hero-out-of-1", runId: "run-carry", createdAt: "2026-11-16T00:00:00.000Z" };
const CAPTURE_META = { id: "capture-carry", runId: "run-carry", createdAt: "2026-11-16T00:00:00.000Z" };
const levelOne = () => buildUnifiedLevel({ id: "one", tiles: TILES, actors: [PLAYER, CHEST] });
const levelTwo = () => buildUnifiedLevel({ id: "two", tiles: TILES, actors: [{ ...PLAYER, affinities: [], activeAffinityKey: null }] });

const move = (direction) => ({ kind: "move", params: { direction } });
const take = (holdingId) => ({ kind: "take", params: { targetId: "chest", holdingId } });

async function lootAndLeave(session) {
  await session.act(move("east"));
  assert.equal((await session.act(take("elixir"))).accepted.length, 1);
  assert.equal((await session.act(take("draught"))).accepted.length, 1);
  for (const direction of ["east", "east", "east"]) await session.act(move(direction));
  await session.act({ kind: "wait" });
  assert.equal(session.status().exited, true);
}

test("the character that leaves: permanent loot carries, a one-level grant does not", async () => {
  const session = await createPlaySession(levelOne());
  await assert.rejects(async () => session.characterState({ meta: META }), /has not left/);
  await lootAndLeave(session);
  const state = session.characterState({ meta: META });
  assert.equal(state.schema, "agon/CharacterState");
  assert.equal(state.actorId, "hero");
  assert.equal(state.character.vitals.health.max, viableVitals().health.max + 5);
  assert.equal(state.character.vitals.mana.max, viableVitals().mana.max, "the draught lasted one level");
  assert.deepEqual(state.character.equippedAffinityKeys, ["fire:push"]);
});

test("the next level seats it, full, and the Allocator reports what it is worth", async () => {
  const first = await createPlaySession(levelOne());
  await lootAndLeave(first);
  const arrivingCharacter = first.characterState({ meta: META });
  const plain = await createPlaySession(levelTwo());
  const carried = await createPlaySession({ ...levelTwo(), arrivingCharacter });
  const health = carried.view().player.vitals.find((vital) => vital.key === "health");
  assert.deepEqual([health.current, health.max], [viableVitals().health.max + 5, viableVitals().health.max + 5]);
  assert.deepEqual(carried.view().player.position, { x: 1, y: 1 }, "it arrives at the level's own seat");
  assert.equal(plain.pricingReport.some((finding) => finding.code === "character_arrived"), false);
  const finding = carried.pricingReport.find((entry) => entry.code === "character_arrived");
  assert.ok(finding.deltaTokens > 0, JSON.stringify(finding));
});

test("a capture replays only with the character it started with", async () => {
  const first = await createPlaySession(levelOne());
  await lootAndLeave(first);
  const arrivingCharacter = first.characterState({ meta: META });
  const played = await createPlaySession({ ...levelTwo(), arrivingCharacter });
  await played.act(move("east"));
  const capture = JSON.parse(JSON.stringify(played.captureInput({ meta: CAPTURE_META })));
  assert.equal(capture.payload.characterStateId, "hero-out-of-1");
  const replayed = await replayPlaySession({ ...levelTwo(), capturedInput: capture, arrivingCharacter });
  assert.deepEqual(replayed.view(), played.view());
  await assert.rejects(replayPlaySession({ ...levelTwo(), capturedInput: capture }), /started with character hero-out-of-1, not the level's own/);
  const other = { ...arrivingCharacter, meta: { ...arrivingCharacter.meta, id: "someone-else" } };
  await assert.rejects(replayPlaySession({ ...levelTwo(), capturedInput: capture, arrivingCharacter: other }), /not someone-else/);
});

test("the controller: carry off plays level two as authored, carry on brings the loot", async () => {
  const levels = [{ name: "one", ...levelOne() }, { name: "two", ...levelTwo() }];
  async function playThrough(carry) {
    const game = await createGameController({ levels, carry, fog: false });
    for (const command of [move("east"), take("elixir"), take("draught"), move("east"), move("east"), move("east"), { kind: "wait" }]) {
      await game.command(command);
    }
    await game.handle({ type: "next_level" });
    return game;
  }
  const off = await playThrough(false);
  const offHealth = off.view().player.vitals.find((vital) => vital.key === "health");
  assert.equal(offHealth.max, viableVitals().health.max);
  assert.equal(off.arrivingCharacter(), null);
  const on = await playThrough(true);
  assert.equal(on.view().player.vitals.find((vital) => vital.key === "health").max, viableVitals().health.max + 5);
  assert.equal(on.arrivingCharacter().actorId, "hero");
});

/**
 * ## TODO: Test Permutations
 *
 * - a defeated player has no character to carry (characterState refuses)
 * - carry across three levels: loot from level one and two both arrive in three
 * - restart of a carried level restarts with the same arriving character
 * - resume of a carried level with resume.arrivingCharacter reproduces the save
 * - a character carried into a level whose seat defeats on durability
 */
