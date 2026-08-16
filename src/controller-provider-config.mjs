import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ANTHROPIC_MESSAGES_ADAPTER_ID, AnthropicMessagesTransport } from "./anthropic-messages-transport.mjs";
import { catalogToBrokerRegistry } from "./provider-catalog.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const CACHE_RETENTION = new Set(["none", "short", "long"]);
const ANTHROPIC_DIALECT = "anthropic-messages";
const ANTHROPIC_ADAPTER = ANTHROPIC_MESSAGES_ADAPTER_ID;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function fingerprint(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeSecretEntry(entry) {
  exactKeys(entry, ["credentialRef", "apiKey"], "credential entry");
  if (typeof entry.credentialRef !== "string" || !ID.test(entry.credentialRef)) throw new Error("credential entry credentialRef is invalid");
  if (typeof entry.apiKey !== "string" || entry.apiKey.length < 1 || entry.apiKey.length > 4_096 || /[\0\r\n]/.test(entry.apiKey)) {
    throw new Error("credential entry apiKey is invalid");
  }
  return Object.freeze({ credentialRef: entry.credentialRef, apiKey: entry.apiKey, credentialRefFingerprint: fingerprint(entry.apiKey) });
}

function normalizeRoute(route) {
  exactKeys(route, [
    "resourceId", "capacityGroup", "profile", "accountAlias", "provider", "model", "reasoningEffort",
    "apiDialect", "endpointId", "endpoint", "adapterId", "credentialRef", "cacheRetention",
  ], "controller route");
  for (const key of ["resourceId", "capacityGroup", "profile", "accountAlias", "provider", "model", "endpointId", "credentialRef"]) {
    if (typeof route[key] !== "string" || !ID.test(route[key])) throw new Error(`controller route ${key} is invalid`);
  }
  if (route.reasoningEffort !== null && (typeof route.reasoningEffort !== "string" || !ID.test(route.reasoningEffort))) {
    throw new Error("controller route reasoningEffort is invalid");
  }
  if (route.apiDialect !== ANTHROPIC_DIALECT || route.adapterId !== ANTHROPIC_ADAPTER) {
    throw new Error("controller route is not an approved Anthropic Messages route");
  }
  if (!CACHE_RETENTION.has(route.cacheRetention)) throw new Error("controller route cacheRetention is invalid");
  let endpoint;
  try { endpoint = new URL(route.endpoint); } catch { throw new Error("controller route endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error("controller route endpoint must be credential-free HTTPS without query or fragment");
  }
  return Object.freeze({ ...route, endpoint: endpoint.toString() });
}

function routeFingerprint({ registryFingerprint, registryVersion, routes }) {
  return fingerprint(JSON.stringify({ registryFingerprint, registryVersion, routes: [...routes].sort((a, b) => a.resourceId.localeCompare(b.resourceId)) }));
}

function sameRouteSnapshot(route, snapshot) {
  return snapshot?.accountAlias === route.accountAlias
    && snapshot.provider === route.provider
    && snapshot.model === route.model
    && snapshot.reasoningEffort === route.reasoningEffort
    && snapshot.apiDialect === route.apiDialect
    && snapshot.endpointId === route.endpointId
    && snapshot.adapterId === route.adapterId
    && snapshot.cacheRetention === route.cacheRetention;
}

/**
 * An in-memory, exact-name credential store. It deliberately has no env,
 * keychain, OAuth, default-account or secondary-ref lookup. Callers inject
 * secrets at controller bootstrap; config files never contain an API key.
 */
export class ControllerCredentialStore {
  #byRef = new Map();
  #byFingerprint = new Map();

  constructor({ entries = [] } = {}) {
    if (!Array.isArray(entries) || entries.length > 256) throw new Error("credential store entries must contain at most 256 values");
    for (const entry of entries) this.register(entry);
  }

  register(entry) {
    const normalized = normalizeSecretEntry(entry);
    if (this.#byRef.has(normalized.credentialRef) || this.#byFingerprint.has(normalized.credentialRefFingerprint)) {
      throw new Error("credential store credentialRef or credential fingerprint already exists");
    }
    this.#byRef.set(normalized.credentialRef, normalized);
    this.#byFingerprint.set(normalized.credentialRefFingerprint, normalized);
    return Object.freeze({ credentialRef: normalized.credentialRef, credentialRefFingerprint: normalized.credentialRefFingerprint });
  }

  fingerprintFor(credentialRef) {
    const entry = this.#byRef.get(credentialRef);
    if (!entry) throw new Error("configured credential reference is unavailable");
    return entry.credentialRefFingerprint;
  }

  resolveExact(credentialRef, credentialRefFingerprint) {
    const entry = this.#byRef.get(credentialRef);
    if (!entry || entry.credentialRefFingerprint !== credentialRefFingerprint) return undefined;
    return Object.freeze({ apiKey: entry.apiKey });
  }

  status() {
    return Object.freeze([...this.#byRef.values()].map((entry) => Object.freeze({
      credentialRef: entry.credentialRef,
      credentialRefFingerprint: entry.credentialRefFingerprint,
    })));
  }
}

