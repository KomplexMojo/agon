/**
 * #864: turn events, what happened each tick as data, so a client can animate, shake, play sound
 * and keep a log without comparing two views. The Annotator derives every entry (battle log,
 * `personas/annotator/battle-log.js`); the play session only filters them to what the seat may
 * read and hands them out as `result.events` beside `result.cues`.
 *
 * Every event has `tick`, `seq` (its order within the run) and `event`, plus the fields of its kind:
 *
 * @typedef {{ x: number, y: number }} TurnEventCell
 * @typedef {{ tick: number, seq: number, event: "move", sourceId: string, from?: TurnEventCell, to: TurnEventCell, sprint: boolean }} MoveTurnEvent
 *   `from` is left out when the seat did not see the cell the mover came from.
 * @typedef {{ tick: number, seq: number, event: "cast", sourceId: string, targetId?: string, kind: string, expression: string, struck: boolean, reception?: string, hit?: string, condition?: string, struckVital?: string, struckCondition?: string }} CastTurnEvent
 *   `hit`, `condition`, `struckVital` and `struckCondition` are words (#692), only on a cast our side landed on someone else.
 * @typedef {{ tick: number, seq: number, event: "field", sourceId: string, targetId: string, kind: string, expression: string }} FieldTurnEvent
 *   A lasting field (emit, draw) that started hurting `targetId` this tick.
 * @typedef {{ tick: number, seq: number, event: "vital", targetId: string, vital: string, delta: number, regen: number }} VitalTurnEvent
 *   Numbers, so only for the seat's own side (Darren, 2026-11-15). `regen` is the part of `delta` regeneration gave back.
 * @typedef {{ tick: number, seq: number, event: "take", sourceId: string, targetId: string, taken?: object }} TakeTurnEvent
 * @typedef {{ tick: number, seq: number, event: "defeat", targetId: string, defeatVital?: string, sourceId?: string, kind?: string, expression?: string }} DefeatTurnEvent
 * @typedef {{ tick: number, seq: number, event: "exit", targetId: string }} ExitTurnEvent
 * @typedef {MoveTurnEvent | CastTurnEvent | FieldTurnEvent | VitalTurnEvent | TakeTurnEvent | DefeatTurnEvent | ExitTurnEvent} TurnEvent
 */

/** Every turn event kind, in the order a tick produces them. */
export const TURN_EVENT_KINDS = Object.freeze(["move", "cast", "field", "vital", "take", "defeat", "exit"]);

const FIELDS = Object.freeze({
  move: ["sourceId", "from", "to", "sprint"],
  cast: ["sourceId", "targetId", "kind", "expression", "struck", "reception"],
  field: ["sourceId", "targetId", "kind", "expression"],
  vital: ["targetId", "vital", "delta", "regen"],
  take: ["sourceId", "targetId", "taken"],
  defeat: ["targetId", "defeatVital", "sourceId", "kind", "expression"],
  exit: ["targetId"],
});
const CAST_WORDS = Object.freeze(["hit", "condition", "struckVital", "struckCondition"]);

const copy = (value) => (value && typeof value === "object" ? structuredClone(value) : value);

/**
 * The turn event for one Annotator battle-log entry, or null for a kind that is not one.
 * `words`: keep the #692 words on a cast (our side's hit on someone else). `fromSeen`: keep a move's `from`.
 */
export function toTurnEvent(entry, seq, { words = false, fromSeen = true } = {}) {
  const fields = FIELDS[entry?.event];
  if (!fields) return null;
  const event = { tick: entry.tick, seq, event: entry.event };
  const keys = entry.event === "cast" && words ? [...fields, ...CAST_WORDS] : fields;
  for (const key of keys) {
    if (key === "from" && !fromSeen) continue;
    if (entry[key] !== undefined) event[key] = copy(entry[key]);
  }
  return event;
}
