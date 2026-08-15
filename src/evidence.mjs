import { createHash, randomUUID } from "node:crypto";

const EVIDENCE_KINDS = new Set(["command", "file", "url", "test", "receipt"]);
const EVIDENCE_SOURCES = new Set(["controller", "self_reported"]);

function boundedString(value, label, max = 4_096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`);
  }
  return value;
}

function artifactBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("controller evidence artifact must be bytes or a string");
}

function descriptorMatches(left, right) {
  return left?.source === "controller"
    && left.kind === right.kind
    && left.ref === right.ref
    && left.claim === right.claim
    && left.contentHash === right.contentHash;
}

/**
 * Controller-owned evidence index. Raw command/file/tool output is hashed at
 * capture and deliberately not retained here; an external artifact store may
 * retain it under its own redaction and retention policy.
 */
export class ControllerEvidenceStore {
  #entries = new Map();

  capture({ kind, claim, artifact, capturedAt = Date.now() }) {
    if (!EVIDENCE_KINDS.has(kind)) throw new Error("unsupported controller evidence kind");
    boundedString(claim, "controller evidence claim");
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error("capturedAt must be a non-negative safe integer");
    const bytes = artifactBytes(artifact);
    const entry = Object.freeze({
      kind,
      ref: `controller:${randomUUID()}`,
      claim,
      source: "controller",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      capturedAt,
      size: bytes.length,
    });
    this.#entries.set(entry.ref, entry);
    return entry;
  }

  verify(descriptor) {
    const stored = this.#entries.get(descriptor?.ref);
    return stored !== undefined && descriptorMatches(descriptor, stored);
  }

  entries() {
    return Object.freeze([...this.#entries.values()]);
  }
}

/**
 * Validate only evidence provenance and acceptance binding. Self-reported
 * evidence remains available as context but can never satisfy acceptance.
 */
export function validateResultEvidence(result, { acceptance = [], evidenceStore } = {}) {
  if (!evidenceStore || typeof evidenceStore.verify !== "function") throw new Error("validation requires a controller evidence store");
  if (!Array.isArray(acceptance) || acceptance.some((check) => typeof check !== "string" || !check)) {
    throw new Error("acceptance must be an array of non-empty strings");
  }
  if (!result || !Array.isArray(result.evidence) || !Array.isArray(result.validationPerformed)) {
    return Object.freeze({ status: "rejected", reasons: Object.freeze(["result evidence shape is invalid"]), satisfied: Object.freeze([]) });
  }

  const evidenceByRef = new Map();
  const reasons = [];
  for (const evidence of result.evidence) {
    if (!evidence || !EVIDENCE_KINDS.has(evidence.kind) || !EVIDENCE_SOURCES.has(evidence.source)
      || typeof evidence.ref !== "string" || typeof evidence.claim !== "string") {
      reasons.push("result contains malformed evidence");
      continue;
    }
    if (evidence.source === "controller" && !evidenceStore.verify(evidence)) {
      reasons.push(`controller evidence ref is not authentic: ${evidence.ref}`);
      continue;
    }
    evidenceByRef.set(evidence.ref, evidence);
  }

  const satisfied = [];
  for (const check of acceptance) {
    const validation = result.validationPerformed.find((item) => item?.check === check && item?.outcome === "pass");
    const evidence = validation ? evidenceByRef.get(validation.evidenceRef) : undefined;
    if (!validation || !evidence || evidence.source !== "controller" || evidence.claim !== check) {
      reasons.push(`acceptance lacks controller evidence: ${check}`);
      continue;
    }
    satisfied.push(check);
  }

  return Object.freeze({
    status: reasons.length === 0 ? "accepted" : "rejected",
    reasons: Object.freeze(reasons),
    satisfied: Object.freeze(satisfied),
  });
}
