import { watch, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogToBrokerRegistry } from "./provider-catalog.mjs";

const WATCH_DEBOUNCE_MS = 2_000;

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

  const catalog = [];
  const seen = new Set();

  // 1. Providers from models-store.json (have full model details). A listed
  // model is not an active route: admit it only when this controller has a
  // credential for that exact provider. Otherwise a selector can lease an
  // apparently live model which scoped child auth cannot provision.
  for (const [provider, entry] of Object.entries(store)) {
    if (!auth[provider] || !entry?.models || !Array.isArray(entry.models)) continue;
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
  for (const provider of Object.keys(auth)) {
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
      // Provider has auth and config but no models — create a minimal entry
      catalog.push({
        provider,
        baseUrl: cfg.baseUrl,
        api: cfg.api ?? "openai-completions",
        models: [{
          id: "default", name: provider, contextWindow: 200_000, maxTokens: 8_000,
          reasoning: false, input: ["text"],
        }],
      });
    }
  }

  return catalog;
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
  #running = false;

  constructor({ agentDir, broker, onReload } = {}) {
    if (typeof agentDir !== "string") throw new Error("DynamicProviderWatcher requires agentDir");
    if (!broker || typeof broker.reloadRegistry !== "function") throw new Error("DynamicProviderWatcher requires a broker with reloadRegistry");
    if (onReload !== undefined && typeof onReload !== "function") throw new Error("DynamicProviderWatcher onReload must be a function");
    this.#agentDir = agentDir;
    this.#broker = broker;
    this.#onReload = onReload;
  }

  /**
   * Read the current catalog, build a signed registry, and attempt a hot
   * reload. Returns { status, providerCount } or { status, reason }.
   */
  async refresh() {
    const catalog = readPiCatalog(this.#agentDir);
    if (catalog.length === 0) return this.#report({ status: "skipped", reason: "empty catalog" });
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
      registry = catalogToBrokerRegistry(catalog, { confidence: "observed" });
    } catch (error) {
      // A catalog the broker cannot represent leaves the previous registry in place. Say so:
      // a silently discarded failure looks exactly like a healthy dynamic registry, and the
      // controller would keep routing against a stale or fixture provider set.
      return this.#report({ status: "failed", reason: error.message });
    }
    // Only commit the fingerprint once the catalog is known to be representable, so a
    // transient bad read is retried rather than remembered as the current state.
    this.#lastCatalogFingerprint = fingerprint;
    this.#lastRegistry = registry;

    const now = Date.now();
    const result = this.#broker.reloadRegistry(registry, now);
    if (result.status === "reloaded") {
      return this.#report({ status: "reloaded", providerCount: catalog.length, providers: catalog.map((e) => e.provider) });
    }
    // A deferred reload must be retried when capacity frees up, so do not keep the
    // fingerprint that would suppress the next attempt.
    this.#lastCatalogFingerprint = undefined;
    return this.#report({ status: result.status, reason: "reload deferred — active leases or tasks" });
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
  }

  async #refreshAsync() {
    try { await this.refresh(); } catch { /* transient read failure, retry on next change */ }
  }

  /** Current provider names from the last catalog read. */
  providers() {
    const catalog = readPiCatalog(this.#agentDir);
    return Object.freeze(catalog.map((e) => e.provider));
  }

  /**
   * The registry built from the most recent successful catalog read. Falls back to a fresh
   * read when nothing has been refreshed yet, so a selector wired to this accessor works
   * from the moment the watcher is constructed.
   */
  currentRegistry() {
    if (this.#lastRegistry === undefined) {
      const catalog = readPiCatalog(this.#agentDir);
      if (catalog.length === 0) throw new Error("DynamicProviderWatcher has no provider catalog to build a registry from");
      this.#lastRegistry = catalogToBrokerRegistry(catalog, { confidence: "observed" });
    }
    return this.#lastRegistry;
  }
}