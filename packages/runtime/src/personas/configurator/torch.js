/**
 * #906 — the torch fixture, Configurator policy: a light emit that is cheap because it is small,
 * not because it is exempt from pricing. An ordinary hazard (the Allocator prices it through the
 * same vitals and affinity path), but NOT a field hazard: hazards are authored on their own path
 * and are never raised to the actor viability floor, so a fixture may hold a small mana pool and
 * a regen below its own upkeep. It lights while its mana lasts, goes dark when drained, and the
 * lasting-affinity switch-off path (#412) refills it, so it flickers rather than burns for free.
 * `composeFieldHazard` (minefield.js) is unchanged and keeps the floor.
 */
import { computeInternalManaUpkeep } from "./cost-model.js";
import { terrainPositions } from "./terrain-layout.js";

export const TORCH_ROLES = Object.freeze(["wall", "standing"]);
const INTENSITY = 1;
// A torch lights for this many turns on a full pool, then waits to refill.
const TORCH_BURN_TURNS = 2;
const TORCH_REGEN = 1;

/**
 * A torch hazard of `role` ("wall" | "standing") at range `range`, intensity 1. Mana is just
 * enough to pay `TORCH_BURN_TURNS` of upkeep; regen is the cheapest non-zero point, below
 * upkeep, so it goes dark and recovers. Durability is 1: a fixture, not a fighter.
 */
export function composeTorchFixture(id, role, range = 1) {
  if (!TORCH_ROLES.includes(role)) throw new Error(`torch: role must be one of ${TORCH_ROLES.join(", ")}.`);
  const upkeep = computeInternalManaUpkeep(range + INTENSITY);
  const mana = upkeep * TORCH_BURN_TURNS;
  return {
    id,
    affinity: "light",
    expression: "emit",
    proximityRadius: 0,
    fixture: role,
    affinityStacks: [{ kind: "light", expression: "emit", stacks: range, intensity: INTENSITY, targetType: "floor" }],
    vitals: {
      mana: { kind: "regen", current: mana, max: mana, regen: TORCH_REGEN },
      durability: { kind: "regen", current: 1, max: 1, regen: 0 },
    },
    blocking: false,
    _schemaVersion: 3,
  };
}

const TORCH_PARAMS = Object.freeze(["wall", "standing", "range", "room"]);
const DEFAULTS = Object.freeze({ wall: 2, standing: 1, range: 1 });
const key = ({ x, y }) => `${x},${y}`;
const chebyshev = (left, right) => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

