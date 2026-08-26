import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointStore } from "../src/checkpoint-store.mjs";
import { DefectStore } from "../src/defect-store.mjs";
import { createHumanApproval, repairProposalDigest } from "../src/human-approval.mjs";
import { RepairController, RepairStore } from "../src/repair-controller.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "repair-controller-"));
  const defects = new DefectStore({ root: join(root, "defects") });
  const checkpoints = new CheckpointStore({ root: join(root, "checkpoints") });
  const store = new RepairStore({ root: join(root, "repairs"), budgets: { maxProposals: 4, maxAttempts: 4, maxRepairTokens: 10_000 } });
  const defect = defects.capture({ rootId: "root", taskId: "task", kind: "controller", origin: "controller", message: "IPC failed", observedAt: 1 });
  checkpoints.publish({ rootId: "root", taskId: "task", attemptId: "attempt", artifactKey: "state", artifact: { cursor: 1 }, publishedAt: 1, autoAccept: true });
  return { root, defects, checkpoints, store, defect };
}

test("repair proposals require accepted checkpoints and resume only after verification, fresh canary and reconciliation", async () => {
  const s = setup(); const events = [];
  try {
    const controller = new RepairController({
      defectStore: s.defects, checkpointStore: s.checkpoints, store: s.store,
      verifyProposal: async () => { events.push("verify"); return { status: "passed", evidence: ["focused-test"] }; },
      freshProcessCanary: async () => { events.push("fresh"); return { status: "passed", pid: 1234 }; },
      reconcile: async () => { events.push("reconcile"); return { status: "reconciled" }; },
      resume: async () => { events.push("resume"); },
    });
    const proposal = controller.propose({ defectId: s.defect.defectId, rootId: "root", taskId: "task", summary: "repair IPC", affectedPaths: ["src/report-store.mjs"], tokenBudget: 100 });
    assert.equal(proposal.status, "proposed");
    assert.deepEqual(await controller.run(proposal.repairId), { status: "verified", repairId: proposal.repairId });
    assert.deepEqual(events, ["verify", "fresh", "reconcile", "resume"]);
    assert.equal(s.defects.read(s.defect.defectId).status, "resolved");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("validator/authority paths require a human gate and second-order proposals queue behind active repair", async () => {
  const s = setup(); let release; const gate = new Promise((resolve) => { release = resolve; });
  const secondDefect = s.defects.capture({ rootId: "root", taskId: "task", kind: "controller", origin: "controller", message: "second defect", observedAt: 2 });
  s.checkpoints.publish({ rootId: "root", taskId: "task", attemptId: "attempt-2", artifactKey: "state-2", artifact: { cursor: 2 }, publishedAt: 2, autoAccept: true });
  try {
    const controller = new RepairController({
      defectStore: s.defects, checkpointStore: s.checkpoints, store: s.store,
      verifyProposal: async () => { await gate; return { status: "passed" }; },
      freshProcessCanary: async () => ({ status: "passed" }),
      reconcile: async () => ({ status: "reconciled" }),
      resume: async () => undefined,
    });
    const first = controller.propose({ defectId: s.defect.defectId, rootId: "root", taskId: "task", summary: "first", affectedPaths: ["src/report-store.mjs"], tokenBudget: 100 });
    const running = controller.run(first.repairId);
    await new Promise((resolve) => setImmediate(resolve));
    const queued = controller.propose({ defectId: secondDefect.defectId, rootId: "root", taskId: "task", summary: "second", affectedPaths: ["src/workflow-scheduler.mjs"], tokenBudget: 100 });
    assert.equal(queued.status, "queued");
    const gated = controller.propose({ defectId: secondDefect.defectId, rootId: "root", taskId: "task", summary: "authority", affectedPaths: ["src/capability-compiler.mjs"], tokenBudget: 100 });
    assert.equal(gated.status, "human_review");
    release();
    assert.equal((await running).status, "verified");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("protected repairs require a signed, expiry-bound approval bound to the immutable proposal", async () => {
  const s = setup();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  try {
    const controller = new RepairController({
      defectStore: s.defects, checkpointStore: s.checkpoints, store: s.store,
      humanApprovalPublicKey: publicKey,
      verifyProposal: async () => ({ status: "passed" }),
      freshProcessCanary: async () => ({ status: "passed" }),
      reconcile: async () => ({ status: "reconciled" }),
      resume: async () => undefined,
    });
    const proposal = controller.propose({ defectId: s.defect.defectId, rootId: "root", taskId: "task", summary: "repair acceptance", affectedPaths: ["src/acceptance-verifier.mjs"], tokenBudget: 100 });
    assert.equal(proposal.status, "human_review");
    assert.deepEqual(await controller.run(proposal.repairId), { status: "human_review", repairId: proposal.repairId });
    const stored = s.store.read(proposal.repairId);
    const approval = createHumanApproval({
      privateKey, repairId: stored.repairId, defectId: stored.defectId, rootId: stored.rootId,
      taskId: stored.taskId, proposalDigest: repairProposalDigest(stored), expiresAt: Date.now() + 10_000,
    });
    const tampered = { ...approval, proposalDigest: "0".repeat(64) };
    assert.equal(controller.approve(proposal.repairId, tampered).status, "rejected");
    assert.deepEqual(await controller.run(proposal.repairId, { approval }), { status: "verified", repairId: proposal.repairId });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("repair admission fails closed without an accepted checkpoint or after the repair budget", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-budget-"));
  const defects = new DefectStore({ root: join(root, "defects") });
  const checkpoints = new CheckpointStore({ root: join(root, "checkpoints") });
  const store = new RepairStore({ root: join(root, "repairs"), budgets: { maxProposals: 1, maxAttempts: 1, maxRepairTokens: 50 } });
  try {
    const noCheckpoint = defects.capture({ rootId: "root", taskId: "task", kind: "controller", origin: "controller", message: "missing checkpoint" });
    const controller = new RepairController({ defectStore: defects, checkpointStore: checkpoints, store, verifyProposal: async () => ({ status: "passed" }), freshProcessCanary: async () => ({ status: "passed" }), reconcile: async () => ({ status: "reconciled" }), resume: async () => undefined });
    assert.deepEqual(controller.propose({ defectId: noCheckpoint.defectId, rootId: "root", taskId: "task", summary: "no", affectedPaths: ["src/foo.mjs"] }), { status: "rejected", reason: "accepted_checkpoint_required" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
