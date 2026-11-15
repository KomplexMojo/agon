/**
 * The command kernel's `configurator`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { UNUSED_CLOCK } from "../../personas/_shared/require-clock.js";
import { createAllocatorPersona } from "../../personas/allocator/persona.js";
import { createConfiguratorPersona } from "../../personas/configurator/persona.js";
// CR.7 / WP-5 — design spend is the Allocator's, taken from its PUBLIC barrel.
import { evaluateConfiguratorSpend } from "../../personas/allocator/persona.js";
// M9: the SCHEMAS alias table below, and the two ActionSequence sites M8 relocated, all
// read from contracts/artifacts.ts. The table stays — short keys are what this file's call
// sites use — but its VALUES have one origin now instead of eighteen.
import { ACTOR_LOADOUT_SCHEMA, AFFINITY_PRESET_SCHEMA, AFFINITY_PRESET_SCHEMA_VERSIONS, BUDGET_ARTIFACT_SCHEMA } from "../../contracts/artifacts.ts";
import { SCHEMAS, assembleMovementStamina, assertSchema, buildInitialStateArtifact, buildInteriorBarrierActors, buildResourceEnclosureBarrierActorsForResources, buildSimConfigArtifact, completeObjectPlacement, generateGridLayoutFromInput } from "./helpers.js";

export function createConfiguratorCommands(ctx) {
  const { createMeta, defaultRunCommandOutDir, join, log, makeId, readJson, resolvePath, toRef, writeJson } = ctx;
  const budget = (...args) => ctx.budget(...args);

  async function configurator(args) {
    const runId = args["run-id"] || makeId("run");
    const levelGenPath = resolvePath(args["level-gen"]);
    const actorsPath = resolvePath(args.actors);
    const planPath = resolvePath(args.plan);
    const budgetReceiptPath = resolvePath(args["budget-receipt"]);
    const budgetPath = resolvePath(args.budget);
    const priceListPath = resolvePath(args["price-list"]);
    const receiptOutPath = resolvePath(args["receipt-out"]);
    const affinityPresetsPath = resolvePath(args["affinity-presets"]);
    const affinityLoadoutsPath = resolvePath(args["affinity-loadouts"]);
    const outDir = resolvePath(args["out-dir"]) || defaultRunCommandOutDir("configurator", runId);

    if (!levelGenPath || !actorsPath) {
      throw new Error("configurator requires --level-gen and --actors.");
    }
    if ((affinityPresetsPath && !affinityLoadoutsPath) || (!affinityPresetsPath && affinityLoadoutsPath)) {
      throw new Error("configurator requires both --affinity-presets and --affinity-loadouts.");
    }
    if ((budgetPath && !priceListPath) || (!budgetPath && priceListPath)) {
      throw new Error("configurator requires both --budget and --price-list.");
    }
    if (budgetReceiptPath && (budgetPath || priceListPath)) {
      throw new Error("configurator accepts either --budget-receipt or --budget/--price-list, not both.");
    }
    if (receiptOutPath && !(budgetPath && priceListPath)) {
      throw new Error("configurator requires --budget and --price-list when using --receipt-out.");
    }

    const levelGenInput = await readJson(levelGenPath);
    const actorsInput = await readJson(actorsPath);
    if (!actorsInput || !Array.isArray(actorsInput.actors)) {
      throw new Error("actors file must include an actors array.");
    }
    // #280: the Configurator validates and locks this config, as it does for every build.
    const roundConfigurator = createConfiguratorPersona({ clock: UNUSED_CLOCK });
    roundConfigurator.provideConfig({ levelGen: levelGenInput, actors: actorsInput.actors });
    roundConfigurator.validate();
    roundConfigurator.lock();
    const layoutResult = generateGridLayoutFromInput(levelGenInput);
    if (!layoutResult.ok) {
      const details = layoutResult.errors.map((err) => `${err.field}:${err.code}`).join(", ");
      throw new Error(`level-gen input invalid: ${details}`);
    }
    const objectPlacement = completeObjectPlacement({
      layout: layoutResult.value,
      hazards: [],
      resources: [],
    });
    if (!objectPlacement?.ok) {
      throw new Error(`configurator object placement ${objectPlacement?.status || "failed"}: ${objectPlacement?.reason || "unknown"}`);
    }
    const layout = objectPlacement.layout;

    let plan = null;
    let budgetReceipt = null;
    let budget = null;
    let priceList = null;
    if (planPath) {
      plan = await readJson(planPath);
      assertSchema(plan, SCHEMAS.plan);
    }
    if (budgetReceiptPath) {
      budgetReceipt = await readJson(budgetReceiptPath);
      assertSchema(budgetReceipt, SCHEMAS.budgetReceipt);
    }
    if (budgetPath) {
      budget = await readJson(budgetPath);
      assertSchema(budget, SCHEMAS.budgetArtifact);
    }
    if (priceListPath) {
      priceList = await readJson(priceListPath);
      assertSchema(priceList, SCHEMAS.priceList);
    }

    let affinityPresets = null;
    let affinityLoadouts = null;
    if (affinityPresetsPath) {
      affinityPresets = await readJson(affinityPresetsPath);
      assertSchema(affinityPresets, AFFINITY_PRESET_SCHEMA, AFFINITY_PRESET_SCHEMA_VERSIONS);
    }
    if (affinityLoadoutsPath) {
      affinityLoadouts = await readJson(affinityLoadoutsPath);
      assertSchema(affinityLoadouts, ACTOR_LOADOUT_SCHEMA);
    }

    const placedActors = Array.isArray(objectPlacement.actors) ? objectPlacement.actors : [];
    const barrierCellKey = (point) => `${point?.x},${point?.y}`;
    const existingActorIds = new Set(actorsInput.actors.map((actor) => actor?.id).filter(Boolean));
    const withPlaced = [
      ...actorsInput.actors,
      ...placedActors.filter((actor) => actor?.id && !existingActorIds.has(actor.id)),
    ];
    const seed = Number.isFinite(levelGenInput.seed) ? levelGenInput.seed : 0;

    // #276: with no budget the Allocator's reference budget and price list apply, as for
    // `agon create` (#274). Only a caller-supplied receipt with no budget is taken as already priced.
    // Price before cages so enclosure durability can follow each resource's token total.
    const pricedHere = Boolean(budget) || !budgetReceipt;
    if (pricedHere) {
      const allocator = createAllocatorPersona({ clock: UNUSED_CLOCK });
      budget = budget || {
        schema: BUDGET_ARTIFACT_SCHEMA,
        schemaVersion: 1,
        meta: createMeta({ producedBy: "cli-configurator", runId }),
        budget: { tokens: allocator.pricing.levelAuthoring().referenceBudgetTokens },
      };
      priceList = priceList || allocator.resolvePriceList();
      const spendResult = evaluateConfiguratorSpend({
        budget,
        priceList,
        layout,
        actors: withPlaced,
        proposalMeta: createMeta({ producedBy: "cli-configurator", runId }),
        receiptMeta: createMeta({ producedBy: "cli-configurator", runId }),
        // CR.9 M3: motivation vocabulary is the Configurator's, injected here rather
        // than owned a second time inside the Allocator's pricing.
        normalizeMotivations: createConfiguratorPersona({ clock: UNUSED_CLOCK }).normalizeMotivations,
      });
      budgetReceipt = spendResult.receipt;
    }

    const occupiedBeforeBarriers = new Set(
      withPlaced
        .map((actor) => actor?.position)
        .filter((point) => Number.isInteger(point?.x) && Number.isInteger(point?.y))
        .map(barrierCellKey),
    );
    const resourceTokenValueById = new Map();
    for (const item of budgetReceipt?.lineItems || []) {
      if (item?.category !== "resources") continue;
      const id = item?.subjectRef?.id;
      if (typeof id !== "string" || !id) continue;
      const add = Number.isFinite(item.totalCost) ? item.totalCost : 0;
      resourceTokenValueById.set(id, (resourceTokenValueById.get(id) || 0) + add);
    }
    const takeFree = (cells) => {
      const out = [];
      const seen = new Set();
      for (const cell of cells) {
        const key = barrierCellKey(cell);
        if (!Number.isInteger(cell?.x) || !Number.isInteger(cell?.y)) continue;
        if (occupiedBeforeBarriers.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(cell);
      }
      return out;
    };
    const freeDividerCells = takeFree(layout.interiorBarriers || []);
    const dividerKeys = new Set(freeDividerCells.map(barrierCellKey));
    const interiorBarrierActors = [
      ...buildInteriorBarrierActors(freeDividerCells),
      ...buildResourceEnclosureBarrierActorsForResources(
        layout,
        withPlaced.filter((actor) => actor?.category === "resource"),
        {
          occupied: occupiedBeforeBarriers,
          tokenValueById: resourceTokenValueById,
          skipKeys: dividerKeys,
        },
      ),
    ];
    const afterPlacedIds = new Set(withPlaced.map((actor) => actor?.id).filter(Boolean));
    const actors = [
      ...withPlaced,
      ...interiorBarrierActors.filter((actor) => actor?.id && !afterPlacedIds.has(actor.id)),
    ];

    const simConfig = buildSimConfigArtifact({
      meta: createMeta({ producedBy: "cli-configurator", runId }),
      planRef: plan ? toRef(plan) : undefined,
      budgetReceiptRef: budgetReceipt ? toRef(budgetReceipt) : undefined,
      seed,
      layout,
      movementStamina: assembleMovementStamina({ actors }),
    });
    const initialState = buildInitialStateArtifact({
      meta: createMeta({ producedBy: "cli-configurator", runId }),
      simConfigRef: toRef(simConfig),
      actors,
      dimensions: { width: layout.width, height: layout.height },
      terrain: layout.terrain,
    });

    await writeJson(join(outDir, "sim-config.json"), simConfig);
    await writeJson(join(outDir, "initial-state.json"), initialState);
    if (pricedHere) {
      await writeJson(join(outDir, "price-list.json"), priceList);
      const receiptPath = join(outDir, "budget-receipt.json");
      await writeJson(receiptPath, budgetReceipt);
      if (receiptOutPath) {
        await writeJson(receiptOutPath, budgetReceipt);
      }
    }

    log(`configurator: wrote ${outDir}`);
    return { outDir };
  }

  return { configurator };
}
