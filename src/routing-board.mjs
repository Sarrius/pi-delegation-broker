import { createHash } from "node:crypto";

/**
 * Dynamic routing board: continuously updated, machine-verifiable outcome
 * tracking per (resource, capability) pair. The board derives routing
 * decisions from Wilson score confidence intervals on accepted rates,
 * with exploration bonuses for under-observed resources and drift detection
 * via rolling-window divergence.
 *
 * The board is the measurement layer in the three-layer architecture:
 *   Pi modelRegistry (discovery) → signed registry (policy) → routing board (measurement)
 *
 * Only machine-verifiable outcomes feed the board. Model-graded quality
 * scores must not influence routing.
 */

const EVIDENCE_KINDS = Object.freeze(new Set([
  "test_pass", "schema_valid", "compile_clean", "type_check", "acceptance_criteria",
]));

const OUTCOMES = Object.freeze(new Set(["accepted", "rejected", "error"]));

function wilsonLowerBound(successes, total, z = 1.96) {
  if (total === 0) return 0;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

function wilsonUpperBound(successes, total, z = 1.96) {
  if (total === 0) return 1;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.min(1, (center + margin) / denominator);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function boardKey(resourceId, capability) {
  return `${resourceId}::${capability}`;
}

/**
 * Durable, continuously updated routing board. Tracks machine-verifiable
 * outcomes per (resource, capability) pair and derives routing scores.
 */
export class RoutingBoard {
  #observations = new Map(); // boardKey → { accepted, rejected, error, latencies, costs, rolling: [], allTime: {n, accepted} }
  #config;

  constructor({
    minObservations = 10,
    explorationBonus = 0.3,
    maxExplorationFraction = 0.1,
    maxConsecutiveFailures = 3,
    rollingWindowSize = 100,
    driftThresholdSigma = 2,
    recencyDecayHalfLifeMs = 24 * 60 * 60 * 1_000,
    maxBoardEntries = 10_000,
  } = {}) {
    if (!Number.isSafeInteger(minObservations) || minObservations < 1 || minObservations > 10_000) {
      throw new Error("minObservations must be an integer between 1 and 10000");
    }
    if (typeof explorationBonus !== "number" || explorationBonus < 0 || explorationBonus > 1) {
      throw new Error("explorationBonus must be a number between 0 and 1");
    }
    if (typeof maxExplorationFraction !== "number" || maxExplorationFraction < 0 || maxExplorationFraction > 1) {
      throw new Error("maxExplorationFraction must be a number between 0 and 1");
    }
    if (!Number.isSafeInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1 || maxConsecutiveFailures > 100) {
      throw new Error("maxConsecutiveFailures must be an integer between 1 and 100");
    }
    if (!Number.isSafeInteger(rollingWindowSize) || rollingWindowSize < 10 || rollingWindowSize > 100_000) {
      throw new Error("rollingWindowSize must be an integer between 10 and 100000");
    }
    if (typeof driftThresholdSigma !== "number" || driftThresholdSigma < 0.5 || driftThresholdSigma > 10) {
      throw new Error("driftThresholdSigma must be a number between 0.5 and 10");
    }
    if (!Number.isSafeInteger(recencyDecayHalfLifeMs) || recencyDecayHalfLifeMs < 60_000) {
      throw new Error("recencyDecayHalfLifeMs must be at least 60000");
    }
    if (!Number.isSafeInteger(maxBoardEntries) || maxBoardEntries < 1 || maxBoardEntries > 1_000_000) {
      throw new Error("maxBoardEntries must be an integer between 1 and 1000000");
    }
    this.#config = Object.freeze({
      minObservations, explorationBonus, maxExplorationFraction,
      maxConsecutiveFailures, rollingWindowSize, driftThresholdSigma,
      recencyDecayHalfLifeMs, maxBoardEntries,
    });
  }

  get config() { return this.#config; }

  /**
   * Record one machine-verifiable outcome. Only outcomes with a valid
   * evidenceKind are counted toward routing. All timestamps must be
   * non-decreasing (monotonic clock).
   */
  record({ resourceId, capability, taskClass, outcome, evidenceKind, latencyMs, costMicros, timestamp }) {
    if (typeof resourceId !== "string" || !resourceId) throw new Error("board record requires resourceId");
    if (typeof capability !== "string" || !capability) throw new Error("board record requires capability");
    if (!OUTCOMES.has(outcome)) throw new Error(`board record outcome must be one of: ${[...OUTCOMES].join(", ")}`);
    if (!EVIDENCE_KINDS.has(evidenceKind)) throw new Error(`board record evidenceKind must be machine-verifiable: ${[...EVIDENCE_KINDS].join(", ")}`);
    if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) throw new Error("board record latencyMs must be a non-negative integer");
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("board record timestamp must be a non-negative integer");
    if (costMicros !== undefined && (!Number.isSafeInteger(costMicros) || costMicros < 0)) {
      throw new Error("board record costMicros must be a non-negative integer or undefined");
    }

    const key = boardKey(resourceId, capability);
    let entry = this.#observations.get(key);
    if (!entry) {
      if (this.#observations.size >= this.#config.maxBoardEntries) {
        throw new Error("routing board entry limit exceeded");
      }
      entry = {
        resourceId,
        capability,
        allTime: { n: 0, accepted: 0, rejected: 0, error: 0 },
        rolling: [],
        latencies: [],
        costs: [],
        consecutiveFailures: 0,
        lastObservedAt: 0,
      };
      this.#observations.set(key, entry);
    }

    entry.allTime.n += 1;
    if (outcome === "accepted") {
      entry.allTime.accepted += 1;
      entry.consecutiveFailures = 0;
    } else if (outcome === "rejected") {
      entry.allTime.rejected += 1;
      entry.consecutiveFailures += 1;
    } else {
      entry.allTime.error += 1;
      entry.consecutiveFailures += 1;
    }
    entry.latencies.push(latencyMs);
    if (costMicros !== undefined) entry.costs.push(costMicros);
    entry.rolling.push({ outcome, timestamp });
    if (entry.rolling.length > this.#config.rollingWindowSize) {
      entry.rolling.shift();
    }
    entry.lastObservedAt = Math.max(entry.lastObservedAt, timestamp);
  }

  /**
   * Compute the routing score for one (resource, capability) pair.
   * Returns null if the pair has no observations.
   *
   * Score = Wilson lower bound on accepted rate, with exploration bonus
   * for under-observed pairs and drift penalty for diverging pairs.
   */
  score(resourceId, capability, now) {
    const key = boardKey(resourceId, capability);
    const entry = this.#observations.get(key);
    if (!entry || entry.allTime.n === 0) return null;

    const { allTime } = entry;
    const lb = wilsonLowerBound(allTime.accepted, allTime.n);
    const ub = wilsonUpperBound(allTime.accepted, allTime.n);

    // Exploration bonus for under-observed pairs
    let explorationBonus = 0;
    if (allTime.n < this.#config.minObservations) {
      explorationBonus = this.#config.explorationBonus;
    }

    // Drift detection: rolling window vs all-time
    let driftPenalty = 0;
    let drifting = false;
    if (entry.rolling.length >= 10 && allTime.n >= 20) {
      const rollingAccepted = entry.rolling.filter((r) => r.outcome === "accepted").length;
      const rollingRate = rollingAccepted / entry.rolling.length;
      const allTimeRate = allTime.accepted / allTime.n;
      const se = Math.sqrt((allTimeRate * (1 - allTimeRate)) / entry.rolling.length);
      if (se > 0 && Math.abs(rollingRate - allTimeRate) / se > this.#config.driftThresholdSigma) {
        drifting = true;
        driftPenalty = clamp(Math.abs(rollingRate - allTimeRate), 0, 0.5);
      }
    }

    // Recency decay: stale observations lose weight
    let recencyFactor = 1;
    if (now !== undefined && entry.lastObservedAt > 0) {
      const age = now - entry.lastObservedAt;
      if (age > 0) {
        recencyFactor = Math.pow(0.5, age / this.#config.recencyDecayHalfLifeMs);
      }
    }

    // Consecutive failure penalty
    const failurePenalty = entry.consecutiveFailures >= this.#config.maxConsecutiveFailures ? 0.5 : 0;

    const score = clamp(
      (lb + explorationBonus - driftPenalty - failurePenalty) * recencyFactor,
      0, 1,
    );

    return Object.freeze({
      score,
      lowerBound: lb,
      upperBound: ub,
      n: allTime.n,
      accepted: allTime.accepted,
      rejected: allTime.rejected,
      error: allTime.error,
      acceptedRate: allTime.n > 0 ? allTime.accepted / allTime.n : 0,
      exploration: allTime.n < this.#config.minObservations,
      drifting,
      consecutiveFailures: entry.consecutiveFailures,
      recencyFactor,
      p50LatencyMs: percentile(entry.latencies, 0.5),
      p95LatencyMs: percentile(entry.latencies, 0.95),
      avgCostMicros: entry.costs.length > 0
        ? Math.round(entry.costs.reduce((a, b) => a + b, 0) / entry.costs.length)
        : null,
      lastObservedAt: entry.lastObservedAt,
    });
  }

  /**
   * Rank candidate resources for a given capability. Returns an array of
   * { resourceId, score, ... } sorted by score descending.
   *
   * Filters:
   * - Only resources with at least one observation are ranked
   * - Exploration resources get a fixed bonus
   * - Drifting resources are penalized but not excluded
   * - Resources exceeding maxConsecutiveFailures are excluded
   */
  rank(capability, now, { resourceIds, maxResults = 10 } = {}) {
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) return [];
    const results = [];
    for (const resourceId of resourceIds) {
      const s = this.score(resourceId, capability, now);
      if (!s) continue;
      if (s.consecutiveFailures >= this.#config.maxConsecutiveFailures) continue;
      results.push({ resourceId, ...s });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Snapshot of the entire board for audit/debugging. Read-only.
   */
  snapshot(now) {
    const entries = {};
    for (const [key, entry] of this.#observations) {
      const [resourceId, capability] = key.split("::");
      entries[key] = this.score(resourceId, capability, now);
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      totalEntries: this.#observations.size,
      config: this.#config,
    });
  }

  /**
   * Export board state for persistence. Returns a JSON-serializable object.
   */
  export() {
    const data = {};
    for (const [key, entry] of this.#observations) {
      data[key] = {
        resourceId: entry.resourceId,
        capability: entry.capability,
        allTime: { ...entry.allTime },
        rolling: [...entry.rolling],
        latencies: [...entry.latencies],
        costs: [...entry.costs],
        consecutiveFailures: entry.consecutiveFailures,
        lastObservedAt: entry.lastObservedAt,
      };
    }
    return Object.freeze({
      version: 1,
      exportedAt: Date.now(),
      config: this.#config,
      data: Object.freeze(data),
    });
  }

  /**
   * Import board state from a previously exported object. Merges with
   * existing data (does not replace).
   */
  import(exported) {
    if (!exported || exported.version !== 1 || !exported.data) {
      throw new Error("routing board import requires a version-1 export");
    }
    for (const [key, entry] of Object.entries(exported.data)) {
      if (this.#observations.size >= this.#config.maxBoardEntries) break;
      if (!this.#observations.has(key)) {
        this.#observations.set(key, {
          resourceId: entry.resourceId,
          capability: entry.capability,
          allTime: { ...entry.allTime },
          rolling: [...entry.rolling],
          latencies: [...entry.latencies],
          costs: [...entry.costs],
          consecutiveFailures: entry.consecutiveFailures ?? 0,
          lastObservedAt: entry.lastObservedAt ?? 0,
        });
      }
    }
    return { status: "imported", entries: this.#observations.size };
  }

  /** Number of tracked (resource, capability) pairs. */
  get size() { return this.#observations.size; }

  /** Clear all observations. */
  clear() { this.#observations.clear(); }
}

function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1));
  return arr[idx];
}