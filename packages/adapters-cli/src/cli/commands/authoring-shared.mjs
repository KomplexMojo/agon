/**
 * Helpers the authoring commands and the *-plan commands share: build output writing, cost summaries, artifact files.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { join } from "node:path";
import { buildBuildArtifacts, buildBuildManifestEntries, collectBuildOutputArtifactRecords } from "../../../../runtime/src/commands/kernel.js";
import { buildBuildTelemetryRecord } from "../../../../runtime/src/build/telemetry.js";
import { filterSchemaCatalogEntries } from "../../../../runtime/src/contracts/schema-catalog.js";
import { readWastedRegen } from "../../../../runtime/src/personas/allocator/controller.js";
// M9: this file's whole schema vocabulary — the SCHEMAS alias table below, the four
// schema constants it already imported, and the scattered literals in between —
// now has one origin.
import { HAZARD_ARTIFACT_SCHEMA, RESOURCE_ARTIFACT_SCHEMA } from "../../../../runtime/src/contracts/artifacts.ts";
import { SCHEMAS, buildStructuredSuccessSummary, collectPreviewCardSet, gradeAllocator, isNonEmptyString, normalizePreviewCardType, writeJson } from "./shared.mjs";

function sanitizeFileSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "capture";
}

function sanitizeFileName(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "capture";
}

function buildCapturedInputPath(adapter, index, outputRefId) {
  if (isNonEmptyString(outputRefId)) {
    return `${sanitizeFileName(outputRefId)}.json`;
  }
  return `captured-input-${sanitizeFileSegment(adapter)}-${index + 1}.json`;
}

// Finding #4: `create`/`configure`'s positioned --hazard/--resource land straight in the
// grid (spec.configurator.inputs.levelGen.hazards / .resources) and never produce a
// plan.hints.cardSet entry — cards are structurally unpositioned everywhere in this codebase
// (createDesignCard has no x/y field), so this is intentional, not a gap to close. What was
// missing was any signal in the response itself: a caller authoring a hazard/resource had no
// way to know it landed placed-only instead of as a reviewable Design-tab card. Surfaced only
// when at least one was actually placed, so most create/configure calls stay unaffected.
function buildPlacedObjectsNote(spec) {
  const placedHazards = Array.isArray(spec?.configurator?.inputs?.levelGen?.hazards)
    ? spec.configurator.inputs.levelGen.hazards.length
    : 0;
  const placedResources = Array.isArray(spec?.configurator?.inputs?.resources)
    ? spec.configurator.inputs.resources.length
    : 0;
  if (placedHazards === 0 && placedResources === 0) {
    return undefined;
  }
  const cardSet = collectPreviewCardSet(spec);
  const cardCount = (type) => cardSet.filter((card) => normalizePreviewCardType(card?.type) === type).length;
  const note = {};
  if (placedHazards > 0) {
    note.hazards = { placed: placedHazards, cards: cardCount("hazard") };
  }
  if (placedResources > 0) {
    note.resources = { placed: placedResources, cards: cardCount("resource") };
  }
  return note;
}

// Configurator input preparation (grid sizing, room-size profiles, hazard
// capacity) moved to personas/configurator/input-preparation.js in P2.2 and is
// consumed here through the Configurator persona surface (P2.3.1).

export async function writeBuildOutputs({
  outDir,
  spec,
  buildResult,
  requestArtifact = null,
  emitIntermediates = false,
  commandName,
  producedBy,
  tacticPlan,
  actorPlan,
} = {}) {
  await writeJson(join(outDir, "spec.json"), spec);

  const capturedInputs = Array.isArray(buildResult.capturedInputs) ? buildResult.capturedInputs : [];
  const capturedArtifacts = capturedInputs.map((entry, index) => {
    const artifact = entry?.artifact || entry;
    return {
      artifact,
      path: entry?.path || buildCapturedInputPath(artifact?.source?.adapter || "llm", index, artifact?.meta?.id),
    };
  });
  const persistedArtifacts = collectBuildOutputArtifactRecords(buildResult, {
    requestArtifact,
    capturedInputs: capturedArtifacts,
    emitIntermediates,
    includeAffinitySummary: true,
  });
  for (const entry of persistedArtifacts) {
    await writeJson(join(outDir, entry.path), entry.artifact);
  }

  const bundleArtifacts = buildBuildArtifacts(buildResult, {
    requestArtifact,
    capturedInputs: capturedArtifacts,
    emitIntermediates,
    includeAffinitySummary: true,
  });

  const manifestEntries = buildBuildManifestEntries(buildResult, {
    requestArtifact,
    capturedInputs: capturedArtifacts,
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
    spec,
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

  const telemetry = buildBuildTelemetryRecord({
    spec,
    status: "success",
    artifactRefs: buildArtifactRefs(manifestEntries),
    producedBy,
    clock: () => spec.meta.createdAt,
    data: { solverDecisions: Array.isArray(buildResult.solverDecisions) ? buildResult.solverDecisions : [] },
  });
  await writeJson(join(outDir, "telemetry.json"), telemetry);

  const costSummary = buildCostSummary(buildResult.budgetReceipt, buildResult.spendProposal, outDir);
  for (const { actorId, affinity, range, intensity, mana, manaMax } of buildResult.unaffordableCasts ?? []) {
    console.error(`warning: ${actorId} holds ${affinity}:${range}:${intensity}, which costs ${mana} mana a cast, `
      + `but its mana max is ${manaMax}; it can never cast it.`);
  }
  const placedObjects = buildPlacedObjectsNote(spec);
  // #301: how each `--place` constraint came out, from the Configurator's placement decision.
  const constraintReport = (Array.isArray(buildResult.solverDecisions) ? buildResult.solverDecisions : [])
    .find((decision) => Array.isArray(decision?.placementReport))?.placementReport;
  // #396: the Configurator's note on each tactic in the plan follows the constraint rows.
  const tacticReport = Array.isArray(buildResult.tacticReport) ? buildResult.tacticReport : [];
  const placementReport = constraintReport !== undefined || tacticReport.length > 0
    ? [...(constraintReport || []), ...tacticReport]
    : undefined;
  // #396: the tactic plan the build used and its seed, so the level can be rebuilt exactly.
  const tactics = buildResult.plan?.directives?.tactics;
  const buildSeed = spec?.configurator?.inputs?.levelGen?.seed;
  // #422: the grade and its numbers, and the Allocator's word on a --budget-tokens override.
  const gradeId = spec?.intent?.hints?.grade;
  const builtTokens = spec?.intent?.hints?.budgetTokens;
  const grade = typeof gradeId === "string" ? gradeAllocator.pricing.levelGradeReport(gradeId, builtTokens) : undefined;

  return buildStructuredSuccessSummary({
    command: commandName,
    outDir,
    runId: spec.meta.runId,
    manifestEntries,
    initialState: buildResult.initialState,
    simConfig: buildResult.simConfig,
    spec,
    extra: {
      ...(costSummary !== undefined ? { cost: costSummary } : {}),
      ...(placedObjects !== undefined ? { placedObjects } : {}),
      ...(placementReport !== undefined ? { placementReport } : {}),
      ...(Array.isArray(tactics) && tactics.length > 0 ? { tactics } : {}),
      ...(tacticPlan ? { tacticPlan } : {}),
      ...(actorPlan ? { actorPlan } : {}),
      ...(Number.isSafeInteger(buildSeed) ? { seed: buildSeed } : {}),
      ...(grade ? { grade } : {}),
      // #371: authored vitals a Configurator floor raised, so none changes silently.
      ...(buildResult.vitalsReport?.length > 0 ? { vitalsReport: buildResult.vitalsReport } : {}),
      // #732: casts a held affinity can never make, because they cost more than the mana max.
      ...(buildResult.unaffordableCasts?.length > 0 ? { unaffordableCasts: buildResult.unaffordableCasts } : {}),
    },
  });
}

function buildCostSummary(budgetReceipt, spendProposal, outDir) {
  if (!budgetReceipt || budgetReceipt.schema !== SCHEMAS.budgetReceiptArtifact) {
    return undefined;
  }
  const totalSpend = budgetReceipt.totalCost ?? 0;
  const remaining = budgetReceipt.remaining ?? 0;
  // The Allocator prices regen above max as asked and flags it; say so, refuse nothing.
  const wastedRegen = readWastedRegen(budgetReceipt);
  for (const { subjectId, vital, regen, usableRegen, wastedTokens } of wastedRegen) {
    console.error(`warning: ${subjectId} buys ${vital} regen ${regen} but its max is ${usableRegen}; `
      + `regen never fills past max, so ${wastedTokens} tokens buy nothing.`);
  }
  return {
    totalSpend,
    budgetTokens: totalSpend + remaining,
    remaining,
    status: budgetReceipt.status,
    ...(wastedRegen.length > 0 ? { wastedRegen } : {}),
    receiptPath: join(outDir, "budget-receipt.json"),
    proposalPath: spendProposal ? join(outDir, "spend-proposal.json") : undefined,
  };
}

export async function writeHazardArtifactFiles({ parsedHazards = [], outDir, runId, createdAt, producedBy } = {}) {
  for (let i = 0; i < parsedHazards.length; i += 1) {
    const h = parsedHazards[i].value;
    const hazardVersion = h._schemaVersion ?? 3;
    const hazardArtifact = {
      schema: HAZARD_ARTIFACT_SCHEMA,
      schemaVersion: hazardVersion,
      meta: {
        id: h.id,
        runId,
        createdAt,
        producedBy,
      },
      affinity: h.affinity,
      expression: h.expression,
      ...(hazardVersion === 3
        ? {
          proximityRadius: h.proximityRadius,
          affinityStacks: h.affinityStacks.map((entry) => ({ ...entry })),
          vitals: {
            mana: { ...h.vitals.mana },
            durability: { ...h.vitals.durability },
          },
        }
        : {
          proximityRadius: h.proximityRadius,
          mana: { ...h.mana },
          ...(hazardVersion === 1 && h.durability ? { durability: { ...h.durability } } : {}),
        }),
    };
    await writeJson(join(outDir, `hazard-${i + 1}.json`), hazardArtifact);
  }
}

export async function writeResourceArtifactFiles({ parsedResources = [], outDir, runId, createdAt, producedBy } = {}) {
  for (let i = 0; i < parsedResources.length; i += 1) {
    const r = parsedResources[i].value;
    const resourceVersion = r._schemaVersion ?? 1;
    const meta = { id: r.id, runId, createdAt, producedBy };
    let resourceArtifact;
    if (resourceVersion === 3) {
      resourceArtifact = {
        schema: RESOURCE_ARTIFACT_SCHEMA,
        schemaVersion: 4,
        meta,
        vitals: r.vitals,
        permanenceMode: r.permanenceMode,
      };
      if (r.affinity) resourceArtifact.affinity = r.affinity;
    } else {
      resourceArtifact = {
        schema: RESOURCE_ARTIFACT_SCHEMA,
        schemaVersion: 1,
        meta,
        tier: r.tier,
        stat: r.stat,
        delta: r.delta,
        dropRate: r.dropRate,
      };
    }
    await writeJson(join(outDir, `resource-${i + 1}.json`), resourceArtifact);
  }
}

function buildArtifactRefs(entries) {
  return entries.map((entry) => ({
    id: entry.id,
    schema: entry.schema,
    schemaVersion: entry.schemaVersion,
  }));
}
