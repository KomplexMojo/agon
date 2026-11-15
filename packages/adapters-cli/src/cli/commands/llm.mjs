/**
 * `agon llm` (alias `ollama`) and `agon llm-plan`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { join } from "node:path";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { commandKernel, defaultOutDir, emitJsonStdout, makeId, resolvePath, summarizeBuildLikeOutput, usage, writeJson } from "./shared.mjs";

export async function llmCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("llm", runId);
  const outPath = resolvePath(args.out) || join(outDir, "llm.json");
  const result = await commandKernel.llm(args);
  await writeJson(outPath, result.output);
  console.log(`llm: wrote ${outPath}`);
}

export async function llmPlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await commandKernel.llmPlan(args);
  emitJsonStdout(await summarizeBuildLikeOutput({
    command: "llm-plan",
    outDir: result.outDir,
  }));
}