/**
 * Immutable controller route configuration. It maps a broker-selected resource
 * to one exact account/model/endpoint/ref and never selects a replacement.
 */
export class ControllerRouteTable {
  #registryFingerprint;
  #registryVersion;
  #routes;
  #byResource;
  #byEndpoint;
  #fingerprint;

  constructor({ registryFingerprint, registryVersion, routes } = {}) {
    if (typeof registryFingerprint !== "string" || !FINGERPRINT.test(registryFingerprint)) throw new Error("route table registryFingerprint is invalid");
    if (!Number.isSafeInteger(registryVersion) || registryVersion < 1) throw new Error("route table registryVersion is invalid");
    if (!Array.isArray(routes) || routes.length < 1 || routes.length > 256) throw new Error("route table requires 1..256 routes");
    const normalized = routes.map(normalizeRoute);
    if (new Set(normalized.map((route) => route.resourceId)).size !== normalized.length
      || new Set(normalized.map((route) => route.endpointId)).size !== normalized.length) {
      throw new Error("route table resourceId and endpointId values must be unique");
    }
    this.#registryFingerprint = registryFingerprint;
    this.#registryVersion = registryVersion;
    this.#routes = Object.freeze(normalized);
    this.#byResource = new Map(normalized.map((route) => [route.resourceId, route]));
    this.#byEndpoint = new Map(normalized.map((route) => [route.endpointId, route]));
    this.#fingerprint = routeFingerprint({ registryFingerprint, registryVersion, routes: normalized });
  }

  get fingerprint() { return this.#fingerprint; }

  resolveForLease(lease, credentialStore) {
    if (!lease || typeof lease !== "object") throw new Error("controller route resolution requires a lease");
    if (!credentialStore || typeof credentialStore.fingerprintFor !== "function") throw new Error("controller route resolution requires credential store");
    const route = this.#byResource.get(lease.resourceId);
    if (!route || lease.capacityGroup !== route.capacityGroup || lease.profile !== route.profile) {
      throw new Error("broker lease is not bound to a configured controller route");
    }
    return Object.freeze({
      registryFingerprint: this.#registryFingerprint,
      registryVersion: this.#registryVersion,
      accountAlias: route.accountAlias,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      apiDialect: route.apiDialect,
      endpointId: route.endpointId,
      adapterId: route.adapterId,
      credentialRefFingerprint: credentialStore.fingerprintFor(route.credentialRef),
      cacheRetention: route.cacheRetention,
    });
  }

  endpointFor(snapshot) {
    const route = this.#byEndpoint.get(snapshot?.endpointId);
    if (!route || snapshot.registryFingerprint !== this.#registryFingerprint || snapshot.registryVersion !== this.#registryVersion
      || !sameRouteSnapshot(route, snapshot)) return undefined;
    return route.endpoint;
  }

  credentialFor(snapshot, credentialStore) {
    const route = this.#byEndpoint.get(snapshot?.endpointId);
    if (!route || snapshot?.registryFingerprint !== this.#registryFingerprint || snapshot?.registryVersion !== this.#registryVersion
      || !sameRouteSnapshot(route, snapshot) || !credentialStore || typeof credentialStore.resolveExact !== "function") return undefined;
    return credentialStore.resolveExact(route.credentialRef, snapshot.credentialRefFingerprint);
  }

  routes() {
    return Object.freeze(this.#routes.map((route) => Object.freeze({
      resourceId: route.resourceId, capacityGroup: route.capacityGroup, profile: route.profile,
      accountAlias: route.accountAlias, provider: route.provider, model: route.model,
      reasoningEffort: route.reasoningEffort, apiDialect: route.apiDialect, endpointId: route.endpointId,
      adapterId: route.adapterId, credentialRef: route.credentialRef, cacheRetention: route.cacheRetention,
    })));
  }
}

