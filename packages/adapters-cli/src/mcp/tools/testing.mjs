import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createHandlerTool,
  pathSchema,
  stringArraySchema,
  stringSchema,
} from "./shared.mjs";
import { RECIPE_CATALOG, SCAFFOLDABLE_RECIPES } from "../../../../../scripts/testing/recipe-catalog.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../../../../../");
const INVENTORY_PATH = resolve(ROOT, "local-codex/test-inventory.json");
const CLASSIFICATION_PATH = resolve(ROOT, "local-codex/test-classification.md");

function runNodeScript(relativeScriptPath, args = []) {
  const result = spawnSync(process.execPath, [resolve(ROOT, relativeScriptPath), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  let parsed;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {}
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout,
    stderr,
    parsed,
  };
}

function ensureInventory() {
  if (!existsSync(INVENTORY_PATH)) {
    const result = runNodeScript("scripts/testing/inventory-tests.mjs", [INVENTORY_PATH]);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Failed to generate inventory.");
    }
  }
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

function ensureClassification() {
  if (!existsSync(CLASSIFICATION_PATH)) {
    const result = runNodeScript("scripts/testing/classify-tests.mjs", [CLASSIFICATION_PATH]);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Failed to generate classification.");
    }
  }
  return readFileSync(CLASSIFICATION_PATH, "utf8");
}

function readCodemodExceptions() {
  const result = runNodeScript("scripts/testing/report-codemod-exceptions.mjs");
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Failed to read codemod exceptions.");
  }
  return result.parsed ?? { ok: false, exceptions: [] };
}

function toLiteralList(items = []) {
  return items.map((item) => JSON.stringify(item)).join(", ");
}

function listRecipeMetadata() {
  return Object.entries(RECIPE_CATALOG)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, ...value }));
}

function scaffoldCliSuccess(args) {
  const expectedArtifacts = args.expectedArtifacts ?? [];
  const forbiddenArtifacts = args.forbiddenArtifacts ?? [];
  return `const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync } = require("node:fs");
const { join, resolve } = require("node:path");
const os = require("node:os");

const ROOT = resolve(__dirname, "..", "..");
const CLI = resolve(ROOT, "packages/adapters-cli/src/cli/agon.mjs");

test(${JSON.stringify(args.title)}, () => {
  const outDir = mkdtempSync(join(os.tmpdir(), "agon-cli-"));
  const result = spawnSync(process.execPath, [CLI, ${toLiteralList(args.commandArgs ?? [])}, "--out-dir", outDir], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
${expectedArtifacts.map((artifact) => `  assert.equal(existsSync(join(outDir, ${JSON.stringify(artifact)})), true);`).join("\n")}
${forbiddenArtifacts.map((artifact) => `  assert.equal(existsSync(join(outDir, ${JSON.stringify(artifact)})), false);`).join("\n")}
});
`;
}

function scaffoldAdapterPortContract(args) {
  const paths = args.targetPaths ?? [];
  return `const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");

test(${JSON.stringify(args.title)}, () => {
${paths.map((entry) => `  assert.equal(existsSync(resolve(ROOT, ${JSON.stringify(entry)})), true, ${JSON.stringify(`Missing ${entry}`)});`).join("\n")}
});
`;
}

function scaffoldBudgetPolicyInvariant(args) {
  const expectedChecks = args.expectedChecks ?? [];
  return `const assert = require("node:assert/strict");

function getValueAtPath(root, path) {
  return path.split(".").reduce((value, segment) => {
    if (segment === "") return value;
    const index = Number(segment);
    if (Number.isInteger(index) && String(index) === segment) {
      return value?.[index];
    }
    return value?.[segment];
  }, root);
}

test(${JSON.stringify(args.title)}, async () => {
  const { ${args.exportName} } = await import(${JSON.stringify(`../../${args.modulePath}`)});
  const result = ${args.exportName}(${args.inputJson ?? "{}"});

${expectedChecks.map((entry) => {
    const [path, rawExpected = "null"] = entry.split("=", 2);
    return `  assert.deepEqual(getValueAtPath(result, ${JSON.stringify(path)}), ${rawExpected});`;
  }).join("\n")}
});
`;
}

