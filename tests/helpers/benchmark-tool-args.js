'use strict';
/**
 * The benchmark's tool-argument normalization and outcome classifier, kept in agon for the
 * deterministic failure-corpus replay (`tests/integration/benchmark-failure-corpus-replay.test.js`)
 * and the resource-vital shape test. The benchmark harness itself moved to the private
 * KomplexMojo/agon-ops repository (#871), which keeps its own copy in
 * `tools/remote-ollama-control/scripts/lib/agon-runner.js`. The recorded corpus is frozen, so this
 * copy only has to replay it the way the harness did when the corpus was harvested.
 */

// ---------------------------------------------------------------------------
// Ollama-specific normalization — compensates for qwen3 output quirks.
// These functions run BEFORE the shared MCP translation layer.
// ---------------------------------------------------------------------------

// qwen3's thinking mode sometimes serializes arrays as Python repr strings
// ([{'key': 'val'}]) using single quotes. Convert to valid JSON.
function pythonReprToJson(s) {
  return s
    .replace(/'/g, '"')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
}

// Repairs bracket-balance faults in an array-of-objects string: either trailing garbage after
// a complete value (a stray closing brace after the array's own ]), or a missing final closer
// (the objects inside are all complete but the outer [ never closes). Tracks depth outside
// quoted strings; the first time depth returns to zero the value is complete and anything after
// is dropped. If the string runs out with brackets still open, closing them in reverse order is
// safe -- every bracket left on the stack was opened after everything it contains already
// balanced, so there is nothing to guess at.
function repairJsonBrackets(s) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[' || c === '{') { stack.push(c); continue; }
    if (c === ']' || c === '}') {
      const expectedOpener = c === ']' ? '[' : '{';
      if (stack.length === 0 || stack[stack.length - 1] !== expectedOpener) return s.slice(0, i);
      stack.pop();
      if (stack.length === 0) return s.slice(0, i + 1);
    }
  }
  return stack.length > 0 ? s + stack.reverse().map((open) => (open === '[' ? ']' : '}')).join('') : s;
}

// Normalize an entity array field: handles actual arrays, JSON-encoded strings,
// and Python repr strings that qwen3 emits from its thinking mode.
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const s = val.trim();
    if (s.startsWith('[')) {
      try { return JSON.parse(s); } catch {}
      const converted = pythonReprToJson(s);
      try { return JSON.parse(converted); } catch {}
      // Some models close the outer list with ) instead of ] — repair and retry.
      try { return JSON.parse(converted.replace(/\)\s*$/, ']')); } catch {}
      // Some models emit a bracket-unbalanced array: an extra trailing } after a complete
      // array, or a missing closing ] on an otherwise-complete one. Repair and retry.
      try { return JSON.parse(repairJsonBrackets(converted)); } catch {}
    }
    return s ? [s] : [];
  }
  return [val];
}

// Model-invented motivation names → nearest valid agon.mjs value.
const MOTIVATION_ALIASES = {
  supporting: 'friendly', support: 'friendly', healing: 'friendly', healer: 'friendly',
  offensive: 'attacking', aggressive: 'attacking', melee: 'attacking',
  defensive: 'defending', guard: 'defending', guardian: 'defending',
  stealth: 'stealthy', patrol: 'patrolling', mixed: 'exploring',
};

// Apply Ollama model compensations to a single entity spec object.
function normalizeEntitySpec(key, spec) {
  if (typeof spec === 'string') {
    const s = spec.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return normalizeEntitySpec(key, JSON.parse(s)); } catch {}
      try { return normalizeEntitySpec(key, JSON.parse(pythonReprToJson(s))); } catch {}
    }
    return spec;
  }

  const out = { ...spec };

  // Map non-standard motivation values
  if (out.motivation && typeof out.motivation === 'string') {
    out.motivation = MOTIVATION_ALIASES[out.motivation.toLowerCase()] ?? out.motivation;
  }

  if (key === 'resource') {
    // Strip unsupported aggregate/model-invented fields. The canonical V3
    // affinity field is deliberately retained for temporary/permanent grants.
    //
    // tier/stat/dropRate are the pre-V3 resource vocabulary. The CLI rejects them
    // outright once any V3 key (permanenceMode, vital, affinity) appears in the same
    // spec, and models blend the two vocabularies freely — that blend cost 73 of 700
    // attempts on 2026-08-22. Dropping them here is the last point before argv is
    // built; the tool schema no longer offers them, so a model that still emits one
    // is improvising rather than following the contract.
    // `vitals` stays: a resource may carry the actor-style vital map, which the shared
    // serializer (resourceSpecToString) flattens to the CLI grammar (#185).
    for (const f of ['affinities', 'goals', 'kind', 'tier', 'stat', 'dropRate']) {
      delete out[f];
    }
  }

  // Strip model-invented fields that hazards don't support. Coordinates are
  // stripped because benchmark hazards are proximity-based. Blocking is a
  // supported execution-semantic input and must survive generated authoring.
  if (key === 'hazard') {
    for (const f of ['manaDrain', 'healthDrain', 'staminaDrain', 'damage', 'effect', 'duration', 'x', 'y', 'vitals']) {
      delete out[f];
    }
    if (out.proximityRadius == null) {
      out.proximityRadius = 2;
    }
  }

  return out;
}

// Normalize all entity array fields in toolArgs.
function normalizeToolArgs(toolArgs) {
  const ENTITY_KEYS = ['room', 'floorTile', 'hazard', 'resource', 'delver', 'warden'];
  const out = { ...toolArgs };
  for (const key of ENTITY_KEYS) {
    out[key] = toArray(out[key]).map((spec) => normalizeEntitySpec(key, spec));
  }
  return out;
}

// ---------------------------------------------------------------------------
function classifyExecutionOutcome(runResult) {
  if (runResult?.llmError || runResult?.execResult?.timedOut) return 'infrastructure_error';
  if (!runResult?.toolCallProduced) return 'model_failure';
  if (runResult.execResult?.succeeded) return 'success';
  const message = `${runResult.execResult?.stdout || ''}\n${runResult.execResult?.stderr || ''}`;
  if (/budget[^\n]*(denied|exceeded|insufficient)|requested[^\n]*available/i.test(message)) {
    return 'budget_denied';
  }
  return 'execution_failed';
}

module.exports = { classifyExecutionOutcome, normalizeToolArgs };
