/**
 * The player-facing wording as message ids plus parameters (#865), so a game can re-word or
 * translate what the controls say without matching English text.
 *
 * Every sentence the controls produce has an id in `MESSAGE_IDS`, and `DEFAULT_MESSAGES` holds
 * today's English for it as a template `(params) => string`. The controls build `{ id, params }`
 * (the data twins in `messages.js` and the game controller) and format through
 * `formatMessage`, so a catalogue passed to `createGameController({ messages })` changes the
 * words and nothing else.
 *
 * Params are data, not text: numbers, ids, affinity keys (`fire:push`), vital keys, positions,
 * grants. The exceptions are names an author gave (`label`, `targetLabel`, `sourceLabel`), an
 * Actor validation error (`error`), and a battle-log line (`battleLine`, render's wording,
 * #554), which this catalogue does not own.
 */
import { HUD_VITAL_LABELS } from "../render/actor-hud-model.js";
import { aimLabel, grantLabel, keyLabel, LEVELS, signed } from "./messages.js";

/** Friendlier words for core's rejection codes; the raw name is the fallback. */
export const REJECTION_MESSAGES = Object.freeze({
  BlockedByWall: "A wall blocks the way.",
  ActorCollision: "Something is in the way.",
  OutOfBounds: "You cannot leave the map that way.",
  InsufficientStamina: "Too tired to move.",
  InsufficientMana: "Not enough mana.",
  NoActiveAffinity: "Nothing is equipped. Press i to equip an affinity.",
  AffinityNotCastable: "Emit and draw work on their own while equipped. Only push and pull are cast.",
  TargetOutOfRange: "Out of range. The target panel shows how far each cast reaches.",
  InvalidTarget: "That cannot be targeted.",
  UnknownAffinity: "You do not know that affinity.",
  AffinityAlreadyEquipped: "That affinity is already equipped.",
  NothingToTake: "Nothing left to take there.",
  NotAdjacent: "Too far away to take that.",
  InvalidCapability: "You cannot do that.",
  AffinityNotEquipped: "That affinity is not equipped.",
  InvalidAffinityStacks: "You cannot run it at that range.",
  InvalidAffinityIntensity: "You cannot run it at that intensity.",
  not_playable: "Only your party (actors authored user_controlled) takes your commands.",
  unknown_actor: "No actor goes by that name.",
  exited: "They have already left the level.",
  defeated: "They were defeated.",
  not_yours: "Only your party and actors on your side take orders.",
});


const vitalName = (vital) => HUD_VITAL_LABELS[vital] ?? vital;
const changeWords = ({ vital, delta }) => `${vitalName(vital)} ${delta < 0 ? "−" : "+"}${Math.abs(delta)}`;
const castWords = ({ affinityKey, changes = [] }) => `${keyLabel(affinityKey)}: ${changes.length ? changes.map(changeWords).join(", ") : "no effect"}`;
const lootWords = (item = {}) => (item.kind === "affinity" ? `${item.affinity} ${item.expression}`
  : item.vitals?.length ? grantLabel(item) : "a vital boost");
const levelName = (field) => LEVELS[field]?.name ?? field;
const pairLevel = ({ stacks, intensity }) => `r${stacks} ×${intensity ?? 1}`;

const REJECTION_TEMPLATES = Object.fromEntries(Object.entries(REJECTION_MESSAGES)
  .map(([reason, text]) => [`rejection.${reason}`, () => text]));

