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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

function validEntry(entry) {
  return Boolean(entry) && typeof entry === "object"
    && typeof entry.taskClass === "string" && typeof entry.resourceId === "string" && RESOURCE_ID.test(entry.resourceId)
    && [entry.accepted, entry.rejected, entry.latencyTotalMs, entry.lastObservedAt].every((value) => Number.isSafeInteger(value) && value >= 0);
}

/**
 * Migrate a v1 journal instead of discarding it. Verified accept/reject history is expensive to
 * re-earn — it only accumulates through authenticated verifier receipts — so dropping it would
 * silently reset routing to guesswork. Consumption is a different matter: v1 recorded only a
 * money estimate, which this journal no longer treats as evidence. Migrated entries therefore
 * carry zero token/attempt samples, which the ranker already reads as "unmeasured" and scores
 * neutrally, rather than as a route that consumed nothing.
 */
function migrateV1(value) {
  const observations = {};
  for (const [key, entry] of Object.entries(value.observations)) {
    if (!validEntry(entry)) continue;
    observations[key] = {
      taskClass: entry.taskClass,
      resourceId: entry.resourceId,
      accepted: entry.accepted,
      rejected: entry.rejected,
      latencyTotalMs: entry.latencyTotalMs,
      tokenTotal: 0,
      attemptTotal: 0,
      lastObservedAt: entry.lastObservedAt,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, observations };
}

function load(path) {
  if (!existsSync(path)) return fresh();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || !value.observations || typeof value.observations !== "object" || Array.isArray(value.observations)) return fresh();
    if (value.schemaVersion === 1) return migrateV1(value);
    if (value.schemaVersion !== SCHEMA_VERSION) return fresh();
    for (const [key, entry] of Object.entries(value.observations)) {
      if (!validEntry(entry) || !Number.isSafeInteger(entry.tokenTotal) || !Number.isSafeInteger(entry.attemptTotal)) delete value.observations[key];
    }
    return value;
  } catch { return fresh(); }
}

function reliability(entry) {
  const total = entry.accepted + entry.rejected;
  if (total < MIN_OBSERVATIONS) return undefined;
  // Beta(1,1) posterior mean. Sample size expresses confidence, never a volume bonus.
  return (entry.accepted + 1) / (total + 2);
}

function means(entry) {
  const total = Math.max(1, entry.accepted + entry.rejected);
  return {
    tokens: entry.tokenSamples ? entry.tokenTotal / entry.tokenSamples : undefined,
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
  const ratio = (value, floor) => (value !== undefined && best[floor] > 0 ? Math.max(1, value / best[floor]) : 1);
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
  #store;
  #context;

  constructor({ path, store, context = "legacy", now = () => Date.now() } = {}) {
    if (!store && (typeof path !== "string" || !isAbsolute(path))) throw new Error("model affinity journal requires an absolute path");
    if (typeof now !== "function") throw new Error("model affinity journal requires a clock");
    this.#path = path;
    this.#now = now;
    this.#store = store;
    this.#context = context;
    this.#state = store ? fresh() : load(path);
  }

  /** Called only by a controller verifier bridge after receipt validation. */
  recordVerified({ resourceId, capabilities, outcome, latencyMs, tokens, attempts, observationId, context = this.#context, timestamp = this.#now() } = {}) {
    if (typeof resourceId !== "string" || !RESOURCE_ID.test(resourceId)) throw new Error("model affinity requires a valid resource id");
    if (outcome !== "accepted" && outcome !== "rejected") throw new Error("model affinity outcome must be accepted or rejected");
    if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("model affinity requires non-negative latency and timestamp");
    }
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new Error("model affinity tokens must be non-negative");
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) throw new Error("model affinity attempts must be a positive count");
    const taskClass = capabilityClass(capabilities);
    if (this.#store) {
      this.#store.append({ id: observationId ?? `quality:${randomUUID()}`, kind: "quality", timestamp,
        data: {resourceId, capabilities, outcome, latencyMs, context, ...(tokens === undefined ? {} : {tokens}), ...(attempts === undefined ? {} : {attempts})} });
      this.#refresh(context);
      const entry = this.#state.observations[`${taskClass}\u0000${resourceId}`];
      return Object.freeze({...entry, reliability: reliability(entry), efficiency: means(entry)});
    }
    const key = `${taskClass}\u0000${resourceId}`;
    const entry = this.#state.observations[key]
      ?? { taskClass, resourceId, accepted: 0, rejected: 0, latencyTotalMs: 0, tokenTotal: 0, attemptTotal: 0, lastObservedAt: 0 };
    entry[outcome] += 1;
    entry.latencyTotalMs += latencyMs;
    entry.tokenTotal += tokens ?? 0;
    if (tokens !== undefined) entry.tokenSamples = (entry.tokenSamples ?? 0) + 1;
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
  rank({ resourceIds, capabilities, context = this.#context, selectionId, explore = false } = {}) {
    this.#refresh(context);
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
      entry.score = entry.reliability;
      entry.efficiency = efficiencyDiscount(entry.observed, floor);
    }
    // Quality bands keep cost a tie-breaker, so cheap wrong work cannot buy a higher tier.
    const ordered = [...measured, ...unmeasured.map(entry => ({...entry, score: 0.5, efficiency: 1}))]
      .sort((a,b) => (Math.floor(b.score * 20) - Math.floor(a.score * 20)) || (b.efficiency-a.efficiency) || a.index-b.index);
    if (this.#store && selectionId && explore && unmeasured.length && measured.some(entry => entry.score >= 0.5)) {
      this.#store.transaction(() => {
      const id = `decision:${selectionId}`;
      const prior = this.#store.list({kind: "decision", limit: 100000}).filter(row => row.data.context === context && row.data.taskClass === taskClass);
      const existing = prior.find(row => row.id === id);
      // One eligible, low-risk exploration per ten decisions. Preview/rank without selectionId is pure.
      const chosen = existing ? existing.data.explorationResource : (prior.length % 10 === 9
        ? unmeasured[Math.floor(prior.length / 10) % unmeasured.length].resourceId : null);
      this.#store.append({id,kind: "decision",data: {context,taskClass,explorationResource:chosen}});
      const index = ordered.findIndex(entry => entry.resourceId === chosen);
      if (index > 0) ordered.unshift(...ordered.splice(index,1));
      });
    }
    return Object.freeze(ordered.map(entry => entry.resourceId));
  }

  snapshot(context = this.#context) {
    this.#refresh(context);
    return Object.freeze(structuredClone(this.#state));
  }

  #refresh(context) {
    if (!this.#store) return;
    const state = fresh();
    // A bounded recent evidence window permits recovery from model/harness drift.
    for (const {data, timestamp} of this.#store.list({kind:"quality",limit:100000})) {
      if (data.context !== context) continue;
      if (timestamp < this.#now() - 30 * 24 * 60 * 60 * 1000) continue;
      const taskClass = capabilityClass(data.capabilities);
      const key = `${taskClass}\u0000${data.resourceId}`;
      const entry = state.observations[key] ??= {taskClass,resourceId:data.resourceId,accepted:0,rejected:0,latencyTotalMs:0,tokenTotal:0,tokenSamples:0,attemptTotal:0,lastObservedAt:0};
      entry[data.outcome]++;
      entry.latencyTotalMs += data.latencyMs;
      if (data.tokens !== undefined) {entry.tokenTotal += data.tokens; entry.tokenSamples++;}
      entry.attemptTotal += data.attempts ?? 1;
      entry.lastObservedAt = Math.max(entry.lastObservedAt,timestamp);
    }
    this.#state = state;
  }

  #persist() {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
