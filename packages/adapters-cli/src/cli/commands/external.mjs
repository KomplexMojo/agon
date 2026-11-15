/**
 * `agon ipfs*` and `agon blockchain*`.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "../../../../runtime/src/commands/authoring-specs.js";
import { commandKernel, defaultOutDir, makeId, readJson, resolvePath, usage, writeJson } from "./shared.mjs";

async function writeText(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

export async function ipfsCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("ipfs", runId);
  const outPath = resolvePath(args.out) || join(outDir, args.json ? "ipfs.json" : "ipfs.txt");
  const result = await commandKernel.ipfs(args);
  if (args.json) await writeJson(outPath, result.output);
  else await writeText(outPath, result.output);

  console.log(`ipfs: wrote ${outPath}`);
}

export async function ipfsPublishCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const artifactMapPath = resolvePath(args["artifact-map"]);
  if (!artifactMapPath) {
    throw new Error("ipfs-publish requires --artifact-map.");
  }

  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("ipfs-publish", runId);
  const outPath = resolvePath(args.out) || join(outDir, "ipfs-publish.json");
  const artifactMap = await readJson(artifactMapPath);

  const result = await commandKernel.ipfsPublish({
    path: args.path,
    gateway: args.gateway,
    "fixture-cid": args["fixture-cid"],
    "artifact-map": artifactMap,
  });
  await writeJson(outPath, {
    cid: result.cid,
    rootPath: result.rootPath || "",
    publishedFiles: result.publishedFiles || [],
    mode: result.mode || "live",
  });
  console.log(`ipfs-publish: wrote ${outPath}`);
}

export async function ipfsLoadCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("ipfs-load", runId);
  const outPath = resolvePath(args.out) || join(outDir, "ipfs-load.json");
  const fixtureMapPath = resolvePath(args["fixture-map"]);
  const fixtureMap = fixtureMapPath ? await readJson(fixtureMapPath) : undefined;

  const result = await commandKernel.ipfsLoad({
    cid: args.cid,
    path: args.path,
    file: args.file,
    gateway: args.gateway,
    "fixture-map": fixtureMap,
  });

  const fetched = result?.fetched || {};
  for (const [fileName, payload] of Object.entries(fetched)) {
    await writeJson(join(outDir, fileName), payload);
  }
  await writeJson(outPath, {
    cid: result.cid,
    rootPath: result.rootPath || "",
    fetchedFiles: Object.keys(fetched),
    missing: result.missing || [],
  });
  console.log(`ipfs-load: wrote ${outDir}`);
}

export async function blockchainCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("blockchain", runId);
  const outPath = resolvePath(args.out) || join(outDir, "blockchain.json");
  const result = await commandKernel.blockchain(args);
  await writeJson(outPath, result.output);
  console.log(`blockchain: wrote ${outPath}`);
}

export async function blockchainMintCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("blockchain-mint", runId);
  const outPath = resolvePath(args.out) || join(outDir, "blockchain-mint.json");
  const result = await commandKernel.blockchainMint(args);
  await writeJson(outPath, result.output);
  console.log(`blockchain-mint: wrote ${outPath}`);
}

export async function blockchainLoadCommand(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const runId = makeId("run");
  const outDir = resolvePath(args["out-dir"]) || defaultOutDir("blockchain-load", runId);
  const outPath = resolvePath(args.out) || join(outDir, "blockchain-load.json");
  const result = await commandKernel.blockchainLoad(args);
  await writeJson(outPath, result.output);
  console.log(`blockchain-load: wrote ${outPath}`);
}
