
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand, schemasCommand, solveCommand } from "./commands/build.mjs";
import { inspectCommand, narrateCommand, replayCommand, runCommand, tickCommand } from "./commands/run.mjs";
import { budgetCommand, configuratorCommand, configureAuthoringCommand, createCommand, recipeCommand, recipesCommand } from "./commands/authoring.mjs";
import { blockchainCommand, blockchainLoadCommand, blockchainMintCommand, ipfsCommand, ipfsLoadCommand, ipfsPublishCommand } from "./commands/external.mjs";
import { llmCommand, llmPlanCommand } from "./commands/llm.mjs";
import { delverPlanCommand, hazardPlanCommand, resourcePlanCommand, roomPlanCommand, wardenPlanCommand } from "./commands/plans.mjs";
import { scenarioCommand } from "./commands/scenario.mjs";
import { diffCommand, runsCommand, showCommand } from "./commands/inspection.mjs";
import { sandboxCreateCommand, sandboxMoveCommand, sandboxPlaceCommand } from "./commands/sandbox.mjs";
import { playCommand, playSessionCommand } from "./commands/play.mjs";
import { emitJsonStdout, usage } from "./commands/shared.mjs";
export { resolveFromRunArtifactPathsFromCommandOutDirs, summarizeRunDiff, summarizeRunShowFromCommandOutDirs } from "./commands/inspection.mjs";
export { PLAY_SESSIONS_DIR } from "./commands/play.mjs";
export { compileBuildSpecToGameplayBundle } from "./commands/shared.mjs";

const STRUCTURED_STDOUT_COMMANDS = new Set([
  "recipes",
  "recipe",
  "play",
  "play-session",
  "solve",
  "build",
  "budget",
  "create",
  "configure",
  "room-plan",
  "hazard-plan",
  "resource-plan",
  "delver-plan",
  "warden-plan",
  "run",
  "inspect",
  "narrate",
  "llm-plan",
  "scenario",
  "show",
  "diff",
  "runs",
  "tick",
  "sandbox-create",
  "sandbox-place",
  "sandbox-move",
]);

export const COMMANDS = {
  build: buildCommand,
  schemas: schemasCommand,
  solve: solveCommand,
  run: runCommand,
  create: createCommand,
  configure: configureAuthoringCommand,
  configurator: configuratorCommand,
  budget: budgetCommand,
  replay: replayCommand,
  inspect: inspectCommand,
  narrate: narrateCommand,
  ipfs: ipfsCommand,
  "ipfs-publish": ipfsPublishCommand,
  "ipfs-load": ipfsLoadCommand,
  blockchain: blockchainCommand,
  "blockchain-mint": blockchainMintCommand,
  "blockchain-load": blockchainLoadCommand,
  llm: llmCommand,
  ollama: llmCommand,
  "room-plan": roomPlanCommand,
  "hazard-plan": hazardPlanCommand,
  "resource-plan": resourcePlanCommand,
  "delver-plan": delverPlanCommand,
  "warden-plan": wardenPlanCommand,
  "llm-plan": llmPlanCommand,
  scenario: scenarioCommand,
  show: showCommand,
  diff: diffCommand,
  runs: runsCommand,
  tick: tickCommand,
  "sandbox-create": sandboxCreateCommand,
  "sandbox-place": sandboxPlaceCommand,
  "sandbox-move": sandboxMoveCommand,
  play: playCommand,
  "play-session": playSessionCommand,
  recipes: recipesCommand,
  recipe: recipeCommand,
};

export async function executeCommand(command, rest = []) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  await handler(rest);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    console.log(usage());
    process.exit(1);
  }
  try {
    await executeCommand(command, rest);
  } catch (error) {
    const message = error?.message || String(error);
    if (STRUCTURED_STDOUT_COMMANDS.has(command)) {
      console.error(message);
      emitJsonStdout({
        ok: false,
        command,
        error: message,
      });
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}

const isDirectExecution = (() => {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return resolve(scriptPath) === fileURLToPath(import.meta.url);
})();

if (isDirectExecution) {
  await main();
}
