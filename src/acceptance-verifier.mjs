import { randomUUID } from "node:crypto";
import { validateResultEvidence } from "./evidence.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const KINDS = new Set(["command", "test"]);

function bounded(value, label, max = 500) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function normalizeCheck(check) {
  exactKeys(check, ["id", "claim", "kind", "timeoutMs"], "Verifier check");
  if (typeof check.id !== "string" || !ID.test(check.id)) throw new Error("Verifier check id is invalid");
  const claim = bounded(check.claim, "Verifier check claim");
  if (!KINDS.has(check.kind)) throw new Error("Verifier check kind must be command or test");
  if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 120_000) {
    throw new Error("Verifier check timeoutMs must be an integer between 100 and 120000");
  }
  return Object.freeze({ id: check.id, claim, kind: check.kind, timeoutMs: check.timeoutMs });
}

function freezeResult(value) {
  return Object.freeze({
    ...value,
    ...(value.evidence ? { evidence: Object.freeze(value.evidence) } : {}),
    ...(value.validationPerformed ? { validationPerformed: Object.freeze(value.validationPerformed) } : {}),
    ...(value.checks ? { checks: Object.freeze(value.checks) } : {}),
  });
}

function safeError(error) {
  const text = error instanceof Error ? error.message : "controller verifier failed";
  return text.length <= 300 && !/[\0\r\n]/.test(text) ? text : "controller verifier failed";
}

function passed(kind, observation) {
  if (kind === "command") return observation?.exitCode === 0;
  return observation?.outcome === "pass";
}

/**
 * Execute a controller-owned, fixed acceptance plan. No method accepts a
 * child-provided command, check ID, expected output, or evidence descriptor:
 * the caller supplies a trusted runCheck closure that maps the fixed IDs to
 * read-only verifier work in its own isolated environment.
 */
/**
 * Retain a fixed-plan verifier outcome through a controller authority before
 * passing it to broker.finalizeVerifiedTask. This intentionally cannot turn a
 * merely shape-valid child report into a terminal receipt.
 */
export function controllerVerificationReceipt(verification, authority, binding) {
  if (!authority || typeof authority.attest !== "function") {
    throw new Error("controller verification receipt requires a controller verification authority");
  }
  return authority.attest(verification, binding);
}

export class ControllerAcceptanceVerifier {
  #evidenceStore;
  #checks;
  #runCheck;
  #running = false;

  constructor({ evidenceStore, checks, runCheck } = {}) {
    if (!evidenceStore || typeof evidenceStore.captureObservation !== "function" || typeof evidenceStore.verify !== "function") {
      throw new Error("ControllerAcceptanceVerifier requires a controller evidence store");
    }
    if (!Array.isArray(checks) || checks.length < 1 || checks.length > 20) {
      throw new Error("ControllerAcceptanceVerifier requires 1..20 fixed checks");
    }
    const normalized = checks.map(normalizeCheck);
    if (new Set(normalized.map((check) => check.id)).size !== normalized.length
      || new Set(normalized.map((check) => check.claim)).size !== normalized.length) {
      throw new Error("ControllerAcceptanceVerifier check ids and claims must be unique");
    }
    if (typeof runCheck !== "function") throw new Error("ControllerAcceptanceVerifier requires a controller runCheck function");
    this.#evidenceStore = evidenceStore;
    this.#checks = Object.freeze(normalized);
    this.#runCheck = runCheck;
  }

  get checks() { return this.#checks; }

  /** Run every fixed check serially. A timeout or malformed result is rejection, never a skipped check. */
  async verify() {
    if (this.#running) throw new Error("controller_acceptance_verifier_busy");
    this.#running = true;
    const runId = randomUUID();
    try {
      const evidence = [];
      const validationPerformed = [];
      const checkResults = [];
      for (const check of this.#checks) {
        const outcome = await this.#verifyOne(check);
        checkResults.push(outcome.publicResult);
        if (outcome.evidence) evidence.push(outcome.evidence);
        validationPerformed.push({
          check: check.claim,
          outcome: outcome.passed ? "pass" : "fail",
          ...(outcome.evidence ? { evidenceRef: outcome.evidence.ref } : {}),
        });
      }
      const result = freezeResult({ evidence, validationPerformed });
      const validation = validateResultEvidence(result, {
        acceptance: this.#checks.map((check) => check.claim),
        evidenceStore: this.#evidenceStore,
      });
      return freezeResult({
        runId,
        status: validation.status,
        validation,
        result,
        checks: checkResults,
      });
    } finally {
      this.#running = false;
    }
  }

  async #verifyOne(check) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const runner = Promise.resolve(this.#runCheck(Object.freeze({ id: check.id, kind: check.kind, claim: check.claim }), {
        signal: controller.signal,
      }));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({ timeout: true });
        }, check.timeoutMs);
        timer.unref?.();
      });
      const observation = await Promise.race([runner, timeout]);
      if (timedOut || observation?.timeout === true) {
        return Object.freeze({
          passed: false,
          publicResult: Object.freeze({ id: check.id, claim: check.claim, status: "timed_out" }),
        });
      }
      const descriptor = this.#evidenceStore.captureObservation({ kind: check.kind, claim: check.claim, observation });
      const isPassed = passed(check.kind, observation);
      return Object.freeze({
        passed: isPassed,
        evidence: descriptor,
        publicResult: Object.freeze({ id: check.id, claim: check.claim, status: isPassed ? "passed" : "failed", evidenceRef: descriptor.ref }),
      });
    } catch (error) {
      return Object.freeze({
        passed: false,
        publicResult: Object.freeze({ id: check.id, claim: check.claim, status: "controller_error", reason: safeError(error) }),
      });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}
