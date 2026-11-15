// #862: runtime is production code; a default that resolves a tests/ path belongs to the host
// (the CLI names its llm-plan fixture through `host.defaultLlmFixturePath`).
const assert = require("node:assert/strict");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");

const ROOT = join(__dirname, "../..");
const RUNTIME = join(ROOT, "packages/runtime/src");

function sources(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.(m?js|m?ts|cjs)$/.test(entry)) found.push(full);
  }
  return found;
}

test("no runtime source names a tests/fixtures path", () => {
  const hits = sources(RUNTIME).filter((file) => readFileSync(file, "utf8").includes("tests/fixtures"))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(hits, []);
});
