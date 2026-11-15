/**
 * `agon create`, `configure`, `configurator`, `budget`, `recipes`, `recipe`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { randomInt } from "node:crypto";
import { createLlmAdapter } from "../../adapters/llm/index.js";
// Genuinely Orchestrator law — the prompt contract itself — so taken from its barrel.
import { buildActorPlanPrompt, buildTacticPlanPrompt, readActorPlanResponse, readTacticPlanResponse } from "../../../../runtime/src/personas/orchestrator/persona.js";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "../../../../runtime/src/contracts/domain-constants.js";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { createRecipeCatalogue } from "../../../../runtime/src/commands/recipe-catalogue.js";
import { allowNetworkRequests, buildDryRunBudgetEstimate, buildDryRunFailure, buildDryRunSuccess, commandKernel, configurator, defaultRunCommandOutDir, deriveActorIds, deriveRoomIds, emitJsonStdout, isLlmLiveEnabled, isLocalBaseUrl, prepareAuthoringBuild, readJson, readText, resolvePath, tacticDirector, usage } from "./shared.mjs";
import { writeBuildOutputs, writeHazardArtifactFiles, writeResourceArtifactFiles } from "./authoring-shared.mjs";

export async function configuratorCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  await commandKernel.configurator(args);
}

export async function budgetCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await commandKernel.budget(args);
  emitJsonStdout({ ok: true, command: "budget", ...result.output });
}

/**
 * #402: `--tactic llm`. The Orchestrator's prompt asks the model for a tactic plan; the Director
 * reads the tactics (unknown ones refused) and the Configurator checks params and counts. With no
 * model (no --fixture and AGON_LLM_LIVE off, or a non-local URL without AGON_ALLOW_NETWORK), a failed
 * call or an invalid reply, the seeded plan (#401) decides. `tacticPlan` records which path decided
 * and what the model returned; the result's `tactics` replays the build with no model.
 */
async function resolveLlmTacticPlan({ args, seededTactics, levelCounts, rooms }) {
  const fallback = (reasons, extra = {}) => ({
    tactics: seededTactics,
    tacticPlan: { decidedBy: "seeded", reasons, ...extra },
  });
  const fixturePath = args.fixture;
  const baseUrl = args["base-url"] || process.env.AGON_LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
  if (!fixturePath && !isLlmLiveEnabled()) {
    return fallback(["no model: pass --fixture or set AGON_LLM_LIVE=1"]);
  }
  if (!fixturePath && !allowNetworkRequests() && !isLocalBaseUrl(baseUrl)) {
    return fallback(["no model: a non-local --base-url needs AGON_ALLOW_NETWORK=1"]);
  }
  const model = args.model || process.env.AGON_LLM_MODEL || DEFAULT_LLM_MODEL;
  const prompt = buildTacticPlanPrompt({ ...levelCounts, rooms, goal: args.goal });
  let payload;
  try {
    const adapter = fixturePath
      ? createLlmAdapter({ fixture: JSON.parse(await readText(fixturePath)) })
      : createLlmAdapter({ baseUrl });
    payload = await adapter.generate({ model, prompt, stream: false });
  } catch (error) {
    return fallback([`model call failed: ${error.message}`], { model });
  }
  const reply = readTacticPlanResponse(payload);
  if (reply.errors) return fallback(reply.errors, { model });
  let tactics;
  try {
    tactics = tacticDirector.normalizeTactics(reply.tactics);
  } catch (error) {
    return fallback([error.message], { model, response: reply.tactics });
  }
  const errors = configurator.validateTactics(tactics, levelCounts);
  if (errors.length > 0) return fallback(errors, { model, response: reply.tactics });
  return { tactics, tacticPlan: { decidedBy: "llm", model, response: reply.tactics } };
}

/**
 * #721: `--actors llm` — the model picks the level's delvers and wardens from --text and the recipe
 * catalogue. Unlike a tactic plan there is no seeded cast to fall back to, so a missing model or an
 * unreadable reply is an error; the specs it returns are parsed like typed ones, so an unknown
 * recipe is refused there. `actorPlan` records the model and its reply.
 */
async function resolveLlmActorPlan({ args, text, budgetTokens, recipes, strategies }) {
  const fixturePath = args.fixture;
  const baseUrl = args["base-url"] || process.env.AGON_LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
  if (!fixturePath && !isLlmLiveEnabled()) throw new Error("--actors llm needs a model: pass --fixture or set AGON_LLM_LIVE=1.");
  if (!fixturePath && !allowNetworkRequests() && !isLocalBaseUrl(baseUrl)) {
    throw new Error("--actors llm: a non-local --base-url needs AGON_ALLOW_NETWORK=1.");
  }
  const model = args.model || process.env.AGON_LLM_MODEL || DEFAULT_LLM_MODEL;
  const prompt = buildActorPlanPrompt({ text, goal: args.goal, budgetTokens, recipes, strategies });
  const adapter = fixturePath
    ? createLlmAdapter({ fixture: JSON.parse(await readText(fixturePath)) })
    : createLlmAdapter({ baseUrl });
  const payload = await adapter.generate({ model, prompt, stream: false });
  const reply = readActorPlanResponse(payload);
  if (reply.errors) throw new Error(`--actors llm: the model's reply could not be read (${reply.errors.join("; ")}).`);
  return { delvers: reply.delvers, wardens: reply.wardens,
    actorPlan: { decidedBy: "llm", model, delvers: reply.delvers, wardens: reply.wardens } };
}

