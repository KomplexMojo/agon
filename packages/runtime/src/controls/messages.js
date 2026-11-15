/**
 * The shared wording and small view readers behind every interface's messages (#505): core's
 * rejection codes in words, battle and vital lines, loot and order labels. Pure functions of a
 * play-session view; no terminal, no rules. `ui-ascii` consumes them and a sibling client does the same,
 * so a message changes once.
 */
import { HUD_VITAL_LABELS } from "../render/actor-hud-model.js";
import { formatMessage, msg, REJECTION_MESSAGES } from "./message-catalogue.js";

/**
 * An affinity's range and intensity as `r6 ×2` (#345). A slot run below what is held shows
 * running/held for that number (#230): `r1/6 ×2`, `r6 ×1/2`.
 */
export function slotLevelLabel(player, pair) {
  const key = `${pair.kind}:${pair.expression}`;
  const heldIntensity = pair.intensity ?? 1;
  const level = (running, held) => (Number.isInteger(running) && running < held ? `${running}/${held}` : `${held}`);
  return `r${level(player?.equippedAffinityStacks?.[key], pair.stacks)}`
    + ` ×${level(player?.equippedAffinityIntensity?.[key], heldIntensity)}`;
}

// #865: the rejection words moved into the message catalogue; re-exported here unchanged.
export { REJECTION_MESSAGES };

/** Current mana of a view's seated player, or 0. */
export const currentMana = (player) => (player?.vitals || []).find((vital) => vital.key === "mana")?.current ?? 0;

/** #865: a refusal as `{ id, params }`; `rejectionMessage` is its words. */
export function rejectionMessageData(reason, player, params) {
  // #588: a refused cast says what it costs and what you have.
  if (reason === "InsufficientMana" && player) {
    const key = params?.affinityKey ?? (player.equippedAffinityKeys || []).find((k) => player.castableAffinities?.[k]);
    const price = player.castableAffinities?.[key]?.mana;
    if (key && price !== undefined) return msg("rejection.manaCost", { affinityKey: key, cost: price, have: currentMana(player) });
  }
  // #617: a refused move says what it costs and what you have.
  if (reason === "InsufficientStamina" && player?.moveStamina) {
    const have = (player.vitals || []).find((vital) => vital.key === "stamina")?.current ?? 0;
    // A refused move carries core's params: `target` (and `via` for a sprint), not the direction asked.
    const from = player.position;
    const to = params?.target;
    const diagonal = Boolean(from && to && to.x !== from.x && to.y !== from.y);
    const cost = params?.via ? player.moveStamina.sprint : diagonal ? player.moveStamina.diagonal : player.moveStamina.step;
    return msg("rejection.staminaCost", { sprint: Boolean(params?.via), cost, have });
  }
  return REJECTION_MESSAGES[reason] ? msg(`rejection.${reason}`) : msg("rejection.unknown", { reason });
}

export function rejectionMessage(reason, player, params) {
  return formatMessage(rejectionMessageData(reason, player, params));
}

/** An affinity as held: kind, expression, range and intensity, e.g. `fire push r6 ×2` (#345). */
export function affinityLabel(pair) {
  return `${pair.kind} ${pair.expression} ${slotLevelLabel(null, pair)}`;
}

/**
 * What an equipped affinity runs at, per number: what is held unless run lower. `stacks`
 * is its range (#230), `intensity` its strength (#345).
 */
export const LEVELS = Object.freeze({
  stacks: { running: "equippedAffinityStacks", held: (pair) => pair.stacks, name: "range" },
  intensity: { running: "equippedAffinityIntensity", held: (pair) => pair.intensity ?? 1, name: "intensity" },
});
export function runningLevel(player, pair, field) {
  const running = player?.[LEVELS[field].running]?.[`${pair.kind}:${pair.expression}`];
  return Number.isInteger(running) ? running : LEVELS[field].held(pair);
}

/** Where an aimed tile is from the player, in steps: "2 east, 1 north of you". */
export function aimLabel(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const parts = [...(dx ? [`${Math.abs(dx)} ${dx > 0 ? "east" : "west"}`] : []),
    ...(dy ? [`${Math.abs(dy)} ${dy > 0 ? "south" : "north"}`] : [])];
  return parts.length ? `${parts.join(", ")} of you` : "under you";
}

export function keyLabel(affinityKey) {
  return String(affinityKey || "").replace(":", " ");
}

