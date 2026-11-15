import { DEFAULT_LLM_BASE_URL } from "../../../../runtime/src/contracts/domain-constants.js";

export async function postJson(fetchFn, url, body, headers, { errorPrefix = "LLM request failed" } = {}) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // The server's own reason (Ollama sends { "error": "..." }) is what tells a failed model load from a bad request.
    let detail = "";
    try { detail = String(await response.text?.() ?? "").trim().slice(0, 300); } catch { /* the status line alone is enough */ }
    const error = new Error(`${errorPrefix}: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function createLlmAdapter({ baseUrl = DEFAULT_LLM_BASE_URL, fetchFn = globalThis.fetch, fixture } = {}) {
  if (fixture !== undefined) {
    const response = JSON.parse(JSON.stringify(fixture));
    return { generate: async () => JSON.parse(JSON.stringify(response)) };
  }
  if (!fetchFn) {
    throw new Error("LLM adapter requires a fetch implementation.");
  }
  async function generate({ model, prompt, options = {}, stream = false, format, think } = {}) {
    if (!model || !prompt) {
      throw new Error("LLM generate requires model and prompt.");
    }
    const payload = { model, prompt, options, stream };
    if (format) payload.format = format;
    // false asks a reasoning model to answer directly instead of spending its budget on a thinking channel.
    if (think !== undefined) payload.think = think;
    return postJson(fetchFn, `${baseUrl}/api/generate`, payload, { "content-type": "application/json" }, {
      errorPrefix: "LLM request failed",
    });
  }
  return {
    generate,
  };
}
