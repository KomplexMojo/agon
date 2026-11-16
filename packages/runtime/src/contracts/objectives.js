/**
 * #867 — level objectives: what a level asks of the player, as data from a small closed vocabulary.
 * No scripting. A SimConfig may carry `objectives`; absent means `DEFAULT_OBJECTIVES`, one
 * `reach_exit`, which is today's only goal. The Configurator checks a level's objectives against its
 * actors; the Moderator evaluates them each tick; the play session reports them.
 *
 * One objective: { id, kind, params, required }
 *   reach_exit  {}                                  the seated actor leaves by the exit
 *   defeat      { actorIds: string[] } | { role }   every named actor, or every actor of that role
 *                                                   (the level's presentation category: warden, hazard, ...), is defeated
 *   survive     { ticks }                           the seated actor is alive at tick `ticks`
 *   collect     { count, holdingKind? }             the party takes `count` holdings ("vital" | "affinity"; any when absent)
 *   escort      { actorId }                         that actor leaves by the exit alive
 *   within      { ticks }                           every other required objective is met by tick `ticks`, else lost
 * `required: false` marks an optional objective, for score: it never decides the outcome.
 *
 * This module checks shape only. Whether a level can satisfy an objective (the named actors exist,
 * there is something to collect) is the Configurator's call.
 */
export const OBJECTIVE_KINDS = Object.freeze(["reach_exit", "defeat", "survive", "collect", "escort", "within"]);
export const OBJECTIVE_STATES = Object.freeze(["open", "met", "failed"]);
export const OBJECTIVE_HOLDING_KINDS = Object.freeze(["vital", "affinity"]);

/** What a level with no `objectives` asks: reach the exit. */
export const DEFAULT_OBJECTIVES = Object.freeze([
  Object.freeze({ id: "reach_exit", kind: "reach_exit", params: Object.freeze({}), required: true }),
]);

const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;
const isId = (value) => typeof value === "string" && value.trim().length > 0;

function paramErrors(kind, params, at) {
  const errors = [];
  const only = (allowed) => {
    for (const key of Object.keys(params)) if (!allowed.includes(key)) errors.push(`${at}.params.${key} is not a ${kind} param`);
  };
  switch (kind) {
    case "reach_exit":
      only([]);
      break;
    case "defeat": {
      only(["actorIds", "role"]);
      const hasIds = params.actorIds !== undefined;
      const hasRole = params.role !== undefined;
      if (hasIds === hasRole) errors.push(`${at}.params needs exactly one of actorIds or role`);
      if (hasIds && (!Array.isArray(params.actorIds) || params.actorIds.length === 0 || !params.actorIds.every(isId))) {
        errors.push(`${at}.params.actorIds must be a non-empty list of actor ids`);
      }
      if (hasRole && !isId(params.role)) errors.push(`${at}.params.role must be a role name`);
      break;
    }
    case "survive":
    case "within":
      only(["ticks"]);
      if (!isPositiveInteger(params.ticks)) errors.push(`${at}.params.ticks must be a whole number of at least 1`);
      break;
    case "collect":
      only(["count", "holdingKind"]);
      if (!isPositiveInteger(params.count)) errors.push(`${at}.params.count must be a whole number of at least 1`);
      if (params.holdingKind !== undefined && !OBJECTIVE_HOLDING_KINDS.includes(params.holdingKind)) {
        errors.push(`${at}.params.holdingKind must be one of ${OBJECTIVE_HOLDING_KINDS.join(", ")}`);
      }
      break;
    case "escort":
      only(["actorId"]);
      if (!isId(params.actorId)) errors.push(`${at}.params.actorId must be an actor id`);
      break;
    default:
      break;
  }
  return errors;
}

/** Shape errors in an `objectives` list (empty when it is valid). */
export function validateObjectives(objectives) {
  if (!Array.isArray(objectives)) return ["objectives must be a list"];
  if (objectives.length === 0) return ["objectives must name at least one objective (leave the field out for reach_exit)"];
  const errors = [];
  const seen = new Set();
  objectives.forEach((objective, index) => {
    const at = `objectives[${index}]`;
    if (!objective || typeof objective !== "object" || Array.isArray(objective)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(objective)) {
      if (!["id", "kind", "params", "required"].includes(key)) errors.push(`${at}.${key} is not an objective field`);
    }
    if (!isId(objective.id)) errors.push(`${at}.id must be a non-empty string`);
    else if (seen.has(objective.id)) errors.push(`${at}.id "${objective.id}" is used twice`);
    else seen.add(objective.id);
    if (typeof objective.required !== "boolean") errors.push(`${at}.required must be true or false`);
    if (!OBJECTIVE_KINDS.includes(objective.kind)) {
      errors.push(`${at}.kind "${objective.kind}" is not one of ${OBJECTIVE_KINDS.join(", ")}`);
      return;
    }
    const params = objective.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) {
      errors.push(`${at}.params must be an object`);
      return;
    }
    errors.push(...paramErrors(objective.kind, params, at));
  });
  if (objectives.filter((objective) => objective?.kind === "within").length > 1) errors.push("objectives may hold at most one within");
  const required = objectives.filter((objective) => objective?.required === true);
  if (required.length > 0 && required.every((objective) => objective.kind === "within")) {
    errors.push("a within objective needs another required objective to time");
  }
  if (!objectives.some((objective) => objective?.required === true)) errors.push("objectives need at least one required objective");
  return errors;
}

/** The objectives a SimConfig asks for: its own list, or `DEFAULT_OBJECTIVES` when it names none. */
export function levelObjectives(simConfig) {
  return Array.isArray(simConfig?.objectives) ? simConfig.objectives : DEFAULT_OBJECTIVES;
}
