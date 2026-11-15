// #869: the minimal example game runs end to end through the published entries only.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "../..");
const PLAY = join(ROOT, "examples/minimal-game/play.mjs");

test("the minimal game plays a scripted run and prints a board and a final status", async () => {
  // The package entries resolve to the built bundle; build it when this run has none yet.
  if (!existsSync(join(ROOT, "packages/engine/dist/client.js"))) {
    const { buildEngine } = await import("../../scripts/build/engine-bundle.mjs");
    await buildEngine();
  }
  const result = spawnSync(process.execPath, [PLAY, "--script", "d,d,s,."], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^tick \d+ {2}health \d+\/\d+/m, "a status line under the board");
  assert.match(result.stdout, /@/, "the board shows the player");
  assert.match(result.stdout, /^You (left the level|were defeated|stopped) on tick \d+\.$/m);
});

test("the minimal game imports only the published entries, under 120 lines", () => {
  const source = readFileSync(PLAY, "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("node:") || specifier.startsWith("@agon-engine/engine/"), specifier);
    assert.doesNotMatch(specifier, /packages\/|core-ts/);
  }
  assert.ok(source.split("\n").length < 120);
});

// ## TODO: Test Permutations
// - a script that walks into a wall prints core's refusal words
// - "q" first stops on tick 0 with the stopped line
// - an unknown key prints the key help and keeps playing
