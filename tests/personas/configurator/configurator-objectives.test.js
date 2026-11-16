const assert = require("node:assert/strict");

/**
 * #867 step 4 — the Configurator authors and checks level objectives: the `--objective` grammar,
 * and a refusal for any objective the level cannot satisfy (a named actor or role it does not
 * hold, more holdings than it has to collect). An authored level carries the checked list on its
 * SimConfig; a level without one is unchanged.
 */

const CREATED_AT = "2026-11-16T00:00:00.000Z";

async function load() {
  const { createConfiguratorPersona } = await import("../../../packages/runtime/src/personas/configurator/persona.js");
  const { authorLevel } = await import("../../../packages/runtime/src/commands/author-level.js");
  const { createRecordedSolverAdapter } = await import("../../../packages/adapters-web/src/adapters/solver-recorded/index.js");
  const { UNUSED_CLOCK } = await import("../../../packages/runtime/src/personas/_shared/require-clock.js");
  return { configurator: createConfiguratorPersona({ clock: UNUSED_CLOCK }), authorLevel, createRecordedSolverAdapter };
}

const ROSTER = [
  { id: "delver-1", motivations: ["user_controlled"], affinities: [{ kind: "fire" }], holdings: [] },
  { id: "warden-1", motivations: ["defending"], affinities: [{ kind: "dark" }], holdings: [] },
  { id: "chest-1", holdings: [{ id: "potion", kind: "vital" }] },
];
const PRESENTATION = { "delver-1": { category: "delver" }, "warden-1": { category: "warden" }, "chest-1": { category: "resource" } };
const check = (configurator, objectives) => configurator.checkLevelObjectives({ objectives, actors: ROSTER, presentation: PRESENTATION });

test("the spec grammar reads every kind's params", async () => {
  const { configurator } = await load();
  assert.deepEqual(configurator.parseObjectiveSpec("kind=defeat;role=warden"),
    { id: "defeat", kind: "defeat", params: { role: "warden" }, required: true });
  assert.deepEqual(configurator.parseObjectiveSpec("kind=defeat;actorIds=a, b;id=boss", 1),
    { id: "boss", kind: "defeat", params: { actorIds: ["a", "b"] }, required: true });
  assert.deepEqual(configurator.parseObjectiveSpec("kind=collect;count=2;holdingKind=vital;required=false", 2),
    { id: "collect-3", kind: "collect", params: { count: 2, holdingKind: "vital" }, required: false });
  assert.deepEqual(configurator.parseObjectiveSpec("kind=survive;ticks=30").params, { ticks: 30 });
  assert.throws(() => configurator.parseObjectiveSpec("kind=win"), /needs kind= one of/);
  assert.throws(() => configurator.parseObjectiveSpec("kind=defeat;boss"), /must be key=value/);
  assert.throws(() => configurator.parseObjectiveSpec("kind=defeat;target=x"), /is not one of/);
});

test("a level that can satisfy its objectives passes", async () => {
  const { configurator } = await load();
  assert.deepEqual(check(configurator, [
    { id: "slay", kind: "defeat", params: { role: "warden" }, required: true },
    { id: "loot", kind: "collect", params: { count: 2 }, required: false },
    { id: "out", kind: "reach_exit", params: {}, required: true },
  ]), []);
});

test("refusals: unknown actor, missing role, escort of nobody, too little to collect, bad shape", async () => {
  const { configurator } = await load();
  assert.match(check(configurator, [{ id: "boss", kind: "defeat", params: { actorIds: ["ogre"] }, required: true }])[0], /no actor "ogre"/);
  assert.match(check(configurator, [{ id: "slay", kind: "defeat", params: { role: "hazard" }, required: true }])[0], /role "hazard"/);
  assert.match(check(configurator, [{ id: "guide", kind: "escort", params: { actorId: "pilgrim" }, required: true }])[0], /no actor "pilgrim"/);
  assert.match(check(configurator, [{ id: "loot", kind: "collect", params: { count: 2, holdingKind: "vital" }, required: true }])[0],
    /asks for 2 vital holdings but the level has 1/);
  // The party's own affinities are not something to collect: only the warden's one counts.
  assert.match(check(configurator, [{ id: "loot", kind: "collect", params: { count: 2, holdingKind: "affinity" }, required: true }])[0],
    /the level has 1/);
  assert.match(check(configurator, [{ id: "hold", kind: "survive", params: { ticks: 0 }, required: true }])[0], /ticks must be a whole number/);
});

test("agon create --objective puts the checked list on the SimConfig, and refuses one the level cannot meet", async () => {
  const { authorLevel, createRecordedSolverAdapter } = await load();
  const base = ["--created-at", CREATED_AT, "--run-id", "objectives", "--seed", "1", "--room", "size=small;count=1", "--delver", "count=1;motivation=user_controlled"];
  const plain = await authorLevel(base, { adapter: createRecordedSolverAdapter([]) });
  assert.equal(plain.buildResult.simConfig.objectives, undefined, "no --objective: the level is as before");
  const timed = await authorLevel([...base, "--objective", "kind=reach_exit", "--objective", "kind=within;ticks=50"],
    { adapter: createRecordedSolverAdapter([]) });
  assert.deepEqual(timed.buildResult.simConfig.objectives, [
    { id: "reach_exit", kind: "reach_exit", params: {}, required: true },
    { id: "within-2", kind: "within", params: { ticks: 50 }, required: true },
  ]);
  await assert.rejects(authorLevel([...base, "--objective", "kind=defeat;role=warden"], { adapter: createRecordedSolverAdapter([]) }),
    /no actor in this level has the role "warden"/);
});

/**
 * ## TODO: Test Permutations
 *
 * - collect with no holdingKind sums vital and affinity holdings
 * - defeat by actorIds naming one real and one missing actor (one refusal, not two)
 * - an escort target that is the player itself
 * - --objective with required=false alone (refused: needs a required objective)
 * - the agon_create MCP objectives field gives the same SimConfig as the flag
 */
