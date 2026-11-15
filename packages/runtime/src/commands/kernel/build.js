/**
 * The command kernel's `build`, `authoringBuild` and `planBuild`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { orchestrateBuild } from "../../build/orchestrate-build.js";
import { runPlanBuild } from "../../build/authoring-build.js";
import { runHostedAuthoringBuild } from "../author-level.js";
import { summarizeMixedRoomAssemblies, formatMixedRoomAssembliesCliLines } from "../../build/mixed-room-summary.js";
import { buildBuildTelemetryRecord } from "../../build/telemetry.js";
import { filterSchemaCatalogEntries } from "../../contracts/schema-catalog.js";
import { buildArtifactRefs, buildBuildArtifacts, buildBuildManifestEntries, captureAdapterPayload, collectBuildOutputArtifactRecords } from "./helpers.js";

export function createBuildCommands(ctx) {
  const { allowNetworkRequests, createSolverAdapter, defaultBuildOutDir, defaultRunCommandOutDir, dirname, host, hostObjectPlacement, join, log, readJson, readText, resolvePath, writeJson } = ctx;

  async function build(args) {
    if (typeof args.spec !== "string") {
      throw new Error("build requires --spec <path>.");
    }
    if (args["out-dir"] !== undefined && typeof args["out-dir"] !== "string") {
      throw new Error("build requires --out-dir <path> when provided.");
    }

    const specPath = resolvePath(args.spec);
    if (!specPath) {
      throw new Error("build requires --spec <path>.");
    }

    let spec = null;
    let outDir = null;
    let result = null;
    let manifestEntries = [];
    let capturedInputs = [];
    const solverDecisions = [];
    const producedBy = "cli-build";
    const baseDir = dirname(specPath);
    const emitIntermediates = Boolean(args["emit-intermediates"]);

    try {
      spec = await readJson(specPath);
      outDir = resolvePath(args["out-dir"]) || defaultBuildOutDir(spec);

      let solver = null;
      const solverSpec = spec.plan?.hints?.solver ?? spec.intent?.hints?.solver;
      if (solverSpec !== undefined) {
        if (!solverSpec || typeof solverSpec !== "object" || Array.isArray(solverSpec)) {
          throw new Error("build requires solver hints as an object when provided.");
        }
        const fixturePath = resolvePath(solverSpec.fixture || solverSpec.fixturePath, baseDir);
        if (!fixturePath) {
          throw new Error("build requires solver fixture path (solver.fixture).");
        }
        const scenarioFile = resolvePath(solverSpec.scenarioFile, baseDir);
        const optionsPath = resolvePath(solverSpec.optionsPath, baseDir);
        let scenarioData = solverSpec.scenario;
        if (scenarioData === undefined && scenarioFile) {
          scenarioData = await readText(scenarioFile);
        }
        let options = solverSpec.options;
        if (options === undefined && optionsPath) {
          options = await readJson(optionsPath);
        }

        const solverAdapter = await createSolverAdapter({ fixturePath });
        solver = {
          adapter: solverAdapter,
          scenario: scenarioData,
          options,
          clock: () => spec.meta.createdAt,
        };
      }

      const placeObjects = await hostObjectPlacement(spec.meta.createdAt, (decision) => solverDecisions.push(decision));
      result = await orchestrateBuild({ spec, producedBy, solver, placeObjects, solverDecisions });
      const mixedRoomAssemblies = summarizeMixedRoomAssemblies(result?.simConfig?.layout?.data?.rooms);
      if (result?.affinitySummary && typeof result.affinitySummary === "object") {
        result.affinitySummary = {
          ...result.affinitySummary,
          mixedRoomAssemblies,
        };
      }

      await writeJson(join(outDir, "spec.json"), result.spec);

      const captures = Array.isArray(spec.adapters?.capture) ? spec.adapters.capture : [];
      if (captures.length > 0) {
        const allowNetwork = allowNetworkRequests();
        for (let i = 0; i < captures.length; i += 1) {
          const captured = await captureAdapterPayload({
            capture: captures[i],
            index: i,
            baseDir,
            spec,
            producedBy,
            allowNetwork,
            host,
          });
          capturedInputs.push(captured);
        }
      }

      const persistedArtifacts = collectBuildOutputArtifactRecords(result, {
        capturedInputs,
        emitIntermediates,
        includeAffinitySummary: true,
      });
      for (const entry of persistedArtifacts) {
        await writeJson(join(outDir, entry.path), entry.artifact);
      }

      const bundleArtifacts = buildBuildArtifacts(result, {
        capturedInputs,
        emitIntermediates,
        includeAffinitySummary: true,
      });
      manifestEntries = buildBuildManifestEntries(result, {
        capturedInputs,
        emitIntermediates,
        includeAffinitySummary: true,
      });

      const schemaEntries = filterSchemaCatalogEntries({
        schemaRefs: [
          { schema: spec.schema, schemaVersion: spec.schemaVersion },
          ...manifestEntries,
        ],
      });

      const bundle = {
        spec: result.spec,
        schemas: schemaEntries,
        artifacts: bundleArtifacts,
      };

      await writeJson(join(outDir, "bundle.json"), bundle);

      const manifest = {
        specPath: "spec.json",
        correlation: {
          runId: spec.meta.runId,
          source: spec.meta.source,
          correlationId: spec.meta.correlationId,
        },
        schemas: schemaEntries,
        artifacts: manifestEntries,
      };

      if (!manifest.correlation.correlationId) {
        delete manifest.correlation.correlationId;
      }

      await writeJson(join(outDir, "manifest.json"), manifest);

      const artifactRefs = buildArtifactRefs(manifestEntries);
      const telemetry = buildBuildTelemetryRecord({
        spec,
        status: "success",
        artifactRefs,
        producedBy,
        clock: () => spec.meta.createdAt,
        data: { solverDecisions },
      });
      await writeJson(join(outDir, "telemetry.json"), telemetry);

      log(`build: wrote ${outDir}`);
      formatMixedRoomAssembliesCliLines(mixedRoomAssemblies).forEach((line) => {
        log(line);
      });
      return { outDir };
    } catch (error) {
      const message = error?.message || String(error);
      const runId = spec?.meta?.runId || "run_unknown";
      outDir = outDir || defaultRunCommandOutDir("build", runId);
      let artifactRefs = buildArtifactRefs(manifestEntries);
      if (artifactRefs.length === 0 && result) {
        const fallbackEntries = buildBuildManifestEntries(result, { capturedInputs });
        artifactRefs = buildArtifactRefs(fallbackEntries);
      }
      const telemetry = buildBuildTelemetryRecord({
        spec,
        status: "error",
        errors: [message],
        artifactRefs,
        producedBy,
        clock: () => spec?.meta?.createdAt || "1970-01-01T00:00:00.000Z",
        data: { solverDecisions },
      });
      await writeJson(join(outDir, "telemetry.json"), telemetry);
      throw error;
    }
  }
  // Authoring build (P2.3.2): the create/configure domain build pipeline the
  // CLI previously reimplemented inline. Its only host IO is the solver round trip
  // for object placement (#296) — the CLI keeps parse/maximize/summary+request
  // assembly and all writing — so otherwise this is a pass-through to the runtime
  // pipeline (routes translation through the Director controller, like llmPlan).
  async function authoringBuild(input) {
    return runHostedAuthoringBuild(input, { adapter: await createSolverAdapter({}) });
  }
  // Plain authored build (P2.3.3): the *-plan commands' build pipeline
  // (room/hazard/resource/delver/warden-plan) — Director-routed spec assembly,
  // no Configurator input prep or motivation patching. Hosts object placement
  // and passes through, same as authoringBuild.
  async function planBuild(input) {
    const solverDecisions = [];
    const placeObjects = await hostObjectPlacement(input?.createdAt, (decision) => solverDecisions.push(decision));
    return runPlanBuild({ ...input, placeObjects, solverDecisions });
  }

  return { build, authoringBuild, planBuild };
}
