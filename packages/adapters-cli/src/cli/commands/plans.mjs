/**
 * `agon room-plan`, `hazard-plan`, `resource-plan`, `delver-plan`, `warden-plan`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
// CR.7 / WP-5 — the vocabulary comes from CONTRACTS, not from the Orchestrator's alias of
// it. `prompt-contract.js` only renamed these (P5.1 D1: one value, three names), so the
// boundary crossing died with the hop rather than being republished. Aliased on import so
// the call sites below are untouched.
import { AFFINITY_KINDS as ALLOWED_AFFINITIES } from "../../../../runtime/src/contracts/domain-constants.js";
import { DEFAULT_DUNGEON_AFFINITY, DEFAULT_ROOM_CARD_AFFINITY } from "../../../../runtime/src/contracts/domain-constants.js";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { SCHEMAS, applyBudgetCappedFulfillment, assertSchema, buildAuthoringSection, buildSharedOptimizationGoals, commandKernel, dedupeOptimizationGoals, defaultRunCommandOutDir, emitJsonStdout, ensureBudgetedFulfillmentFeasible, extractBudgetTokensFromText, isNonEmptyString, makeId, parseDelverSpecs, parseHazardSpecs, parsePositiveIntStrict, parseResourceSpecs, parseRoomSpecs, parseWardenSpecs, readJson, resolveAuthoringBudget, resolvePath, resolveTextVitalOptimizationGoals, usage } from "./shared.mjs";
import { writeBuildOutputs, writeHazardArtifactFiles, writeResourceArtifactFiles } from "./authoring-shared.mjs";

function assertAllowedRoomPlanArgs(args) {
  const allowed = new Set([
    "room",
    "goal",
    "dungeon-affinity",
    "budget-tokens",
    "budget",
    "price-list",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
  ]);
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
    throw new Error(`room-plan only accepts --room, --goal, --dungeon-affinity, --budget-tokens, --budget, --price-list, --out-dir, --run-id, --created-at, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

function assertAllowedHazardPlanArgs(args) {
  const allowed = new Set([
    "hazard",
    "goal",
    "dungeon-affinity",
    "budget-tokens",
    "budget",
    "price-list",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
  ]);
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
    throw new Error(`hazard-plan only accepts --hazard, --goal, --dungeon-affinity, --budget-tokens, --budget, --price-list, --out-dir, --run-id, --created-at, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

function assertAllowedResourcePlanArgs(args) {
  const allowed = new Set([
    "resource",
    "goal",
    "dungeon-affinity",
    "budget-tokens",
    "budget",
    "price-list",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
  ]);
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
    throw new Error(`resource-plan only accepts --resource, --goal, --dungeon-affinity, --budget-tokens, --budget, --price-list, --out-dir, --run-id, --created-at, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

function assertAllowedDelverPlanArgs(args) {
  const allowed = new Set([
    "delver",
    "goal",
    "dungeon-affinity",
    "budget-tokens",
    "budget",
    "price-list",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
  ]);
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
    throw new Error(`delver-plan only accepts --delver, --goal, --dungeon-affinity, --budget-tokens, --budget, --price-list, --out-dir, --run-id, --created-at, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

function assertAllowedWardenPlanArgs(args) {
  const allowed = new Set([
    "warden",
    "goal",
    "dungeon-affinity",
    "budget-tokens",
    "budget",
    "price-list",
    "out-dir",
    "run-id",
    "created-at",
    "emit-intermediates",
  ]);
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
    throw new Error(`warden-plan only accepts --warden, --goal, --dungeon-affinity, --budget-tokens, --budget, --price-list, --out-dir, --run-id, --created-at, and --emit-intermediates. Unknown: ${unknown.join(", ")}`);
  }
}

export async function roomPlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedRoomPlanArgs(args);

  const parsedRooms = parseRoomSpecs(args.room);
  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("room-plan", runId);
  const budgetPath = resolvePath(args.budget);
  const priceListPath = resolvePath(args["price-list"]);

  const dungeonAffinity = isNonEmptyString(args["dungeon-affinity"])
    ? args["dungeon-affinity"].trim().toLowerCase()
    : (DEFAULT_ROOM_CARD_AFFINITY ?? undefined);
  if (dungeonAffinity !== undefined && !ALLOWED_AFFINITIES.includes(dungeonAffinity)) {
    throw new Error(`room-plan --dungeon-affinity must be one of: ${ALLOWED_AFFINITIES.join(", ")}.`);
  }

  let budgetTokensFlag;
  if (args["budget-tokens"] !== undefined) {
    budgetTokensFlag = parsePositiveIntStrict(args["budget-tokens"], "room-plan --budget-tokens");
  }
  if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
    throw new Error("room-plan requires both --budget and --price-list.");
  }

  let budgetArtifact = null;
  let priceListArtifact = null;
  if (budgetPath) {
    budgetArtifact = await readJson(budgetPath);
    assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
  }
  if (priceListPath) {
    priceListArtifact = await readJson(priceListPath);
    assertSchema(priceListArtifact, SCHEMAS.priceList);
  }

  const goal = isNonEmptyString(args.goal)
    ? args.goal.trim()
    : `Author dungeon rooms (${parsedRooms.length} configuration${parsedRooms.length === 1 ? "" : "s"}).`;
  const textBudgetTokens = extractBudgetTokensFromText(goal, "room-plan --goal");
  const {
    resolvedBudgetTokens,
    requestedBudgetTokens,
    constraints: authoringConstraints,
  } = resolveAuthoringBudget({
    commandName: "room-plan",
    textBudgetTokens,
    flagBudgetTokens: budgetTokensFlag,
    budgetArtifact,
  });
  resolveTextVitalOptimizationGoals({
    commandName: "room-plan",
    text: goal,
    scope: null,
  });
  const sharedOptimizationGoals = buildSharedOptimizationGoals({
    text: goal,
    hardBudgetConstraint: authoringConstraints,
  });
  ensureBudgetedFulfillmentFeasible({
    commandName: "room-plan",
    budgetTokens: resolvedBudgetTokens,
    rooms: parsedRooms,
    delvers: [],
    priceListArtifact,
  });
  const fulfilledRooms = applyBudgetCappedFulfillment({
    rooms: parsedRooms,
    delvers: [],
    priceListArtifact,
    budgetTokens: requestedBudgetTokens,
  }).rooms;
  const summary = {
    goal,
    dungeonAffinity,
    rooms: fulfilledRooms.map((entry) => entry.value),
    actors: [],
    poolWeights: [{ id: "rooms", weight: 1 }],
  };
  if (resolvedBudgetTokens !== undefined) {
    summary.budgetTokens = resolvedBudgetTokens;
  }

  const authoring = buildAuthoringSection({
    objectKinds: ["room"],
    constraints: authoringConstraints,
    sharedOptimizationGoals,
  });
  const { buildResult } = await commandKernel.planBuild({
    summary,
    authoring,
    commandName: "room-plan",
    runId,
    createdAt,
    budgetArtifact,
    priceListArtifact,
  });
  emitJsonStdout(await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName: "room-plan",
    producedBy: "cli-room-plan",
  }));
}

export async function hazardPlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedHazardPlanArgs(args);

  const parsedHazards = parseHazardSpecs(args.hazard);
  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("hazard-plan", runId);
  const budgetPath = resolvePath(args.budget);
  const priceListPath = resolvePath(args["price-list"]);

  const dungeonAffinity = isNonEmptyString(args["dungeon-affinity"])
    ? args["dungeon-affinity"].trim().toLowerCase()
    : (DEFAULT_DUNGEON_AFFINITY ?? undefined);
  if (dungeonAffinity !== undefined && !ALLOWED_AFFINITIES.includes(dungeonAffinity)) {
    throw new Error(`hazard-plan --dungeon-affinity must be one of: ${ALLOWED_AFFINITIES.join(", ")}.`);
  }

  let budgetTokensFlag;
  if (args["budget-tokens"] !== undefined) {
    budgetTokensFlag = parsePositiveIntStrict(args["budget-tokens"], "hazard-plan --budget-tokens");
  }
  if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
    throw new Error("hazard-plan requires both --budget and --price-list.");
  }

  let budgetArtifact = null;
  let priceListArtifact = null;
  if (budgetPath) {
    budgetArtifact = await readJson(budgetPath);
    assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
  }
  if (priceListPath) {
    priceListArtifact = await readJson(priceListPath);
    assertSchema(priceListArtifact, SCHEMAS.priceList);
  }

  const goal = isNonEmptyString(args.goal)
    ? args.goal.trim()
    : `Author hazards (${parsedHazards.length} configuration${parsedHazards.length === 1 ? "" : "s"}).`;
  const textBudgetTokens = extractBudgetTokensFromText(goal, "hazard-plan --goal");
  const {
    resolvedBudgetTokens,
    constraints: authoringConstraints,
  } = resolveAuthoringBudget({
    commandName: "hazard-plan",
    textBudgetTokens,
    flagBudgetTokens: budgetTokensFlag,
    budgetArtifact,
  });
  const sharedOptimizationGoals = buildSharedOptimizationGoals({
    text: goal,
    hardBudgetConstraint: authoringConstraints,
  });
  const hazards = parsedHazards.map((entry) => entry.value);
  const summary = {
    goal,
    dungeonAffinity,
    hazards,
    budgetScaffold: true,
    poolWeights: [{ id: "hazards", weight: 1 }],
  };
  if (resolvedBudgetTokens !== undefined) {
    summary.budgetTokens = resolvedBudgetTokens;
  }

  const authoring = buildAuthoringSection({
    objectKinds: ["hazard"],
    constraints: authoringConstraints,
    sharedOptimizationGoals,
  });
  const { buildResult } = await commandKernel.planBuild({
    summary,
    authoring,
    commandName: "hazard-plan",
    runId,
    createdAt,
    budgetArtifact,
    priceListArtifact,
  });
  const stdoutSummary = await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName: "hazard-plan",
    producedBy: "cli-hazard-plan",
  });
  await writeHazardArtifactFiles({
    parsedHazards,
    outDir,
    runId,
    createdAt,
    producedBy: "cli-hazard-plan",
  });
  emitJsonStdout(stdoutSummary);
}

export async function resourcePlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedResourcePlanArgs(args);

  const parsedResources = parseResourceSpecs(args.resource);
  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("resource-plan", runId);
  const budgetPath = resolvePath(args.budget);
  const priceListPath = resolvePath(args["price-list"]);

  const dungeonAffinity = isNonEmptyString(args["dungeon-affinity"])
    ? args["dungeon-affinity"].trim().toLowerCase()
    : (DEFAULT_DUNGEON_AFFINITY ?? undefined);
  if (dungeonAffinity !== undefined && !ALLOWED_AFFINITIES.includes(dungeonAffinity)) {
    throw new Error(`resource-plan --dungeon-affinity must be one of: ${ALLOWED_AFFINITIES.join(", ")}.`);
  }

  let budgetTokensFlag;
  if (args["budget-tokens"] !== undefined) {
    budgetTokensFlag = parsePositiveIntStrict(args["budget-tokens"], "resource-plan --budget-tokens");
  }
  if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
    throw new Error("resource-plan requires both --budget and --price-list.");
  }

  let budgetArtifact = null;
  let priceListArtifact = null;
  if (budgetPath) {
    budgetArtifact = await readJson(budgetPath);
    assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
  }
  if (priceListPath) {
    priceListArtifact = await readJson(priceListPath);
    assertSchema(priceListArtifact, SCHEMAS.priceList);
  }

  const goal = isNonEmptyString(args.goal)
    ? args.goal.trim()
    : `Author resources (${parsedResources.length} configuration${parsedResources.length === 1 ? "" : "s"}).`;
  const textBudgetTokens = extractBudgetTokensFromText(goal, "resource-plan --goal");
  const {
    resolvedBudgetTokens,
    constraints: authoringConstraints,
  } = resolveAuthoringBudget({
    commandName: "resource-plan",
    textBudgetTokens,
    flagBudgetTokens: budgetTokensFlag,
    budgetArtifact,
  });
  const sharedOptimizationGoals = buildSharedOptimizationGoals({
    text: goal,
    hardBudgetConstraint: authoringConstraints,
  });
  const resources = parsedResources.map((entry) => entry.value);
  const summary = {
    goal,
    dungeonAffinity,
    resources,
    budgetScaffold: true,
    poolWeights: [{ id: "resources", weight: 1 }],
  };
  if (resolvedBudgetTokens !== undefined) {
    summary.budgetTokens = resolvedBudgetTokens;
  }

  const authoring = buildAuthoringSection({
    objectKinds: ["resource"],
    constraints: authoringConstraints,
    sharedOptimizationGoals,
  });
  const { buildResult } = await commandKernel.planBuild({
    summary,
    authoring,
    commandName: "resource-plan",
    runId,
    createdAt,
    budgetArtifact,
    priceListArtifact,
  });
  const stdoutSummary = await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName: "resource-plan",
    producedBy: "cli-resource-plan",
  });
  await writeResourceArtifactFiles({
    parsedResources,
    outDir,
    runId,
    createdAt,
    producedBy: "cli-resource-plan",
  });
  emitJsonStdout(stdoutSummary);
}

export async function delverPlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedDelverPlanArgs(args);

  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("delver-plan", runId);
  const budgetPath = resolvePath(args.budget);
  const priceListPath = resolvePath(args["price-list"]);

  const dungeonAffinity = isNonEmptyString(args["dungeon-affinity"])
    ? args["dungeon-affinity"].trim().toLowerCase()
    : (DEFAULT_DUNGEON_AFFINITY ?? undefined);
  if (dungeonAffinity !== undefined && !ALLOWED_AFFINITIES.includes(dungeonAffinity)) {
    throw new Error(`delver-plan --dungeon-affinity must be one of: ${ALLOWED_AFFINITIES.join(", ")}.`);
  }

  const parsedDelvers = parseDelverSpecs(args.delver, { defaultAffinity: dungeonAffinity });

  let budgetTokensFlag;
  if (args["budget-tokens"] !== undefined) {
    budgetTokensFlag = parsePositiveIntStrict(args["budget-tokens"], "delver-plan --budget-tokens");
  }
  if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
    throw new Error("delver-plan requires both --budget and --price-list.");
  }

  let budgetArtifact = null;
  let priceListArtifact = null;
  if (budgetPath) {
    budgetArtifact = await readJson(budgetPath);
    assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
  }
  if (priceListPath) {
    priceListArtifact = await readJson(priceListPath);
    assertSchema(priceListArtifact, SCHEMAS.priceList);
  }

  const goal = isNonEmptyString(args.goal)
    ? args.goal.trim()
    : `Author delvers (${parsedDelvers.length} configuration${parsedDelvers.length === 1 ? "" : "s"}).`;
  const textBudgetTokens = extractBudgetTokensFromText(goal, "delver-plan --goal");
  const {
    resolvedBudgetTokens,
    requestedBudgetTokens,
    constraints: authoringConstraints,
  } = resolveAuthoringBudget({
    commandName: "delver-plan",
    textBudgetTokens,
    flagBudgetTokens: budgetTokensFlag,
    budgetArtifact,
  });
  const textVitalGoals = resolveTextVitalOptimizationGoals({
    commandName: "delver-plan",
    text: goal,
    scope: "delver",
  });
  const sharedOptimizationGoals = buildSharedOptimizationGoals({
    text: goal,
    hardBudgetConstraint: authoringConstraints,
  });
  const delverOptimizationGoals = dedupeOptimizationGoals([
    ...parsedDelvers.flatMap((entry) => entry.optimizationGoals || []),
    ...textVitalGoals,
  ]);
  ensureBudgetedFulfillmentFeasible({
    commandName: "delver-plan",
    budgetTokens: resolvedBudgetTokens,
    rooms: [],
    delvers: parsedDelvers.map((entry) => ({
      ...entry,
      optimizationGoals: dedupeOptimizationGoals([
        ...(entry.optimizationGoals || []),
        ...textVitalGoals,
      ]),
    })),
    priceListArtifact,
  });
  const fulfilledDelvers = applyBudgetCappedFulfillment({
    rooms: [],
    delvers: parsedDelvers.map((entry) => ({
      ...entry,
      optimizationGoals: dedupeOptimizationGoals([
        ...(entry.optimizationGoals || []),
        ...textVitalGoals,
      ]),
    })),
    priceListArtifact,
    budgetTokens: requestedBudgetTokens,
  }).delvers;
  const summary = {
    goal,
    dungeonAffinity,
    cardSet: fulfilledDelvers.map((entry) => entry.value),
    budgetScaffold: true,
    poolWeights: [{ id: "delver", weight: 1 }],
  };
  if (resolvedBudgetTokens !== undefined) {
    summary.budgetTokens = resolvedBudgetTokens;
  }

  const authoring = buildAuthoringSection({
    objectKinds: ["delver"],
    constraints: authoringConstraints,
    sharedOptimizationGoals,
    objectOptimizationGoals: delverOptimizationGoals,
  });
  const { buildResult } = await commandKernel.planBuild({
    summary,
    authoring,
    commandName: "delver-plan",
    runId,
    createdAt,
    budgetArtifact,
    priceListArtifact,
  });
  emitJsonStdout(await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName: "delver-plan",
    producedBy: "cli-delver-plan",
  }));
}

export async function wardenPlanCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  assertAllowedWardenPlanArgs(args);

  const runId = args["run-id"] || makeId("run");
  const createdAt = args["created-at"] || new Date().toISOString();
  const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("warden-plan", runId);
  const budgetPath = resolvePath(args.budget);
  const priceListPath = resolvePath(args["price-list"]);

  const dungeonAffinity = isNonEmptyString(args["dungeon-affinity"])
    ? args["dungeon-affinity"].trim().toLowerCase()
    : (DEFAULT_DUNGEON_AFFINITY ?? undefined);
  if (dungeonAffinity !== undefined && !ALLOWED_AFFINITIES.includes(dungeonAffinity)) {
    throw new Error(`warden-plan --dungeon-affinity must be one of: ${ALLOWED_AFFINITIES.join(", ")}.`);
  }

  const wardens = parseWardenSpecs(args.warden, { defaultAffinity: dungeonAffinity });

  let budgetTokensFlag;
  if (args["budget-tokens"] !== undefined) {
    budgetTokensFlag = parsePositiveIntStrict(args["budget-tokens"], "warden-plan --budget-tokens");
  }
  if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
    throw new Error("warden-plan requires both --budget and --price-list.");
  }

  let budgetArtifact = null;
  let priceListArtifact = null;
  if (budgetPath) {
    budgetArtifact = await readJson(budgetPath);
    assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
  }
  if (priceListPath) {
    priceListArtifact = await readJson(priceListPath);
    assertSchema(priceListArtifact, SCHEMAS.priceList);
  }

  const goal = isNonEmptyString(args.goal)
    ? args.goal.trim()
    : `Author wardens (${wardens.length} configuration${wardens.length === 1 ? "" : "s"}).`;
  const textBudgetTokens = extractBudgetTokensFromText(goal, "warden-plan --goal");
  const {
    resolvedBudgetTokens,
    constraints: authoringConstraints,
  } = resolveAuthoringBudget({
    commandName: "warden-plan",
    textBudgetTokens,
    flagBudgetTokens: budgetTokensFlag,
    budgetArtifact,
  });
  const textVitalGoals = resolveTextVitalOptimizationGoals({
    commandName: "warden-plan",
    text: goal,
    scope: "warden",
  });
  const sharedOptimizationGoals = buildSharedOptimizationGoals({
    text: goal,
    hardBudgetConstraint: authoringConstraints,
  });
  ensureBudgetedFulfillmentFeasible({
    commandName: "warden-plan",
    budgetTokens: resolvedBudgetTokens,
    rooms: [],
    delvers: [],
    wardens: wardens.map((entry) => ({
      value: entry,
      optimizationGoals: dedupeOptimizationGoals(textVitalGoals),
    })),
    priceListArtifact,
  });
  const summary = {
    goal,
    dungeonAffinity,
    cardSet: wardens,
    budgetScaffold: true,
    poolWeights: [{ id: "wardens", weight: 1 }],
  };
  if (resolvedBudgetTokens !== undefined) {
    summary.budgetTokens = resolvedBudgetTokens;
  }

  const authoring = buildAuthoringSection({
    objectKinds: ["warden"],
    constraints: authoringConstraints,
    sharedOptimizationGoals,
    objectOptimizationGoals: textVitalGoals,
  });
  const { buildResult } = await commandKernel.planBuild({
    summary,
    authoring,
    commandName: "warden-plan",
    runId,
    createdAt,
    budgetArtifact,
    priceListArtifact,
  });
  emitJsonStdout(await writeBuildOutputs({
    outDir,
    spec: buildResult.spec,
    buildResult,
    emitIntermediates: Boolean(args["emit-intermediates"]),
    commandName: "warden-plan",
    producedBy: "cli-warden-plan",
  }));
}
