import { watch, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogToBrokerRegistry } from "./provider-catalog.mjs";

const WATCH_DEBOUNCE_MS = 2_000;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

function oauthExpiryMs(credential) {
  const raw = credential?.expires ?? credential?.expiresAt ?? credential?.expires_at;
  if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
  // Pi has historically stored OAuth expiry in milliseconds, while a few provider adapters use
  // Unix seconds. Normalize both so an apparently live token cannot survive for 55,000 years.
  return raw < 100_000_000_000 ? raw * 1_000 : raw;
}

/** Return the one bearer/API token that the controller may use for a live preflight. */
export function activeCredentialToken(credential, now = Date.now()) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
  if ((credential.type === "api_key" || credential.type === "api-key")
    && typeof credential.key === "string" && credential.key.length > 0) return credential.key;
  if (credential.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0
    && (oauthExpiryMs(credential) ?? 0) > now + 30_000) return credential.access;
  return undefined;
}

/** Credential-free admission preflight. Expired OAuth must not reach a child and discover a
 * dead refresh token after launch; the periodic watcher re-evaluates expiry even when auth.json
 * itself does not change. */
export function activeAuthorizedProviders(auth, now = Date.now()) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return Object.freeze([]);
  return Object.freeze(Object.entries(auth).flatMap(([provider, credential]) => activeCredentialToken(credential, now) ? [provider] : []));
}

/**
 * Read Pi's models-store.json, models.json, and auth.json and merge them
 * into a complete broker catalog. Covers:
 * - Base providers from models-store.json
 * - Provider config (baseUrl, api) from models.json
 * - pi-multi-account providers from auth.json (openai-codex-account-N
 *   inherit models from their base provider openai-codex)
 * - Any auth-only provider with a config in models.json
 */
function readPiCatalog(agentDir) {
  let store = {}, modelsConfig = {}, auth = {};
  try { store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8")); } catch { /* not present */ }
  try { modelsConfig = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")); } catch { /* not present */ }
  try { auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")); } catch { /* not present */ }
  if (!store || typeof store !== "object" || Array.isArray(store)) store = {};
  if (!modelsConfig || typeof modelsConfig !== "object" || Array.isArray(modelsConfig)) modelsConfig = {};
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) auth = {};
  const providersConfig = modelsConfig.providers ?? {};
  const authorized = new Set(activeAuthorizedProviders(auth));

  const catalog = [];
  const seen = new Set();

  // 1. Providers from models-store.json (have full model details). A listed
  // model is not an active route: admit it only when this controller has a
  // credential for that exact provider. Otherwise a selector can lease an
  // apparently live model which scoped child auth cannot provision.
  for (const [provider, entry] of Object.entries(store)) {
    if (!authorized.has(provider) || !entry?.models || !Array.isArray(entry.models)) continue;
    if (seen.has(provider)) continue;
    seen.add(provider);
    const cfg = providersConfig[provider] ?? {};
    catalog.push({
      provider,
      baseUrl: cfg.baseUrl ?? entry.models[0]?.baseUrl ?? `https://${provider}.example`,
      api: cfg.api ?? entry.models[0]?.api ?? "openai-completions",
      models: entry.models.map((m) => ({
        id: m.id, name: m.name ?? m.id,
        contextWindow: m.contextWindow ?? 200_000, maxTokens: m.maxTokens ?? 8_000,
        reasoning: m.reasoning !== false,
        input: Array.isArray(m.input) ? m.input : ["text"],
      })),
    });
  }

  // 2. Providers in auth.json that are NOT in models-store.
  //    This covers pi-multi-account accounts (openai-codex-account-N) and
  //    any provider the user logged into but Pi hasn't fetched models for yet.
  for (const provider of authorized) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const cfg = providersConfig[provider] ?? {};
    // Try to find a base provider to inherit models from.
    // e.g. openai-codex-account-7 → base = openai-codex
    const baseName = provider.replace(/-account-\d+$/, "");
    const baseEntry = store[baseName];
    if (baseEntry?.models && Array.isArray(baseEntry.models)) {
      catalog.push({
        provider,
        baseUrl: cfg.baseUrl ?? baseEntry.models[0]?.baseUrl ?? `https://${provider}.example`,
        api: cfg.api ?? baseEntry.models[0]?.api ?? "openai-completions",
        models: baseEntry.models.map((m) => ({
          id: m.id, name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? 200_000, maxTokens: m.maxTokens ?? 8_000,
          reasoning: m.reasoning !== false,
          input: Array.isArray(m.input) ? m.input : ["text"],
        })),
      });
    } else if (cfg.baseUrl) {
      // Provider has auth and endpoint config. models.json may carry the real model
      // list (multi-account provisions its slots there at login); only fall back to a
      // placeholder when it does not.
      const configuredModels = Array.isArray(cfg.models)
        ? cfg.models
            .map((m) => (typeof m === "string" ? { id: m } : m))
            .filter((m) => m && typeof m.id === "string" && m.id.length > 0)
        : [];
      catalog.push({
        provider,
        baseUrl: cfg.baseUrl,
        api: cfg.api ?? "openai-completions",
        models: configuredModels.length > 0
          ? configuredModels.map((m) => ({
              id: m.id, name: typeof m.name === "string" ? m.name : m.id,
              contextWindow: Number.isSafeInteger(m.contextWindow) ? m.contextWindow : 200_000,
              maxTokens: Number.isSafeInteger(m.maxTokens) ? m.maxTokens : 8_000,
              reasoning: m.reasoning !== false,
              input: Array.isArray(m.input) ? m.input : ["text"],
            }))
          : [{
              id: "default", name: provider, contextWindow: 200_000, maxTokens: 8_000,
              reasoning: false, input: ["text"],
            }],
      });
    }
  }

  return catalog;
}

/** Convert Pi's live ModelRegistry surface into the broker's credential-free catalog.
 * This preserves per-account model availability registered at runtime by any provider
 * extension instead of incorrectly cloning one base provider's models onto every alias. */
export function modelRegistryToProviderCatalog(models, { authorizedProviders } = {}) {
  if (!Array.isArray(models)) throw new Error("model registry snapshot must be an array");
  const allowed = authorizedProviders === undefined ? undefined : new Set(authorizedProviders);
  const grouped = new Map();
  for (const model of models) {
    if (!model || typeof model !== "object" || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    if (!model.provider || !model.id || (allowed && !allowed.has(model.provider))) continue;
    const current = grouped.get(model.provider) ?? [];
    current.push(model);
    grouped.set(model.provider, current);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, providerModels]) => {
      const first = providerModels[0];
      return {
        provider,
        baseUrl: first.baseUrl ?? `https://${provider}.example`,
        api: first.api ?? "openai-completions",
        models: providerModels
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            contextWindow: model.contextWindow ?? 200_000,
            maxTokens: model.maxTokens ?? 8_000,
            reasoning: model.reasoning !== false,
            input: Array.isArray(model.input) ? model.input : ["text"],
          })),
      };
    });
}