/** A vital change as the HUD names it: `HP −8`, `MP +3` (#463). */
export function changeLabel({ vital, delta }) {
  return `${HUD_VITAL_LABELS[vital] ?? vital} ${delta < 0 ? "\u2212" : "+"}${Math.abs(delta)}`;
}

/**
 * The battle lines of the last tick (#463): the player's own hit (`You hit W1 with decay push:
 * HP −8`) and every hit on the player by others (`W1 hits you with growth push: HP +3`),
 * from the casts the play session reports. Self-casts and casts at nobody have no line.
 */
export function battleLinesData(view) {
  const me = view.player?.id;
  const lines = { own: null, others: [] };
  for (const cast of view.casts || []) {
    if (!cast.targetId || cast.targetId === cast.sourceId || !me) continue;
    const changes = cast.changes.filter((change) => change.actorId === cast.targetId)
      .map(({ vital, delta }) => ({ vital, delta }));
    const what = { affinityKey: `${cast.kind}:${cast.expression}`, changes };
    if (cast.sourceId === me) {
      lines.own = msg("battle.ownHit", { targetId: cast.targetId, ...(cast.targetLabel ? { targetLabel: cast.targetLabel } : {}), ...what });
    } else if (cast.targetId === me) {
      lines.others.push(msg("battle.hitBy", { sourceId: cast.sourceId, ...(cast.sourceLabel ? { sourceLabel: cast.sourceLabel } : {}), ...what }));
    }
  }
  return lines;
}

export function battleLines(view) {
  const data = battleLinesData(view);
  return { own: data.own ? formatMessage(data.own) : null, others: data.others.map((line) => formatMessage(line)) };
}

/**
 * #573: the first tick a harmful field of yours (or your party's) hurts one of your own side, and
 * the tick one of them falls to it, says so with the amount: `Your fire emit — a sheet of flame — is hurting D2 pal
 * (HP \u22124)`. Friendly fire stays; this only warns. Later ticks ride the vitals line.
 */
export function allyWarningData(view) {
  const tick = view.tick;
  return (view.battleLog || []).filter((line) => line.ally && line.tick === tick).map((line) => {
    // #582: a line that already states the amount and the net needs no suffix.
    if (line.detailed) return msg("battle.allyWarningDetailed", { targetId: line.targetId, battleLine: line.text });
    const change = (view.vitalChanges || []).find((c) => c.actorId === line.targetId && c.hit < 0);
    return msg("battle.allyWarning", { targetId: line.targetId, battleLine: line.text,
      ...(change ? { change: { vital: change.vital, delta: change.hit } } : {}) });
  });
}

export function allyWarningLines(view) {
  return allyWarningData(view).map((line) => formatMessage(line));
}

export const signed = (value) => `${value < 0 ? "\u2212" : "+"}${Math.abs(value)}`;
export const VITAL_LINE_LIMIT = 3;

/**
 * What hit whom last tick and what regen gave back (#410), e.g. `W1 DU 10/10 (−1 +1)`, so a
 * hit regen cancels is still seen landing. The player's own line comes first (`You HP ...`);
 * only vitals that were hit are named, at most three.
 */
export function vitalChangeData(view) {
  const me = view.player?.id;
  // A hit the cast line already names (`You hit W1 with corrode push: DU −8`) is not said twice:
  // someone else's change that is exactly what the tick's casts did, with no regen to add.
  const byCast = new Map();
  for (const cast of view.casts || []) for (const change of cast.changes || []) {
    if (change.actorId === cast.sourceId) continue;
    const key = `${change.actorId}|${change.vital}`;
    byCast.set(key, (byCast.get(key) ?? 0) + change.delta);
  }
  const said = (change) => change.actorId !== me && change.regen === 0 && byCast.get(`${change.actorId}|${change.vital}`) === change.hit;
  const hits = (view.vitalChanges || []).filter((change) => change.hit !== 0 && !said(change))
    .sort((left, right) => Number(right.actorId === me) - Number(left.actorId === me));
  if (hits.length === 0) return null;
  return msg("vitals.changes", { changes: hits.slice(0, VITAL_LINE_LIMIT).map((change) => {
    const self = change.actorId === me;
    // #497: what a hit did to someone else, not their state; only your own vitals show current/max.
    return { actorId: change.actorId, self, ...(!self && change.label ? { label: change.label } : {}), vital: change.vital,
      hit: change.hit, regen: change.regen, ...(self ? { current: change.current, max: change.max } : {}) };
  }) });
}

