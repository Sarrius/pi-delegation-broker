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
// A model id may carry a vendor path, a variant suffix and a rolling-alias marker —
// `anthropic/claude-opus-5:batch`, `cohere/north-mini-code:free`, `~openai/gpt-latest`. Those
// characters are part of the model's identity at the provider, so rejecting them silently drops
// 97 real models on a live openrouter account. Everything else stays as strict as a provider
// name: no whitespace, no control characters, bounded length.
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,159}$/;
const MAX_MODELS_PER_PROVIDER = 4_096;

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
  // Aggregator providers are legitimately large: a real openrouter account publishes ~350
  // models. The bound exists to stop a runaway catalog, not to decide which models a
  // controller may route to, so it sits far above any real provider rather than at a size
  // that silently excludes one.
  if (!Array.isArray(entry.models) || entry.models.length < 1 || entry.models.length > MAX_MODELS_PER_PROVIDER) {
    throw new Error(`catalog provider ${entry.provider} requires 1..${MAX_MODELS_PER_PROVIDER} models`);
  }
  for (const model of entry.models) {
    if (!model || typeof model !== "object") throw new Error(`catalog model on provider ${entry.provider} must be an object`);
    if (typeof model.id !== "string" || !MODEL_ID.test(model.id)) {
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
      ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }) } : {}),
    })),
  };
}

/**
 * Derive the capability supports for a model. Reasoning-capable models
 * support code_reasoning; image-capable models support vision_input; all
 * models support text_generation.
 *
 * This is the whole capability vocabulary the derived registry speaks. A
 * controller that needs a wider vocabulary must supply its own signed
 * registry rather than teach this deriver new words.
 */
export function deriveModelSupports(model) {
  const supports = ["text_generation"];
  if (model.reasoning) supports.push("code_reasoning");
  if (model.input.includes("image")) supports.push("vision_input");
  if (model.contextWindow >= 200_000) supports.push("large_context");
  return Object.freeze(supports.sort());
}

/**
 * A profile is a capability tier, not a model identity. Two models from two
 * unrelated providers that support the same capabilities land on the same
 * profile, which is what lets one contract be served by whichever provider
 * still has capacity. Deriving the id from the sorted capability set keeps
 * that mapping deterministic and collision-free.
 */
export function capabilityTierId(supports) {
  return `caps/${[...supports].sort().join(".")}/v1`;
}

/**
 * Convert a validated catalog into a broker registry.
 *
 * The mapping models what actually constrains delegation:
 * - one resource per (provider, model) — the concrete thing a lease routes to,
 *   so a provider's cheap model is selectable instead of being hidden behind
 *   its strongest one;
 * - one capacity group per provider — an account has a single rate-limit
 *   bucket that every one of its models shares, so a 429 on one model must
 *   cool down all of them;
 * - one profile per capability tier — shared across providers, so a contract
 *   pinning a tier can be served by whichever provider is alive right now.
 *
 * maxConcurrent defaults to 2 rather than 1: the group reserves one slot for
 * control-class admission, so a single-slot group can never admit work.
 *
 * Returns { profiles, capacityGroups, resources } in broker registry format.
 * Resources additionally carry a controller-side `model` identity and
 * `catalog` metadata; the broker ignores both and persists neither.
 */
export function catalogToBrokerRegistry(catalog, options = {}) {
  if (!Array.isArray(catalog) || catalog.length < 1) {
    throw new Error("broker registry catalog must be a non-empty array of provider entries");
  }
  const maxConcurrentPerProvider = Number.isSafeInteger(options.maxConcurrentPerProvider)
    ? options.maxConcurrentPerProvider
    : 2;
  const confidence = typeof options.confidence === "string" ? options.confidence : "assumed";
  const cooldownDefaultMs = Number.isSafeInteger(options.cooldownDefaultMs) ? options.cooldownDefaultMs : 21_600_000;
  const cooldownProbeIntervalMs = Number.isSafeInteger(options.cooldownProbeIntervalMs) ? options.cooldownProbeIntervalMs : 300_000;

  const validated = catalog.map(validateCatalogProvider);
  const profiles = {};
  const capacityGroups = {};
  const resources = {};
  const seenProviders = new Set();

  for (const entry of validated) {
    if (seenProviders.has(entry.provider)) throw new Error(`catalog repeats provider ${entry.provider}`);
    seenProviders.add(entry.provider);

    const groupId = `G-${entry.provider}`;
    capacityGroups[groupId] = Object.freeze({
      maxConcurrent: maxConcurrentPerProvider,
      admission: Object.freeze({ controlReserve: 1, verifyReserve: 0 }),
      cooldown: Object.freeze({ defaultMs: cooldownDefaultMs, probeIntervalMs: cooldownProbeIntervalMs }),
      confidence,
    });

    const seenModels = new Set();
    for (const model of entry.models) {
      if (seenModels.has(model.id)) throw new Error(`catalog provider ${entry.provider} repeats model ${model.id}`);
      seenModels.add(model.id);

      const supports = deriveModelSupports(model);
      const profileId = capabilityTierId(supports);
      profiles[profileId] ??= Object.freeze({ status: "approved", supports });

      resources[`${entry.provider}/${model.id}`] = Object.freeze({
        capacityGroup: groupId,
        profile: profileId,
        confidence,
        enforcement: Object.freeze({ input: "hard", output: "hard" }),
        model: Object.freeze({ provider: entry.provider, modelId: model.id }),
        catalog: Object.freeze({
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }),
      });
    }
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
    }],
  },
]) {
  return Object.freeze(entries.map((e) => Object.freeze({
    ...e,
    models: Object.freeze(e.models.map((m) => Object.freeze(m))),
  })));
}