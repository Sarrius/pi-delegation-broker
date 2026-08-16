/**
 * Controller-owned learned model affinities.
 *
 * This is the durable "parallel notes" layer: which concrete resource has repeatedly produced
 * controller-accepted results for which task capability class. It deliberately cannot ingest a
 * child/provider self-report. ControllerVerifiedRoutingBoard calls recordVerified only after a
 * verifier receipt is authenticated and the broker terminal outcome agrees with it.
 *
 * User policy remains first: user tiers → learned affinity → automatic currency-aware routing.
 *
 * The measure is efficiency, not money. A broker cannot observe spend: providers expose no
 * synchronous ledger and subscription accounts have no per-request price at all, so any cost
 * figure here would be a guess dressed as evidence. What the controller genuinely observes is
 * what a route consumed to produce an accepted result — tokens, wall-clock latency, and how many
 * attempts it took. That is the currency this journal keeps.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const RESOURCE_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SCHEMA_VERSION = 2;
// Weights for how far consumption may drag a route below a more frugal peer. Reliability stays
// dominant: a cheap route that fails verification is worthless, however little it burned.
const TOKEN_WEIGHT = 0.5;
const LATENCY_WEIGHT = 0.3;
const ATTEMPT_WEIGHT = 0.2;
// Efficiency may cost a route at most half its standing. Left unbounded, a route that burns few
// tokens producing rejected work would outrank one that actually passes verification, which
// inverts the whole point: correctness is not purchasable with frugality.
const MIN_EFFICIENCY_DISCOUNT = 0.5;
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

function reliability(entry) {
  const total = entry.accepted + entry.rejected;
  if (total < MIN_OBSERVATIONS) return undefined;
  // Wilson-like conservative prior: a route with 3/3 wins ranks below a route with a long,
  // equally clean record less often than a raw percentage would. Rejections hurt sharply.
  return (entry.accepted + 1) / (total + 2) * Math.log2(total + 1);
}

function means(entry) {
  const total = Math.max(1, entry.accepted + entry.rejected);
  return {
    tokens: entry.tokenTotal / total,
    latencyMs: entry.latencyTotalMs / total,
    attempts: (entry.attemptTotal || total) / total,
  };
}

/**
 * Efficiency is only meaningful against the other candidates for the same task, so it is scored
 * in `rank` where the whole field is visible: the most frugal measured route keeps its full
 * reliability score and the others are discounted by how much more they consume to do the
 * same accepted work.
 */
function efficiencyDiscount(observed, best) {
  const ratio = (value, floor) => (best[floor] > 0 ? Math.max(1, value / best[floor]) : 1);
  const excess = TOKEN_WEIGHT * (ratio(observed.tokens, "tokens") - 1)
    + LATENCY_WEIGHT * (ratio(observed.latencyMs, "latencyMs") - 1)
    + ATTEMPT_WEIGHT * (ratio(observed.attempts, "attempts") - 1);
  return Math.max(MIN_EFFICIENCY_DISCOUNT, 1 / (1 + excess));
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
  recordVerified({ resourceId, capabilities, outcome, latencyMs, tokens, attempts, timestamp = this.#now() } = {}) {
    if (typeof resourceId !== "string" || !RESOURCE_ID.test(resourceId)) throw new Error("model affinity requires a valid resource id");
    if (outcome !== "accepted" && outcome !== "rejected") throw new Error("model affinity outcome must be accepted or rejected");
    if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("model affinity requires non-negative latency and timestamp");
    }
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new Error("model affinity tokens must be non-negative");
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) throw new Error("model affinity attempts must be a positive count");
    const taskClass = capabilityClass(capabilities);
    const key = `${taskClass}\u0000${resourceId}`;
    const entry = this.#state.observations[key]
      ?? { taskClass, resourceId, accepted: 0, rejected: 0, latencyTotalMs: 0, tokenTotal: 0, attemptTotal: 0, lastObservedAt: 0 };
    entry[outcome] += 1;
    entry.latencyTotalMs += latencyMs;
    entry.tokenTotal += tokens ?? 0;
    entry.attemptTotal += attempts ?? 1;
    entry.lastObservedAt = Math.max(entry.lastObservedAt, timestamp);
    this.#state.observations[key] = entry;
    this.#persist();
    return Object.freeze({
      taskClass, resourceId, accepted: entry.accepted, rejected: entry.rejected,
      reliability: reliability(entry), efficiency: Object.freeze(means(entry)),
    });
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
      const value = entry && reliability(entry);
      (value === undefined ? unmeasured : measured).push({ resourceId, index, reliability: value, observed: entry && means(entry) });
    }
    const best = measured.reduce((floor, entry) => ({
      tokens: Math.min(floor.tokens, entry.observed.tokens || Infinity),
      latencyMs: Math.min(floor.latencyMs, entry.observed.latencyMs || Infinity),
      attempts: Math.min(floor.attempts, entry.observed.attempts || Infinity),
    }), { tokens: Infinity, latencyMs: Infinity, attempts: Infinity });
    for (const entry of measured) {
      const floor = {
        tokens: Number.isFinite(best.tokens) ? best.tokens : 0,
        latencyMs: Number.isFinite(best.latencyMs) ? best.latencyMs : 0,
        attempts: Number.isFinite(best.attempts) ? best.attempts : 0,
      };
      entry.score = entry.reliability * efficiencyDiscount(entry.observed, floor);
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
