#!/usr/bin/env node
/**
 * Fresh-process smoke: a separate Pi RPC process can submit two independent
 * read-only workflow nodes and both reach `completed`.
 *
 * This is not acceptance of workflow-mtmzxk2i-4. That incident was a 27-turn
 * read-only child that reconciled to used=804330, then hard-denied a 236663-byte
 * reservation against cap=1000000. The numeric/enforcement regression lives in
 * test/broker.test.mjs, test/ipc-stream.test.mjs, the fresh-process worker
 * test/fixtures/incident-input-cap-worker.mjs, the real Pi child
 * test/incident-input-cap-child.test.mjs, the parent-extension probe
 * test/incident-input-cap-parent.test.mjs, and the fresh `pi` binary parent
 * test/incident-input-cap-pi-host.test.mjs. A one-word child never exercises
 * that UTF-8/token gap.
 *
 * Usage:
 *   LIVE_WORKFLOW_VERIFY=1 node scripts/verify-live-workflow.mjs
 *
 * Exits non-zero unless every node reaches `completed`.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTENSION = join(ROOT, "extensions", "pi-delegation-broker.ts");
const JOBS_DIR = join(homedir(), ".pi", "agent", "delegation-broker", "jobs");
const DEADLINE_MS = 12 * 60_000;
const POLL_MS = 2_000;

if (process.env.LIVE_WORKFLOW_VERIFY !== "1") {
  console.error("Refusing to spend live provider capacity. Re-run with LIVE_WORKFLOW_VERIFY=1.");
  process.exit(2);
}

const PROMPT = [
  "Call the delegate_workflow tool exactly once and then stop.",
  "Submit exactly two independent read-only nodes, with no dependsOn between them:",
  '  node id "evidence-audit", tier "cheap", task: "Reply with exactly the single word: audited. Do not use any tools."',
  '  node id "decision-review", tier "cheap", task: "Reply with exactly the single word: reviewed. Do not use any tools."',
  'For each node include work: taskClass "lookup", deliverable equal to its required word, benefit "Owner-requested live lifecycle test", parentWork "Wait for both reports without producing their words", maxAttempts 1.',
  "Do not set acceptance, do not wait, and do not call any other tool.",
  "After the tool returns, reply with only the workflow id.",
].join("\n");

function attachJsonl(stream, onLine) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index).replace(/\r$/, "");
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
    }
  });
}

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXTENSION], {
  cwd: ROOT,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.setDefaultEncoding("utf8");

let workflowId;
let settled = false;
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

const finish = (code, message) => {
  if (settled) return;
  settled = true;
  console.log(message);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
};

attachJsonl(child.stdout, (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "tool_execution_end" && event.toolName === "delegate_workflow") {
    workflowId = event.result?.details?.workflowId;
    if (workflowId) {
      console.log(`submitted ${workflowId}`);
      void poll(workflowId);
    }
    return;
  }
  if (event.type === "agent_settled" && !workflowId) {
    finish(1, "FAIL: the parent never submitted a workflow");
  }
});

async function poll(id) {
  const path = join(JOBS_DIR, `${id}.json`);
  const deadline = Date.now() + DEADLINE_MS;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (!existsSync(path)) continue;
    let job;
    try { job = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const nodes = (job.nodes ?? []).map((node) => `${node.id}=${node.state}`).join(" ");
    const line = `${job.status} :: ${nodes}`;
    if (line !== last) { console.log(line); last = line; }
    if (!["completed", "failed", "cancelled", "expired"].includes(job.status)) continue;

    const failures = (job.nodes ?? []).filter((node) => node.state !== "completed");
    if (job.status === "completed" && failures.length === 0) {
      const attempts = job.team?.usage?.startedAttempts;
      const cap = job.team?.budgets?.maxAttempts;
      return finish(0, `PASS: ${id} completed; every node completed; physical attempts ${attempts}/${cap}`);
    }
    for (const node of failures) {
      const route = (node.result?.route ?? [])
        .map((attempt) => `${attempt.resourceId ?? "unassigned"}:${attempt.outcome ?? "unknown"}`)
        .join(" -> ");
      console.log(`  ${node.id}: ${node.state} :: ${node.error ?? node.result?.error ?? "no reason"}${route ? ` [${route}]` : ""}`);
    }
    return finish(1, `FAIL: ${id} settled ${job.status} with ${failures.length} incomplete node(s)`);
  }
  return finish(1, `FAIL: ${id} did not settle within ${DEADLINE_MS}ms`);
}

child.once("exit", (code) => {
  if (settled) return;
  finish(1, `FAIL: pi exited early (${code})\n${stderr.join("").slice(-4000)}`);
});

child.stdin.write(`${JSON.stringify({ id: "run", type: "prompt", message: PROMPT })}\n`);
