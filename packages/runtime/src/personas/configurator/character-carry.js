/**
 * #868 — carrying the player's character from one level to the next. Actor configuration is the
 * Configurator's, so it both writes the character down as it leaves (`characterStateFromActor`)
 * and seats it in the next level (`seatArrivingCharacter`). Darren's rule (2026-11-15): holdings
 * carry, vitals refill, and the Allocator prices the arriving character (not here).
 *
 * What carries: affinities with their stacks and intensity, affinity slots, which are equipped (and
 * at what stacks and intensity), and each vital's max and regen. A grant that lasts one level
 * (`permanenceMode: "level"`) is taken back off the max and regen it raised. What does not:
 * position, damage (vitals arrive full), lifecycle, and everything that belongs to the level it
 * left (watches, soak, regen pauses, exhaustion). Identity, position, alignment, capabilities and
 * motivations stay the next level's own: the character fills the seat, it does not move it.
 */
import { CHARACTER_STATE_SCHEMA } from "../../contracts/artifacts.ts";
import { PERSONA_IDS, stampPersona } from "../_shared/persona-stamp.js";

const VITAL_KINDS = ["health", "durability", "mana", "stamina"];
const keyOf = (entry) => `${entry.kind}:${entry.expression}`;
const isWhole = (value, min) => Number.isSafeInteger(value) && value >= min;

function equippedKeys(actor) {
  if (Array.isArray(actor.equippedAffinityKeys) && actor.equippedAffinityKeys.length > 0) return [...actor.equippedAffinityKeys];
  return typeof actor.activeAffinityKey === "string" ? [actor.activeAffinityKey] : [];
}

/**
 * The character an actor carries out of a level.
 * @param {object} args
 * @param {object} args.actor        the actor's record as it left (the session's final snapshot)
 * @param {object[]} [args.levelGrants]  the vital holdings it took that last one level
 *                                       (`{ vitals: [{ key, delta, regen? }] }`), taken back off
 * @param {object} args.meta         the artifact's meta (`id`, `runId`, `createdAt`)
 * @param {{ simConfigId: string, initialStateId: string }} [args.fromLevel]
 */
export function characterStateFromActor({ actor, levelGrants = [], meta, fromLevel } = {}) {
  if (!actor || typeof actor.id !== "string") throw new Error("characterStateFromActor: an actor record is required");
  if (!meta?.id || !meta?.runId || !meta?.createdAt) throw new Error("characterStateFromActor: meta with id, runId and createdAt is required");
  const vitals = {};
  for (const kind of VITAL_KINDS) {
    const vital = actor.vitals?.[kind];
    if (vital) vitals[kind] = { max: vital.max, regen: vital.regen };
  }
  for (const grant of levelGrants.flatMap((holding) => holding?.vitals ?? [])) {
    const vital = vitals[grant.key];
    if (!vital) continue;
    vital.max = Math.max(1, vital.max - grant.delta);
    vital.regen = Math.max(0, vital.regen - (grant.regen ?? 0));
  }
  const character = {
    defeatVital: actor.defeatVital,
    vitals,
    ...(actor.affinitySlots !== undefined ? { affinitySlots: actor.affinitySlots } : {}),
    affinities: (actor.affinities ?? []).map((entry) => ({ ...entry })),
    equippedAffinityKeys: equippedKeys(actor),
    ...(actor.equippedAffinityStacks ? { equippedAffinityStacks: { ...actor.equippedAffinityStacks } } : {}),
    ...(actor.equippedAffinityIntensity ? { equippedAffinityIntensity: { ...actor.equippedAffinityIntensity } } : {}),
  };
  const artifact = {
    schema: CHARACTER_STATE_SCHEMA,
    schemaVersion: 1,
    meta: stampPersona(meta, PERSONA_IDS.configurator),
    actorId: actor.id,
    ...(fromLevel ? { fromLevel: { simConfigId: fromLevel.simConfigId, initialStateId: fromLevel.initialStateId } } : {}),
    character,
  };
  const errors = validateCharacterState(artifact);
  if (errors.length > 0) throw new Error(`characterStateFromActor: ${errors.join("; ")}`);
  return structuredClone(artifact);
}

