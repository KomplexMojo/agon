/**
 * play-save.js — the agon/PlaySave envelope (#863): a player capture plus what it takes to
 * resume it honestly (the level it belongs to, the engine that made it, and a digest of the
 * state it reached). Resuming replays the capture through the real tick loop
 * (`resumePlaySession` in play-session.js); there is no second way to build state.
 */
import { CAPTURED_INPUT_SCHEMA, PLAY_SAVE_SCHEMA } from "../contracts/artifacts.ts";

export { PLAY_SAVE_SCHEMA };

/** JSON with object keys sorted, so equal states serialise equally whatever the key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** FNV-1a (32-bit) over a string, as 8 hex digits. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable digest of a play state: every actor (id, position, lifecycle, vitals, held
 * affinities and the rest of its snapshot record), who has left, and the tick. Pure.
 * @param {{ actors: object[], tick: number, exited?: string[] }} state
 */
export function playStateDigest({ actors = [], tick = 0, exited = [] } = {}) {
  const sorted = [...actors].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return fnv1a(canonical({ tick, exited: [...exited].sort(), actors: sorted }));
}

/** Structural check of a PlaySave. Returns `{ ok, errors }`; never throws. */
export function validatePlaySave(save) {
  const errors = [];
  const isText = (value) => typeof value === "string" && value.length > 0;
  if (!save || typeof save !== "object") return { ok: false, errors: ["save must be an object"] };
  if (save.schema !== PLAY_SAVE_SCHEMA) errors.push(`schema must be ${PLAY_SAVE_SCHEMA}`);
  if (save.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!save.meta || !isText(save.meta.id)) errors.push("meta.id is required");
  if (!isText(save.engineVersion)) errors.push("engineVersion is required");
  if (!save.level || !isText(save.level.simConfigId) || !isText(save.level.initialStateId) || !Number.isFinite(save.level.seed)) {
    errors.push("level needs simConfigId, initialStateId and a numeric seed");
  }
  if (!isText(save.stateDigest)) errors.push("stateDigest is required");
  if (!Number.isInteger(save.tick) || save.tick < 0) errors.push("tick must be a non-negative integer");
  const status = save.status;
  if (!status || ["exited", "atExit", "defeated"].some((key) => typeof status[key] !== "boolean")) {
    errors.push("status needs boolean exited, atExit and defeated");
  }
  const capture = save.capture;
  if (capture?.schema !== CAPTURED_INPUT_SCHEMA || capture?.source?.adapter !== "player" || !Array.isArray(capture?.payload?.commands)) {
    errors.push("capture must be a player CapturedInputArtifact with commands");
  }
  return { ok: errors.length === 0, errors };
}

/** An error with a machine-readable `code` (`PLAY_SAVE_WRONG_LEVEL`, `PLAY_SAVE_STALE`, `PLAY_SAVE_INVALID`). */
export function playSaveError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
