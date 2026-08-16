const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EVIDENCE_KIND = "acceptance_criteria";

function normalizedCapabilities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((capability) => typeof capability !== "string" || !ID.test(capability))
    || new Set(value).size !== value.length) {
    throw new Error("routing observation requires 1..32 unique capability identifiers");
  }
  return Object.freeze([...value].sort());
}

function candidateIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000
    || value.some((resourceId) => typeof resourceId !== "string" || !ID.test(resourceId))
    || new Set(value).size !== value.length) {
    throw new Error("routing candidates require 1..10000 unique resource identifiers");
  }
  return Object.freeze([...value]);
}

/**
 * Controller-rooted bridge from independently verified task outcomes to the
 * measurement-only RoutingBoard. A child/provider claim cannot update scores:
 * the receipt must validate against the controller evidence authority and must
 * match the finalized broker outcome.
 */
export class ControllerVerifiedRoutingBoard {
  #board;
  #authority;
  #affinityJournal;
  #now;

  constructor({ routingBoard, verificationAuthority, affinityJournal, now = () => Date.now() } = {}) {
    if (!routingBoard || typeof routingBoard.record !== "function" || typeof routingBoard.score !== "function" || typeof routingBoard.rank !== "function") {
      throw new Error("verified routing board requires a RoutingBoard");
    }
    if (!verificationAuthority || typeof verificationAuthority.verify !== "function") {
      throw new Error("verified routing board requires a controller verification authority");
    }
    if (affinityJournal !== undefined && typeof affinityJournal.recordVerified !== "function") {
      throw new Error("verified routing board affinityJournal must be controller-owned");
    }
    if (typeof now !== "function") throw new Error("verified routing board requires a clock function");
    this.#board = routingBoard;
    this.#authority = verificationAuthority;
    this.#affinityJournal = affinityJournal;
    this.#now = now;
  }

  /** Record the terminal outcome only after broker finalization has succeeded. */
  recordFinalized({ taskId, leaseId, fencingToken, verification, outcome, resourceId, capabilities, latencyMs, costMicros } = {}) {
    if (typeof taskId !== "string" || !ID.test(taskId) || typeof leaseId !== "string" || !ID.test(leaseId)
      || !Number.isSafeInteger(fencingToken) || fencingToken < 1
      || typeof resourceId !== "string" || !ID.test(resourceId)
      || !Number.isSafeInteger(latencyMs) || latencyMs < 0
      || (costMicros !== undefined && (!Number.isSafeInteger(costMicros) || costMicros < 0))) {
      throw new Error("verified routing observation is invalid");
    }
    const requiredCapabilities = normalizedCapabilities(capabilities);
    const binding = Object.freeze({ taskId, leaseId, fencingToken });
    if (!this.#authority.verify(verification, binding)) throw new Error("routing observation has no authentic controller verifier receipt");
    const expectedOutcome = verification.status === "accepted" ? "completed" : "failed";
    if (outcome?.status !== expectedOutcome) throw new Error("routing observation outcome does not match controller verification");
    const timestamp = this.#now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("verified routing board clock is invalid");
    const record = Object.freeze({
      resourceId,
      taskClass: "controller_verified",
      outcome: verification.status === "accepted" ? "accepted" : "rejected",
      evidenceKind: EVIDENCE_KIND,
      latencyMs,
      ...(costMicros === undefined ? {} : { costMicros }),
      timestamp,
    });
    for (const capability of requiredCapabilities) this.#board.record({ ...record, capability });
    // This is intentionally after receipt authentication and terminal-outcome matching. A child
    // cannot improve its own future routing score by reporting a convincing-looking success.
    this.#affinityJournal?.recordVerified({
      resourceId,
      capabilities: requiredCapabilities,
      outcome: record.outcome,
      latencyMs,
      ...(costMicros === undefined ? {} : { costMicros }),
      timestamp,
    });
    return Object.freeze({ resourceId, capabilities: requiredCapabilities, outcome: record.outcome, evidenceKind: EVIDENCE_KIND, timestamp });
  }

  /**
   * Produce a complete, deterministic candidate permutation. Observed routes
   * that score across every required capability go first by their weakest
   * capability score; unobserved candidates retain signed-registry order, so
   * lack of history never becomes an implicit denial or invented failover.
   */
  prioritizeCandidates({ resourceIds, capabilities, now = this.#now() } = {}) {
    const candidates = candidateIds(resourceIds);
    const requiredCapabilities = normalizedCapabilities(capabilities);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("routing priority time is invalid");
    const perCapabilityEligible = requiredCapabilities.map((capability) => new Set(
      this.#board.rank(capability, now, { resourceIds: candidates, maxResults: candidates.length }).map((entry) => entry.resourceId),
    ));
    const observed = [];
    for (const resourceId of candidates) {
      if (!perCapabilityEligible.every((eligible) => eligible.has(resourceId))) continue;
      const scores = requiredCapabilities.map((capability) => this.#board.score(resourceId, capability, now)?.score);
      if (scores.some((score) => typeof score !== "number")) continue;
      observed.push({ resourceId, score: Math.min(...scores) });
    }
    observed.sort((left, right) => (right.score - left.score) || left.resourceId.localeCompare(right.resourceId));
    const seen = new Set(observed.map((entry) => entry.resourceId));
    return Object.freeze([...observed.map((entry) => entry.resourceId), ...candidates.filter((resourceId) => !seen.has(resourceId))]);
  }

  /** Controller-only broker injection. Its output is validated as a full permutation by the broker. */
  resourceRanker() {
    return ({ contract, resourceIds, now }) => this.prioritizeCandidates({
      resourceIds,
      capabilities: contract?.capability?.required,
      now,
    });
  }
}
