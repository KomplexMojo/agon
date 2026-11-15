/**
 * `agon sandbox-create`, `sandbox-place`, `sandbox-move`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { executeSandboxCreate, executeSandboxPlace, executeSandboxMove } from "../../mcp/tools/sandbox.mjs";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { emitJsonStdout, isNonEmptyString, resolvePath, usage } from "./shared.mjs";

export async function sandboxCreateCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const width = args.width !== undefined ? Number(args.width) : 10;
  const height = args.height !== undefined ? Number(args.height) : 10;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error("sandbox-create: --width must be a positive integer.");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error("sandbox-create: --height must be a positive integer.");
  }

  // #277: one sandbox-create for the CLI and MCP, so the Allocator judges and issues every receipt.
  const result = await executeSandboxCreate({
    budgetReceipt: resolvePath(args["budget-receipt"]),
    budget: resolvePath(args.budget),
    width,
    height,
    entityCategories: isNonEmptyString(args["entity-categories"]) ? args["entity-categories"].split(",") : undefined,
    runId: args["run-id"],
    createdAt: args["created-at"],
    outDir: resolvePath(args["out-dir"]) || undefined,
  });
  emitJsonStdout(result);
}

export async function sandboxPlaceCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const sessionPath = resolvePath(args.session);
  const entityType = args["entity-type"];
  const spec = args.spec;

  if (!sessionPath) {
    throw new Error("sandbox-place requires --session <path>");
  }
  if (!isNonEmptyString(entityType)) {
    throw new Error("sandbox-place requires --entity-type <type>");
  }
  if (!isNonEmptyString(spec)) {
    throw new Error("sandbox-place requires --spec <spec-string>");
  }

  const result = await executeSandboxPlace({ session: sessionPath, entityType, spec });
  emitJsonStdout(result);
  if (!result.ok) {
    process.exit(1);
  }
}

export async function sandboxMoveCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const sessionPath = resolvePath(args.session);
  const actorId = args["actor-id"];
  const direction = args.direction;
  const actionsOut = resolvePath(args["actions-out"]);

  if (!sessionPath) {
    throw new Error("sandbox-move requires --session <path>");
  }
  if (!isNonEmptyString(actorId)) {
    throw new Error("sandbox-move requires --actor-id <id>");
  }
  if (!isNonEmptyString(direction)) {
    throw new Error(
      "sandbox-move requires --direction <north|northeast|east|southeast|south|southwest|west|northwest>",
    );
  }
  if (!actionsOut) {
    throw new Error("sandbox-move requires --actions-out <path>");
  }

  const result = await executeSandboxMove({
    session: sessionPath,
    actorId,
    direction,
    actionsOut,
  });
  emitJsonStdout(result);
  if (!result.ok) {
    process.exit(1);
  }
}