async function agentAuthoringCommand(argv, { commandName, action, allowDryRun = false } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const {
    runId,
    createdAt,
    resolvedBudgetTokens,
    warnings: specWarnings = [],
    tacticPlan,
    actorPlan,
    requestArtifact,
    hazards: canonicalHazardEntries,
    resources: parsedResources,
    buildInput,
  } = await prepareAuthoringBuild(args, { commandName, action, allowDryRun }, {
    readArtifact: (path) => readJson(resolvePath(path)),
    drawSeed: () => randomInt(0, 2 ** 31 - 1),
    planTacticsWithLlm: resolveLlmTacticPlan,
    planActorsWithLlm: resolveLlmActorPlan,
    now: () => new Date().toISOString(),
  });
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir(commandName, runId);
  for (const warning of specWarnings) console.error(`warning: ${warning}`);

  // Authoring domain build runs in the kernel (P2.3.2): assemble the BuildSpec
  // through the Director controller, Configurator input prep, orchestrateBuild,
  // and post-process.
  const { buildResult } = await commandKernel.authoringBuild(buildInput);

  if (args["dry-run"]) {
    emitJsonStdout(buildDryRunSuccess({
      command: commandName,
      runId,
      outDir,
      actorIds: deriveActorIds(buildResult.initialState),
      roomIds: deriveRoomIds(buildResult.simConfig),
      budgetEstimate: buildDryRunBudgetEstimate({
        budgetReceipt: buildResult.budgetReceipt,
        spendProposal: buildResult.spendProposal,
        budgetTokens: resolvedBudgetTokens,
      }),
    }));
    return;
  }

  const stdoutSummary = await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    requestArtifact,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName,
    producedBy: `cli-${commandName}`,
    tacticPlan,
    actorPlan,
  });

  await writeHazardArtifactFiles({
    parsedHazards: canonicalHazardEntries,
    outDir,
    runId,
    createdAt,
    producedBy: `cli-${commandName}`,
  });
  await writeResourceArtifactFiles({
    parsedResources,
    outDir,
    runId,
    createdAt,
    producedBy: `cli-${commandName}`,
  });

  emitJsonStdout(specWarnings.length > 0 ? { ...stdoutSummary, warnings: specWarnings } : stdoutSummary);
}

export async function createCommand(argv) {
  const args = parseArgs(argv);
  if (args["dry-run"]) {
    try {
      await agentAuthoringCommand(argv, { commandName: "create", action: "author", allowDryRun: true });
    } catch (error) {
      emitJsonStdout(buildDryRunFailure({
        command: "create",
        runId: args["run-id"] || "",
        outDir: resolvePath(args["out-dir"]),
        error,
      }));
    }
    return;
  }
  await agentAuthoringCommand(argv, { commandName: "create", action: "author", allowDryRun: true });
}

export async function configureAuthoringCommand(argv) {
  await agentAuthoringCommand(argv, { commandName: "configure", action: "configure" });
}

// #716: the recipe catalogue (Configurator configuration recipes, Actor strategy recipes), each
// configuration priced by the Allocator. Text by default, `--json` for the structured rows.
const RECIPE_CATALOGUE_FLAGS = new Set(["_", "kind", "role", "json", "help"]);
function assertRecipeArgs(args, command) {
  const unknown = Object.keys(args).filter((key) => !RECIPE_CATALOGUE_FLAGS.has(key));
  if (unknown.length) throw new Error(`${command} only accepts --kind, --role and --json. Unknown: ${unknown.join(", ")}`);
}

export async function recipesCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return; }
  assertRecipeArgs(args, "recipes");
  const rows = createRecipeCatalogue().list({ kind: args.kind, role: args.role });
  if (args.json) { emitJsonStdout({ ok: true, command: "recipes", recipes: rows }); return; }
  for (const row of rows) {
    if (row.kind === "config") {
      const roles = Object.entries(row.roles).filter(([, n]) => n > 0).map(([role, n]) => `${role} ${n}`).join(", ") || "none";
      console.log(`${row.name.padEnd(16)} ${String(row.cost.delver).padStart(4)} t  ${row.archetype.padEnd(11)} ${roles.padEnd(26)} ${row.affinities.join(" ")}`);
    } else {
      const tags = [row.postures.join("/"), row.mobility, row.fits === "list" ? null : row.fits].filter(Boolean).join(" · ");
      console.log(`${row.name.padEnd(22)} strategy  ${tags.padEnd(30)} ${row.title}`);
    }
  }
}

export async function recipeCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return; }
  const name = args._?.[0];
  if (!name) throw new Error("recipe needs a name: agon recipe <name> (agon recipes lists them).");
  if (args._.length > 1) throw new Error(`recipe takes one name, got ${args._.join(" ")}.`);
  const { _: _positional, ...flags } = args;
  assertRecipeArgs(flags, "recipe");
  const shown = createRecipeCatalogue().show(String(name).toLowerCase(), { role: args.role, kind: args.kind });
  if (args.json) { emitJsonStdout({ ok: true, command: "recipe", recipe: shown }); return; }
  console.log(JSON.stringify(shown, null, 2));
}
