/**
 * Currency layer: which models are current, which are history.
 *
 * The broker's catalog comes from Pi's files, and provider model lists are accumulative by
 * design — OpenAI's live /v1/models still serves davinci-002 and gpt-3.5-turbo, z.ai's still
 * serves glm-4.5. "Listed by the provider" therefore cannot mean "worth routing to", and a
 * capability flag cannot tell glm-5.3 from glm-4.7. This module derives the missing fact —
 * generation — from the data itself, with no hardcoded model rankings:
 *
 * 1. Every model id is split into (family, version): glm-5.3 → (glm, 5.3),
 *    gpt-5.6-luna → (gpt, 5.6), minimax-m3 → (minimax-m, 3), kimi-k3 → (kimi-k, 3).
 * 2. Families are ranked across the WHOLE observed fleet (every provider, every account),
 *    because a stale generation is stale everywhere: glm-4.7 does not become current on
 *    another host.
 * 3. generation = rank of the model's version inside its family: 0 newest, 1 previous,
 *    2+ legacy. Models with no parseable version form single-member families (generation 0)
 *    unless a live listing contradicts it.
 *
 * A live probe (GET {baseUrl}/models per account, controller-side credentials only) adds a
 * second fact: whether the provider actually lists the model right now. A model that vanished
 * from the listing is legacy regardless of what Pi's cache says — that is exactly how
 * glm-4.7-class entries get demoted before they can break a launch.
 *
 * The selector consumes this as `currency`: a plain resourceId → fact map. It never sees
 * credentials, and no part of this module runs inside a child.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Generations 0 and 1 are routable by default; 2+ only as an explicitly marked last resort. */
export const LEGACY_GENERATION = 2;
/** A model predating its family's newest known member by ~3 months is legacy. */
export const FAMILY_STALENESS_MS = 90 * 24 * 60 * 60 * 1_000;

// Family may itself contain hyphens (minimax-m3, claude-opus-5). The lazy capture stops
// at the first usable version delimiter; trailing codenames and size tags are irrelevant.
const VERSION_PATTERN = /^([a-z][a-z0-9-]*?)[-_.:/]?v?(\d+(?:\.\d+)*).*/;

/**
 * Split a model id into (family, version). The family is the alphabetic stem with provider
 * prefixes already stripped by the caller; trailing codenames (luna, pro, flash, 0813) do not
 * affect the version. Returns { family, version: [numbers] | null }.
 */