/** One controller-issued, bounded approval for this exact route-table generation. */
export class ControllerLiveProviderApproval {
  #routeTableFingerprint;
  #expiresAt;
  #remaining;
  #now;
  #approvalId;

  constructor({ routeTableFingerprint, expiresAt, maxRequests = 1, now = () => Date.now(), approvalId = randomUUID() } = {}) {
    if (typeof routeTableFingerprint !== "string" || !FINGERPRINT.test(routeTableFingerprint)) throw new Error("live approval routeTableFingerprint is invalid");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) {
      throw new Error("live approval expiry or request limit is invalid");
    }
    if (typeof now !== "function" || typeof approvalId !== "string" || !ID.test(approvalId)) throw new Error("live approval is invalid");
    this.#routeTableFingerprint = routeTableFingerprint;
    this.#expiresAt = expiresAt;
    this.#remaining = maxRequests;
    this.#now = now;
    this.#approvalId = approvalId;
  }

  consume(routeTableFingerprint) {
    if (routeTableFingerprint !== this.#routeTableFingerprint || this.#now() >= this.#expiresAt || this.#remaining < 1) return false;
    this.#remaining -= 1;
    return true;
  }

  status() {
    return Object.freeze({ approvalId: this.#approvalId, expiresAt: this.#expiresAt, remaining: this.#remaining });
  }
}

/**
 * Construct the sole supported real provider injection. Authorization is
 * consumed before credential lookup/send, routes are exact, and no retry or
 * account/model failover capability is exposed.
 */
export function createApprovedAnthropicProviderRoute({ routeTable, credentialStore, liveApproval, fetchImpl, now } = {}) {
  if (!(routeTable instanceof ControllerRouteTable)) throw new Error("approved Anthropic route requires a ControllerRouteTable");
  if (!(credentialStore instanceof ControllerCredentialStore)) throw new Error("approved Anthropic route requires a ControllerCredentialStore");
  if (!(liveApproval instanceof ControllerLiveProviderApproval)) throw new Error("approved Anthropic route requires a ControllerLiveProviderApproval");
  const transport = new AnthropicMessagesTransport({
    credentialResolver: async (snapshot) => routeTable.credentialFor(snapshot, credentialStore),
    endpointResolver: async (snapshot) => routeTable.endpointFor(snapshot),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(now === undefined ? {} : { now }),
  });
  return Object.freeze({
    providerTransport: Object.freeze({
      async *stream(snapshot, context, options) {
        if (!liveApproval.consume(routeTable.fingerprint)) throw new Error("live_provider_approval_unavailable");
        yield* transport.stream(snapshot, context, options);
      },
    }),
    routeResolver: async (lease) => routeTable.resolveForLease(lease, credentialStore),
  });
}

/**
 * Read a public controller route config from an owner-only regular file. The
 * schema deliberately has no secret field; API keys must be injected into the
 * in-memory ControllerCredentialStore by the controller bootstrap.
 */
export function loadControllerRouteConfiguration(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("controller route configuration path must be absolute");
  const link = lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("controller route configuration must be a regular non-symlink file");
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if ((stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw new Error("controller route configuration must be owner-only and bounded");
  let value;
  try { value = JSON.parse(readFileSync(canonical, "utf8")); } catch { throw new Error("controller route configuration is invalid JSON"); }
  return new ControllerRouteTable(value);
}

/**
 * Controller-only snapshot adapter for pi-multi-account/Pi modelRegistry.
 * It accepts an injected reader, stores no credentials, and emits only an
 * observed catalog-derived registry candidate that still needs signing/policy.
 */
export class ControllerAccountInventory {
  #readCatalog;
  #now;
  #latest;

  constructor({ readCatalog, now = () => Date.now() } = {}) {
    if (typeof readCatalog !== "function" || typeof now !== "function") throw new Error("controller account inventory requires controller readCatalog and clock functions");
    this.#readCatalog = readCatalog;
    this.#now = now;
  }

  async refresh() {
    const catalog = await this.#readCatalog();
    const registryCandidate = catalogToBrokerRegistry(catalog, { confidence: "observed" });
    const capturedAt = this.#now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error("controller account inventory clock is invalid");
    const catalogFingerprint = fingerprint(JSON.stringify(catalog));
    this.#latest = Object.freeze({ capturedAt, catalogFingerprint, registryCandidate });
    return this.#latest;
  }

  latest() { return this.#latest; }
}
