import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { captureLosslessJson } from "./lossless-json.mjs";
import { repairProposalDigest, verifyHumanApproval } from "./human-approval.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/;
const STATES = new Set(["proposed", "queued", "human_review", "verifying", "verified", "rejected", "failed"]);
const TERMINAL = new Set(["verified", "rejected", "failed"]);
const TRANSITIONS = new Map([
  ["proposed", new Set(["queued", "human_review", "verifying", "rejected"])],
  ["queued", new Set(["human_review", "verifying", "rejected"])],
  ["human_review", new Set(["queued", "verifying", "rejected"])],
  ["verifying", new Set(["verified", "failed", "human_review"])],
  ["verified", new Set()], ["rejected", new Set()], ["failed", new Set()],
]);
const DEFAULT_BUDGETS = Object.freeze({ maxProposals: 8, maxAttempts: 8, maxRepairTokens: 200_000 });
const PROTECTED = [
  /acceptance/i, /capability/i, /trusted-launch/i, /behavioral/i, /lease/i, /broker/i, /ipc/i, /attestation/i,
];

function fail(message) { throw new Error(`repair controller: ${message}`); }
function bounded(value, label, max = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  return value.trim();
}
function id(value, label) { if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`); return value; }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`); return value; }
function rootDir(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) fail("root must not be a symlink");
  const canonical = realpathSync(path); const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fail("root must be owner-only");
  return canonical;
}
function json(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
function atomic(path, value) { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temp, path); chmodSync(path, 0o600); }
function file(root, repairId) { return join(root, "records", `${createHash("sha256").update(repairId).digest("hex")}.json`); }
function stateFile(root, repairId) { return join(root, "states", `${createHash("sha256").update(repairId).digest("hex")}.json`); }
function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) || proposal.schemaVersion !== 1 || proposal.mode !== "proposal_only" || !UUID.test(proposal.repairId ?? "") || !UUID.test(proposal.defectId ?? "")) fail("proposal identity is invalid");
  id(proposal.rootId, "rootId"); id(proposal.taskId, "taskId"); bounded(proposal.summary, "summary", 2_000);
  if (!Array.isArray(proposal.affectedPaths) || proposal.affectedPaths.length > 256 || proposal.affectedPaths.some((path) => typeof path !== "string" || path.startsWith("/") || path.split("/").includes(".."))) fail("affectedPaths are invalid");
  integer(proposal.tokenBudget, "tokenBudget", 1, 2_000_000);
  if (typeof proposal.freshProcessRequired !== "boolean") fail("freshProcessRequired is invalid");
  return proposal;
}
function budgets(value = {}) {
  return Object.freeze({
    maxProposals: integer(value.maxProposals ?? DEFAULT_BUDGETS.maxProposals, "maxProposals", 1, 100),
    maxAttempts: integer(value.maxAttempts ?? DEFAULT_BUDGETS.maxAttempts, "maxAttempts", 1, 100),
    maxRepairTokens: integer(value.maxRepairTokens ?? DEFAULT_BUDGETS.maxRepairTokens, "maxRepairTokens", 1, 10_000_000),
  });
}