/**
 * Build a broker registry directly from a Pi agent dir, without a broker. The controller
 * uses this to sign the supervisor's initial registry; the watcher then keeps it hot.
 */
export function readProviderRegistry(agentDir, { confidence = "observed" } = {}) {
  const catalog = readPiCatalog(agentDir);
  if (catalog.length === 0) throw new Error(`no provider catalog readable in ${agentDir}`);
  return catalogToBrokerRegistry(catalog, { confidence });
}

/**
 * Controller-owned dynamic provider watcher. It monitors Pi's agent directory
 * for changes to auth.json and models-store.json, rebuilds the broker
 * registry catalog, re-signs it with a controller-generated key, and triggers
 * a hot reload on the broker when the catalog changes.
 *
 * New providers appear as `observed` confidence — they are available for
 * routing but cannot satisfy hard-budget contracts until explicitly upgraded
 * to `measured` in a signed registry update.
 */
export class DynamicProviderWatcher {
  #agentDir;
  #broker;
  #onReload;
  #watcher;
  #debounceTimer;
  #lastCatalogFingerprint;
  #lastRegistry;
  #readCatalog;
  #refreshIntervalMs;
  #refreshTimer;
  #running = false;

  constructor({ agentDir, broker, onReload, readCatalog, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS } = {}) {
    if (typeof agentDir !== "string") throw new Error("DynamicProviderWatcher requires agentDir");
    if (!broker || (typeof broker.updateRegistry !== "function" && typeof broker.reloadRegistry !== "function")) {
      throw new Error("DynamicProviderWatcher requires a broker with updateRegistry or reloadRegistry");
    }
    if (onReload !== undefined && typeof onReload !== "function") throw new Error("DynamicProviderWatcher onReload must be a function");
    if (readCatalog !== undefined && typeof readCatalog !== "function") throw new Error("DynamicProviderWatcher readCatalog must be a function");
    if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 100 || refreshIntervalMs > 3_600_000) {
      throw new Error("DynamicProviderWatcher refreshIntervalMs must be between 100 and 3600000");
    }
    this.#agentDir = agentDir;
    this.#broker = broker;
    this.#onReload = onReload;
    this.#readCatalog = readCatalog ?? (() => readPiCatalog(this.#agentDir));
    this.#refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Read the current catalog, build a signed registry, and attempt a hot
   * reload. Returns { status, providerCount } or { status, reason }.
   */
  async refresh() {
    const catalog = this.#readCatalog();
    if (!Array.isArray(catalog)) throw new Error("provider catalog reader must return an array");
    // Fingerprint the models too, not just the provider names: a provider that gains or
    // loses a model is a different routing surface, and name-only fingerprinting reported
    // "unchanged" and never reloaded.
    const fingerprint = JSON.stringify(
      catalog.map((entry) => [entry.provider, entry.models.map((model) => model.id).sort()])
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );
    if (fingerprint === this.#lastCatalogFingerprint) return { status: "unchanged" };

    let registry;
    try {
      // Empty means that no credential is currently authorized. Keeping the previous registry
      // here would route work to an expired account forever, so the broker must represent the
      // empty fleet explicitly and deny new reservations until a provider returns.
      registry = catalogToBrokerRegistry(catalog, { confidence: "observed", allowEmpty: true });
    } catch (error) {
      // A catalog the broker cannot represent leaves the previous registry in place. Say so:
      // a silently discarded failure looks exactly like a healthy dynamic registry, and the
      // controller would keep routing against a stale or fixture provider set.
      return this.#report({ status: "failed", reason: error.message });
    }
    const now = Date.now();
    // Dynamic membership is safe to apply while leases are live: additions are admitted now,
    // withdrawals drain, and only incompatible policy changes are deferred. The old full reload
    // path rejected every catalog change during continuous work, making newly recovered accounts
    // invisible until the fleet became idle.
    const result = typeof this.#broker.updateRegistry === "function"
      ? this.#broker.updateRegistry(registry, now)
      : this.#broker.reloadRegistry(registry, now);
    if (result.status === "updated" || result.status === "reloaded") {
      // Commit only after the broker accepted the candidate. A rejected replacement must not
      // leave selector state one generation ahead of SQLite admission.
      this.#lastCatalogFingerprint = fingerprint;
      this.#lastRegistry = registry;
      return this.#report({ status: "reloaded", providerCount: catalog.length, providers: catalog.map((e) => e.provider) });
    }
    // A deferred/rejected update must be retried on the next periodic pass.
    this.#lastCatalogFingerprint = undefined;
    return this.#report({ status: result.status, reason: "provider registry update deferred" });
  }

  #report(outcome) {
    const frozen = Object.freeze({ ...outcome });
    try { this.#onReload?.(frozen); } catch { /* controller callback failure must not stop watching */ }
    return frozen;
  }

  /** Start watching the agent directory for auth/model changes. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#refreshAsync().catch(() => undefined);
    this.#refreshTimer = setInterval(() => this.#refreshAsync(), this.#refreshIntervalMs);
    this.#refreshTimer.unref?.();
    try {
      this.#watcher = watch(this.#agentDir, { persistent: false }, (eventType, filename) => {
        if (filename !== "auth.json" && filename !== "models-store.json" && filename !== "models.json") return;
        if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
        this.#debounceTimer = setTimeout(() => {
          this.#debounceTimer = undefined;
          this.#refreshAsync().catch(() => undefined);
        }, WATCH_DEBOUNCE_MS);
        this.#debounceTimer.unref?.();
      });
    } catch {
      // If the directory can't be watched, periodic refresh still works.
    }
  }

  stop() {
    this.#running = false;
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  async #refreshAsync() {
    try { await this.refresh(); } catch { /* transient read failure, retry on next change */ }
  }

  /** Current provider names from the last catalog read. */
  providers() {
    const catalog = this.#readCatalog();
    return Object.freeze(catalog.map((e) => e.provider));
  }

  /**
   * The registry built from the most recent successful catalog read. Falls back to a fresh
   * read when nothing has been refreshed yet, so a selector wired to this accessor works
   * from the moment the watcher is constructed.
   */
  currentRegistry() {
    if (this.#lastRegistry === undefined) {
      const catalog = this.#readCatalog();
      if (!Array.isArray(catalog)) throw new Error("DynamicProviderWatcher provider catalog is invalid");
      this.#lastRegistry = catalogToBrokerRegistry(catalog, { confidence: "observed", allowEmpty: true });
    }
    return this.#lastRegistry;
  }
}