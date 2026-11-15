/**
 * The command kernel's `ipfs*` and `blockchain*`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { isNonEmptyString, isObject, normalizeStringList, requireHostFunction } from "./helpers.js";

export function createExternalCommands(ctx) {
  const { cwd, host, makeId, readJson, readText, resolvePath } = ctx;

  async function ipfs(args) {
    const createIpfsAdapter = requireHostFunction(host, "createIpfsAdapter");
    const cid = args.cid;
    const pathValue = args.path || "";
    const gatewayUrl = args.gateway || "https://ipfs.io/ipfs";
    const fixturePath = resolvePath(args.fixture, cwd());

    if (!isNonEmptyString(cid)) {
      throw new Error("ipfs requires --cid.");
    }

    let fetchFn;
    if (fixturePath) {
      const fixtureText = await readText(fixturePath);
      fetchFn = async () => ({ ok: true, text: async () => fixtureText });
    }

    const adapter = createIpfsAdapter({ gatewayUrl, fetchFn });
    if (args.json) {
      const output = await adapter.fetchJson(cid, pathValue);
      return { output, contentType: "application/json" };
    }
    const output = await adapter.fetchText(cid, pathValue);
    return { output, contentType: "text/plain" };
  }
  async function ipfsPublish(args) {
    const createIpfsAdapter = requireHostFunction(host, "createIpfsAdapter");
    const gatewayUrl = args.gateway || "https://ipfs.io/ipfs";
    const rootPath = isNonEmptyString(args.path) ? args.path.trim().replace(/^\/+|\/+$/g, "") : "";
    const fixtureCid = isNonEmptyString(args["fixture-cid"]) ? args["fixture-cid"].trim() : "";
    const artifactMap = isObject(args["artifact-map"]) ? args["artifact-map"] : null;

    if (!artifactMap) {
      throw new Error("ipfs-publish requires --artifact-map.");
    }
    const entries = Object.entries(artifactMap)
      .filter(([fileName, value]) => isNonEmptyString(fileName) && value !== undefined);
    if (entries.length === 0) {
      throw new Error("ipfs-publish requires at least one artifact.");
    }

    if (fixtureCid) {
      return {
        cid: fixtureCid,
        rootPath: rootPath || "",
        published: Object.fromEntries(entries),
        publishedFiles: entries.map(([fileName]) => String(fileName).replace(/^\/+/, "")),
        mode: "fixture",
      };
    }

    const adapter = createIpfsAdapter({ gatewayUrl });
    if (!adapter || typeof adapter.publishJsonMap !== "function") {
      throw new Error("ipfs-publish requires an adapter with publishJsonMap support.");
    }

    const published = Object.fromEntries(entries.map(([fileName, value]) => [
      String(fileName).replace(/^\/+/, ""),
      value,
    ]));
    const publishResult = await adapter.publishJsonMap(published, { pathPrefix: rootPath || "" });
    return {
      cid: publishResult.cid,
      rootPath: rootPath || "",
      published,
      publishedFiles: Object.keys(published),
      mode: "live",
      entries: Array.isArray(publishResult.entries) ? publishResult.entries : [],
      rootName: publishResult.rootName || "",
    };
  }
  async function ipfsLoad(args) {
    const createIpfsAdapter = requireHostFunction(host, "createIpfsAdapter");
    const cid = args.cid;
    const rootPath = isNonEmptyString(args.path) ? args.path.trim().replace(/^\/+|\/+$/g, "") : "";
    const gatewayUrl = args.gateway || "https://ipfs.io/ipfs";
    const files = normalizeStringList(args.file);
    const targetFiles = files.length > 0
      ? files
      : [
        "bundle.json",
        "manifest.json",
        "spec.json",
        "sim-config.json",
        "initial-state.json",
        "budget.json",
        "price-list.json",
        "budget-receipt.json",
      ];
    const fixtureMap = isObject(args["fixture-map"]) ? args["fixture-map"] : null;

    if (!isNonEmptyString(cid)) {
      throw new Error("ipfs-load requires --cid.");
    }

    let fetchFn;
    if (fixtureMap) {
      fetchFn = async (resource) => {
        const url = String(resource || "");
        const cidToken = `${cid}/`;
        const marker = url.lastIndexOf(cidToken);
        const suffix = marker >= 0 ? url.slice(marker + cidToken.length) : "";
        const normalized = suffix.replace(/^\/+/, "");
        const value = fixtureMap[normalized];
        if (value === undefined) {
          return { ok: false, status: 404, statusText: "Not Found" };
        }
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return { ok: true, text: async () => text };
      };
    }

    const adapter = createIpfsAdapter({ gatewayUrl, fetchFn });
    const fetched = {};
    const missing = [];

    for (const fileName of targetFiles) {
      const normalizedFile = fileName.replace(/^\/+/, "");
      const ipfsPath = rootPath ? `${rootPath}/${normalizedFile}` : normalizedFile;
      try {
        fetched[normalizedFile] = await adapter.fetchJson(cid, ipfsPath);
      } catch (error) {
        missing.push({
          file: normalizedFile,
          error: error?.message || String(error),
        });
      }
    }

    if (!fetched["bundle.json"]) {
      throw new Error("ipfs-load could not fetch required bundle.json.");
    }

    return {
      cid,
      rootPath: rootPath || "",
      fetched,
      missing,
    };
  }
  async function resolveJsonFixture(value) {
    if (isObject(value) || Array.isArray(value)) {
      return value;
    }
    const fixturePath = resolvePath(value, cwd());
    if (!fixturePath) return null;
    return JSON.parse(await readText(fixturePath));
  }
  async function blockchain(args) {
    const createBlockchainAdapter = requireHostFunction(host, "createBlockchainAdapter");
    const rpcUrl = args["rpc-url"];
    const address = args.address;
    const chainFixture = await resolveJsonFixture(args["fixture-chain-id"]);
    const balanceFixture = await resolveJsonFixture(args["fixture-balance"]);

    if (!isNonEmptyString(rpcUrl)) {
      throw new Error("blockchain requires --rpc-url.");
    }

    let fetchFn;
    if (chainFixture || balanceFixture) {
      fetchFn = async (_url, options) => {
        const body = JSON.parse(options?.body || "{}");
        if (body.method === "eth_chainId" && chainFixture) {
          return { ok: true, json: async () => chainFixture };
        }
        if (body.method === "eth_getBalance" && balanceFixture) {
          return { ok: true, json: async () => balanceFixture };
        }
        return { ok: false, status: 500, statusText: "Missing fixture" };
      };
    }

    const adapter = createBlockchainAdapter({ rpcUrl, fetchFn });
    const output = { rpcUrl };
    output.chainId = await adapter.getChainId();
    if (address) {
      output.address = address;
      output.balance = await adapter.getBalance(address);
    }
    return { output, contentType: "application/json" };
  }
  async function blockchainMint(args) {
    const createBlockchainAdapter = requireHostFunction(host, "createBlockchainAdapter");
    const rpcUrl = args["rpc-url"];
    const owner = args.owner;
    const contractAddress = args.contract || args["contract-address"];
    const tokenIdHint = args["token-id"];
    const cardJson = isObject(args["card-json"]) ? args["card-json"] : null;
    const cardPath = resolvePath(args.card, cwd());
    const chainFixture = await resolveJsonFixture(args["fixture-chain-id"]);
    const mintFixture = await resolveJsonFixture(args["fixture-mint"]);

    if (!isNonEmptyString(rpcUrl)) {
      throw new Error("blockchain-mint requires --rpc-url.");
    }
    if (!cardJson && !cardPath) {
      throw new Error("blockchain-mint requires --card.");
    }

    const card = cardJson || await readJson(cardPath);
    const metadata = {
      schema: card?.schema || null,
      schemaVersion: Number.isFinite(card?.schemaVersion) ? card.schemaVersion : null,
      cardType: isNonEmptyString(card?.type) ? card.type : null,
      cardId: isNonEmptyString(card?.id) ? card.id : null,
    };

    let fetchFn;
    if (chainFixture || mintFixture) {
      fetchFn = async (_url, options) => {
        const body = JSON.parse(options?.body || "{}");
        if (body.method === "eth_chainId" && chainFixture) {
          return { ok: true, json: async () => chainFixture };
        }
        if (body.method === "agon_mintCard" && mintFixture) {
          return { ok: true, json: async () => mintFixture };
        }
        return { ok: false, status: 500, statusText: "Missing fixture" };
      };
    }

    const adapter = createBlockchainAdapter({ rpcUrl, fetchFn });
    const output = { rpcUrl };
    output.chainId = await adapter.getChainId();
    if (isNonEmptyString(owner)) output.owner = owner;
    if (isNonEmptyString(contractAddress)) output.contractAddress = contractAddress;
    output.card = card;
    const mintResult = await adapter.mintCard({
      owner,
      contractAddress,
      tokenId: tokenIdHint,
      card,
      metadata,
    });
    const tokenId = isNonEmptyString(mintResult?.tokenId)
      ? mintResult.tokenId
      : isNonEmptyString(tokenIdHint)
        ? tokenIdHint
        : makeId("token");
    output.tokenId = tokenId;
    if (isNonEmptyString(mintResult?.txHash)) output.txHash = mintResult.txHash;
    if (isObject(mintResult?.metadata)) output.metadata = mintResult.metadata;
    return { output, contentType: "application/json" };
  }
  async function blockchainLoad(args) {
    const createBlockchainAdapter = requireHostFunction(host, "createBlockchainAdapter");
    const rpcUrl = args["rpc-url"];
    const tokenId = args["token-id"];
    const owner = args.owner;
    const contractAddress = args.contract || args["contract-address"];
    const chainFixture = await resolveJsonFixture(args["fixture-chain-id"]);
    const loadFixture = await resolveJsonFixture(args["fixture-load"]);

    if (!isNonEmptyString(rpcUrl)) {
      throw new Error("blockchain-load requires --rpc-url.");
    }
    if (!isNonEmptyString(tokenId)) {
      throw new Error("blockchain-load requires --token-id.");
    }

    let fetchFn;
    if (chainFixture || loadFixture) {
      fetchFn = async (_url, options) => {
        const body = JSON.parse(options?.body || "{}");
        if (body.method === "eth_chainId" && chainFixture) {
          return { ok: true, json: async () => chainFixture };
        }
        if (body.method === "agon_getMintedCard" && loadFixture) {
          return { ok: true, json: async () => loadFixture };
        }
        return { ok: false, status: 500, statusText: "Missing fixture" };
      };
    }

    const adapter = createBlockchainAdapter({ rpcUrl, fetchFn });
    const output = { rpcUrl, tokenId };
    output.chainId = await adapter.getChainId();
    if (isNonEmptyString(owner)) output.owner = owner;
    if (isNonEmptyString(contractAddress)) output.contractAddress = contractAddress;
    const loaded = await adapter.loadMintedCard({ tokenId, owner, contractAddress });
    if (isObject(loaded)) {
      if (loaded.card !== undefined) output.card = loaded.card;
      if (loaded.owner !== undefined && output.owner === undefined) output.owner = loaded.owner;
      if (loaded.contractAddress !== undefined && output.contractAddress === undefined) {
        output.contractAddress = loaded.contractAddress;
      }
      if (loaded.metadata !== undefined) output.metadata = loaded.metadata;
      if (loaded.txHash !== undefined) output.txHash = loaded.txHash;
    } else {
      output.card = loaded;
    }
    return { output, contentType: "application/json" };
  }

  return { ipfs, ipfsPublish, ipfsLoad, resolveJsonFixture, blockchain, blockchainMint, blockchainLoad };
}
