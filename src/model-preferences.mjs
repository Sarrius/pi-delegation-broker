/** User-owned model tier policy. Controller-side and reloadable on every selection. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TIERS = new Set(["apex", "frontier", "standard", "cheap"]);
export const MODEL_PREFERENCE_TIERS = Object.freeze([...TIERS]);
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,159}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\*?$/;

const LEGACY_SEEDED_MODEL_PREFERENCES = Object.freeze({
  schemaVersion: 1,
  tiers: Object.freeze({
    frontier: Object.freeze([
      Object.freeze({ model: "gpt-5.6-sol", via: Object.freeze(["openai-codex*"]) }),
      Object.freeze({ model: "kimi-k3", via: Object.freeze(["kimi-coding", "ollama"]) }),
      Object.freeze({ model: "glm-5.3", via: Object.freeze(["zai", "opencode-go-api"]) }),
      Object.freeze({ model: "grok-4.6", via: Object.freeze(["openrouter"]) }),
      Object.freeze({ model: "claude-opus-5", via: Object.freeze(["openrouter"]) }),
    ]),
    standard: Object.freeze([]),
    cheap: Object.freeze([]),
  }),
});

export const DEFAULT_MODEL_PREFERENCES = Object.freeze({
  schemaVersion: 1,
  // Empty means strict automatic subscription-native/current-only selection. Entries are
  // explicit allowlists and may intentionally admit an aggregator or mixed-provider route.
  tiers: Object.freeze({
    apex: Object.freeze([]),
    frontier: Object.freeze([]),
    standard: Object.freeze([]),
    cheap: Object.freeze([]),
  }),
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function isLegacySeed(value) {
  if (!value || value.schemaVersion !== 1 || !value.tiers || !Array.isArray(value.tiers.frontier)
    || (value.tiers.apex?.length ?? 0) !== 0
    || (value.tiers.standard?.length ?? 0) !== 0 || (value.tiers.cheap?.length ?? 0) !== 0) return false;
  const key = (entry) => `${entry?.model ?? ""}|${Array.isArray(entry?.via) ? entry.via.join(",") : ""}`;
  const required = new Set(LEGACY_SEEDED_MODEL_PREFERENCES.tiers.frontier.map(key));
  const actual = new Set(value.tiers.frontier.map(key));
  if ([...required].some((entry) => !actual.has(entry))) return false;
  return value.tiers.frontier.every((entry) => required.has(key(entry))
    || (/^(cursor-grok-|grok-(4\.5|4\.6)|composer-)/.test(entry?.model ?? "")
      && Array.isArray(entry?.via) && entry.via.every((provider) => /^cursor\*?$/.test(provider))));
}

function normalizeEntry(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be an object`);
  if (typeof entry.model !== "string" || !MODEL_ID.test(entry.model)) throw new Error(`${label} has invalid model`);
  if (!Array.isArray(entry.via) || entry.via.length < 1 || entry.via.some((provider) => typeof provider !== "string" || !PROVIDER_PATTERN.test(provider))) {
    throw new Error(`${label} requires one or more valid via providers`);
  }
  return Object.freeze({ model: entry.model, via: Object.freeze([...new Set(entry.via)]) });
}

/** Validate a human-editable preference document, preserving only policy fields. */
export function normalizeModelPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error("model preferences schemaVersion must equal 1");
  }
  if (!value.tiers || typeof value.tiers !== "object" || Array.isArray(value.tiers)) throw new Error("model preferences require tiers");
  const tiers = {};
  for (const tier of TIERS) {
    const entries = value.tiers[tier] ?? [];
    if (!Array.isArray(entries) || entries.length > 100) throw new Error(`model preference tier ${tier} must contain 0..100 entries`);
    tiers[tier] = Object.freeze(entries.map((entry, index) => normalizeEntry(entry, `model preference ${tier}[${index}]`)));
  }
  return Object.freeze({ schemaVersion: 1, tiers: Object.freeze(tiers) });
}

export function loadModelPreferences(path) {
  if (!existsSync(path)) return normalizeModelPreferences(clone(DEFAULT_MODEL_PREFERENCES));
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  // The original shipped seed included aggregator routes. It was a product default, not a
  // conscious user allowlist, so migrate that exact document to strict automatic mode. Any
  // edited v1 document remains an explicit user policy.
  if (isLegacySeed(parsed)) {
    return normalizeModelPreferences(clone(DEFAULT_MODEL_PREFERENCES));
  }
  return normalizeModelPreferences(parsed);
}

export function writeModelPreferences(path, preferences) {
  const normalized = normalizeModelPreferences(preferences);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function requireTier(tier) {
  if (!TIERS.has(tier)) throw new Error("model preference tier must be cheap, standard, or frontier");
  return tier;
}

/** Add routes to one user-owned model preference, merging rather than duplicating it. */
export function addModelPreference(preferences, { tier, model, via } = {}) {
  const current = normalizeModelPreferences(preferences);
  const checkedTier = requireTier(tier);
  const added = normalizeEntry({ model, via }, `model preference ${checkedTier} addition`);
  const entries = current.tiers[checkedTier].map((entry) => ({ model: entry.model, via: [...entry.via] }));
  const existing = entries.find((entry) => entry.model === added.model);
  if (existing) existing.via = [...new Set([...existing.via, ...added.via])];
  else entries.push({ model: added.model, via: [...added.via] });
  return normalizeModelPreferences({
    schemaVersion: 1,
    tiers: { ...current.tiers, [checkedTier]: entries },
  });
}

/** Remove a model entirely, or only selected provider patterns when `via` is non-empty. */
export function removeModelPreference(preferences, { tier, model, via } = {}) {
  const current = normalizeModelPreferences(preferences);
  const checkedTier = requireTier(tier);
  if (typeof model !== "string" || !MODEL_ID.test(model)) throw new Error("model preference removal has invalid model");
  if (via !== undefined && (!Array.isArray(via) || via.some((provider) => typeof provider !== "string" || !PROVIDER_PATTERN.test(provider)))) {
    throw new Error("model preference removal via must contain valid provider patterns");
  }
  const removeRoutes = new Set(via ?? []);
  const entries = current.tiers[checkedTier].flatMap((entry) => {
    if (entry.model !== model) return [{ model: entry.model, via: [...entry.via] }];
    if (removeRoutes.size === 0) return [];
    const retained = entry.via.filter((provider) => !removeRoutes.has(provider));
    return retained.length ? [{ model: entry.model, via: retained }] : [];
  });
  return normalizeModelPreferences({
    schemaVersion: 1,
    tiers: { ...current.tiers, [checkedTier]: entries },
  });
}

/** Cheap/standard/frontier default follows the task requirement; caller may explicitly override. */
export function taskModelTier(requirement, explicitTier) {
  if (explicitTier !== undefined) {
    if (!TIERS.has(explicitTier)) throw new Error("model tier must be cheap, standard, or frontier");
    return explicitTier;
  }
  if (requirement.effectCapable || requirement.capabilities.includes("large_context") || requirement.capabilities.includes("vision_input")) return "frontier";
  if (requirement.capabilities.includes("code_reasoning")) return "standard";
  return "cheap";
}

function providerMatches(pattern, provider) {
  return pattern.endsWith("*") ? provider.startsWith(pattern.slice(0, -1)) : provider === pattern;
}

/** True only when this exact resource is allowed by the user's model×provider policy. */
export function preferenceMatches(entries, { provider, modelId }) {
  return entries.some((entry) => entry.model === modelId && entry.via.some((pattern) => providerMatches(pattern, provider)));
}
