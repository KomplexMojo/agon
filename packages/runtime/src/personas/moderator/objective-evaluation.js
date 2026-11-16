/**
 * #867 — level objectives: whether each one is open, met or failed, and the run's outcome.
 * End-of-run is the Moderator's (tick control), so this is its rule. The caller supplies facts,
 * never verdicts: the tick, when each actor was defeated or left, and what the party took. The
 * result follows from those facts alone, so a replay of the same ticks reads the same.
 *
 * `seatId` is the player actor the level is about (the session's player). `roles` maps actor id to
 * its role (the level's presentation category).
 *
 * Rules, per kind (contracts/objectives.js has the vocabulary):
 *   reach_exit  met when the seat leaves; failed when it is defeated first
 *   defeat      met when every target is defeated (progress: defeated of targets)
 *   survive     met at tick `ticks` with the seat alive, or when the seat leaves earlier (it got out);
 *               failed when the seat is defeated at or before `ticks`
 *   collect     met when the party has taken `count` holdings (of `holdingKind`, when named)
 *   escort      met when that actor leaves; failed when it is defeated first
 *   within      met when every other required objective was met by tick `ticks`; failed once the
 *               tick passes `ticks` without that
 * Outcome: "lost" when the seat is defeated or a required objective failed, "won" when every
 * required one is met, else "playing" — except that a seat which has left with a required objective
 * still open has nothing more it can do there, so that is "lost" too. With the default (one `reach_exit`) that is exactly
 * "won on exit, lost on defeat".
 */
import { levelObjectives } from "../../contracts/objectives.js";

const at = (record, id) => (Number.isInteger(record?.[id]) ? record[id] : null);

function targetsOf(params, roles) {
  if (Array.isArray(params.actorIds)) return params.actorIds;
  return Object.entries(roles ?? {}).filter(([, role]) => role === params.role).map(([id]) => id).sort();
}

/** When each objective was met (a tick) or failed, from the facts; `null` while it is open. */
function judge(objective, facts) {
  const { tick, seatId, defeatedAt, exitedAt, takes, roles } = facts;
  const params = objective.params ?? {};
  const seatDefeated = at(defeatedAt, seatId);
  const seatExited = at(exitedAt, seatId);
  switch (objective.kind) {
    case "reach_exit":
      if (seatExited !== null) return { metAt: seatExited };
      return seatDefeated !== null ? { failedAt: seatDefeated } : {};
    case "defeat": {
      const targets = targetsOf(params, roles);
      const down = targets.map((id) => at(defeatedAt, id)).filter((value) => value !== null);
      const progress = { done: down.length, of: targets.length };
      return targets.length > 0 && down.length === targets.length ? { metAt: Math.max(...down), progress } : { progress };
    }
    case "survive": {
      const progress = { done: Math.min(tick, params.ticks), of: params.ticks };
      if (seatDefeated !== null && seatDefeated <= params.ticks) return { failedAt: seatDefeated, progress };
      if (seatExited !== null && seatExited < params.ticks) return { metAt: seatExited, progress };
      return tick >= params.ticks ? { metAt: params.ticks, progress } : { progress };
    }
    case "collect": {
      const counted = (takes ?? []).filter((take) => !params.holdingKind || take.holdingKind === params.holdingKind)
        .map((take) => take.tick).sort((a, b) => a - b);
      const progress = { done: Math.min(counted.length, params.count), of: params.count };
      return counted.length >= params.count ? { metAt: counted[params.count - 1], progress } : { progress };
    }
    case "escort": {
      const left = at(exitedAt, params.actorId);
      if (left !== null) return { metAt: left };
      const lost = at(defeatedAt, params.actorId);
      return lost !== null ? { failedAt: lost } : {};
    }
    default:
      return {};
  }
}

/**
 * @param {object} args
 * @param {object} args.simConfig     the level (its `objectives`, or the default)
 * @param {number} args.tick          the current tick
 * @param {string} args.seatId        the player actor
 * @param {Record<string, number>} args.defeatedAt  actor id -> tick it was defeated
 * @param {Record<string, number>} args.exitedAt    actor id -> tick it left by the exit
 * @param {{ tick: number, holdingKind?: string }[]} args.takes  each holding the party took
 * @param {Record<string, string>} args.roles       actor id -> role
 * @returns {{ outcome: "playing" | "won" | "lost", objectives: object[] }}
 */
export function evaluateLevelObjectives({ simConfig, tick = 0, seatId, defeatedAt = {}, exitedAt = {}, takes = [], roles = {} } = {}) {
  const objectives = levelObjectives(simConfig);
  const facts = { tick, seatId, defeatedAt, exitedAt, takes, roles };
  const judged = new Map(objectives.filter((objective) => objective.kind !== "within")
    .map((objective) => [objective.id, judge(objective, facts)]));
  for (const objective of objectives.filter((candidate) => candidate.kind === "within")) {
    const others = objectives.filter((other) => other.required && other.kind !== "within").map((other) => judged.get(other.id));
    const deadline = objective.params.ticks;
    const allMetAt = others.every((verdict) => verdict.metAt !== undefined) ? Math.max(...others.map((verdict) => verdict.metAt)) : null;
    const progress = { done: Math.min(tick, deadline), of: deadline };
    judged.set(objective.id, allMetAt !== null && allMetAt <= deadline ? { metAt: allMetAt, progress }
      : tick > deadline ? { failedAt: deadline + 1, progress } : { progress });
  }
  const report = objectives.map((objective) => {
    const verdict = judged.get(objective.id);
    const state = verdict.failedAt !== undefined ? "failed" : verdict.metAt !== undefined ? "met" : "open";
    return {
      id: objective.id, kind: objective.kind, required: objective.required, state,
      ...(verdict.progress ? { progress: verdict.progress } : {}),
    };
  });
  const required = report.filter((objective) => objective.required);
  const allMet = required.every((objective) => objective.state === "met");
  const lost = at(defeatedAt, seatId) !== null || required.some((objective) => objective.state === "failed")
    || (at(exitedAt, seatId) !== null && !allMet);
  const won = !lost && allMet;
  return { outcome: lost ? "lost" : won ? "won" : "playing", objectives: report };
}