function scaffoldRuntimeModuleContract(args) {
  const expectedChecks = args.expectedChecks ?? [];
  return `const assert = require("node:assert/strict");

function getValueAtPath(root, path) {
  return path.split(".").reduce((value, segment) => {
    if (segment === "") return value;
    const index = Number(segment);
    if (Number.isInteger(index) && String(index) === segment) {
      return value?.[index];
    }
    return value?.[segment];
  }, root);
}

test(${JSON.stringify(args.title)}, async () => {
  const mod = await import(${JSON.stringify(`../../${args.modulePath}`)});
  const fn = mod[${JSON.stringify(args.exportName)}];
  assert.equal(typeof fn, "function", ${JSON.stringify(`Missing export ${args.exportName}`)});
  const result = await fn(${args.inputJson ?? "{}"});

${expectedChecks.map((entry) => {
    const [path, rawExpected = "null"] = entry.split("=", 2);
    return `  assert.deepEqual(getValueAtPath(result, ${JSON.stringify(path)}), ${rawExpected});`;
  }).join("\n")}
});
`;
}

function scaffoldRuntimePersonaTransition(args) {
  const retainedField = args.retainedField ?? "";
  const retainEvent = args.retainEvent ?? "";
  const retainedAssertions = retainedField && retainEvent
    ? `    if (entry.event === ${JSON.stringify(retainEvent)}) {
      assert.equal(result.context.${retainedField}, before.context.${retainedField});
    }`
    : "";
  const counterAssertions = (args.counterChecks ?? []).map((entry) => {
    const [fixtureField, contextField] = entry.split(":", 2);
    return `    if (entry.${fixtureField} !== undefined) {
      assert.equal(result.context.${contextField}, entry.${fixtureField});
    }`;
  }).join("\n");

  return `const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const happyFixture = JSON.parse(readFileSync(resolve(__dirname, ${JSON.stringify(args.happyFixturePath)}), "utf8"));
const guardFixture = JSON.parse(readFileSync(resolve(__dirname, ${JSON.stringify(args.guardFixturePath)}), "utf8"));

test(${JSON.stringify(args.title)} + " happy path", async () => {
  const { ${args.factoryName}, ${args.statesEnum} } = await import(${JSON.stringify(`../../${args.personaModulePath}`)});
  const fixture = happyFixture;
  const machine = ${args.factoryName}({ initialState: fixture.initialState, clock: () => "fixed" });

  fixture.cases.forEach((entry) => {
    const before = machine.view();
    const result = machine.advance(entry.event, entry.payload);
    assert.equal(result.state, ${args.statesEnum}[entry.expectState.toUpperCase()]);
    assert.equal(result.context.lastEvent, entry.event);
    assert.equal(result.context.updatedAt, "fixed");
${counterAssertions}
${retainedAssertions}
  });
});

test(${JSON.stringify(args.title)} + " guards", async () => {
  const { ${args.factoryName} } = await import(${JSON.stringify(`../../${args.personaModulePath}`)});
  const fixture = guardFixture;
  const machine = ${args.factoryName}({ initialState: fixture.initialState, clock: () => "fixed" });

  fixture.cases.forEach((entry) => {
    let threw = false;
    try {
      machine.advance(entry.event, entry.payload);
    } catch (err) {
      threw = true;
      assert.match(err.message, new RegExp(entry.expectError));
    }
    assert.equal(threw, true);
  });
});
`;
}

function scaffoldCliFailure(args) {
  return `const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");
const CLI = resolve(ROOT, "packages/adapters-cli/src/cli/agon.mjs");

test(${JSON.stringify(args.title)}, () => {
  const result = spawnSync(process.execPath, [CLI, ${toLiteralList(args.commandArgs ?? [])}], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "Expected CLI to fail");
  assert.match(result.stderr, new RegExp(${JSON.stringify(args.expectedErrorPattern ?? "requires")}));
});
`;
}

