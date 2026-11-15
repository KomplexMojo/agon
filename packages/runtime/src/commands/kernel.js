import { createHostedLayoutBudgetFitter, hostConfiguratorPlacement } from "./solver-host.js";
import { requireHostFunction } from "./kernel/helpers.js";
import { createSolveCommands } from "./kernel/solve.js";
import { createBuildCommands } from "./kernel/build.js";
import { createRunCommands } from "./kernel/run.js";
import { createReplayCommands } from "./kernel/replay.js";
import { createInspectCommands } from "./kernel/inspect.js";
import { createConfiguratorCommands } from "./kernel/configurator.js";
import { createBudgetCommands } from "./kernel/budget.js";
import { createExternalCommands } from "./kernel/external.js";
import { createLlmCommands } from "./kernel/llm.js";
import { createLlmPlanCommands } from "./kernel/llm-plan.js";
export { normalizeWorldStateCheckpoints, collectBuildOutputArtifactRecords, buildBuildArtifacts, buildBuildManifestEntries } from "./kernel/helpers.js";


export function createCommandKernel(host = {}) {
  const readJson = requireHostFunction(host, "readJson");
  const readText = requireHostFunction(host, "readText");
  const writeJson = requireHostFunction(host, "writeJson");
  const resolvePath = requireHostFunction(host, "resolvePath");
  const join = requireHostFunction(host, "join");
  const dirname = requireHostFunction(host, "dirname");
  const exists = requireHostFunction(host, "exists");
  const makeId = requireHostFunction(host, "makeId");
  const createMeta = requireHostFunction(host, "createMeta");
  const toRef = requireHostFunction(host, "toRef");
  const defaultBuildOutDir = requireHostFunction(host, "defaultBuildOutDir");
  const defaultRunCommandOutDir = requireHostFunction(host, "defaultRunCommandOutDir");
  const defaultLlmPlanOutDir = requireHostFunction(host, "defaultLlmPlanOutDir");
  const allowNetworkRequests = requireHostFunction(host, "allowNetworkRequests");
  const isLlmLiveEnabled = requireHostFunction(host, "isLlmLiveEnabled");
  const isLlmStrictEnabled = requireHostFunction(host, "isLlmStrictEnabled");
  const isLlmBudgetLoopEnabled = requireHostFunction(host, "isLlmBudgetLoopEnabled");
  const isLocalBaseUrl = requireHostFunction(host, "isLocalBaseUrl");
  const createSolverAdapter = requireHostFunction(host, "createSolverAdapter");
  const createLlmAdapter = requireHostFunction(host, "createLlmAdapter");
  const nowIso = requireHostFunction(host, "nowIso");

  const log = typeof host.log === "function" ? host.log : () => {};
  const warn = typeof host.warn === "function" ? host.warn : () => {};
  const cwd = typeof host.cwd === "function" ? host.cwd : () => ".";

  // The Configurator's object placement, posed to the host's solver adapter. Every build
  // entry point hosts it the same way (#296): a command that skipped this got the
  // reading-order fallback for the same persona question the others put to the solver.
  // `record` receives each solver decision, for commands that report them.
  async function hostObjectPlacement(createdAt, record) {
    return hostConfiguratorPlacement({ createdAt, adapter: await createSolverAdapter({}), record });
  }

  // The Allocator's budget fit (asked through an open Director round), posed to the host's
  // solver adapter. Unhosted, the Allocator answers with its greedy fallback (#296).
  async function hostLayoutBudgetFit(director, createdAt, record) {
    return createHostedLayoutBudgetFitter({
      prepare: director.prepareLayoutBudgetFit,
      complete: director.completeLayoutBudgetFit,
      adapter: await createSolverAdapter({}),
      clock: () => createdAt,
      ...(record ? { record } : {}),
    });
  }

  // #862: each command lives in kernel/<command>.js; this wires them to the host functions above.
  const ctx = { host, readJson, readText, writeJson, resolvePath, join, dirname, exists, makeId, createMeta, toRef, defaultBuildOutDir, defaultRunCommandOutDir, defaultLlmPlanOutDir, allowNetworkRequests, isLlmLiveEnabled, isLlmStrictEnabled, isLlmBudgetLoopEnabled, isLocalBaseUrl, createSolverAdapter, createLlmAdapter, nowIso, log, warn, cwd, hostObjectPlacement, hostLayoutBudgetFit };
  Object.assign(ctx, createSolveCommands(ctx));
  Object.assign(ctx, createBuildCommands(ctx));
  Object.assign(ctx, createRunCommands(ctx));
  Object.assign(ctx, createReplayCommands(ctx));
  Object.assign(ctx, createInspectCommands(ctx));
  Object.assign(ctx, createConfiguratorCommands(ctx));
  Object.assign(ctx, createBudgetCommands(ctx));
  Object.assign(ctx, createExternalCommands(ctx));
  Object.assign(ctx, createLlmCommands(ctx));
  Object.assign(ctx, createLlmPlanCommands(ctx));

  return {
    solve: ctx.solve,
    build: ctx.build,
    run: ctx.run,
    replay: ctx.replay,
    inspect: ctx.inspect,
    configurator: ctx.configurator,
    budget: ctx.budget,
    ipfs: ctx.ipfs,
    ipfsPublish: ctx.ipfsPublish,
    ipfsLoad: ctx.ipfsLoad,
    blockchain: ctx.blockchain,
    blockchainMint: ctx.blockchainMint,
    blockchainLoad: ctx.blockchainLoad,
    llm: ctx.llm,
    llmPlan: ctx.llmPlan,
    authoringBuild: ctx.authoringBuild,
    planBuild: ctx.planBuild,
    hostObjectPlacement: ctx.hostObjectPlacement,
    hostLayoutBudgetFit: ctx.hostLayoutBudgetFit,
    manualMove: ctx.manualMove,
  };
}
