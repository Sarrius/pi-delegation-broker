import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControllerAcceptanceVerifier, controllerVerificationReceipt } from "../src/acceptance-verifier.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";

async function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), "acceptance-verifier-"));
  try { return await run(new ControllerEvidenceStore({ root })); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function checks() {
  return [
    { id: "typecheck", claim: "npm run check", kind: "command", timeoutMs: 1_000 },
    { id: "tests", claim: "npm test", kind: "test", timeoutMs: 1_000 },
  ];
}

test("controller verifier runs its complete fixed plan and produces retained controller evidence", async () => {
  await withStore(async (store) => {
    const invoked = [];
    const verifier = new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: checks(),
      runCheck: async (check) => {
        invoked.push(check);
        if (check.id === "typecheck") return { exitCode: 0, stdout: "checked\n", stderr: "" };
        return { suite: "unit", outcome: "pass", passed: 4, failed: 0, skipped: 0 };
      },
    });
    const verification = await verifier.verify();
    assert.equal(verification.status, "accepted");
    assert.equal(verification.validation.status, "accepted");
    assert.deepEqual(invoked.map((check) => check.id), ["typecheck", "tests"]);
    assert.deepEqual(verification.result.validationPerformed.map((item) => item.check), ["npm run check", "npm test"]);
    assert.equal(verification.result.evidence.every((descriptor) => descriptor.source === "controller" && store.verify(descriptor)), true);
    assert.equal(verification.checks.every((check) => check.status === "passed"), true);
    const receipt = controllerVerificationReceipt(verification);
    assert.equal(receipt.status, "accepted");
    assert.deepEqual(receipt.evidenceRefs, verification.result.evidence.map((descriptor) => descriptor.ref));
  });
});

test("failed, malformed, or timed-out controller checks reject instead of accepting a worker claim", async () => {
  await withStore(async (store) => {
    const failed = new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "check", claim: "npm run check", kind: "command", timeoutMs: 1_000 }],
      runCheck: async () => ({ exitCode: 1, stdout: "", stderr: "failed" }),
    });
    const failedResult = await failed.verify();
    assert.equal(failedResult.status, "rejected");
    assert.equal(failedResult.checks[0].status, "failed");
    assert.match(failedResult.validation.reasons.join("\n"), /acceptance lacks controller evidence/);
    assert.deepEqual(controllerVerificationReceipt(failedResult), {
      status: "rejected", verifierRunId: failedResult.runId, evidenceRefs: [failedResult.result.evidence[0].ref],
    });

    const malformed = new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "tests", claim: "npm test", kind: "test", timeoutMs: 1_000 }],
      runCheck: async () => ({ outcome: "pass" }),
    });
    const malformedResult = await malformed.verify();
    assert.equal(malformedResult.status, "rejected");
    assert.equal(malformedResult.checks[0].status, "controller_error");

    let aborted = false;
    const timedOut = new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "slow", claim: "npm run slow-check", kind: "command", timeoutMs: 100 }],
      runCheck: async (_check, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ exitCode: 0, stdout: "late", stderr: "" });
        }, { once: true });
      }),
    });
    const timeoutResult = await timedOut.verify();
    assert.equal(timeoutResult.status, "rejected");
    assert.equal(timeoutResult.checks[0].status, "timed_out");
    assert.equal(aborted, true);
  });
});

test("verifier rejects mutable check selection and overlapping verification", async () => {
  await withStore(async (store) => {
    assert.throws(() => new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "same", claim: "one", kind: "command", timeoutMs: 1_000 }, { id: "same", claim: "two", kind: "command", timeoutMs: 1_000 }],
      runCheck: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }), /unique/);
    assert.throws(() => new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "url", claim: "url", kind: "url", timeoutMs: 1_000 }],
      runCheck: async () => ({}),
    }), /command or test/);

    let finish;
    const verifier = new ControllerAcceptanceVerifier({
      evidenceStore: store,
      checks: [{ id: "check", claim: "check", kind: "command", timeoutMs: 1_000 }],
      runCheck: async () => new Promise((resolve) => { finish = resolve; }),
    });
    const first = verifier.verify();
    await assert.rejects(() => verifier.verify(), /busy/);
    finish({ exitCode: 0, stdout: "ok", stderr: "" });
    assert.equal((await first).status, "accepted");
  });
});
