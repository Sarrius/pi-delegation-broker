import { randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EVIDENCE_REF = /^controller:[0-9a-f-]{36}$/;
const RECEIPT_SCHEMA = "controller-verification-receipt/v1";

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function normalizeBinding(value) {
  exactKeys(value, ["taskId", "leaseId", "fencingToken"], "verification binding");
  if (typeof value.taskId !== "string" || !ID.test(value.taskId)
    || typeof value.leaseId !== "string" || !ID.test(value.leaseId)
    || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    throw new Error("verification binding is invalid");
  }
  return Object.freeze({ taskId: value.taskId, leaseId: value.leaseId, fencingToken: value.fencingToken });
}

function normalizeReceipt(value) {
  exactKeys(value, ["status", "verifierRunId", "evidenceRefs", "receiptRef"], "verification receipt");
  if (value.status !== "accepted" && value.status !== "rejected") throw new Error("verification receipt status must be accepted or rejected");
  if (typeof value.verifierRunId !== "string" || !ID.test(value.verifierRunId)) throw new Error("verification receipt verifierRunId is invalid");
  if (typeof value.receiptRef !== "string" || !EVIDENCE_REF.test(value.receiptRef)) throw new Error("verification receipt receiptRef is invalid");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 20
    || value.evidenceRefs.some((ref) => typeof ref !== "string" || !EVIDENCE_REF.test(ref))
    || new Set(value.evidenceRefs).size !== value.evidenceRefs.length
    || (value.status === "accepted" && value.evidenceRefs.length < 1)) {
    throw new Error("verification receipt evidenceRefs are invalid");
  }
  return Object.freeze({
    status: value.status,
    verifierRunId: value.verifierRunId,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    receiptRef: value.receiptRef,
  });
}

