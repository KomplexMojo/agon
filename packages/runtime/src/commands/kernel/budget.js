/**
 * The command kernel's `budget`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { SCHEMAS, assertSchema } from "./helpers.js";

export function createBudgetCommands(ctx) {
  const { join, log, readJson, resolvePath, writeJson } = ctx;

  async function budget(args) {
    const budgetPath = resolvePath(args.budget);
    const priceListPath = resolvePath(args["price-list"]);
    const receiptPath = resolvePath(args.receipt);
    const receiptOutPath = resolvePath(args["receipt-out"]);
    const outDir = resolvePath(args["out-dir"]);
    const outPath = resolvePath(args.out);

    if (!budgetPath && !priceListPath && !receiptPath) {
      throw new Error("budget requires at least one of --budget, --price-list, or --receipt.");
    }

    let budgetArtifact = null;
    let priceList = null;
    let receipt = null;

    if (budgetPath) {
      budgetArtifact = await readJson(budgetPath);
      assertSchema(budgetArtifact, SCHEMAS.budgetArtifact);
    }
    if (priceListPath) {
      priceList = await readJson(priceListPath);
      assertSchema(priceList, SCHEMAS.priceList);
    }
    if (receiptPath) {
      receipt = await readJson(receiptPath);
      assertSchema(receipt, SCHEMAS.budgetReceiptArtifact);
    }

    if (outDir) {
      if (budgetArtifact) await writeJson(join(outDir, "budget.json"), budgetArtifact);
      if (priceList) await writeJson(join(outDir, "price-list.json"), priceList);
      if (receipt) await writeJson(join(outDir, "budget-receipt.json"), receipt);
    }
    if (receiptOutPath && receipt) {
      await writeJson(receiptOutPath, receipt);
    }

    const output = {};
    if (budgetArtifact) output.budget = budgetArtifact;
    if (priceList) output.priceList = priceList;
    if (receipt) output.receipt = receipt;

    if (outPath) {
      await writeJson(outPath, output);
    } else {
      log(JSON.stringify(output, null, 2));
    }

    return { outDir, outPath, output };
  }

  return { budget };
}
