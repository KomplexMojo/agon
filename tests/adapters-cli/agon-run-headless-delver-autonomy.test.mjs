/**
 * Headless `agon run` remaps authored user_controlled delvers to computer autonomy by default.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(ROOT, "packages/adapters-cli/src/cli/agon.mjs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const agon = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
const lastJson = (stdout) => JSON.parse(stdout.trim().split("\n").at(-1));

let dir;
let level;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agon-run-headless-autonomy-"));
  level = join(dir, "level");
  const created = agon([
    "create",
    "--room", "size=small;count=1",
    "--delver", "count=1;id=hero;affinity=wind;motivation=exploring+user_controlled",
    "--warden", "count=1;affinity=earth;motivation=defending",
    "--run-id", "headless_autonomy",
    "--created-at", "2026-11-19T00:00:00.000Z",
    "--out-dir", level,
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("default headless run remaps the delver and reports headlessDelverAutonomy", () => {
  const outDir = join(dir, "default");
  const result = agon([
    "run",
    "--sim-config", join(level, "sim-config.json"),
    "--initial-state", join(level, "initial-state.json"),
    "--ticks", "2",
    "--out-dir", outDir,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = lastJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.headlessDelverAutonomy));
  assert.equal(payload.headlessDelverAutonomy.length, 1);
  const remap = payload.headlessDelverAutonomy[0];
  assert.match(remap.actorId, /^hero/);
  assert.ok(remap.from.includes("user_controlled"));
  assert.ok(remap.from.includes("exploring"));
  assert.deepEqual(remap.to, ["exploring", "goal_oriented"]);

  const resolved = readJson(join(outDir, "resolved-initial-state.json"));
  const hero = resolved.actors.find((actor) => actor.id === remap.actorId);
  assert.deepEqual(hero.motivations, ["exploring", "goal_oriented"]);
  const authored = readJson(join(level, "initial-state.json"));
  assert.ok(authored.actors.find((actor) => actor.id === remap.actorId).motivations.includes("user_controlled"));
});

test("--preserve-player-control keeps user_controlled", () => {
  const outDir = join(dir, "preserved");
  const result = agon([
    "run",
    "--sim-config", join(level, "sim-config.json"),
    "--initial-state", join(level, "initial-state.json"),
    "--ticks", "1",
    "--preserve-player-control",
    "--out-dir", outDir,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = lastJson(result.stdout);
  assert.equal(payload.headlessDelverAutonomy, undefined);
  assert.equal(payload.artifactPaths.resolved_initial_state, undefined);
});

test("MCP agon_run advertises preservePlayerControl and maps it to the CLI flag", async () => {
  const { simulationTools } = await import("../../packages/adapters-cli/src/mcp/tools/simulation.mjs");
  const tool = simulationTools.find((entry) => entry.name === "agon_run");
  assert.ok(tool);
  assert.match(tool.inputSchema.properties.preservePlayerControl.description, /user_controlled/);
  const mapped = tool.buildArgs({ fromRun: "demo", ticks: 3, preservePlayerControl: true });
  assert.deepEqual(mapped, ["--from-run", "demo", "--ticks", "3", "--preserve-player-control"]);
});

// ## TODO: Test Permutations
// - dry-run reports headlessDelverAutonomy without writing resolved-initial-state
// - --actions path skips the remap even without --preserve-player-control