export class RepairStore {
  #root; #records; #states; #budgetPath; #budgets;
  constructor({ root, budgets: limits } = {}) {
    this.#root = rootDir(root); this.#records = rootDir(join(this.#root, "records")); this.#states = rootDir(join(this.#root, "states"));
    this.#budgetPath = join(this.#root, "budget.json"); this.#budgets = budgets(limits);
    const prior = json(this.#budgetPath);
    if (prior && JSON.stringify(prior.budgets) !== JSON.stringify(this.#budgets)) fail("repair budget is immutable");
    if (!prior) atomic(this.#budgetPath, { schemaVersion: 1, budgets: this.#budgets, reservedProposals: 0, reservedTokens: 0, attempts: 0 });
  }
  budgets() { return this.#budgets; }
  usage() { const value = json(this.#budgetPath); return Object.freeze({ reservedProposals: value?.reservedProposals ?? 0, reservedTokens: value?.reservedTokens ?? 0, attempts: value?.attempts ?? 0 }); }
  reserve(tokenBudget) {
    const usage = this.usage(); integer(tokenBudget, "tokenBudget", 1, this.#budgets.maxRepairTokens);
    if (usage.reservedProposals >= this.#budgets.maxProposals) return { status: "budget_exhausted", reason: "maxProposals" };
    if (usage.reservedTokens + tokenBudget > this.#budgets.maxRepairTokens) return { status: "budget_exhausted", reason: "maxRepairTokens" };
    atomic(this.#budgetPath, { schemaVersion: 1, budgets: this.#budgets, reservedProposals: usage.reservedProposals + 1, reservedTokens: usage.reservedTokens + tokenBudget, attempts: usage.attempts });
    return { status: "reserved" };
  }
  attempt() {
    const usage = this.usage();
    if (usage.attempts >= this.#budgets.maxAttempts) return { status: "budget_exhausted", reason: "maxAttempts" };
    atomic(this.#budgetPath, { schemaVersion: 1, budgets: this.#budgets, reservedProposals: usage.reservedProposals, reservedTokens: usage.reservedTokens, attempts: usage.attempts + 1 });
    return { status: "reserved" };
  }
  create(input) {
    const now = input.createdAt ?? Date.now();
    const proposal = validateProposal({ schemaVersion: 1, mode: "proposal_only", repairId: input.repairId ?? randomUUID(), defectId: input.defectId, rootId: input.rootId, taskId: input.taskId, summary: input.summary, affectedPaths: [...new Set(input.affectedPaths ?? [])].sort(), tokenBudget: input.tokenBudget, freshProcessRequired: input.freshProcessRequired !== false, createdAt: now, ...input.metadata ? { metadata: captureLosslessJson(input.metadata, { maxBytes: 64 * 1024, maxDepth: 16, maxNodes: 2_000 }).value } : {} });
    const path = file(this.#root, proposal.repairId); if (existsSync(path)) return this.read(proposal.repairId);
    atomic(path, proposal); return this.read(proposal.repairId);
  }
  read(repairId) {
    if (!UUID.test(repairId ?? "")) return undefined;
    const record = json(file(this.#root, repairId)); if (!record) return undefined;
    const marker = json(stateFile(this.#root, repairId));
    try { validateProposal(record); } catch { return undefined; }
    if (marker && (!STATES.has(marker.status) || marker.repairId !== repairId
      || (marker.approvalDigest !== undefined && !/^[a-f0-9]{64}$/.test(marker.approvalDigest))
      || (marker.approvalReceipt !== undefined && (typeof marker.approvalReceipt !== "object" || Array.isArray(marker.approvalReceipt) || JSON.stringify(marker.approvalReceipt).length > 16_384)))) return undefined;
    return Object.freeze({
      ...record,
      status: marker?.status ?? "proposed",
      ...(marker?.reason ? { statusReason: marker.reason } : {}),
      ...(marker?.at ? { statusAt: marker.at } : {}),
      ...(marker?.approvalDigest ? { approvalDigest: marker.approvalDigest } : {}),
      ...(marker?.approvalReceipt ? { approvalReceipt: structuredClone(marker.approvalReceipt) } : {}),
    });
  }
  list({ rootId, statuses } = {}) {
    const wanted = statuses ? new Set(statuses) : undefined; const out = [];
    // Directory iteration stays bounded by the proposal budget.
    for (const name of readdirSync(this.#records)) { if (!name.endsWith(".json")) continue; const raw = json(join(this.#records, name)); const value = raw && this.read(raw.repairId); if (!value || (rootId && value.rootId !== rootId) || (wanted && !wanted.has(value.status))) continue; out.push(value); }
    return Object.freeze(out.sort((a, b) => a.createdAt - b.createdAt || a.repairId.localeCompare(b.repairId)));
  }
  transition(repairId, status, { reason, approvalDigest, approvalReceipt, at = Date.now() } = {}) {
    if (!STATES.has(status)) fail("repair status is invalid"); const current = this.read(repairId); if (!current) return undefined;
    if (current.status === status) return current;
    if (!TRANSITIONS.get(current.status)?.has(status)) fail(`transition ${current.status} -> ${status} is not allowed`);
    if (approvalDigest !== undefined && !/^[a-f0-9]{64}$/.test(approvalDigest)) fail("approvalDigest is invalid");
    if (approvalReceipt !== undefined && (typeof approvalReceipt !== "object" || Array.isArray(approvalReceipt) || JSON.stringify(approvalReceipt).length > 16_384)) fail("approvalReceipt is invalid");
    atomic(stateFile(this.#root, repairId), {
      schemaVersion: 1, repairId, status, at,
      ...(reason ? { reason: bounded(reason, "reason", 2_000) } : {}),
      ...(approvalDigest ? { approvalDigest } : {}),
      ...(approvalReceipt ? { approvalReceipt: structuredClone(approvalReceipt) } : {}),
    });
    return this.read(repairId);
  }
}

export class RepairController {
  #defects; #checkpoints; #store; #verify; #canary; #reconcile; #resume; #active; #humanApprovalVerifier;
  constructor({ defectStore, checkpointStore, store, verifyProposal, freshProcessCanary, reconcile, resume, humanApprovalVerifier, humanApprovalPublicKey } = {}) {
    if (!defectStore || typeof defectStore.read !== "function") fail("defectStore is required");
    if (!checkpointStore || typeof checkpointStore.acceptedFor !== "function") fail("checkpointStore is required");
    if (!store || typeof store.reserve !== "function") fail("repair store is required");
    if (typeof verifyProposal !== "function" || typeof freshProcessCanary !== "function" || typeof reconcile !== "function" || typeof resume !== "function") fail("controller gates are required");
    if (humanApprovalVerifier !== undefined && typeof humanApprovalVerifier !== "function") fail("humanApprovalVerifier must be a function");
    if (humanApprovalVerifier === undefined && humanApprovalPublicKey !== undefined && !humanApprovalPublicKey) fail("humanApprovalPublicKey is invalid");
    this.#defects = defectStore; this.#checkpoints = checkpointStore; this.#store = store; this.#verify = verifyProposal; this.#canary = freshProcessCanary; this.#reconcile = reconcile; this.#resume = resume;
    this.#humanApprovalVerifier = humanApprovalVerifier ?? (humanApprovalPublicKey
      ? (receipt, proposal) => verifyHumanApproval(receipt, {
        publicKey: humanApprovalPublicKey,
        expected: {
          repairId: proposal.repairId, defectId: proposal.defectId, rootId: proposal.rootId,
          taskId: proposal.taskId, proposalDigest: repairProposalDigest(proposal),
        },
      })
      : undefined);
  }
  propose({ defectId, rootId, taskId, summary, affectedPaths, tokenBudget = 1_000, metadata } = {}) {
    const defect = this.#defects.read(defectId); if (!defect || defect.rootId !== rootId || defect.taskId !== taskId) return { status: "rejected", reason: "defect_binding" };
    if (!this.#checkpoints.acceptedFor({ rootId, taskId }).length) return { status: "rejected", reason: "accepted_checkpoint_required" };
    const reservation = this.#store.reserve(tokenBudget); if (reservation.status !== "reserved") return reservation;
    const protectedPath = (affectedPaths ?? []).find((path) => PROTECTED.some((pattern) => pattern.test(path)));
    const proposal = this.#store.create({ defectId, rootId, taskId, summary, affectedPaths, tokenBudget, metadata });
    this.#defects.transition(defectId, "queued", { reason: "repair proposal admitted" });
    if (this.#active || protectedPath) {
      this.#store.transition(proposal.repairId, protectedPath ? "human_review" : "queued", { reason: protectedPath ? `human gate required for ${protectedPath}` : "repair queued behind active proposal" });
      return Object.freeze({ status: protectedPath ? "human_review" : "queued", repairId: proposal.repairId });
    }
    return Object.freeze({ status: "proposed", repairId: proposal.repairId });
  }
  approve(repairId, receipt) {
    const proposal = this.#store.read(repairId);
    if (!proposal) return { status: "rejected", reason: "unknown_repair" };
    if (proposal.status !== "human_review") return { status: proposal.status, repairId };
    const verifier = this.#humanApprovalVerifier;
    let valid = false;
    try { valid = typeof verifier === "function" && verifier(receipt, proposal) === true; } catch { valid = false; }
    if (!valid) return Object.freeze({ status: "rejected", reason: "human_approval_invalid", repairId });
    const receiptDigest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    this.#store.transition(repairId, "queued", { reason: "signed human approval recorded", approvalDigest: receiptDigest, approvalReceipt: receipt });
    return Object.freeze({ status: "approved", repairId, approvalDigest: receiptDigest });
  }

  async run(repairId, { approval } = {}) {
    if (this.#active) return Object.freeze({ status: "queued", repairId, reason: "another repair is active" });
    let proposal = this.#store.read(repairId); if (!proposal) return { status: "rejected", reason: "unknown_repair" };
    const protectedPath = proposal.affectedPaths.find((path) => PROTECTED.some((pattern) => pattern.test(path)));
    if (proposal.status === "human_review") {
      if (approval === undefined) return { status: "human_review", repairId };
      const approved = this.approve(repairId, approval);
      if (approved.status !== "approved") return approved;
      proposal = this.#store.read(repairId);
    }
    if (protectedPath) {
      let approvalStillValid = false;
      try { approvalStillValid = proposal.approvalDigest !== undefined && this.#humanApprovalVerifier?.(proposal.approvalReceipt, proposal) === true; } catch { approvalStillValid = false; }
      if (!approvalStillValid) return { status: "human_review", repairId };
    }
    if (proposal.status !== "proposed" && proposal.status !== "queued") return { status: proposal.status, repairId };
    const attempt = this.#store.attempt(); if (attempt.status !== "reserved") return attempt;
    this.#active = repairId;
    try {
      this.#store.transition(repairId, "verifying");
      const defect = this.#defects.read(proposal.defectId);
      const accepted = this.#checkpoints.acceptedFor({ rootId: proposal.rootId, taskId: proposal.taskId });
      const verified = await this.#verify({ proposal, defect, acceptedCheckpoints: accepted });
      if (!verified || verified.status !== "passed") { this.#store.transition(repairId, "failed", { reason: "controller verification failed" }); return { status: "failed", repairId }; }
      if (proposal.freshProcessRequired) {
        const canary = await this.#canary({ proposal, verified });
        if (!canary || canary.status !== "passed") { this.#store.transition(repairId, "failed", { reason: "fresh-process canary failed" }); return { status: "failed", repairId }; }
      }
      const reconciled = await this.#reconcile({ proposal, verified });
      if (!reconciled || reconciled.status !== "reconciled") { this.#store.transition(repairId, "failed", { reason: "repair reconciliation failed" }); return { status: "failed", repairId }; }
      this.#store.transition(repairId, "verified", { reason: "controller verification and reconciliation passed" });
      this.#defects.transition(proposal.defectId, "resolved", { reason: "verified repair" });
      await this.#resume({ rootId: proposal.rootId, taskId: proposal.taskId, repairId });
      return { status: "verified", repairId };
    } finally { this.#active = undefined; }
  }
}