function normalizeVerificationRun(verification) {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)
    || (verification.status !== "accepted" && verification.status !== "rejected")
    || typeof verification.runId !== "string" || !ID.test(verification.runId)
    || !Array.isArray(verification.result?.evidence)
    || !Array.isArray(verification.checks)
    || !verification.validation || verification.validation.status !== verification.status) {
    throw new Error("controller verification run is malformed");
  }
  if (verification.status === "accepted" && (verification.checks.length < 1
    || verification.checks.some((check) => check?.status !== "passed"))) {
    throw new Error("accepted controller verification run has incomplete checks");
  }
  const evidence = verification.result.evidence;
  if (evidence.some((descriptor) => descriptor?.source !== "controller" || typeof descriptor.ref !== "string" || !EVIDENCE_REF.test(descriptor.ref))) {
    throw new Error("controller verification run has an invalid evidence descriptor");
  }
  const evidenceRefs = evidence.map((descriptor) => descriptor.ref);
  if (new Set(evidenceRefs).size !== evidenceRefs.length || (verification.status === "accepted" && evidenceRefs.length < 1)) {
    throw new Error("controller verification run has invalid evidence references");
  }
  return Object.freeze({
    status: verification.status,
    verifierRunId: verification.runId,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

/**
 * Controller-rooted verifier boundary. It turns a locally executed fixed-plan
 * verifier run into a retained receipt and later verifies that exact receipt.
 * The verifier root stays process-local; children have neither this object nor
 * the evidence-store root, so a child report cannot mint a terminal verdict.
 */
export class ControllerVerificationAuthority {
  #evidenceStore;

  constructor({ evidenceStore } = {}) {
    if (!evidenceStore || typeof evidenceStore.capture !== "function" || typeof evidenceStore.verify !== "function"
      || typeof evidenceStore.artifact !== "function" || typeof evidenceStore.entries !== "function") {
      throw new Error("ControllerVerificationAuthority requires a controller evidence store");
    }
    this.#evidenceStore = evidenceStore;
  }

  /** Retain one immutable controller verifier receipt and return its public reference. */
  attest(verification, binding) {
    const run = normalizeVerificationRun(verification);
    const taskBinding = normalizeBinding(binding);
    const descriptors = this.#descriptors(run.evidenceRefs);
    if (descriptors.some((descriptor) => !this.#evidenceStore.verify(descriptor)
      || !["command", "test"].includes(descriptor.kind))) {
      throw new Error("controller verification evidence is missing, corrupt, or unsupported");
    }
    const artifact = Object.freeze({
      schema: RECEIPT_SCHEMA,
      status: run.status,
      verifierRunId: run.verifierRunId,
      evidenceRefs: run.evidenceRefs,
      binding: taskBinding,
    });
    const retained = this.#evidenceStore.capture({
      kind: "receipt",
      claim: `controller verification ${run.verifierRunId}`,
      artifact: JSON.stringify(artifact),
    });
    return Object.freeze({ ...run, receiptRef: retained.ref });
  }

  /** Verify a receipt without trusting caller-provided evidence descriptors. */
  verify(receipt, binding) {
    let normalized;
    let taskBinding;
    try {
      normalized = normalizeReceipt(receipt);
      taskBinding = normalizeBinding(binding);
    } catch { return false; }
    const descriptor = this.#descriptor(normalized.receiptRef);
    if (!descriptor || descriptor.kind !== "receipt" || descriptor.source !== "controller" || !this.#evidenceStore.verify(descriptor)) return false;
    let artifact;
    try { artifact = JSON.parse(this.#evidenceStore.artifact(descriptor).toString("utf8")); } catch { return false; }
    if (!artifact || artifact.schema !== RECEIPT_SCHEMA || artifact.status !== normalized.status
      || artifact.verifierRunId !== normalized.verifierRunId
      || !Array.isArray(artifact.evidenceRefs)
      || artifact.evidenceRefs.length !== normalized.evidenceRefs.length
      || artifact.evidenceRefs.some((ref, index) => ref !== normalized.evidenceRefs[index])
      || artifact.binding?.taskId !== taskBinding.taskId
      || artifact.binding?.leaseId !== taskBinding.leaseId
      || artifact.binding?.fencingToken !== taskBinding.fencingToken) return false;
    const descriptors = this.#descriptors(normalized.evidenceRefs);
    return descriptors.length === normalized.evidenceRefs.length
      && descriptors.every((item) => this.#evidenceStore.verify(item) && ["command", "test"].includes(item.kind));
  }

  #descriptor(ref) {
    return this.#evidenceStore.entries().find((entry) => entry.ref === ref);
  }

  #descriptors(refs) {
    const byRef = new Map(this.#evidenceStore.entries().map((entry) => [entry.ref, entry]));
    return refs.map((ref) => byRef.get(ref));
  }
}

/**
 * Controller-only lifecycle coordinator. It receives task/lease identity, but
 * never a child status, result, command, expected output, or evidence object.
 */
export class ControllerQueuedTaskVerifier {
  #authority;
  #createVerifier;
  #finalize;
  #onFinalized;
  #running = new Set();

  constructor({ authority, createVerifier, finalize, onFinalized } = {}) {
    if (!authority || typeof authority.attest !== "function" || typeof authority.verify !== "function") {
      throw new Error("ControllerQueuedTaskVerifier requires a verification authority");
    }
    if (typeof createVerifier !== "function" || typeof finalize !== "function") {
      throw new Error("ControllerQueuedTaskVerifier requires trusted verifier and finalizer functions");
    }
    if (onFinalized !== undefined && typeof onFinalized !== "function") {
      throw new Error("ControllerQueuedTaskVerifier onFinalized must be a controller-owned function");
    }
    this.#authority = authority;
    this.#createVerifier = createVerifier;
    this.#finalize = finalize;
    this.#onFinalized = onFinalized;
  }

  async verifyAndFinalize({ taskId, leaseId, fencingToken, routingObservation } = {}) {
    if (typeof taskId !== "string" || !ID.test(taskId) || typeof leaseId !== "string" || !ID.test(leaseId)
      || !Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new Error("controller queued verifier task identity is invalid");
    }
    if (this.#running.has(leaseId)) throw new Error("controller_queued_verifier_busy");
    this.#running.add(leaseId);
    try {
      const verifier = await this.#createVerifier(Object.freeze({ taskId, leaseId, fencingToken }));
      if (!verifier || typeof verifier.verify !== "function") throw new Error("controller verifier factory returned invalid verifier");
      const verification = await verifier.verify();
      const binding = Object.freeze({ taskId, leaseId, fencingToken });
      const receipt = this.#authority.attest(verification, binding);
      const outcome = await this.#finalize(Object.freeze({ ...binding, verification: receipt }));
      let routing;
      if (this.#onFinalized) {
        try {
          routing = await this.#onFinalized(Object.freeze({ ...binding, verification: receipt, outcome, routingObservation }));
        } catch {
          // Routing is measurement, never task acceptance authority. A failed
          // measurement write must not roll back or relabel a durable verdict.
          routing = Object.freeze({ status: "not_recorded" });
        }
      }
      return Object.freeze({ verification: receipt, outcome, ...(routing === undefined ? {} : { routing }) });
    } finally {
      this.#running.delete(leaseId);
    }
  }
}

/** Generate an opaque run id only for controller-owned custom verifier implementations. */
export function createControllerVerifierRunId() {
  return randomUUID();
}