function readCount(params, name, minimum) {
  if (params[name] === undefined) return DEFAULTS[name];
  const value = Number(params[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`tactic torch: ${name} must be a whole number >= ${minimum}.`);
  return value;
}

export function readTorchParams(params = {}) {
  const unknown = Object.keys(params).filter((name) => !TORCH_PARAMS.includes(name));
  if (unknown.length > 0) throw new Error(`tactic torch: unknown param ${unknown.join(", ")} (${TORCH_PARAMS.join(", ")}).`);
  return {
    wall: readCount(params, "wall", 0),
    standing: readCount(params, "standing", 0),
    range: readCount(params, "range", 1),
    room: params.room === undefined ? null : String(params.room),
  };
}

function inRoom(room, { x, y }) {
  return x >= room.x && y >= room.y && x < room.x + room.width && y < room.y + room.height;
}

function onEdge(room, { x, y }) {
  return x === room.x || y === room.y || x === room.x + room.width - 1 || y === room.y + room.height - 1;
}

/**
 * Compose torches in `room`. A wall torch sits on a floor cell along the room's edge (against a
 * wall); a standing torch sits on an interior floor cell. No two seats touch and none touches
 * another hazard. Returns `{ hazards, placement, row }`; a room too small for the count seats what
 * fits and says so, never a silent shortfall. Priced by the Allocator through the hazard path, and
 * `fitTacticHazards` drops torches the hazard share cannot afford.
 */
export function composeTorches({ layout, room, params, takenIds = new Set(), occupied = new Set() }) {
  const clear = terrainPositions(layout).filter((cell) => inRoom(room, cell) && [...occupied].every((entry) => {
    const [x, y] = entry.split(",").map(Number);
    return chebyshev(cell, { x, y }) > 1;
  })).sort((left, right) => left.y - right.y || left.x - right.x);
  const seated = [];
  const seatRole = (role, count, eligible) => {
    let seats = 0;
    for (const cell of clear.filter(eligible)) {
      if (seats >= count) break;
      if (seated.every((other) => chebyshev(other.cell, cell) > 1)) { seated.push({ role, cell }); seats += 1; }
    }
    return seats;
  };
  const walls = seatRole("wall", params.wall, (cell) => onEdge(room, cell));
  const standing = seatRole("standing", params.standing, (cell) => !onEdge(room, cell));
  const notes = [];
  if (walls < params.wall) notes.push(`${room.id} holds ${walls} of ${params.wall} wall torches`);
  if (standing < params.standing) notes.push(`${room.id} holds ${standing} of ${params.standing} standing torches`);
  if (seated.length === 0) return { row: { applied: false, note: `${room.id} has no cell clear of other hazards for a torch` } };
  const hazards = [];
  const placement = [];
  const ids = [];
  seated.forEach(({ role, cell }, index) => {
    let id;
    let ordinal = index;
    do { ordinal += 1; id = `torch_${room.id}_${ordinal}`; } while (takenIds.has(id));
    takenIds.add(id);
    hazards.push(composeTorchFixture(id, role, params.range));
    ids.push({ id, kind: "light", role });
    placement.push({ label: `torch ${room.id}: hazard:${id} (${role}) at ${key(cell)}`,
      subject: { kind: "hazard", ref: id }, near: { target: { kind: "cells", cells: [cell] }, distance: 0 } });
  });
  return { hazards, placement, row: { applied: true, room: room.id, hazards: ids, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) } };
}

export const TORCH_ACTIVATION = Object.freeze({ PROXIMITY: "proximity", ROOM_ENTER: "room_enter" });
const DEFAULT_PROXIMITY_RADIUS = 3;

/**
 * #906: give every light fixture in `initialState` a dormancy for `mode`, so it stays dark until a
 * delver nears it (`proximity`, within DEFAULT_PROXIMITY_RADIUS or `radius`) or enters its room
 * (`room_enter`, the layout room holding it). Core wakes it (`wakeDormantActors`); this only
 * authors the trigger data. A null or absent mode returns the state unchanged, so a level without
 * the option keeps today's behaviour. Pure: returns a new initial state.
 */
export function applyTorchActivation({ initialState, layout, mode, radius = DEFAULT_PROXIMITY_RADIUS } = {}) {
  if (mode === undefined || mode === null) return initialState;
  if (!Object.values(TORCH_ACTIVATION).includes(mode)) {
    throw new Error(`torchActivation must be one of ${Object.values(TORCH_ACTIVATION).join(", ")}.`);
  }
  if (!Number.isSafeInteger(radius) || radius < 1) throw new Error("torchActivation radius must be a whole number >= 1.");
  const data = layout?.data || layout || {};
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const roomOf = ({ x, y }) => rooms.find((room) => x >= room.x && y >= room.y && x < room.x + room.width && y < room.y + room.height);
  const actors = (Array.isArray(initialState?.actors) ? initialState.actors : []).map((actor) => {
    if (!actor?.fixture || actor.dormant) return actor;
    if (mode === TORCH_ACTIVATION.PROXIMITY) return { ...actor, dormant: { mode, radius } };
    const room = roomOf(actor.position);
    // A torch outside every room has no room to wait for, so it stays always-on rather than never lighting.
    return room ? { ...actor, dormant: { mode, area: { x: room.x, y: room.y, width: room.width, height: room.height } } } : actor;
  });
  return { ...initialState, actors };
}
