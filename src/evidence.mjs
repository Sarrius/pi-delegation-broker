import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const EVIDENCE_KINDS = new Set(["command", "file", "url", "test", "receipt"]);
const EVIDENCE_SOURCES = new Set(["controller", "self_reported"]);
const HASH = /^[a-f0-9]{64}$/;
const REF = /^controller:([0-9a-f-]{36})$/;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /CANARY_SECRET_[A-Za-z0-9_-]+/g,
];

function boundedString(value, label, max = 4_096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`);
  }
  return value;
}

function redactText(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function artifactBytes(value, artifactIsRedacted) {
  if (typeof value === "string") return Buffer.from(redactText(value), "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (!artifactIsRedacted) throw new Error("binary controller evidence requires artifactIsRedacted: true");
    return Buffer.from(value);
  }
  throw new Error("controller evidence artifact must be bytes or a string");
}

function normalizeOutput(value, policy = {}) {
  if (typeof value !== "string") throw new Error("semantic command/url output must be a string");
  let text = redactText(value)
    .replaceAll("\r\n", "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split("\n").map((line) => line.trimEnd()).join("\n").trim();
  if (policy.stripTimestamps === true) text = text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
  if (policy.stripPids === true) text = text.replace(/\b(pid|process)\s*[:=#]?\s*\d+\b/gi, "$1=<pid>");
  for (const root of policy.rootPaths ?? []) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("semantic normalization rootPaths must be absolute paths");
    text = text.replaceAll(root, "<root>");
  }
  if (policy.unorderedLines === true) text = text.split("\n").sort().join("\n");
  return text;
}

function normalizationConflicts(criterion, normalization) {
  if (typeof criterion !== "string" || !normalization) return [];
  const conflicts = [];
  if (normalization.stripTimestamps === true && /(?:\b(?:timestamp|date|datetime|time)\b|час|дат(?:а|и|у|ою)?)/iu.test(criterion)) conflicts.push("timestamp");
  if (normalization.stripPids === true && /(?:\b(?:pid|process[ _-]?id)\b|ідентифікатор\s+процесу)/iu.test(criterion)) conflicts.push("pid");
  if (normalization.unorderedLines === true && /(?:\b(?:order|ordered|ordering|sequence)\b|порядок|послідовність)/iu.test(criterion)) conflicts.push("line order");
  if ((normalization.rootPaths?.length ?? 0) > 0 && /(?:\b(?:path|directory|root)\b|шлях|каталог)/iu.test(criterion)) conflicts.push("path");
  return conflicts;
}

function semanticProjection(kind, observation, baselinePolicy) {
  if (!observation || typeof observation !== "object") throw new Error("semantic evidence observation must be an object");
  if (kind === "command") {
    if (!Number.isSafeInteger(observation.exitCode)) throw new Error("semantic command evidence requires integer exitCode");
    const normalization = baselinePolicy ?? Object.freeze({
      stripTimestamps: observation.normalization?.stripTimestamps === true,
      stripPids: observation.normalization?.stripPids === true,
      unorderedLines: observation.normalization?.unorderedLines === true,
      rootPaths: Object.freeze([...(observation.normalization?.rootPaths ?? [])]),
    });
    return {
      schema: "command/v1",
      exitCode: observation.exitCode,
      stdout: normalizeOutput(observation.stdout ?? "", normalization),
      stderr: normalizeOutput(observation.stderr ?? "", normalization),
      normalization,
    };
  }
  if (kind === "file") {
    if (typeof observation.content !== "string" || !Number.isSafeInteger(observation.lineStart) || observation.lineStart < 1
      || !Number.isSafeInteger(observation.lineEnd) || observation.lineEnd < observation.lineStart
      || typeof observation.revision !== "string" || !observation.revision) {
      throw new Error("semantic file evidence requires content, revision, and a valid line range");
    }
    return {
      schema: "file/v1",
      revision: observation.revision,
      lineStart: observation.lineStart,
      lineEnd: observation.lineEnd,
      contentHash: createHash("sha256").update(redactText(observation.content)).digest("hex"),
    };
  }
  if (kind === "test") {
    if (!new Set(["pass", "fail", "skip"]).has(observation.outcome)
      || !["passed", "failed", "skipped"].every((key) => Number.isSafeInteger(observation[key] ?? 0) && (observation[key] ?? 0) >= 0)) {
      throw new Error("semantic test evidence requires outcome and non-negative counts");
    }
    return {
      schema: "test/v1",
      suite: boundedString(observation.suite, "semantic test suite"),
      outcome: observation.outcome,
      passed: observation.passed ?? 0,
      failed: observation.failed ?? 0,
      skipped: observation.skipped ?? 0,
    };
  }
  if (kind === "url") {
    if (!Number.isSafeInteger(observation.status) || observation.status < 100 || observation.status > 599
      || !Number.isSafeInteger(observation.retrievedAt) || observation.retrievedAt < 0) {
      throw new Error("semantic URL evidence requires HTTP status and retrievedAt");
    }
    const normalization = baselinePolicy ?? Object.freeze({
      stripTimestamps: observation.normalization?.stripTimestamps === true,
      stripPids: false,
      unorderedLines: observation.normalization?.unorderedLines === true,
      rootPaths: Object.freeze([]),
    });
    return {
      schema: "url/v1",
      status: observation.status,
      retrievedAt: observation.retrievedAt,
      body: normalizeOutput(observation.body ?? "", normalization),
      normalization,
    };
  }
  throw new Error(`semantic comparison is not defined for evidence kind ${kind}`);
}

function semanticComparable(projection) {
  if (projection.schema !== "url/v1") return projection;
  const { retrievedAt: _retrievedAt, ...comparable } = projection;
  return comparable;
}

function descriptorMatches(left, right) {
  return left?.source === "controller"
    && left.kind === right.kind
    && left.ref === right.ref
    && left.claim === right.claim
    && left.contentHash === right.contentHash
    && left.capturedAt === right.capturedAt
    && left.size === right.size
    && left.retentionUntil === right.retentionUntil
    && left.semanticSchema === right.semanticSchema;
}

function writeDurableExclusive(path, bytes) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requireOwnerOnlyDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("controller evidence root must be an absolute path");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error("controller evidence root must not be a symbolic link");
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("controller evidence root must be owner-only");
  return canonical;
}

function validateStoredEntry(entry) {
  const match = typeof entry?.ref === "string" ? REF.exec(entry.ref) : undefined;
  if (!match || !EVIDENCE_KINDS.has(entry.kind) || entry.source !== "controller"
    || typeof entry.claim !== "string" || !HASH.test(entry.contentHash)
    || !Number.isSafeInteger(entry.capturedAt) || entry.capturedAt < 0
    || !Number.isSafeInteger(entry.retentionUntil) || entry.retentionUntil <= entry.capturedAt
    || !Number.isSafeInteger(entry.size) || entry.size < 0
    || (entry.semanticSchema !== undefined && !new Set(["command/v1", "file/v1", "test/v1", "url/v1"]).has(entry.semanticSchema))) {
    throw new Error("controller evidence metadata is malformed");
  }
  return match[1];
}

/**
 * Controller-owned content-addressed evidence store. Text is redacted before
 * hashing and retention; binary input must be explicitly declared pre-redacted.
 * Metadata and content survive controller restart and are pruned only by the
 * explicit retention transition.
 */
export class ControllerEvidenceStore {
  #root;
  #objects;
  #metadata;
  #retentionMs;
  #maxArtifactBytes;
  #entries = new Map();

  constructor({ root, retentionMs = 7 * 24 * 60 * 60 * 1_000, maxArtifactBytes = 10 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new Error("controller evidence retentionMs must be between 1ms and 365 days");
    }
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > 100 * 1024 * 1024) {
      throw new Error("controller evidence maxArtifactBytes must be between 1 and 104857600 bytes");
    }
    this.#root = requireOwnerOnlyDirectory(root);
    this.#objects = requireOwnerOnlyDirectory(join(this.#root, "objects"));
    this.#metadata = requireOwnerOnlyDirectory(join(this.#root, "entries"));
    this.#retentionMs = retentionMs;
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#load();
  }

  capture(input) {
    return this.#capture(input);
  }

  captureObservation({ kind, claim, observation, capturedAt = Date.now() }) {
    const projection = semanticProjection(kind, observation);
    return this.#capture({
      kind,
      claim,
      artifact: JSON.stringify(projection),
      capturedAt,
      semanticSchema: projection.schema,
    });
  }

  compareSemantic(descriptor, observation, { criterion = descriptor?.claim } = {}) {
    if (!this.verify(descriptor)) return Object.freeze({ status: "invalid_evidence", differences: Object.freeze(["retained evidence is missing or corrupt"]) });
    if (typeof descriptor.semanticSchema !== "string") return Object.freeze({ status: "unsupported", differences: Object.freeze(["evidence has no semantic schema"]) });
    const retained = JSON.parse(this.artifact(descriptor).toString("utf8"));
    if (retained.schema !== descriptor.semanticSchema) return Object.freeze({ status: "invalid_evidence", differences: Object.freeze(["semantic schema does not match retained content"]) });
    const policyConflicts = normalizationConflicts(criterion, retained.normalization);
    if (policyConflicts.length > 0) {
      return Object.freeze({
        status: "policy_conflict",
        differences: Object.freeze(policyConflicts.map((field) => `acceptance criterion names normalized field: ${field}`)),
      });
    }
    const candidate = semanticProjection(descriptor.kind, observation, retained.normalization);
    const expectedComparable = semanticComparable(retained);
    const candidateComparable = semanticComparable(candidate);
    const match = JSON.stringify(expectedComparable) === JSON.stringify(candidateComparable);
    return Object.freeze({
      status: match ? "match" : "mismatch",
      differences: Object.freeze(match ? [] : ["semantic projection differs"]),
      ...(descriptor.kind === "url" ? { baselineRetrievedAt: retained.retrievedAt, candidateRetrievedAt: candidate.retrievedAt } : {}),
    });
  }

  #capture({ kind, claim, artifact, artifactIsRedacted = false, capturedAt = Date.now(), semanticSchema }) {
    if (!EVIDENCE_KINDS.has(kind)) throw new Error("unsupported controller evidence kind");
    boundedString(claim, "controller evidence claim");
    const safeClaim = redactText(claim);
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error("capturedAt must be a non-negative safe integer");
    if (!Number.isSafeInteger(capturedAt + this.#retentionMs)) throw new Error("controller evidence retention timestamp exceeds safe-integer range");
    const bytes = artifactBytes(artifact, artifactIsRedacted);
    if (bytes.length > this.#maxArtifactBytes) throw new Error("controller evidence artifact exceeds maxArtifactBytes");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const objectPath = join(this.#objects, contentHash);
    if (!existsSync(objectPath)) {
      try { writeDurableExclusive(objectPath, bytes); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const id = randomUUID();
    const entry = Object.freeze({
      kind,
      ref: `controller:${id}`,
      claim: safeClaim,
      source: "controller",
      contentHash,
      capturedAt,
      size: bytes.length,
      retentionUntil: capturedAt + this.#retentionMs,
      ...(semanticSchema === undefined ? {} : { semanticSchema }),
    });
    if (!this.#verifyCandidate(entry)) throw new Error("controller evidence object path is unsafe or corrupt");
    writeDurableExclusive(join(this.#metadata, `${id}.json`), `${JSON.stringify(entry)}\n`);
    this.#entries.set(entry.ref, entry);
    return entry;
  }

  verify(descriptor) {
    const stored = this.#entries.get(descriptor?.ref);
    if (!stored || !descriptorMatches(descriptor, stored)) return false;
    return this.#verifyCandidate(stored);
  }

  artifact(descriptor) {
    if (!this.verify(descriptor)) throw new Error("controller evidence descriptor or retained artifact is invalid");
    return Buffer.from(readFileSync(join(this.#objects, descriptor.contentHash)));
  }

  prune(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("controller evidence prune time must be a non-negative safe integer");
    const removed = [];
    for (const [ref, entry] of this.#entries) {
      if (entry.retentionUntil > now) continue;
      const id = REF.exec(ref)?.[1];
      if (id) rmSync(join(this.#metadata, `${id}.json`), { force: true });
      this.#entries.delete(ref);
      removed.push(ref);
    }
    const liveHashes = new Set([...this.#entries.values()].map((entry) => entry.contentHash));
    for (const name of readdirSync(this.#objects)) {
      if (HASH.test(name) && !liveHashes.has(name)) rmSync(join(this.#objects, name), { force: true });
    }
    return Object.freeze(removed);
  }

  entries() {
    return Object.freeze([...this.#entries.values()]);
  }

  #load() {
    for (const name of readdirSync(this.#metadata).sort()) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("controller evidence metadata directory contains an unexpected file");
      const entry = JSON.parse(readFileSync(join(this.#metadata, name), "utf8"));
      const id = validateStoredEntry(entry);
      if (name !== `${id}.json`) throw new Error("controller evidence ref does not match metadata filename");
      const frozen = Object.freeze(entry);
      if (!this.#verifyCandidate(frozen)) throw new Error(`controller evidence artifact is missing or corrupt: ${entry.ref}`);
      this.#entries.set(frozen.ref, frozen);
    }
    const referenced = new Set([...this.#entries.values()].map((entry) => entry.contentHash));
    for (const name of readdirSync(this.#objects)) {
      if (!HASH.test(name)) throw new Error("controller evidence object directory contains an unexpected file");
      if (!referenced.has(name)) rmSync(join(this.#objects, name), { force: true });
    }
  }

  #verifyCandidate(entry) {
    const objectPath = join(this.#objects, entry.contentHash);
    if (!existsSync(objectPath)) return false;
    const stat = lstatSync(objectPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const bytes = readFileSync(objectPath);
    return bytes.length === entry.size && createHash("sha256").update(bytes).digest("hex") === entry.contentHash;
  }
}

/**
 * Validate only evidence provenance and acceptance binding. Self-reported
 * evidence remains available as context but can never satisfy acceptance.
 */
export function validateResultEvidence(result, { acceptance = [], evidenceStore, semanticRecaptures = {} } = {}) {
  if (!evidenceStore || typeof evidenceStore.verify !== "function") throw new Error("validation requires a controller evidence store");
  if (!Array.isArray(acceptance) || acceptance.some((check) => typeof check !== "string" || !check)) {
    throw new Error("acceptance must be an array of non-empty strings");
  }
  if (!semanticRecaptures || typeof semanticRecaptures !== "object" || Array.isArray(semanticRecaptures)) {
    throw new Error("semanticRecaptures must be an object keyed by evidence ref");
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
    if (Object.hasOwn(semanticRecaptures, evidence.ref)) {
      if (typeof evidenceStore.compareSemantic !== "function") {
        reasons.push(`semantic comparison is unavailable: ${check}`);
        continue;
      }
      const comparison = evidenceStore.compareSemantic(evidence, semanticRecaptures[evidence.ref], { criterion: check });
      if (comparison.status !== "match") {
        reasons.push(comparison.status === "policy_conflict"
          ? `semantic normalization policy conflicts with acceptance: ${check}`
          : `semantic recapture mismatch: ${check}`);
        continue;
      }
    }
    satisfied.push(check);
  }

  return Object.freeze({
    status: reasons.length === 0 ? "accepted" : "rejected",
    reasons: Object.freeze(reasons),
    satisfied: Object.freeze(satisfied),
  });
}
