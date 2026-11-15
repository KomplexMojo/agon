// #865: player-facing wording as { id, params }, so a game can re-word or translate it.
const assert = require("node:assert/strict");

const EXEMPT_STRING_PARAMS = new Set(["label", "targetLabel", "sourceLabel", "error", "battleLine"]);

function stringParamsWithSpaces(value, path = "params") {
  if (typeof value === "string") return value.includes(" ") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringParamsWithSpaces(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => (EXEMPT_STRING_PARAMS.has(key) ? [] : stringParamsWithSpaces(item, `${path}.${key}`)));
  }
  return [];
}

const PLAYER = {
  id: "D1", position: { x: 2, y: 2 },
  vitals: [{ key: "mana", current: 4 }, { key: "stamina", current: 1 }],
  equippedAffinityKeys: ["fire:push"], castableAffinities: { "fire:push": { mana: 6 } },
  moveStamina: { step: 2, diagonal: 3, sprint: 5 },
};

test("every id has a default template and MESSAGE_IDS names itself", async () => {
  const { MESSAGE_IDS, DEFAULT_MESSAGES } = await import("../../packages/runtime/src/controls/message-catalogue.js");
  assert.ok(Object.keys(MESSAGE_IDS).length > 40);
  for (const [key, id] of Object.entries(MESSAGE_IDS)) {
    assert.equal(key, id);
    assert.equal(typeof DEFAULT_MESSAGES[id], "function", id);
  }
});

test("formatMessage words a known id, brackets an unknown one, and takes an override", async () => {
  const { formatMessage } = await import("../../packages/runtime/src/controls/message-catalogue.js");
  assert.equal(formatMessage({ id: "slot.empty", params: { slot: 2 } }), "Slot 2 is empty.");
  assert.equal(formatMessage({ id: "no.such.id", params: {} }), "[no.such.id]");
  assert.equal(formatMessage({ id: "slot.empty", params: { slot: 2 } }, { "slot.empty": ({ slot }) => `Emplacement ${slot} vide.` }), "Emplacement 2 vide.");
});

test("the string functions keep today's English, worded from their data twins", async () => {
  const m = await import("../../packages/runtime/src/controls/messages.js");
  assert.equal(m.rejectionMessage("BlockedByWall"), "A wall blocks the way.");
  assert.equal(m.rejectionMessage("Weird"), "Rejected (Weird).");
  assert.equal(m.rejectionMessage("InsufficientMana", PLAYER, {}), "Not enough mana: fire push costs 6, you have 4.");
  assert.equal(m.rejectionMessage("InsufficientStamina", PLAYER, { target: { x: 3, y: 3 } }), "Too tired to move: it costs 3 stamina, you have 1.");
  assert.equal(m.rejectionMessage("InsufficientStamina", PLAYER, { target: { x: 4, y: 2 }, via: { x: 3, y: 2 } }), "Too tired to sprint: it costs 5 stamina, you have 1.");
  assert.deepEqual(m.rejectionMessageData("InsufficientMana", PLAYER, {}), { id: "rejection.manaCost", params: { affinityKey: "fire:push", cost: 6, have: 4 } });

  const view = {
    tick: 5, player: { id: "D1" },
    casts: [
      { sourceId: "D1", targetId: "W1", kind: "decay", expression: "push", changes: [{ actorId: "W1", vital: "health", delta: -8 }] },
      { sourceId: "W1", targetId: "D1", sourceLabel: "Warden", kind: "growth", expression: "push", changes: [] },
    ],
    vitalChanges: [{ actorId: "D1", vital: "health", hit: -3, regen: 1, current: 7, max: 10 }],
  };
  assert.deepEqual(m.battleLines(view), { own: "You hit W1 with decay push: HP −8", others: ["Warden hits you with growth push: no effect"] });
  assert.equal(m.vitalChangeLine(view), "You HP 7/10 (−3 +1)");
  assert.equal(m.vitalChangeLine({ player: { id: "D1" } }), "");
  assert.equal(m.takeRefusal({ player: { position: { x: 0, y: 0 } } }), "Nothing here to take.");
});

test("no param is pre-formatted English (no string with a space outside names and errors)", async () => {
  const m = await import("../../packages/runtime/src/controls/messages.js");
  const view = {
    tick: 5, player: { id: "D1", position: { x: 0, y: 0 } },
    casts: [{ sourceId: "D1", targetId: "W1", targetLabel: "Old Warden", kind: "decay", expression: "push", changes: [{ actorId: "W1", vital: "health", delta: -8 }] }],
    vitalChanges: [{ actorId: "W1", label: "Old Warden", vital: "health", hit: -3, regen: 0 }],
    actors: [{ id: "R1", role: "resource", position: { x: 1, y: 0 } }],
  };
  const data = [
    m.rejectionMessageData("InsufficientMana", PLAYER, {}), m.rejectionMessageData("InsufficientStamina", PLAYER, { target: { x: 3, y: 3 } }),
    m.battleLinesData(view).own, m.vitalChangeData(view), m.takeRefusalData(view),
  ];
  for (const item of data) assert.deepEqual(stringParamsWithSpaces(item.params), [], item.id);
});

test("a controller given a catalogue shows the override, and frame() carries messageData", async () => {
  const { createGameController } = await import("../../packages/runtime/src/controls/game-controller.js");
  const { loadBundledLevels } = require("../../packages/ui-ascii/src/levels.js");
  const game = await createGameController({ levels: loadBundledLevels(), showHelp: false,
    messages: { "sprint.armed": () => "Sprint prêt." } });
  await game.handle({ type: "sprint" });
  assert.equal(game.frame().message, "Sprint prêt.");
  assert.deepEqual(game.frame().messageData, [{ id: "sprint.armed", params: {} }]);
  for (const item of game.frame().messageData) assert.deepEqual(stringParamsWithSpaces(item.params), []);
});

// ## TODO: Test Permutations
// - every controller branch that sets a message produces an id in MESSAGE_IDS
// - battle.allyWarning with and without a change suffix matches allyWarningLines
// - take.vital with intact/spent combinations words exactly as before
// - a catalogue override for a rejection id applies to switchTo refusals too
