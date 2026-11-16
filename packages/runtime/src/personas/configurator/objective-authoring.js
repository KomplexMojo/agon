/**
 * #867 step 4 — level objectives are level configuration, so the Configurator authors and checks
 * them. Two things live here:
 *   - the `--objective` spec grammar `agon create` and `agon_create` share:
 *       "kind=<kind>[;id=<id>][;required=false][;role=<role>|actorIds=<a>,<b>][;actorId=<id>][;ticks=<n>][;count=<n>][;holdingKind=<kind>]"
 *   - `checkLevelObjectives`: the shape check (contracts/objectives.js) plus whether this level can
 *     satisfy each objective: the actors it names exist, a role has at least one actor, and there
 *     are enough holdings to collect. A level that cannot be won is refused, not built.
 * Objectives are free (no pricing): the Allocator is not asked.
 */
import { OBJECTIVE_KINDS, validateObjectives } from "../../contracts/objectives.js";

const LIST_PARAMS = new Set(["actorIds"]);
const NUMBER_PARAMS = new Set(["ticks", "count"]);
const STRING_PARAMS = new Set(["role", "actorId", "holdingKind"]);

/** One `--objective` spec string as an objective. Shape errors are `checkLevelObjectives`' to report. */
export function parseObjectiveSpec(text, index = 0) {
  const field = `objective[${index + 1}]`;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${field} must be a non-empty spec string.`);
  const clauses = text.split(";").map((part) => part.trim()).filter(Boolean);
  let kind;
  let id;
  let required = true;
  const params = {};
  for (const clause of clauses) {
    const eq = clause.indexOf("=");
    if (eq === -1) throw new Error(`${field} clause "${clause}" must be key=value.`);
    const key = clause.slice(0, eq).trim();
    const value = clause.slice(eq + 1).trim();
    if (key === "kind") kind = value;
    else if (key === "id") id = value;
    else if (key === "required") {
      if (value !== "true" && value !== "false") throw new Error(`${field} required must be true or false.`);
      required = value === "true";
    } else if (LIST_PARAMS.has(key)) params[key] = value.split(",").map((part) => part.trim()).filter(Boolean);
    else if (NUMBER_PARAMS.has(key)) params[key] = Number(value);
    else if (STRING_PARAMS.has(key)) params[key] = value;
    else throw new Error(`${field} clause "${clause}" is not one of kind=, id=, required=, role=, actorIds=, actorId=, ticks=, count=, holdingKind=.`);
  }
  if (!OBJECTIVE_KINDS.includes(kind)) throw new Error(`${field} needs kind= one of ${OBJECTIVE_KINDS.join(", ")}.`);
  return { id: id || (index === 0 ? kind : `${kind}-${index + 1}`), kind, params, required };
}

/** Holdings the party could take of a kind: authored vital holdings, and one per affinity a defeat yields. */
function collectableHoldings(actors, holdingKind) {
  let vital = 0;
  let affinity = 0;
  for (const actor of actors) {
    vital += (Array.isArray(actor?.holdings) ? actor.holdings : []).filter((holding) => holding?.kind === "vital").length;
    affinity += Array.isArray(actor?.affinities) ? actor.affinities.length : 0;
  }
  if (holdingKind === "vital") return vital;
  if (holdingKind === "affinity") return affinity;
  return vital + affinity;
}

/**
 * Errors in a level's objectives, checked against its roster (empty when the level can be won).
 * @param {object} args
 * @param {object[]} args.objectives    the list to check
 * @param {object[]} args.actors        the level's actors
 * @param {Record<string, { category?: string }>} [args.presentation]  actor id -> its role
 * @param {string[]} [args.partyIds]    the player's party, never a collect source for itself
 *                                      (default: the `user_controlled` actors)
 */
export function checkLevelObjectives({ objectives, actors = [], presentation = {}, partyIds } = {}) {
  const shape = validateObjectives(objectives);
  if (shape.length > 0) return shape;
  partyIds ??= actors.filter((actor) => (Array.isArray(actor?.motivations) ? actor.motivations : [])
    .some((motivation) => (motivation?.kind ?? motivation) === "user_controlled")).map((actor) => actor.id);
  const ids = new Set(actors.map((actor) => actor?.id).filter(Boolean));
  const others = actors.filter((actor) => !partyIds.includes(actor?.id));
  const errors = [];
  objectives.forEach((objective, index) => {
    const at = `objectives[${index}] (${objective.id})`;
    const { params } = objective;
    if (objective.kind === "defeat" && params.actorIds) {
      for (const actorId of params.actorIds) if (!ids.has(actorId)) errors.push(`${at}: no actor "${actorId}" in this level`);
    }
    if (objective.kind === "defeat" && params.role !== undefined
      && !actors.some((actor) => presentation[actor?.id]?.category === params.role)) {
      errors.push(`${at}: no actor in this level has the role "${params.role}"`);
    }
    if (objective.kind === "escort" && !ids.has(params.actorId)) errors.push(`${at}: no actor "${params.actorId}" in this level`);
    if (objective.kind === "collect") {
      const available = collectableHoldings(others, params.holdingKind);
      if (available < params.count) {
        errors.push(`${at}: asks for ${params.count} ${params.holdingKind ?? ""} holding${params.count === 1 ? "" : "s"} but the level has ${available}`.replace("  ", " "));
      }
    }
  });
  return errors;
}

/**
 * The SimConfig with the level's objectives on it, once they are checked against the built
 * roster (`initialState`). No objectives leaves it as it is (the level asks for the exit). Throws
 * with every reason when the level cannot satisfy them.
 */
export function withLevelObjectives({ simConfig, initialState, objectives } = {}) {
  if (objectives === undefined || objectives === null) return simConfig;
  const errors = checkLevelObjectives({
    objectives, actors: initialState?.actors ?? [], presentation: initialState?.presentation ?? {},
  });
  if (errors.length > 0) throw new Error(`level objectives: ${errors.join("; ")}`);
  return { ...simConfig, objectives: structuredClone(objectives) };
}