function scaffoldArtifactSchemaRoundtrip(args) {
  const expectedOk = String(args.expectedOk ?? "true").toLowerCase() !== "false";
  return `const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");

test(${JSON.stringify(args.title)}, async () => {
  const fixture = JSON.parse(readFileSync(resolve(ROOT, ${JSON.stringify(args.fixturePath)}), "utf8"));
  const { ${args.validatorExport ?? "validateArtifact"}: validate } = await import(${JSON.stringify(`../../${args.validatorModule}`)});
  const result = validate(fixture);
  assert.equal(result.ok, ${expectedOk ? "true" : "false"}, result.errors?.join("; "));
});
`;
}

function scaffoldManifestBundleConsistency(args) {
  return `const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");
const BUNDLE_DIR = resolve(ROOT, ${JSON.stringify(args.bundleDir)});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test(${JSON.stringify(args.title)}, () => {
  const manifest = readJson(join(BUNDLE_DIR, "manifest.json"));
  const bundle = readJson(join(BUNDLE_DIR, "bundle.json"));
  const spec = readJson(join(BUNDLE_DIR, manifest.specPath));

  assert.deepEqual(bundle.spec, spec);
  assert.deepEqual(bundle.schemas, manifest.schemas);
  assert.equal(bundle.artifacts.length, manifest.artifacts.length);
});
`;
}

function explainFailureText(text) {
  if (!text) {
    return {
      kind: "unknown",
      summary: "No output provided.",
    };
  }
  if (text.includes("No test suite found in file")) {
    return {
      kind: "runner_migration_gap",
      summary: "Runner discovered a file but no tests registered under the current framework.",
      suggestion: "Check whether the file still depends on legacy node:test patterns or is a wrapper file that should be excluded.",
    };
  }
  if (text.includes("is not a function")) {
    return {
      kind: "missing_runtime_api",
      summary: "The test expects an API that is not exposed by the current implementation.",
      suggestion: "Verify whether this is a pre-existing product/runtime gap rather than a harness migration issue.",
    };
  }
  if (text.includes("ERR_MODULE_NOT_FOUND")) {
    return {
      kind: "module_resolution",
      summary: "A required module could not be resolved at runtime.",
      suggestion: "Check dependency installation, runner loader configuration, and path assumptions.",
    };
  }
  if (text.includes("EPERM") && text.includes("listen")) {
    return {
      kind: "sandbox_or_port_binding",
      summary: "The test tried to bind a local port and failed.",
      suggestion: "Run this under the browser-native or local-server path, or adjust the environment assumptions.",
    };
  }
  if (text.includes("AssertionError") || text.includes("assert.")) {
    return {
      kind: "assertion_failure",
      summary: "A test assertion failed.",
      suggestion: "Inspect expected vs actual values in the reported assertion context.",
    };
  }
  return {
    kind: "unknown",
    summary: "Failure did not match a built-in classifier.",
  };
}