/** @type {Readonly<Record<string, (params: object) => string>>} */
export const DEFAULT_MESSAGES = Object.freeze({
  ...REJECTION_TEMPLATES,
  "rejection.unknown": ({ reason }) => `Rejected (${reason}).`,
  "rejection.manaCost": ({ affinityKey, cost, have }) => `Not enough mana: ${keyLabel(affinityKey)} costs ${cost}, you have ${have}.`,
  "rejection.staminaCost": ({ sprint, cost, have }) => `Too tired to ${sprint ? "sprint" : "move"}: it costs ${cost} stamina, you have ${have}.`,

  "battle.ownHit": (p) => `You hit ${p.targetLabel ?? p.targetId} with ${castWords(p)}`,
  "battle.hitBy": (p) => `${p.sourceLabel ?? p.sourceId} hits you with ${castWords(p)}`,
  "battle.allyWarning": ({ battleLine, change }) => `${battleLine.replace(/\.$/, "")}${change ? ` (${changeWords(change)})` : ""}.`,
  "battle.allyWarningDetailed": ({ battleLine }) => battleLine,
  "vitals.changes": ({ changes = [] }) => changes.map((change) => {
    const who = change.self ? "You" : change.label ?? change.actorId;
    const regen = change.regen !== 0 ? ` ${signed(change.regen)}` : "";
    const amount = change.self ? ` ${change.current}/${change.max}` : "";
    return `${who} ${vitalName(change.vital)}${amount} (${signed(change.hit)}${regen})`;
  }).join("  "),

  "take.sealedAlly": ({ targetId, targetLabel }) => `${targetLabel ?? targetId}'s gear stays with them — allies do not strip fallen allies.`,
  "take.nothingHere": () => "Nothing here to take.",
  "take.spent": ({ targetId }) => `${targetId} has nothing left to take.`,
  "take.stillStanding": ({ targetId, targetLabel }) => `${targetLabel ?? targetId} is still standing: defeat it first, then g takes what it held.`,
  "take.vital": ({ targetId, item, intact, spent }) => `You take ${targetId}: ${lootWords(item)}.${intact ? ` It stays on the floor${spent ? ", spent" : ""}.` : ""}`,
  "take.from": ({ targetId, item }) => `You take ${lootWords(item)} from ${targetId}.`,

  "level.resumeStale": () => "The saved run could not be resumed on this version, so the level starts fresh.",
  "level.last": () => "That was the last level. Press r to replay it or q to quit.",
  "seat.switched": ({ actorId, label }) => `You now play ${actorId}${label ? ` (${label})` : ""}.`,
  "seat.noOtherMember": () => "No one else in your party to play.",
  "order.invalid": ({ error }) => `That order does not make sense: ${error}`,
  "order.taken": ({ actorId, label }) => `${label ?? actorId} takes the order.`,
  "order.noneOnSide": () => "No one on your side to order.",
  "advance.contact": () => "Someone hostile comes into sight.",
  "advance.ordersDone": () => "Every order has run its course.",
  "affinities.noneKnown": () => "You know no affinities yet.",
  "relevel.equipFirst": () => "Equip it first (press its number).",
  "relevel.atLowest": ({ field }) => `It already runs at its lowest ${levelName(field)}, 1.`,
  "relevel.atHeld": ({ field, held }) => `It already runs at all the ${levelName(field)} you hold, ${held}.`,
  "relevel.done": ({ affinityKey, field, value, held }) => `${keyLabel(affinityKey)} now runs at ${levelName(field)} ${value} of ${held}.`,
  "inspect.none": () => "Nothing in sight to inspect.",
  "inspect.study": ({ targetId }) => `You study ${targetId}.`,
  "watch.none": () => "Nothing in sight to watch.",
  "watch.start": ({ targetId }) => `You watch ${targetId}.`,
  "watch.stop": ({ targetId }) => `You stop watching ${targetId}.`,
  "raise.needPush": () => "Equip a push to raise a barrier.",
  "raise.done": ({ affinityKey, from, to, count }) => `You raise ${keyLabel(affinityKey)} ${aimLabel(from, to)}: ${count} barrier${count === 1 ? "" : "s"}.`,
  "cast.atTile": ({ affinityKey, from, to }) => `You cast ${keyLabel(affinityKey)} ${aimLabel(from, to)}.`,
  "cast.atTarget": ({ affinityKey, targetId }) => `You cast ${keyLabel(affinityKey)} at ${targetId}.`,
  "slot.empty": ({ slot }) => `Slot ${slot} is empty.`,
  "slot.passive": ({ affinityKey }) => `${keyLabel(affinityKey)} works on its own while equipped.`,
  "affinity.unequipped": ({ affinityKey }) => `Unequipped ${keyLabel(affinityKey)}.`,
  "affinity.equipped": ({ affinityKey, stacks, intensity, replacedKey }) =>
    `Equipped ${keyLabel(affinityKey)} ${pairLevel({ stacks, intensity })}${replacedKey ? ` in place of ${keyLabel(replacedKey)}` : ""}.`,
  "move.sprint": () => "You sprint.",
  "sprint.armed": () => "Sprint armed.",
  "sprint.off": () => "Sprint off.",
});

/** Every message id, as `MESSAGE_IDS[id] === id`. */
export const MESSAGE_IDS = Object.freeze(Object.fromEntries(Object.keys(DEFAULT_MESSAGES).map((id) => [id, id])));

/** A message as data. */
export const msg = (id, params = {}) => ({ id, params });

/**
 * The words for one `{ id, params }`, from `catalogue` (defaults to `DEFAULT_MESSAGES`). An id the
 * catalogue does not know reads as `[id]` rather than throwing.
 */
export function formatMessage(message, catalogue = DEFAULT_MESSAGES) {
  if (!message?.id) return "";
  const template = catalogue?.[message.id] ?? DEFAULT_MESSAGES[message.id];
  return typeof template === "function" ? template(message.params ?? {}) : `[${message.id}]`;
}
