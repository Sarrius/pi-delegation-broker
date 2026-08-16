/**
 * Converts a Pi modelRegistry snapshot (the provider/model catalog that
 * pi-multi-account and other extensions populate) into a broker registry.
 *
 * The broker does NOT know about multi-account. It consumes a plain
 * catalog snapshot — an array of provider entries with model definitions —
 * and derives capacity groups, profiles, and resources from it. The
 * catalog source is controller-owned: it could come from Pi's modelRegistry,
 * a static file, or a signed distribution. The broker never reaches into
 * extension internals.
 *
 * Architecture: pi-multi-account → Pi modelRegistry → snapshot → broker registry.
 * The broker trusts the snapshot, not the extension.
 */

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Validate and normalize one catalog provider entry.
 * Expected shape (loosely matching Pi modelRegistry.getAll()):
 * {
 *   provider: string,           // e.g. "anthropic", "openai-codex", "ollama-account-2"
 *   baseUrl: string,            // provider endpoint
 *   api: string,                // API dialect
 *   models: [{
 *     id: string,               // model identifier
 *     name: string,             // display name
 *     contextWindow: number,
 *     maxTokens: number,
 *     reasoning: boolean,
 *     input: string[],          // ["text"] or ["text", "image"]
 *     cost: { input, output, cacheRead, cacheWrite },
 *     thinkingLevelMap?: object,
 *   }]
 * }
 */
function validateCatalogProvider(entry, index) {
  if (!entry || typeof entry !== "object") throw new Error(`catalog provider at index ${index} must be an object`);
  if (typeof entry.provider !== "string" || !TOOL_NAME.test(entry.provider)) {
    throw new Error(`catalog provider at index ${index} requires a bounded provider identifier`);
  }
  if (typeof entry.baseUrl !== "string" || !entry.baseUrl) {
    throw new Error(`catalog provider ${entry.provider} requires a baseUrl`);
  }
  if (typeof entry.api !== "string" || !entry.api) {
    throw new Error(`catalog provider ${entry.provider} requires an api dialect`);
  }
  if (!Array.isArray(entry.models) || entry.models.length < 1 || entry.models.length > 256) {
    throw new Error(`catalog provider ${entry.provider} requires 1..256 models`);
  }
  for (const model of entry.models) {
    if (!model || typeof model !== "object") throw new Error(`catalog model on provider ${entry.provider} must be an object`);
    if (typeof model.id !== "string" || !TOOL_NAME.test(model.id)) {
      throw new Error(`catalog model on provider ${entry.provider} requires a bounded id`);
    }
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) {
      throw new Error(`catalog model ${entry.provider}/${model.id} requires a positive contextWindow`);
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) {
      throw new Error(`catalog model ${entry.provider}/${model.id} requires a positive maxTokens`);
    }
  }
  return {
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    api: entry.api,
    models: entry.models.map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning !== false,
      input: Array.isArray(model.input) ? Object.freeze([...model.input]) : Object.freeze(["text"]),
      cost: model.cost && typeof model.cost === "object" ? Object.freeze({ ...model.cost }) : Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }) } : {}),
    })),
  };
}

/**
 * Derive the capability supports for a model. Reasoning-capable models
 * support code_reasoning; image-capable models support vision_input; all
 * models support text_generation.
 */
function deriveModelSupports(model) {
  const supports = ["text_generation"];
  if (model.reasoning) supports.push("code_reasoning");
  if (model.input.includes("image")) supports.push("vision_input");
  if (model.contextWindow >= 200_000) supports.push("large_context");
  return Object.freeze(supports);
}

/**
 * Convert a validated catalog into a broker registry.
 *
 * Each provider's model list becomes a profile (strongest model = profile
 * name). Each provider becomes one resource in its own capacity group.
 * The capacity group's maxConcurrent defaults to 1 (conservative; the
 * controller can override via signed registry).
 *
 * Returns { profiles, capacityGroups, resources } in broker registry format.
 */
export function catalogToBrokerRegistry(catalog, options = {}) {
  if (!Array.isArray(catalog) || catalog.length < 1) {
    throw new Error("broker registry catalog must be a non-empty array of provider entries");
  }
  const maxConcurrentPerProvider = Number.isSafeInteger(options.maxConcurrentPerProvider)
    ? options.maxConcurrentPerProvider
    : 1;
  const confidence = typeof options.confidence === "string" ? options.confidence : "assumed";
  const cooldownDefaultMs = Number.isSafeInteger(options.cooldownDefaultMs) ? options.cooldownDefaultMs : 21_600_000;
  const cooldownProbeIntervalMs = Number.isSafeInteger(options.cooldownProbeIntervalMs) ? options.cooldownProbeIntervalMs : 300_000;

  const validated = catalog.map(validateCatalogProvider);
  const profiles = {};
  const capacityGroups = {};
  const resources = {};

  for (const entry of validated) {
    // Sort models strongest-first by contextWindow descending, then maxTokens
    const sorted = [...entry.models].sort((a, b) =>
      (b.contextWindow - a.contextWindow) || (b.maxTokens - a.maxTokens),
    );
    const strongest = sorted[0];
    const profileId = `${entry.provider}/${strongest.id}`;
    const allSupports = new Set();
    for (const model of sorted) {
      for (const s of deriveModelSupports(model)) allSupports.add(s);
    }

    profiles[profileId] = Object.freeze({
      status: "approved",
      supports: Object.freeze([...allSupports]),
    });

    const groupId = `G-${entry.provider}`;
    capacityGroups[groupId] = Object.freeze({
      maxConcurrent: maxConcurrentPerProvider,
      admission: Object.freeze({ controlReserve: 1, verifyReserve: 0 }),
      cooldown: Object.freeze({ defaultMs: cooldownDefaultMs, probeIntervalMs: cooldownProbeIntervalMs }),
      confidence,
    });

    resources[entry.provider] = Object.freeze({
      capacityGroup: groupId,
      profile: profileId,
      confidence,
      enforcement: Object.freeze({ input: "hard", output: "hard", cost: "metered_best_effort" }),
    });
  }

  return Object.freeze({
    profiles: Object.freeze(profiles),
    capacityGroups: Object.freeze(capacityGroups),
    resources: Object.freeze(resources),
  });
}

/**
 * Create a minimal catalog snapshot for testing. Each entry is a provider
 * with one or more models.
 */
export function fixtureCatalog(entries = [
  {
    provider: "fake-anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{
      id: "claude-fake-1",
      name: "Claude Fake 1",
      contextWindow: 200_000,
      maxTokens: 32_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  },
  {
    provider: "fake-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    models: [{
      id: "gpt-fake-1",
      name: "GPT Fake 1",
      contextWindow: 272_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  },
]) {
  return Object.freeze(entries.map((e) => Object.freeze({
    ...e,
    models: Object.freeze(e.models.map((m) => Object.freeze(m))),
  })));
}