export const testingTools = [
  createHandlerTool({
    name: "agon_test_list_suites",
    description: "List discovered test suites and current runner ownership from the inventory report.",
    inputSchema: {
      properties: {},
    },
    handler: async () => {
      const inventory = ensureInventory();
      ensureClassification();
      return {
        ok: true,
        inventoryPath: relative(ROOT, INVENTORY_PATH),
        classificationPath: relative(ROOT, CLASSIFICATION_PATH),
        summary: inventory.summary,
        recipes: listRecipeMetadata(),
        scaffoldableRecipes: SCAFFOLDABLE_RECIPES,
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_discover_patterns",
    description: "Discover repo test recipes and matching files, optionally filtered by runner or suite.",
    inputSchema: {
      properties: {
        runner: stringSchema("Optional runner filter."),
        suite: stringSchema("Optional suite filter."),
        recipe: stringSchema("Optional recipe filter."),
      },
    },
    handler: async (args) => {
      const inventory = ensureInventory();
      const files = inventory.files.filter((entry) => {
        if (args.runner && entry.runner !== args.runner) return false;
        if (args.suite && entry.suite !== args.suite) return false;
        if (args.recipe && entry.recipe !== args.recipe) return false;
        return true;
      });
      return {
        ok: true,
        count: files.length,
        files,
        recipes: listRecipeMetadata(),
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_plan_from_change",
    description: "Recommend runner scopes from changed paths.",
    inputSchema: {
      required: ["paths"],
      properties: {
        paths: stringArraySchema("Changed repository-relative paths."),
      },
    },
    handler: async (args) => {
      const paths = args.paths ?? [];
      const runners = new Set();
      const suites = new Set();
      for (const path of paths) {
        runners.add("vitest");
        if (path.startsWith("packages/adapters-cli/")) suites.add("adapters-cli");
        if (path.startsWith("packages/runtime/")) suites.add("runtime");
        if (path.startsWith("packages/core-ts/")) suites.add("core-ts");
        if (path.startsWith("tests/")) suites.add(path.split("/")[1] || "tests");
      }
      return {
        ok: true,
        runners: [...runners],
        suites: [...suites].sort((left, right) => left.localeCompare(right)),
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_run",
    description: "Run the test harness inventory, Vitest, legacy, or combined matrix scripts.",
    inputSchema: {
      required: ["mode"],
      properties: {
        mode: stringSchema("One of inventory, classify, coverage, recipe-adoption, parity, vitest, legacy, all."),
        args: stringArraySchema("Additional args passed to the selected runner script."),
      },
    },
    handler: async (args) => {
      const result = runNodeScript("scripts/testing/test-matrix.mjs", [args.mode, ...(args.args ?? [])]);
      return {
        ok: result.ok,
        mode: args.mode,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_scaffold_case",
    description: "Scaffold a new test file from a limited structured recipe set.",
    inputSchema: {
      required: ["recipe", "targetFile", "title"],
      properties: {
        recipe: stringSchema(`Recipe family. Supported scaffold recipes: ${SCAFFOLDABLE_RECIPES.join(", ")}.`),
        targetFile: pathSchema("Repository-relative output path."),
        title: stringSchema("Test title."),
        commandArgs: stringArraySchema("CLI command args for cli_success_artifacts."),
        expectedArtifacts: stringArraySchema("Artifacts expected to exist."),
        forbiddenArtifacts: stringArraySchema("Artifacts expected not to exist."),
        expectedErrorPattern: stringSchema("Regex source expected in stderr for cli_failure_message."),
        fixturePath: pathSchema("Repository-relative fixture JSON path for artifact_schema_roundtrip."),
        validatorModule: stringSchema("Repository-relative ESM module path for artifact_schema_roundtrip."),
        validatorExport: stringSchema("Named export for the validator function."),
        bundleDir: pathSchema("Repository-relative bundle fixture directory for manifest_bundle_consistency."),
        bundlePath: pathSchema("Repository-relative bundle fixture file for browser_bundle_load_flow."),
        targetPaths: stringArraySchema("Repository-relative adapter entrypoint paths for adapter_port_contract."),
        modulePath: pathSchema("Repository-relative ESM module path for budget_policy_invariant."),
        exportName: stringSchema("Named export to invoke for budget_policy_invariant."),
        inputJson: stringSchema("Serialized JS object literal argument for budget_policy_invariant."),
        expectedChecks: stringArraySchema("Expected result checks for budget_policy_invariant as path=<json>."),
        runtimeModulePath: pathSchema("Repository-relative ESM module path for runtime_module_contract."),
        runtimeExportName: stringSchema("Named export to invoke for runtime_module_contract."),
        runtimeInputJson: stringSchema("Serialized JS object literal argument for runtime_module_contract."),
        runtimeExpectedChecks: stringArraySchema("Expected result checks for runtime_module_contract as path=<json>."),
        personaModulePath: pathSchema("Repository-relative ESM state-machine module path for runtime_persona_transition."),
        factoryName: stringSchema("Factory export name for runtime_persona_transition."),
        statesEnum: stringSchema("States enum export name for runtime_persona_transition."),
        happyFixturePath: pathSchema("Relative fixture path from test file to happy transition fixture."),
        guardFixturePath: pathSchema("Relative fixture path from test file to guard transition fixture."),
        counterChecks: stringArraySchema("Counter checks as fixtureField:contextField for runtime_persona_transition."),
        retainedField: stringSchema("Context field that should remain unchanged on retainEvent."),
        retainEvent: stringSchema("Event name that should preserve retainedField."),
        expectedOk: stringSchema("Optional boolean-like flag for artifact_schema_roundtrip."),
      },
    },
    handler: async (args) => {
      const targetPath = resolve(ROOT, args.targetFile);
      mkdirSync(dirname(targetPath), { recursive: true });
      let content;
      switch (args.recipe) {
        case "cli_success_artifacts":
          content = scaffoldCliSuccess(args);
          break;
        case "cli_failure_message":
          content = scaffoldCliFailure(args);
          break;
        case "artifact_schema_roundtrip":
          content = scaffoldArtifactSchemaRoundtrip(args);
          break;
        case "manifest_bundle_consistency":
          content = scaffoldManifestBundleConsistency(args);
          break;
        case "adapter_port_contract":
          content = scaffoldAdapterPortContract(args);
          break;
        case "budget_policy_invariant":
          content = scaffoldBudgetPolicyInvariant(args);
          break;
        case "runtime_module_contract":
          content = scaffoldRuntimeModuleContract({
            title: args.title,
            modulePath: args.runtimeModulePath ?? args.modulePath,
            exportName: args.runtimeExportName ?? args.exportName,
            inputJson: args.runtimeInputJson ?? args.inputJson,
            expectedChecks: args.runtimeExpectedChecks ?? args.expectedChecks,
          });
          break;
        case "runtime_persona_transition":
          content = scaffoldRuntimePersonaTransition(args);
          break;
        default:
          throw new Error(`Unsupported scaffold recipe: ${args.recipe}`);
      }
      writeFileSync(targetPath, content, "utf8");
      return {
        ok: true,
        targetFile: args.targetFile,
        recipe: args.recipe,
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_insert_case",
    description: "Append a scaffolded case to an existing test file.",
    inputSchema: {
      required: ["recipe", "targetFile", "title"],
      properties: {
        recipe: stringSchema(`Recipe family. Supported scaffold recipes: ${SCAFFOLDABLE_RECIPES.join(", ")}.`),
        targetFile: pathSchema("Repository-relative output path."),
        title: stringSchema("Test title."),
        commandArgs: stringArraySchema("CLI command args for cli_success_artifacts."),
        expectedArtifacts: stringArraySchema("Artifacts expected to exist."),
        forbiddenArtifacts: stringArraySchema("Artifacts expected not to exist."),
        expectedErrorPattern: stringSchema("Regex source expected in stderr for cli_failure_message."),
        fixturePath: pathSchema("Repository-relative fixture JSON path for artifact_schema_roundtrip."),
        validatorModule: stringSchema("Repository-relative ESM module path for artifact_schema_roundtrip."),
        validatorExport: stringSchema("Named export for the validator function."),
        bundleDir: pathSchema("Repository-relative bundle fixture directory for manifest_bundle_consistency."),
        bundlePath: pathSchema("Repository-relative bundle fixture file for browser_bundle_load_flow."),
        targetPaths: stringArraySchema("Repository-relative adapter entrypoint paths for adapter_port_contract."),
        modulePath: pathSchema("Repository-relative ESM module path for budget_policy_invariant."),
        exportName: stringSchema("Named export to invoke for budget_policy_invariant."),
        inputJson: stringSchema("Serialized JS object literal argument for budget_policy_invariant."),
        expectedChecks: stringArraySchema("Expected result checks for budget_policy_invariant as path=<json>."),
        runtimeModulePath: pathSchema("Repository-relative ESM module path for runtime_module_contract."),
        runtimeExportName: stringSchema("Named export to invoke for runtime_module_contract."),
        runtimeInputJson: stringSchema("Serialized JS object literal argument for runtime_module_contract."),
        runtimeExpectedChecks: stringArraySchema("Expected result checks for runtime_module_contract as path=<json>."),
        personaModulePath: pathSchema("Repository-relative ESM state-machine module path for runtime_persona_transition."),
        factoryName: stringSchema("Factory export name for runtime_persona_transition."),
        statesEnum: stringSchema("States enum export name for runtime_persona_transition."),
        happyFixturePath: pathSchema("Relative fixture path from test file to happy transition fixture."),
        guardFixturePath: pathSchema("Relative fixture path from test file to guard transition fixture."),
        counterChecks: stringArraySchema("Counter checks as fixtureField:contextField for runtime_persona_transition."),
        retainedField: stringSchema("Context field that should remain unchanged on retainEvent."),
        retainEvent: stringSchema("Event name that should preserve retainedField."),
        expectedOk: stringSchema("Optional boolean-like flag for artifact_schema_roundtrip."),
      },
    },
    handler: async (args) => {
      const targetPath = resolve(ROOT, args.targetFile);
      const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8").trimEnd() : "";
      let fragment;
      switch (args.recipe) {
        case "cli_success_artifacts":
          fragment = scaffoldCliSuccess(args).trim();
          break;
        case "cli_failure_message":
          fragment = scaffoldCliFailure(args).trim();
          break;
        case "artifact_schema_roundtrip":
          fragment = scaffoldArtifactSchemaRoundtrip(args).trim();
          break;
        case "manifest_bundle_consistency":
          fragment = scaffoldManifestBundleConsistency(args).trim();
          break;
        case "adapter_port_contract":
          fragment = scaffoldAdapterPortContract(args).trim();
          break;
        case "budget_policy_invariant":
          fragment = scaffoldBudgetPolicyInvariant(args).trim();
          break;
        case "runtime_module_contract":
          fragment = scaffoldRuntimeModuleContract({
            title: args.title,
            modulePath: args.runtimeModulePath ?? args.modulePath,
            exportName: args.runtimeExportName ?? args.exportName,
            inputJson: args.runtimeInputJson ?? args.inputJson,
            expectedChecks: args.runtimeExpectedChecks ?? args.expectedChecks,
          }).trim();
          break;
        case "runtime_persona_transition":
          fragment = scaffoldRuntimePersonaTransition(args).trim();
          break;
        default:
          throw new Error(`Unsupported insert recipe: ${args.recipe}`);
      }
      const next = previous ? `${previous}\n\n${fragment}\n` : `${fragment}\n`;
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, next, "utf8");
      return {
        ok: true,
        targetFile: args.targetFile,
        recipe: args.recipe,
      };
    },
  }),
  createHandlerTool({
    name: "agon_test_explain_failure",
    description: "Classify a test failure from runner output into a small set of migration-focused categories.",
    inputSchema: {
      required: ["text"],
      properties: {
        text: stringSchema("Runner output or failure excerpt."),
      },
    },
    handler: async (args) => ({
      ok: true,
      explanation: explainFailureText(args.text),
    }),
  }),
  createHandlerTool({
    name: "agon_test_lint_structure",
    description: "Report structural migration gaps: uncategorized recipes and codemod exceptions.",
    inputSchema: {
      properties: {},
    },
    handler: async () => {
      const inventory = ensureInventory();
      const codemod = readCodemodExceptions();
      const uncategorized = inventory.files.filter((entry) => entry.recipe === "general");
      const adoption = runNodeScript("scripts/testing/check-test-recipe-adoption.mjs");
      return {
        ok: true,
        uncategorizedCount: uncategorized.length,
        uncategorized: uncategorized.map((entry) => entry.path),
        codemodExceptionCount: codemod.count ?? 0,
        codemodExceptions: codemod.exceptions ?? [],
        recipeAdoption: adoption.parsed ?? null,
        scaffoldableRecipes: SCAFFOLDABLE_RECIPES,
      };
    },
  }),
];