export function vitalChangeLine(view) {
  return formatMessage(vitalChangeData(view));
}

/** The equipped slots core would cast, with their reach and cast mana, as the play session reports them. */
export const castable = (player) => player?.castableAffinities || {};

/** Equipped keys in equip order, as the play session reports them. */
export const equippedKeys = (player) => player?.equippedAffinityKeys || [];

/** What a vital grant changes: `MP max +5, regen +1` for a lasting grant, `HP +5` for a consumable (#487). */
export function grantLabel(item) {
  const lasting = item.permanenceMode !== "consumable";
  return (item.vitals || []).map((grant) => {
    const name = HUD_VITAL_LABELS[grant.key] ?? grant.key;
    const sign = (n) => `${n < 0 ? "\u2212" : "+"}${Math.abs(n)}`;
    return [`${name}${lasting ? " max" : ""} ${sign(grant.delta)}`, ...(grant.regen ? [`regen ${sign(grant.regen)}`] : [])].join(", ");
  }).join("; ");
}

export function lootLabel(item) {
  if (item.kind === "affinity") return `${item.affinity} ${item.expression}`;
  return item.vitals?.length ? grantLabel(item) : "a vital boost";
}

/** Why `g` finds nothing (#479): who is next to the player and why their holdings are closed. */
export function takeRefusalData(view) {
  const from = view.player?.position;
  const adjacent = (actor) => actor?.position && from
    && Math.max(Math.abs(actor.position.x - from.x), Math.abs(actor.position.y - from.y)) <= 1;
  // AK-7: a same-side corpse is listed in lootBodies with claimable:false (core refuses the take).
  const sealedAlly = (view.lootBodies || []).find((body) => adjacent(body) && body.claimable === false);
  if (sealedAlly) {
    return msg("take.sealedAlly", { targetId: sealedAlly.id, ...(sealedAlly.label ? { targetLabel: sealedAlly.label } : {}) });
  }
  const near = from ? [...(view.actors || []), ...(view.hazards || [])].filter(adjacent) : [];
  if (near.length === 0) return msg("take.nothingHere");
  const spent = near.filter((actor) => actor.role === "resource");
  if (spent.length > 0) return msg("take.spent", { targetId: spent[0].id });
  const other = near[0];
  return msg("take.stillStanding", { targetId: other.id, ...(other.label ? { targetLabel: other.label } : {}) });
}

export function takeRefusal(view) {
  return formatMessage(takeRefusalData(view));
}

export const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Everyone in sight the player could aim at, nearest first. Range is core's to judge. */
export function targetsInSight(view) {
  const from = view.player?.position;
  if (!from) return [];
  return [...(view.actors || []), ...(view.hazards || [])]
    .map((actor) => ({ id: actor.id, position: { x: actor.position.x, y: actor.position.y }, distance: chebyshev(from, actor.position), motivations: actor.motivations ?? [],
      ...(actor.revealed !== undefined ? { revealed: actor.revealed } : {}), vitals: actor.vitals, affinities: actor.affinities }))
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How many turns "hold here" keeps a companion in place: the session needs a count. */
export const HOLD_ORDER_TICKS = 10;

/**
 * The orders the terminal offers (#272), as strategies the play session takes. Each is
 * built from what the screen knows: who is seated, where the ordered actor stands, and
 * the nearest hostile in sight. A choice with nothing to aim at is left out. What a
 * goal means is the Actor's; this only names it.
 */
export function orderChoices({ playerId, actor, hostile }) {
  return [
    { label: `follow you`, strategy: { goals: [{ kind: "follow", target: playerId }] } },
    { label: `guard you`, strategy: { goals: [{ kind: "guard", target: playerId }] } },
    { label: `lead you to the exit`, strategy: { goals: [{ kind: "lead", target: playerId, place: "exit" }] } },
    { label: `go to the exit`, strategy: { goals: [{ kind: "reach", place: "exit" }] } },
    ...(hostile ? [{ label: `defeat ${hostile.label ?? hostile.id}`, strategy: { goals: [{ kind: "defeat", target: hostile.id }] } }] : []),
    ...(actor?.position ? [{ label: `hold where it stands for ${HOLD_ORDER_TICKS} turns`,
      strategy: { goals: [{ kind: "hold", place: { ...actor.position }, ticks: HOLD_ORDER_TICKS }] } }] : []),
    { label: `keep away from hostiles`, strategy: { goals: [{ kind: "survive" }] } },
  ];
}
