// #863: save a run as an agon/PlaySave and resume it through the real tick loop (replay),
// refusing a save from another level and flagging one the current rules no longer reproduce.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "../..");
const LEVELS = resolve(ROOT, "packages/ui-ascii/levels");
const META = { id: "save_1", runId: "run_1", createdAt: "2026-11-15T00:00:00.000Z" };

function level(name) {
  const read = (suffix) => JSON.parse(readFileSync(resolve(LEVELS, `${name}.${suffix}.json`), "utf8"));
  return { name, simConfig: read("sim-config"), initialState: read("initial-state") };
}

async function playedSave(name = "first-steps") {
  const { createPlaySession } = await import("../../packages/runtime/src/runner/play-session.js");
  const { simConfig, initialState } = level(name);
  const session = await createPlaySession({ simConfig, initialState, fog: true });
  await session.act({ kind: "wait" });
  await session.act({ kind: "move", params: { direction: "east" } });
  await session.act({ kind: "wait" });
  return { session, save: session.save({ meta: META }) };
}

test("save carries the level ids, engine version, tick, status, digest and the capture", async () => {
  const { ENGINE_VERSION } = await import("../../packages/runtime/src/contracts/engine-version.js");
  const { validatePlaySave } = await import("../../packages/runtime/src/runner/play-save.js");
  const { session, save } = await playedSave();
  const { simConfig, initialState } = level("first-steps");
  assert.equal(save.schema, "agon/PlaySave");
  assert.equal(save.schemaVersion, 1);
  assert.equal(save.meta.producedBy, "play-session");
  assert.equal(save.engineVersion, ENGINE_VERSION);
  assert.deepEqual(save.level, { simConfigId: simConfig.meta.id, initialStateId: initialState.meta.id, seed: simConfig.seed ?? 0 });
  assert.equal(save.tick, session.status().tick);
  assert.equal(save.capture.payload.commands.length, 3);
  assert.equal(typeof save.stateDigest, "string");
  assert.deepEqual(validatePlaySave(save), { ok: true, errors: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(save)), save, "a save survives JSON");
});

test("resume gives the same view and keeps playing", async () => {
  const { resumePlaySession } = await import("../../packages/runtime/src/runner/play-session.js");
  const { session, save } = await playedSave();
  const { simConfig, initialState } = level("first-steps");
  const resumed = await resumePlaySession({ simConfig, initialState, save: JSON.parse(JSON.stringify(save)), fog: true });
  assert.deepEqual(resumed.view(), session.view());
  const next = await resumed.act({ kind: "wait" });
  assert.equal(next.tick, save.tick + 1);
});

test("a save resumed on another level is refused, naming both ids", async () => {
  const { resumePlaySession } = await import("../../packages/runtime/src/runner/play-session.js");
  const { save } = await playedSave();
  const other = level("warden-hall");
  await assert.rejects(
    resumePlaySession({ simConfig: other.simConfig, initialState: other.initialState, save }),
    (error) => error.code === "PLAY_SAVE_WRONG_LEVEL" && error.message.includes(save.level.simConfigId) && error.message.includes(other.simConfig.meta.id),
  );
});

test("a save whose state the rules no longer reproduce throws PLAY_SAVE_STALE", async () => {
  const { resumePlaySession } = await import("../../packages/runtime/src/runner/play-session.js");
  const { ENGINE_VERSION } = await import("../../packages/runtime/src/contracts/engine-version.js");
  const { save } = await playedSave();
  const { simConfig, initialState } = level("first-steps");
  const edited = { ...save, engineVersion: "0.0.1", stateDigest: "00000000" };
  await assert.rejects(
    resumePlaySession({ simConfig, initialState, save: edited }),
    (error) => error.code === "PLAY_SAVE_STALE" && error.message.includes("0.0.1") && error.message.includes(ENGINE_VERSION),
  );
});

test("a different engine version with a matching digest resumes normally", async () => {
  const { resumePlaySession } = await import("../../packages/runtime/src/runner/play-session.js");
  const { save } = await playedSave();
  const { simConfig, initialState } = level("first-steps");
  const resumed = await resumePlaySession({ simConfig, initialState, save: { ...save, engineVersion: "0.0.1" } });
  assert.equal(resumed.status().tick, save.tick);
});

test("validatePlaySave rejects the invalid fixtures", async () => {
  const { validatePlaySave } = await import("../../packages/runtime/src/runner/play-save.js");
  const read = (name) => JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/artifacts", name), "utf8"));
  assert.equal(validatePlaySave(read("play-save-v1-basic.json")).ok, true);
  const missing = validatePlaySave(read("invalid/play-save-v1-missing-engine-version.json"));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes("engineVersion")));
  const notPlayer = validatePlaySave(read("invalid/play-save-v1-not-player-capture.json"));
  assert.equal(notPlayer.ok, false);
  assert.ok(notPlayer.errors.some((e) => e.includes("capture")));
});

test("the game controller saves with its level index and resumes from it", async () => {
  const { createGameController } = await import("../../packages/runtime/src/controls/game-controller.js");
  const levels = [level("first-steps"), level("warden-hall")];
  const game = await createGameController({ levels, startIndex: 1 });
  await game.handle({ type: "wait" });
  const save = game.save(META);
  assert.equal(save.levelIndex, 1);
  const resumed = await createGameController({ levels, resume: { levelIndex: save.levelIndex, save } });
  assert.equal(resumed.frame().levelIndex, 1);
  assert.deepEqual(resumed.view(), game.view());
});

test("the game controller falls back to a fresh level on a stale save, and says so", async () => {
  const { createGameController } = await import("../../packages/runtime/src/controls/game-controller.js");
  const levels = [level("first-steps")];
  const game = await createGameController({ levels });
  await game.handle({ type: "wait" });
  const save = { ...game.save(META), stateDigest: "00000000" };
  const fresh = await createGameController({ levels, resume: { levelIndex: 0, save } });
  assert.match(fresh.frame().message, /could not be resumed/i);
  assert.equal(fresh.frame().turns, 0);
});

// ## TODO: Test Permutations
// - save on a party level after switchTo, resume reseats the same actor
// - save after defeat / at exit: status round-trips and resume reports the same status
// - resume with fog off vs on gives the same digest
// - a save with a truncated capture (commands removed) is stale, not silently resumed
