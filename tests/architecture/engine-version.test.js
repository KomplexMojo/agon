// #863: ENGINE_VERSION is what a PlaySave records; it must be the published package version.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("ENGINE_VERSION equals packages/engine/package.json version", async () => {
  const { ENGINE_VERSION } = await import("../../packages/runtime/src/contracts/engine-version.js");
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../packages/engine/package.json"), "utf8"));
  assert.equal(ENGINE_VERSION, pkg.version, "bump ENGINE_VERSION with the engine package version");
});
