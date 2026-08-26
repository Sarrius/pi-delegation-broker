import { createHash, randomUUID, sign, verify } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{32,4096}$/;
const FIELDS = ["schemaVersion", "approvalId", "repairId", "defectId", "rootId", "taskId", "proposalDigest", "expiresAt", "decision"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
function message(value) { return Buffer.from(JSON.stringify(canonicalize(value)), "utf8"); }
function fail(messageText) { throw new Error(`human approval: ${messageText}`); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} has unsupported or missing fields`);
}
function normalizeFields(value, label = "approval") {
  exactKeys(value, [...FIELDS, "signature"], label);
  if (value.schemaVersion !== 1 || !UUID.test(value.approvalId ?? "") || !UUID.test(value.repairId ?? "") || !UUID.test(value.defectId ?? "")
    || !ID.test(value.rootId ?? "") || !ID.test(value.taskId ?? "") || !SHA256.test(value.proposalDigest ?? "")
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.decision !== "approve"
    || typeof value.signature !== "string" || !SIGNATURE.test(value.signature)) fail(`${label} fields are invalid`);
  return Object.freeze({
    schemaVersion: 1, approvalId: value.approvalId, repairId: value.repairId, defectId: value.defectId,
    rootId: value.rootId, taskId: value.taskId, proposalDigest: value.proposalDigest,
    expiresAt: value.expiresAt, decision: value.decision, signature: value.signature,
  });
}

/** Digest the immutable repair proposal fields that a human actually approved. */
export function repairProposalDigest(proposal) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) fail("proposal is invalid");
  const value = {
    schemaVersion: proposal.schemaVersion,
    mode: proposal.mode,
    repairId: proposal.repairId,
    defectId: proposal.defectId,
    rootId: proposal.rootId,
    taskId: proposal.taskId,
    summary: proposal.summary,
    affectedPaths: proposal.affectedPaths,
    tokenBudget: proposal.tokenBudget,
    freshProcessRequired: proposal.freshProcessRequired,
    ...(proposal.metadata === undefined ? {} : { metadata: proposal.metadata }),
  };
  return createHash("sha256").update(message(value)).digest("hex");
}

/** Create a signed, expiry-bound owner approval. The private key never belongs in a child. */
export function createHumanApproval({
  privateKey, repairId, defectId, rootId, taskId, proposalDigest, expiresAt, approvalId = randomUUID(), decision = "approve",
} = {}) {
  const unsigned = normalizeFields({ schemaVersion: 1, approvalId, repairId, defectId, rootId, taskId, proposalDigest, expiresAt, decision, signature: "placeholder-signature-000000000000000000000000000000" }, "approval");
  const unsignedFields = Object.fromEntries(FIELDS.map((field) => [field, unsigned[field]]));
  if (!privateKey) fail("privateKey is required");
  const signature = sign(null, message(unsignedFields), privateKey).toString("base64url");
  return Object.freeze({ ...unsignedFields, signature });
}

/** Verify the signature, expiry and exact repair binding against an owner-held public key. */
export function verifyHumanApproval(receipt, { publicKey, now = Date.now(), expected = {} } = {}) {
  try {
    const normalized = normalizeFields(receipt);
    if (!publicKey || !Number.isSafeInteger(now) || now < 0 || normalized.expiresAt <= now) return false;
    for (const field of ["repairId", "defectId", "rootId", "taskId", "proposalDigest"]) {
      if (expected[field] !== undefined && expected[field] !== normalized[field]) return false;
    }
    const unsigned = Object.fromEntries(FIELDS.map((field) => [field, normalized[field]]));
    return verify(null, message(unsigned), publicKey, Buffer.from(normalized.signature, "base64url"));
  } catch { return false; }
}
