/**
 * `agon build`, `agon schemas`, `agon solve`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { join } from "node:path";
import { createSchemaCatalog } from "../../../../runtime/src/contracts/schema-catalog.js";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { commandKernel, emitJsonStdout, resolvePath, summarizeBuildLikeOutput, usage, writeJson } from "./shared.mjs";

function assertAllowedBuildArgs(args) {
  const allowed = new Set(["spec", "out-dir", "emit-intermediates"]);
  const unknown = [];
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help") {
      continue;
    }
    if (!allowed.has(key)) {
      unknown.push(`--${key}`);
    }
  }
  if (Array.isArray(args._) && args._.length > 0) {
    unknown.push(...args._);
  }
  if (unknown.length > 0) {
    throw new Error(`build only accepts --spec, --out-dir, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

function assertAllowedSchemasArgs(args) {
  const allowed = new Set(["out-dir"]);
  const unknown = [];
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help") {
      continue;
    }
    if (!allowed.has(key)) {
      unknown.push(`--${key}`);
    }
  }
  if (Array.isArray(args._) && args._.length > 0) {
    unknown.push(...args._);
  }
  if (unknown.length > 0) {
    throw new Error(`schemas only accepts --out-dir. Unknown: ${unknown.join(", ")}`);
  }
}



export async function buildCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedBuildArgs(args);
  const result = await commandKernel.build(args);
  emitJsonStdout(await summarizeBuildLikeOutput({
    command: "build",
    outDir: result.outDir,
  }));
}

export async function schemasCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedSchemasArgs(args);

  if (args["out-dir"] !== undefined && typeof args["out-dir"] !== "string") {
    throw new Error("schemas requires --out-dir <path> when provided.");
  }

  const outDir = resolvePath(args["out-dir"]);
  const clockOverride = process.env.AGON_SCHEMA_CATALOG_TIME;
  const catalog = createSchemaCatalog({
    clock: clockOverride ? () => clockOverride : undefined,
  });

  if (outDir) {
    await writeJson(join(outDir, "schemas.json"), catalog);
    console.log(`schemas: wrote ${outDir}`);
    return;
  }

  console.log(`${JSON.stringify(catalog, null, 2)}`);
}

export async function solveCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const { outDir, runId, solverRequest, solverResult, answer, artifactPaths: questionPaths } = await commandKernel.solve(args);
  const artifactPaths = questionPaths || {
    solver_request: join(outDir, "solver-request.json"),
    solver_result: join(outDir, "solver-result.json"),
  };
  // `ok` says the command ran; `solved` says whether the solver answered. A deferred
  // result means no adapter served the request's domain, so nothing was solved, and
  // callers (agon_solve above all) must not read the envelope as an answer.
  // With --question, `answer` is the owning persona's verdict: which source decided it
  // (solver or fallback) and what it decided. `not_posed` means the persona needed no search.
  const status = solverResult?.status;
  emitJsonStdout({
    ok: true,
    command: "solve",
    runId: runId || solverRequest?.meta?.runId || args["run-id"] || "",
    outDir,
    solved: status !== "deferred" && status !== "error" && status !== "not_posed",
    status,
    ...(solverResult?.reason ? { reason: solverResult.reason } : {}),
    ...(answer ? { answer } : {}),
    artifactPaths,
  });
}