/** Shape errors in a CharacterState (empty when it is valid). */
export function validateCharacterState(artifact) {
  const errors = [];
  if (!artifact || artifact.schema !== CHARACTER_STATE_SCHEMA || artifact.schemaVersion !== 1) {
    return [`not an ${CHARACTER_STATE_SCHEMA} v1 artifact`];
  }
  if (!artifact.meta?.id) errors.push("meta.id is required");
  if (typeof artifact.actorId !== "string" || !artifact.actorId) errors.push("actorId is required");
  const character = artifact.character;
  if (!character || typeof character !== "object") return [...errors, "character is required"];
  if (!["health", "durability"].includes(character.defeatVital)) errors.push("character.defeatVital must be health or durability");
  for (const [kind, vital] of Object.entries(character.vitals ?? {})) {
    if (!VITAL_KINDS.includes(kind)) errors.push(`character.vitals.${kind} is not a vital`);
    else if (!isWhole(vital?.max, 1) || !Number.isFinite(vital?.regen) || vital.regen < 0) {
      errors.push(`character.vitals.${kind} needs a max of at least 1 and a regen of 0 or more`);
    }
  }
  if (!character.vitals?.[character.defeatVital]) errors.push("character.vitals must hold its defeat vital");
  if (!Array.isArray(character.affinities)) errors.push("character.affinities must be a list");
  const held = new Set((character.affinities ?? []).map(keyOf));
  for (const entry of character.affinities ?? []) {
    if (!isWhole(entry?.stacks, 1)) errors.push(`character.affinities ${keyOf(entry ?? {})} needs stacks of at least 1`);
  }
  if (!Array.isArray(character.equippedAffinityKeys)) errors.push("character.equippedAffinityKeys must be a list");
  for (const key of character.equippedAffinityKeys ?? []) {
    if (!held.has(key)) errors.push(`character.equippedAffinityKeys names ${key}, which it does not hold`);
  }
  if (character.affinitySlots !== undefined && !isWhole(character.affinitySlots, 1)) errors.push("character.affinitySlots must be a whole number of at least 1");
  return errors;
}

/**
 * A level's `initialState` with the arriving character in the seat: the seat keeps its id,
 * position, alignment, capabilities and motivations, and takes the character's affinities,
 * equipment and vitals (full).
 * @param {object} args
 * @param {object} args.initialState    the next level's InitialState
 * @param {object} args.characterState  the CharacterState that arrives
 * @param {string} args.seatId          the actor it arrives as (the level's player)
 */
export function seatArrivingCharacter({ initialState, characterState, seatId } = {}) {
  const errors = validateCharacterState(characterState);
  if (errors.length > 0) throw new Error(`seatArrivingCharacter: ${errors.join("; ")}`);
  const actors = Array.isArray(initialState?.actors) ? initialState.actors : [];
  const seat = actors.find((actor) => actor?.id === seatId);
  if (!seat) throw new Error(`seatArrivingCharacter: no actor "${seatId}" in this level`);
  const { character } = characterState;
  const [active = null, ...rest] = character.equippedAffinityKeys;
  const arrived = {
    id: seat.id,
    position: { ...seat.position },
    alignment: seat.alignment,
    lifecycle: "alive",
    defeatVital: character.defeatVital,
    vitals: Object.fromEntries(Object.entries(character.vitals)
      .map(([kind, vital]) => [kind, { current: vital.max, max: vital.max, regen: vital.regen }])),
    capabilities: { ...seat.capabilities },
    motivations: [...seat.motivations],
    affinities: character.affinities.map((entry) => ({ ...entry })),
    activeAffinityKey: active,
    ...(rest.length > 0 ? { equippedAffinityKeys: [...character.equippedAffinityKeys] } : {}),
    ...(character.equippedAffinityStacks ? { equippedAffinityStacks: { ...character.equippedAffinityStacks } } : {}),
    ...(character.equippedAffinityIntensity ? { equippedAffinityIntensity: { ...character.equippedAffinityIntensity } } : {}),
    holdings: [],
    ...(character.affinitySlots !== undefined ? { affinitySlots: character.affinitySlots } : {}),
    ...(seat.escortOf !== undefined ? { escortOf: seat.escortOf } : {}),
    ...(seat.minionOf !== undefined ? { minionOf: seat.minionOf } : {}),
  };
  return structuredClone({ ...initialState, actors: actors.map((actor) => (actor.id === seatId ? arrived : actor)) });
}
