/**
 * The command kernel's `llm`, moved verbatim from kernel.js's closure (#862).
 * `createCommandKernel` passes the host functions it resolved as `ctx`.
 */
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "../../contracts/domain-constants.js";
import { isNonEmptyString, readEnv } from "./helpers.js";

export function createLlmCommands(ctx) {
  const { createLlmAdapter, cwd, host, readText, resolvePath } = ctx;

  async function llm(args) {
    const model = args.model || readEnv(host.env, "AGON_LLM_MODEL") || DEFAULT_LLM_MODEL;
    const prompt = args.prompt;
    const baseUrl = args["base-url"] || readEnv(host.env, "AGON_LLM_BASE_URL") || DEFAULT_LLM_BASE_URL;
    const fixturePath = resolvePath(args.fixture, cwd());
    const llmFormat = readEnv(host.env, "AGON_LLM_FORMAT");

    if (!isNonEmptyString(prompt)) {
      throw new Error("llm requires --prompt.");
    }

    let fetchFn;
    if (fixturePath) {
      const fixtureJson = JSON.parse(await readText(fixturePath));
      fetchFn = async () => ({ ok: true, json: async () => fixtureJson });
    }

    const adapter = createLlmAdapter({ baseUrl, fetchFn });
    const output = await adapter.generate({
      model,
      prompt,
      stream: false,
      format: isNonEmptyString(llmFormat) ? llmFormat : undefined,
    });
    return { output, contentType: "application/json" };
  }

  return { llm };
}