export function parseModelVersion(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return { family: "unknown", version: null };
  // Aggregators namespace models (`anthropic/claude-opus-5`, `~openai/gpt-latest`).
  // Generation belongs to the terminal model identity, not the reseller/vendor prefix.
  const normalized = modelId.toLowerCase().replace(/^~/, "").split("/").at(-1);
  const match = VERSION_PATTERN.exec(normalized);
  if (!match) return { family: normalized.split(/[-_.:/]/)[0] || normalized, version: null };
  const family = match[1];
  const version = match[2].split(".").map((segment) => Number.parseInt(segment, 10));
  return { family, version };
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * Assign a generation to every model id given the whole observed fleet.
 * `modelIds` is every id the catalog/probe has ever seen; families are ranked globally.
 * Returns a Map: modelId → { family, generation, version }.
 */
export function assignGenerations(modelIds) {
  const families = new Map(); // family → Map(versionKey → { version, models: [] })
  for (const id of modelIds) {
    const { family, version } = parseModelVersion(id);
    if (!families.has(family)) families.set(family, new Map());
    const key = version === null ? "∅" : version.join(".");
    const bucket = families.get(family);
    if (!bucket.has(key)) bucket.set(key, { version, models: [] });
    bucket.get(key).models.push(id);
  }
  const generations = new Map();
  for (const [familyName, bucket] of families) {
    const ranked = [...bucket.values()].sort((a, b) => {
      if (a.version === null && b.version === null) return 0;
      if (a.version === null) return 1; // unversioned ranks below versioned in the same family
      if (b.version === null) return -1;
      return compareVersions(b.version, a.version);
    });
    ranked.forEach((entry, generation) => {
      for (const id of entry.models) {
        generations.set(id, Object.freeze({ family: familyName, generation, version: entry.version ? entry.version.join(".") : null }));
      }
    });
  }
  return generations;
}

/**
 * Fetch one provider's live model list. Controller-side only: the credential never leaves
 * this process and the returned value carries only model ids.
 */
export async function probeProviderModels({ baseUrl, apiKey, timeoutMs = 15_000, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) return { status: "http_error", code: response.status, models: [] };
    const body = await response.json();
    const rows = body?.data ?? body?.models ?? [];
    const created = {};
    const models = [];
    for (const row of rows) {
      const id = row?.id ?? row?.name;
      if (typeof id !== "string") continue;
      models.push(id);
      // OpenAI-compatible APIs use UNIX seconds. Preserve only sane positive values.
      if (Number.isSafeInteger(row?.created) && row.created > 0) created[id] = row.created * 1_000;
    }
    return { status: "ok", models, created };
  } catch (error) {
    return { status: "unreachable", reason: error?.name === "AbortError" ? "timeout" : "connection", models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a provider listing represented as either Set<id> or Map<id, createdMs>. */
function listingFact(listing, modelId) {
  if (listing === undefined) return { listed: null, createdAt: undefined };
  if (listing instanceof Map) return { listed: listing.has(modelId), createdAt: listing.get(modelId) };
  if (listing instanceof Set) return { listed: listing.has(modelId), createdAt: undefined };
  return { listed: null, createdAt: undefined };
}

function listingModelIds(listing) {
  if (listing instanceof Map) return [...listing.keys()];
  if (listing instanceof Set) return [...listing];
  return [];
}

/**
 * Build the currency map for a set of resources.
 *
 * `liveListings` is provider → Set<modelId> or provider → Map<modelId, createdMs>. Supplying
 * the latter lets the filter use the upstream creation date as a second independent staleness
 * signal. Providers absent from the map contribute no listing fact rather than being punished
 * for a probe outage.
 */
export function buildCurrencyMap({ resources, liveListings } = {}) {
  if (!Array.isArray(resources)) throw new Error("buildCurrencyMap requires resources");
  const allIds = resources.map((resource) => resource.modelId);
  // The live listing matters even for models the user has not configured. If their stale Pi
  // cache contains only glm-4.7 but z.ai's live API also lists glm-5.3, glm-4.7 is still
  // legacy. Ranking only local resources would make old cache entries look falsely current.
  for (const listing of liveListings?.values?.() ?? []) allIds.push(...listingModelIds(listing));
  // A model hosted on several providers must get one generation, not one per host: rank the
  // union fleet-wide, then look up per resource.
  const generations = assignGenerations([...new Set(allIds)]);

  // Newest known creation time per family. We use relative age, not wall-clock age: a provider
  // can keep a capable older model around, but a model three months behind its own family's newest
  // release is history even when the provider still lists it.
  const familyNewest = new Map();
  // Use every API-listed model, not merely models present in Pi's cache. Otherwise a cache
  // containing only glm-4.7 would never learn that live z.ai has already shipped glm-5.3.
  for (const listing of liveListings?.values?.() ?? []) {
    if (!(listing instanceof Map)) continue;
    for (const [modelId, createdAt] of listing) {
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0) continue;
      const family = generations.get(modelId)?.family ?? parseModelVersion(modelId).family;
      familyNewest.set(family, Math.max(familyNewest.get(family) ?? 0, createdAt));
    }
  }
  // Providers that expose only a Set (no dates) still contribute nothing to this date-specific
  // check; their version ranking and live-listed/not-listed facts remain active.
  for (const { provider, modelId } of resources) {
    const { createdAt } = listingFact(liveListings?.get(provider), modelId);
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) continue;
    const family = generations.get(modelId)?.family ?? parseModelVersion(modelId).family;
    familyNewest.set(family, Math.max(familyNewest.get(family) ?? 0, createdAt));
  }

  const currency = {};
  for (const { provider, modelId } of resources) {
    const fact = generations.get(modelId) ?? { family: parseModelVersion(modelId).family, generation: 0 };
    const { listed, createdAt } = listingFact(liveListings?.get(provider), modelId);
    const staleByDate = Number.isSafeInteger(createdAt)
      && createdAt > 0
      && (familyNewest.get(fact.family) ?? createdAt) - createdAt > FAMILY_STALENESS_MS;
    const generation = (listed === false || staleByDate)
      ? Math.max(fact.generation, LEGACY_GENERATION)
      : fact.generation;
    currency[`${provider}/${modelId}`] = Object.freeze({
      generation,
      listed,
      ...(Number.isSafeInteger(createdAt) ? { createdAt } : {}),
      ...(staleByDate ? { staleByDate: true } : {}),
      legacy: generation >= LEGACY_GENERATION,
    });
  }
  return Object.freeze(currency);
}

/** Persisted probe cache so a broker restart does not re-probe every account. */
export function readCurrencyCache(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.probedAt === "number" && parsed.listings && typeof parsed.listings === "object") {
      return parsed;
    }
  } catch { /* no cache yet */ }
  return undefined;
}

export function writeCurrencyCache(path, listings) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const serializable = {};
  for (const [provider, ids] of listings) serializable[provider] = [...ids].sort();
  writeFileSync(path, JSON.stringify({ probedAt: Date.now(), listings: serializable }), { mode: 0o600 });
}

export function listingsFromCache(cache) {
  const listings = new Map();
  for (const [provider, ids] of Object.entries(cache?.listings ?? {})) {
    if (Array.isArray(ids)) listings.set(provider, new Set(ids));
  }
  return listings;
}
