/**
 * The command kernel's `solve`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { createAllocatorPersona } from "../../personas/allocator/persona.js";
import { createConfiguratorPersona } from "../../personas/configurator/persona.js";
import { createHostedLayoutBudgetFitter, createHostedObjectPlacer } from "../solver-host.js";
import { SCHEMAS, SOLVE_QUESTIONS, assertSchema } from "./helpers.js";

export function createSolveCommands(ctx) {
  const { createMeta, createSolverAdapter, defaultRunCommandOutDir, exists, join, log, makeId, nowIso, readJson, readText, resolvePath, toRef, writeJson } = ctx;
  const configurator = (...args) => ctx.configurator(...args);

  async function solve(args) {
    const runId = args["run-id"] || makeId("run");
    const scenario = args.scenario || null;
    const scenarioFilePath = resolvePath(args["scenario-file"]);
    const planPath = resolvePath(args.plan);
    const intentPath = resolvePath(args.intent);
    const optionsPath = resolvePath(args.options);
    const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("solve", runId);
    const solverFixturePath = resolvePath(args["solver-fixture"]);

    if (args.question !== undefined) {
      return solveLevelQuestion(args, { runId, outDir, solverFixturePath });
    }

    let scenarioData = scenario;
    if (!scenarioData && scenarioFilePath) {
      scenarioData = await readText(scenarioFilePath);
    }
    if (!scenarioData && !planPath && !intentPath) {
      throw new Error("solve requires --scenario, --scenario-file, --plan, or --intent.");
    }

    let planArtifact = null;
    let intentArtifact = null;
    if (planPath) {
      planArtifact = await readJson(planPath);
      assertSchema(planArtifact, SCHEMAS.plan);
    }
    if (intentPath) {
      intentArtifact = await readJson(intentPath);
      assertSchema(intentArtifact, SCHEMAS.intent);
    }

    let options = null;
    if (optionsPath) {
      options = await readJson(optionsPath);
    }

    const solverRequest = {
      schema: SCHEMAS.solverRequest,
      schemaVersion: 1,
      meta: createMeta({ producedBy: "cli-solve", runId }),
      intentRef: toRef(intentArtifact),
      planRef: toRef(planArtifact),
      problem: {
        language: "custom",
        data: scenarioData || { planRef: toRef(planArtifact) },
      },
      options: options || undefined,
    };

    const solverAdapter = await createSolverAdapter({ fixturePath: solverFixturePath });
    const solverResult = await solverAdapter.solve(solverRequest);
    if (!solverResult.meta) {
      solverResult.meta = createMeta({ producedBy: "cli-solve", runId });
    }
    solverResult.schema = solverResult.schema || SCHEMAS.solverResult;
    solverResult.schemaVersion = solverResult.schemaVersion || 1;
    solverResult.requestRef = solverResult.requestRef || toRef(solverRequest);

    await writeJson(join(outDir, "solver-request.json"), solverRequest);
    await writeJson(join(outDir, "solver-result.json"), solverResult);

    log(`solve: wrote ${outDir}`);
    return { outDir, solverRequest, solverResult };
  }
  /**
   * #300 — ask the solver a real question about a built level. The owning persona poses the
   * problem and judges the answer; this glue only reads the level, records the round trip,
   * and dispatches through the same hosts the build uses.
   */
  async function readLevelPriceList(dir) {
    const path = join(dir, "price-list.json");
    if (!(await exists(path))) return undefined;
    const artifact = await readJson(path);
    assertSchema(artifact, SCHEMAS.priceList);
    return artifact;
  }
  async function solveLevelQuestion(args, { runId, outDir, solverFixturePath }) {
    const question = args.question;
    if (!SOLVE_QUESTIONS.includes(question)) {
      throw new Error(`solve --question must be one of: ${SOLVE_QUESTIONS.join(", ")}.`);
    }
    const dir = resolvePath(args.dir);
    if (!dir) throw new Error("solve --question needs --dir <built level directory>.");
    const simConfig = await readJson(join(dir, "sim-config.json"));
    assertSchema(simConfig, SCHEMAS.simConfig);
    const createdAt = simConfig.meta?.createdAt || nowIso();
    const clock = () => createdAt;

    // Record the request the persona posed and the answer the adapter gave, without
    // handing the persona anything but the hosted round trip it already uses.
    const solverAdapter = await createSolverAdapter({ fixturePath: solverFixturePath });
    const recorded = { prepared: null, request: null, result: null };
    const recordPrepared = (prepare) => (input) => {
      recorded.prepared = prepare(input);
      return recorded.prepared;
    };
    const recordingAdapter = Object.assign(Object.create(solverAdapter), {
      solve: async (request) => {
        recorded.request = request;
        recorded.result = await solverAdapter.solve(request);
        return recorded.result;
      },
    });

    let answer;
    if (question === "place-objects") {
      const initialState = await readJson(join(dir, "initial-state.json"));
      assertSchema(initialState, SCHEMAS.initialState);
      const configurator = createConfiguratorPersona({ clock });
      const requests = configurator.levelObjectRequests(initialState);
      const placeObjects = createHostedObjectPlacer({
        prepare: recordPrepared(configurator.prepareObjectPlacement),
        complete: configurator.completeObjectPlacement,
        adapter: recordingAdapter,
        clock,
      });
      const placement = await placeObjects({ layout: simConfig.layout?.data, ...requests });
      const before = new Map((initialState.actors || []).map((actor) => [actor.id, actor.position]));
      const placements = (placement?.actors || []).map((actor) => ({
        id: actor.id,
        x: actor.position?.x,
        y: actor.position?.y,
        moved: before.get(actor.id)?.x !== actor.position?.x || before.get(actor.id)?.y !== actor.position?.y,
      }));
      answer = {
        question,
        ok: placement?.ok === true,
        ...(placement?.ok ? { source: placement.source, placements } : { status: placement?.status, reason: placement?.reason }),
      };
    } else {
      // The Allocator judges the budget (a missing or invalid one is its refusal, not ours)
      // and prices with the level's own price list, or its default when the level has none.
      const budgetTokens = Number(args["budget-tokens"]);
      const allocator = createAllocatorPersona({ clock, priceList: await readLevelPriceList(dir) });
      const requestedLayout = allocator.billedLayoutTiles(simConfig.layout?.data);
      const fitLayout = createHostedLayoutBudgetFitter({
        prepare: recordPrepared(allocator.prepareLayoutBudgetFit),
        complete: allocator.completeLayoutBudgetFit,
        adapter: recordingAdapter,
        clock,
      });
      const fit = await fitLayout({ layout: requestedLayout, remainingBudgetTokens: budgetTokens });
      answer = { question, budgetTokens, requestedLayout, ...fit };
    }

    // No adapter call means one of two things: the persona posed a problem this adapter
    // cannot serve (it fell back), or the persona needed no search at all.
    let solverResult = recorded.result;
    if (!solverResult && recorded.prepared?.status === "ready") {
      solverResult = { status: "deferred", reason: "solver_domain_unavailable" };
    } else if (!solverResult) {
      solverResult = {
        status: "not_posed",
        reason: recorded.prepared?.status === "bypass" ? "no_search_needed" : recorded.prepared?.reason || "not_posed",
      };
    }
    const artifactPaths = {};
    if (recorded.request) {
      artifactPaths.solver_request = join(outDir, "solver-request.json");
      await writeJson(artifactPaths.solver_request, recorded.request);
      artifactPaths.solver_result = join(outDir, "solver-result.json");
      await writeJson(artifactPaths.solver_result, recorded.result);
    }
    artifactPaths.answer = join(outDir, "solve-answer.json");
    await writeJson(artifactPaths.answer, answer);
    log(`solve: wrote ${outDir}`);
    return { outDir, runId, solverRequest: recorded.request, solverResult, answer, artifactPaths };
  }

  return { solve, readLevelPriceList, solveLevelQuestion };
}
