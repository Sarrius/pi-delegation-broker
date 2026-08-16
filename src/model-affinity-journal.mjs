/**
 * Controller-owned learned model affinities.
 *
 * This is the durable "parallel notes" layer: which concrete resource has repeatedly produced
 * controller-accepted results for which task capability class. It deliberately cannot ingest a
 * child/provider self-report. ControllerVerifiedRoutingBoard calls recordVerified only after a
 * verifier receipt is authenticated and the broker terminal outcome agrees with it.
 *
 * User policy remains first: user tiers → learned affinity → automatic currency-aware routing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const RESOURCE_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SCHEMA_VERSION = 1;
const MIN_OBSERVATIONS = 3;

function capabilityClass(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 32
    || capabilities.some((value) => typeof value !== "string" || !CAPABILITY.test(value))
    || new Set(capabilities).size !== capabilities.length) {
    throw new Error("model affinity requires 1..32 unique capability identifiers");
  }
  return [...capabilities].sort().join("+");
}

function fresh() { return { schemaVersion: SCHEMA_VERSION, observations: {} }; }

function load(path) {
  if (!existsSync(path)) return fresh();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !value.observations || typeof value.observations !== "object" || Array.isArray(value.observations)) return fresh();
    return value;
  } catch { return fresh(); }
}

function score(entry) {
  const total = entry.accepted + entry.rejected;
  if (total < MIN_OBSERVATIONS) return undefined;
  // Wilson-like conservative prior: a route with 3/3 wins ranks below a route with a long,
  // equally clean record less often than a raw percentage would. Rejections hurt sharply.
  return (entry.accepted + 1) / (total + 2) * Math.log2(total + 1);
}

/** Persistent, owner-only journal of verifier-backed routing observations. */
export class ModelAffinityJournal {
  #path;
  #state;
  #now;

  constructor({ path, now = () => Date.now() } = {}) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("model affinity journal requires an absolute path");
    if (typeof now !== "function") throw new Error("model affinity journal requires a clock");
    this.#path = path;
    this.#now = now;
    this.#state = load(path);
  }

  /** Called only by a controller verifier bridge after receipt validation. */
  recordVerified({ resourceId, capabilities, outcome, latencyMs, costMicros, timestamp = this.#now() } = {}) {
    if (typeof resourceId !== "string" || !RESOURCE_ID.test(resourceId)) throw new Error("model affinity requires a valid resource id");
    if (outcome !== "accepted" && outcome !== "rejected") throw new Error("model affinity outcome must be accepted or rejected");
    if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("model affinity requires non-negative latency and timestamp");
    }
    if (costMicros !== undefined && (!Number.isSafeInteger(costMicros) || costMicros < 0)) throw new Error("model affinity cost must be non-negative");
    const taskClass = capabilityClass(capabilities);
    const key = `${taskClass}\u0000${resourceId}`;
    const entry = this.#state.observations[key] ?? { taskClass, resourceId, accepted: 0, rejected: 0, latencyTotalMs: 0, costTotalMicros: 0, lastObservedAt: 0 };
    entry[outcome] += 1;
    entry.latencyTotalMs += latencyMs;
    entry.costTotalMicros += costMicros ?? 0;
    entry.lastObservedAt = Math.max(entry.lastObservedAt, timestamp);
    this.#state.observations[key] = entry;
    this.#persist();
    return Object.freeze({ taskClass, resourceId, accepted: entry.accepted, rejected: entry.rejected, score: score(entry) });
  }

  /** Return a complete candidate ordering; unproven routes retain caller order. */
  rank({ resourceIds, capabilities } = {}) {
    if (!Array.isArray(resourceIds) || resourceIds.some((id) => typeof id !== "string" || !RESOURCE_ID.test(id)) || new Set(resourceIds).size !== resourceIds.length) {
      throw new Error("model affinity rank requires unique resource ids");
    }
    const taskClass = capabilityClass(capabilities);
    const measured = [];
    const unmeasured = [];
    for (const [index, resourceId] of resourceIds.entries()) {
      const entry = this.#state.observations[`${taskClass}\u0000${resourceId}`];
      const value = entry && score(entry);
      (value === undefined ? unmeasured : measured).push({ resourceId, index, score: value });
    }
    measured.sort((left, right) => (right.score - left.score) || (left.index - right.index));
    return Object.freeze([...measured.map((entry) => entry.resourceId), ...unmeasured.map((entry) => entry.resourceId)]);
  }

  snapshot() {
    return Object.freeze(structuredClone(this.#state));
  }

  #persist() {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
  }
}
