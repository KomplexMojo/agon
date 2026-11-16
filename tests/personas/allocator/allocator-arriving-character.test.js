const assert = require("node:assert/strict");

/**
 * #868 step 2 — a character carried in from the last level is priced by the Allocator against the
 * seat the level was priced for, with its own prices, and the difference is reported (not acted on).
 */

async function load(options = {}) {
  const { createAllocatorPersona } = await import("../../../packages/runtime/src/personas/allocator/persona.js");
  const { createConfiguratorPersona } = await import("../../../packages/runtime/src/personas/configurator/persona.js");
  const { UNUSED_CLOCK } = await import("../../../packages/runtime/src/personas/_shared/require-clock.js");
  const configurator = createConfiguratorPersona({ clock: UNUSED_CLOCK });
  return createAllocatorPersona({ clock: UNUSED_CLOCK, normalizeMotivations: configurator.normalizeMotivations, ...options });
}

const SEAT = {
  id: "delver-1", motivations: ["user_controlled"], affinitySlots: 1,
  vitals: { health: { current: 10, max: 10, regen: 1 }, mana: { current: 10, max: 10, regen: 1 }, stamina: { current: 12, max: 12, regen: 2 } },
  affinities: [{ kind: "fire", expression: "push", stacks: 1 }],
};
const withLoot = { ...SEAT, affinities: [{ kind: "fire", expression: "push", stacks: 3 }, { kind: "dark", expression: "emit", stacks: 1 }], affinitySlots: 2 };

test("a character with more holdings prices higher, and the report says by how much", async () => {
  const allocator = await load();
  const finding = allocator.priceArrivingCharacter({ authoredActor: SEAT, arrivingActor: withLoot });
  assert.equal(finding.code, "character_arrived");
  assert.equal(finding.actorId, "delver-1");
  assert.ok(finding.arrivingTokens > finding.authoredTokens);
  assert.equal(finding.deltaTokens, finding.arrivingTokens - finding.authoredTokens);
  assert.equal(finding.authoredTokens, allocator.pricing.quoteActor({ type: "delver", vitals: SEAT.vitals,
    affinities: SEAT.affinities, affinitySlots: 1, motivations: SEAT.motivations }).cost, "the same quote the character sheet uses");
  assert.match(finding.message, /tokens more than the/);
});

test("the same character arriving costs nothing extra", async () => {
  const allocator = await load();
  const finding = allocator.priceArrivingCharacter({ authoredActor: SEAT, arrivingActor: SEAT });
  assert.equal(finding.deltaTokens, 0);
  assert.match(finding.message, /worth \d+ tokens, the same as the level was priced for/);
});

test("prices the list does not hold are reported unpriced, never guessed", async () => {
  const { readFileSync } = require("node:fs");
  const priceList = JSON.parse(readFileSync(require("node:path").join(__dirname, "../../fixtures/artifacts/price-list-artifact-v1-basic.json"), "utf8"));
  const allocator = await load({ priceList });
  const finding = allocator.priceArrivingCharacter({ authoredActor: SEAT, arrivingActor: withLoot });
  assert.equal(finding.code, "character_unpriced");
  assert.match(finding.message, /could not be priced/);
  assert.equal(finding.deltaTokens, undefined);
});

/**
 * ## TODO: Test Permutations
 *
 * - a character that lost affinity slots prices lower (negative delta)
 * - vital regen raised by a permanent grant prices higher
 * - intensity 2 on one affinity versus two stacks
 * - a price list override changes both quotes the same way
 */
