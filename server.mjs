import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteLeaseBroker } from "./src/broker.mjs";
import {
  compileEffectiveChildCapability,
  createEffectiveChildCapability,
  deriveAllowedTools,
} from "./src/capability-compiler.mjs";
import {
  buildFleetProjection,
  fleetSummary,
  formatDelegationStatus,
  formatFleetDetails,
  formatFleetWidget,
} from "./src/fleet-view.mjs";
import { composeTaskPrompt } from "./src/delegation-policy.mjs";
import {
  deriveTaskRequirement,
  selectModelForTask,
} from "./src/model-selector.mjs";
import { catalogToBrokerRegistry } from "./src/provider-catalog.mjs";

const DEFAULT_CATALOG = [
  {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ],
  },
  {
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    models: [
      {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        contextWindow: 272_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.2-mini",
        name: "GPT-5.2 Mini",
        contextWindow: 128_000,
        maxTokens: 32_000,
        reasoning: false,
        input: ["text"],
      },
    ],
  },
  {
    provider: "cursor",
    baseUrl: "https://api2.cursor.sh",
    api: "cursor-agent",
    models: [
      {
        id: "composer-2.5",
        name: "Cursor Composer 2.5",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
        input: ["text"],
      },
    ],
  },
];

export function createBrokerControllerState() {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegation-broker-ui-"));
  const dbPath = join(dir, "broker.sqlite");
  const registry = catalogToBrokerRegistry(DEFAULT_CATALOG, {
    confidence: "measured",
    maxConcurrentPerProvider: 4,
    cooldownDefaultMs: 120_000,
    cooldownProbeIntervalMs: 30_000,
  });

  const broker = new SqliteLeaseBroker({
    path: dbPath,
    registry,
    behavioralEnforcement: "blocking_monitor",
  });

  let monotonicClock = Date.now();
  const nextTick = () => {
    const wall = Date.now();
    monotonicClock = wall > monotonicClock ? wall : monotonicClock + 1;
    return monotonicClock;
  };

  const jobs = new Map();
  const reports = new Map();
  const attempts = new Map();
  const capabilitiesByLease = new Map();
  let taskCounter = 1;

  function seedInitialWork() {
    const now = nextTick();

    // Seed 1: Completed verified read-only audit report
    const completedTaskId = "audit-security-boundary";
    jobs.set(completedTaskId, {
      jobId: completedTaskId,
      kind: "task",
      status: "completed",
      tier: "standard",
      task: "Verify Unix-socket capability hashing and redaction rules across src/ipc.mjs",
      submittedAt: now - 45_000,
      startedAt: now - 44_000,
      completedAt: now - 12_000,
      updatedAt: now - 12_000,
    });
    reports.set(completedTaskId, {
      taskId: completedTaskId,
      logicalId: completedTaskId,
      status: "completed",
      resourceId: "cursor/composer-2.5",
      provider: "cursor",
      modelId: "composer-2.5",
      requestedThinking: "medium",
      effectiveThinking: "medium",
      role: "auditor",
      verificationStatus: "accepted",
      startedAt: now - 44_000,
      completedAt: now - 12_000,
      usage: { input: 4_820, output: 690, cacheRead: 1_200, cacheWrite: 0, turns: 3 },
    });

    // Seed 2: Active delegated task with a real SQLite lease
    delegateTask({
      taskId: "task-1-sqlite-fencing",
      taskDescription: "Audit entire repository SQLite lease reservation and fencing token transitions",
      operationClass: "observe",
      admissionClass: "work",
      thinking: "high",
      role: "reviewer",
      doneWhen: "Return controller-verifiable evidence references for BEGIN IMMEDIATE lease serialization",
    });

    // Seed 3: Active effect-capable patch proposal task with a real SQLite lease
    delegateTask({
      taskId: "task-2-patch-proposal",
      taskDescription: "Refactor capability compiler test coverage and propose patch for observe tools",
      operationClass: "propose_patch",
      admissionClass: "control",
      thinking: "medium",
      role: "implementer",
      contextFiles: ["src/capability-compiler.mjs", "extensions/pi-behavioral-enforcement.ts"],
      doneWhen: "Pass git-diff-check and npm-test in isolated scratch worktree",
    });

    // Seed 4: Blocked Resumable Ticket (released SQLite lease, persisted sessionFile, awaiting delegate_resume)
    const blockedTaskId = "ticket-3-oauth-ttl";
    jobs.set(blockedTaskId, {
      jobId: blockedTaskId,
      kind: "task",
      status: "blocked",
      tier: "standard",
      task: "Implement scoped child refresh token rotation in src/scoped-child-auth.mjs",
      sessionFile: "/tmp/pi-sessions/ticket-3-oauth-ttl.jsonl",
      question: "Should refresh tokens expire after 15 minutes or 60 minutes?",
      contextFiles: ["src/scoped-child-auth.mjs", "src/ipc.mjs"],
      resumeCount: 0,
      submittedAt: now - 30_000,
      startedAt: now - 29_000,
      completedAt: now - 5_000,
      updatedAt: now - 5_000,
    });
    reports.set(blockedTaskId, {
      taskId: blockedTaskId,
      logicalId: blockedTaskId,
      status: "blocked",
      resourceId: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      requestedThinking: "medium",
      effectiveThinking: "medium",
      role: "implementer",
      sessionFile: "/tmp/pi-sessions/ticket-3-oauth-ttl.jsonl",
      question: "Should refresh tokens expire after 15 minutes or 60 minutes?",
      startedAt: now - 29_000,
      completedAt: now - 5_000,
      usage: { input: 3_410, output: 510, cacheRead: 900, cacheWrite: 0, turns: 2 },
    });
  }

  function simulateTaskSelection({
    taskDescription,
    operationClass = "observe",
    admissionClass = "work",
    doneWhen = "Return controller-verifiable evidence references for the requested task",
  }) {
    const now = nextTick();
    const promptDigest = createHash("sha256").update(String(taskDescription)).digest("hex");
    const derived = deriveTaskRequirement(taskDescription, {
      operationClass,
      admissionClass,
    });
    const liveInventory = broker.inventory(now);
    const selection = selectModelForTask({
      taskDescription,
      registry,
      availability: liveInventory,
      now,
      constraints: {
        taskId: "sim-preview",
        promptDigest,
        operationClass: derived.operationClass,
        admissionClass: derived.admissionClass,
        doneWhen: [doneWhen],
      },
    });

    let compiledCapability = null;
    if (selection.action === "allow") {
      const profileObj = registry.profiles[selection.contract.capability.minimumProfile];
      const cap = createEffectiveChildCapability({
        schemaVersion: 1,
        taskId: "sim-preview",
        operationClass: selection.contract.operationClass,
        admissionClass: selection.contract.admissionClass,
        doneWhen: selection.contract.doneWhen,
        allowedTools: deriveAllowedTools(selection.contract.operationClass),
        profileSupports: profileObj?.supports ?? selection.contract.capability.required,
        budget: selection.contract.budget,
        latencyBudgetMs: selection.contract.latencyBudgetMs,
        leaseTtlMs: selection.contract.leaseTtlMs ?? 180_000,
        promptDigest,
        behavioralEnforcement: "blocking_monitor",
        downgradePolicy: "forbid",
      });
      const compiled = compileEffectiveChildCapability(cap);
      compiledCapability = {
        capabilityFingerprint: cap.capabilityFingerprint,
        allowedTools: cap.allowedTools,
        promptRules: compiled.promptRules,
        requiresBehavioralMonitor: compiled.authorizationPolicy.requiresBehavioralMonitor,
        effectCapable: compiled.authorizationPolicy.effectCapable,
      };
    }

    return {
      derived,
      selection,
      compiledCapability,
    };
  }

  function delegateTask({
    taskId: customTaskId,
    taskDescription,
    operationClass = "observe",
    admissionClass = "work",
    thinking = "medium",
    role = "worker",
    contextFiles = [],
    forkSessionFile,
    resumeCount = 0,
    doneWhen = "Return controller-verifiable evidence references for the delegated objective",
  }) {
    const trimmed = typeof taskDescription === "string" ? taskDescription.trim() : "";
    if (!trimmed) {
      return { ok: false, error: "Task description is required." };
    }
    const normalizedContextFiles = Array.isArray(contextFiles)
      ? contextFiles.map((f) => String(f).trim()).filter(Boolean).slice(0, 16)
      : [];
    const effectivePrompt = composeTaskPrompt(trimmed, normalizedContextFiles);
    const now = nextTick();
    const taskId = customTaskId || `task-${++taskCounter}-${ Math.random().toString(36).slice(2, 6) }`;
    const promptDigest = createHash("sha256").update(`${taskId}:${effectivePrompt}`).digest("hex");

    const selection = selectModelForTask({
      taskDescription: trimmed,
      registry,
      availability: broker.inventory(now),
      now,
      constraints: {
        taskId,
        promptDigest,
        operationClass,
        admissionClass,
        doneWhen: [doneWhen],
        leaseTtlMs: 180_000,
      },
    });

    if (selection.action !== "allow") {
      return {
        ok: false,
        error: `Model selector denied launch: ${selection.reason}`,
        selection,
      };
    }

    const contract = {
      ...selection.contract,
      recovery: {
        owner: "controller",
        deadlineAt: now + 600_000,
      },
    };

    const reservation = broker.submit(contract, now);
    if (reservation.status === "leased") {
      const lease = reservation.lease;
      const resourceMeta = registry.resources[lease.resourceId];
      const profileObj = registry.profiles[lease.profile];

      const cap = createEffectiveChildCapability({
        schemaVersion: 1,
        taskId,
        operationClass: contract.operationClass,
        admissionClass: contract.admissionClass,
        doneWhen: contract.doneWhen,
        allowedTools: deriveAllowedTools(contract.operationClass),
        profileSupports: profileObj?.supports ?? contract.capability.required,
        budget: {
          ...(lease.maxInputTokens !== undefined ? { maxInputTokens: lease.maxInputTokens } : {}),
          ...(lease.maxOutputTokens !== undefined ? { maxOutputTokens: lease.maxOutputTokens } : {}),
          enforcement: lease.enforcement,
        },
        latencyBudgetMs: contract.latencyBudgetMs,
        leaseTtlMs: contract.leaseTtlMs ?? 180_000,
        promptDigest,
        behavioralEnforcement: lease.behavioralEnforcement,
        downgradePolicy: "forbid",
      });

      broker.bindEffectiveChildCapability(lease.leaseId, lease.fencingToken, cap, nextTick());
      const issued = broker.issueLeaseCapability(lease.leaseId, lease.fencingToken, nextTick());
      const compiled = compileEffectiveChildCapability(cap);

      capabilitiesByLease.set(lease.leaseId, {
        capabilityFingerprint: cap.capabilityFingerprint,
        allowedTools: cap.allowedTools,
        promptRules: compiled.promptRules,
        capabilityPreview: issued.status === "issued" ? `${issued.capability.slice(0, 10)}…[sha256-bound]` : "unbound",
      });

      const usageSample = {
        input: 1_250,
        output: 320,
        cacheRead: 240,
        cacheWrite: 0,
      };
      broker.recordProviderUsage(lease.leaseId, lease.fencingToken, usageSample, nextTick());

      const sessionFile = forkSessionFile || `/tmp/pi-sessions/${taskId}.jsonl`;
      jobs.set(taskId, {
        jobId: taskId,
        kind: "task",
        status: "running",
        tier: selection.selection?.modelTier ?? "standard",
        task: trimmed,
        sessionFile,
        ...(forkSessionFile ? { forkSessionFile, resumeCount } : {}),
        ...(normalizedContextFiles.length ? { contextFiles: normalizedContextFiles } : {}),
        submittedAt: now,
        startedAt: now,
        updatedAt: now,
      });

      attempts.set(taskId, {
        attemptId: `${taskId}-a1`,
        logicalId: taskId,
        rootId: taskId,
        kind: "task",
        attempt: 1,
        role,
        state: "running",
        resourceId: lease.resourceId,
        provider: resourceMeta?.model?.provider ?? lease.resourceId.split("/")[0],
        modelId: resourceMeta?.model?.modelId ?? lease.resourceId.split("/")[1],
        requestedThinking: thinking,
        effectiveThinking: thinking,
        startedAt: now,
        lastProgressAt: now,
        usage: { ...usageSample, turns: 1 },
      });

      return {
        ok: true,
        status: "leased",
        taskId,
        lease: broker.leases().find((l) => l.leaseId === lease.leaseId) ?? lease,
        selection,
      };
    }

    if (reservation.status === "queued") {
      jobs.set(taskId, {
        jobId: taskId,
        kind: "task",
        status: "queued",
        tier: "standard",
        task: trimmed,
        submittedAt: now,
        updatedAt: now,
      });
      attempts.set(taskId, {
        attemptId: `${taskId}-q1`,
        logicalId: taskId,
        rootId: taskId,
        kind: "task",
        attempt: 1,
        role,
        state: "waiting_capacity",
        requestedThinking: thinking,
        effectiveThinking: thinking,
        startedAt: now,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 },
      });
      return {
        ok: true,
        status: "queued",
        taskId,
        reservation,
      };
    }

    return {
      ok: false,
      error: `Broker reservation returned ${reservation.status}`,
      reservation,
    };
  }

  function releaseLease({ leaseId, outcome = "completed" }) {
    const now = nextTick();
    const activeLease = broker.leases().find((item) => item.leaseId === leaseId);
    if (!activeLease) {
      return { ok: false, error: `Lease ${leaseId} is not active.` };
    }
    if (outcome === "completed") {
      broker.markProviderSucceeded(activeLease.leaseId, activeLease.fencingToken, now);
    }
    const released = broker.release(activeLease.leaseId, activeLease.fencingToken, outcome, nextTick());
    const taskId = activeLease.taskId;
    const job = jobs.get(taskId);
    const attempt = attempts.get(taskId);

    const completedAt = nextTick();
    if (job) {
      jobs.set(taskId, {
        ...job,
        status: outcome === "completed" ? "completed" : "cancelled",
        completedAt,
        updatedAt: completedAt,
      });
    }
    if (attempt) {
      attempts.delete(taskId);
      reports.set(taskId, {
        taskId,
        logicalId: taskId,
        status: outcome === "completed" ? "completed" : "cancelled",
        resourceId: attempt.resourceId,
        provider: attempt.provider,
        modelId: attempt.modelId,
        requestedThinking: attempt.requestedThinking,
        effectiveThinking: attempt.effectiveThinking,
        role: attempt.role,
        verificationStatus: outcome === "completed" ? "accepted" : "cancelled",
        startedAt: attempt.startedAt,
        completedAt,
        usage: attempt.usage,
      });
    }

    // Dispatch any waiting tasks if capacity freed up
    const dispatched = broker.dispatchPending(nextTick());
    for (const ready of dispatched) {
      const queuedJob = jobs.get(ready.taskId);
      if (queuedJob) {
        jobs.set(ready.taskId, { ...queuedJob, status: "running", startedAt: completedAt, updatedAt: completedAt });
      }
      const resourceMeta = registry.resources[ready.lease.resourceId];
      attempts.set(ready.taskId, {
        attemptId: `${ready.taskId}-a1`,
        logicalId: ready.taskId,
        rootId: ready.taskId,
        kind: "task",
        attempt: 1,
        role: "worker",
        state: "running",
        resourceId: ready.lease.resourceId,
        provider: resourceMeta?.model?.provider ?? ready.lease.resourceId.split("/")[0],
        modelId: resourceMeta?.model?.modelId ?? ready.lease.resourceId.split("/")[1],
        requestedThinking: "medium",
        effectiveThinking: "medium",
        startedAt: completedAt,
        lastProgressAt: completedAt,
        usage: { input: 600, output: 140, cacheRead: 0, cacheWrite: 0, turns: 1 },
      });
    }

    return { ok: true, released, dispatchedCount: dispatched.length };
  }

  function blockLease({ leaseId, question = "Clarify ambiguous requirement before modifying target module?" }) {
    const now = nextTick();
    const activeLease = broker.leases().find((item) => item.leaseId === leaseId);
    if (!activeLease) {
      return { ok: false, error: `Lease ${leaseId} is not active.` };
    }
    broker.markProviderSucceeded(activeLease.leaseId, activeLease.fencingToken, now);
    const released = broker.release(activeLease.leaseId, activeLease.fencingToken, "completed", nextTick());
    const taskId = activeLease.taskId;
    const job = jobs.get(taskId);
    const attempt = attempts.get(taskId);
    const completedAt = nextTick();
    const sessionFile = job?.sessionFile || `/tmp/pi-sessions/${taskId}.jsonl`;
    const cleanQuestion = String(question || "Clarify ambiguous requirement?").trim();

    if (job) {
      jobs.set(taskId, {
        ...job,
        status: "blocked",
        sessionFile,
        question: cleanQuestion,
        completedAt,
        updatedAt: completedAt,
      });
    }
    if (attempt) {
      attempts.delete(taskId);
      reports.set(taskId, {
        taskId,
        logicalId: taskId,
        status: "blocked",
        resourceId: attempt.resourceId,
        provider: attempt.provider,
        modelId: attempt.modelId,
        requestedThinking: attempt.requestedThinking,
        effectiveThinking: attempt.effectiveThinking,
        role: attempt.role,
        sessionFile,
        question: cleanQuestion,
        startedAt: attempt.startedAt,
        completedAt,
        usage: attempt.usage,
      });
    }
    return { ok: true, taskId, sessionFile, question: cleanQuestion, released };
  }

  function resumeTicket({ taskId, message = "Confirmed: proceed with the 15-minute TTL policy." }) {
    const job = jobs.get(taskId);
    if (!job) {
      return { ok: false, error: `Ticket ${taskId} not found.` };
    }
    if (!["blocked", "completed", "handback"].includes(job.status)) {
      return { ok: false, error: `Ticket ${taskId} cannot be resumed from status ${job.status}.` };
    }
    const sessionFile = job.sessionFile || `/tmp/pi-sessions/${taskId}.jsonl`;
    reports.delete(taskId);
    return delegateTask({
      taskId,
      taskDescription: `${job.task} [Resumed #${(job.resumeCount ?? 0) + 1}: ${String(message).trim()}]`,
      operationClass: "propose_patch",
      admissionClass: "control",
      thinking: "medium",
      role: "implementer",
      contextFiles: job.contextFiles ?? [],
      forkSessionFile: sessionFile,
      resumeCount: (job.resumeCount ?? 0) + 1,
    });
  }

  function recordBurstUsage({ leaseId }) {
    const now = nextTick();
    const activeLease = broker.leases().find((item) => item.leaseId === leaseId);
    if (!activeLease) {
      return { ok: false, error: `Lease ${leaseId} is not active.` };
    }
    const delta = { input: 2_048, output: 512, cacheRead: 512, cacheWrite: 0 };
    const result = broker.recordProviderUsage(activeLease.leaseId, activeLease.fencingToken, delta, now);
    const attempt = attempts.get(activeLease.taskId);
    if (attempt) {
      attempts.set(activeLease.taskId, {
        ...attempt,
        lastProgressAt: now,
        usage: {
          input: (attempt.usage?.input ?? 0) + delta.input + delta.cacheRead,
          output: (attempt.usage?.output ?? 0) + delta.output,
          cacheRead: (attempt.usage?.cacheRead ?? 0) + delta.cacheRead,
          cacheWrite: 0,
          turns: (attempt.usage?.turns ?? 1) + 1,
        },
      });
    }
    return { ok: true, result };
  }

  function setResourceCooldown({ resourceId, retryAfterMs = 60_000 }) {
    const now = nextTick();
    const res = broker.markRateLimited(resourceId, retryAfterMs, now);
    return { ok: true, result: res };
  }

  function setResourceHealthy({ resourceId }) {
    const now = nextTick();
    const res = broker.markHealthy(resourceId, now);
    return { ok: true, result: res };
  }

  function snapshot() {
    const now = nextTick();
    broker.expire(now);
    const jobList = [...jobs.values()];
    const reportList = [...reports.values()];
    const attemptList = [...attempts.values()];
    const fleet = buildFleetProjection({
      jobs: jobList,
      reports: reportList,
      attempts: attemptList,
      now,
      noProgressTimeoutMs: 180_000,
    });
    const activeLeases = broker.leases().map((lease) => ({
      ...lease,
      boundCapability: capabilitiesByLease.get(lease.leaseId) ?? null,
    }));
    const inventory = broker.inventory(now).map((item) => ({
      ...item,
      provenance: registry.resources[item.resourceId]?.provenance ?? null,
      catalog: registry.resources[item.resourceId]?.catalog ?? null,
    }));
    const recentEvents = broker.events().slice(-25).reverse();

    const resumableTickets = jobList
      .filter((j) => ["blocked", "handback"].includes(j.status))
      .map((j) => ({
        jobId: j.jobId,
        status: j.status,
        task: j.task,
        sessionFile: j.sessionFile || `/tmp/pi-sessions/${j.jobId}.jsonl`,
        question: j.question || j.handbackReason || "Awaiting parent guidance",
        contextFiles: j.contextFiles ?? [],
        resumeCount: j.resumeCount ?? 0,
      }));

    return {
      now,
      summary: fleetSummary(fleet),
      widgetLines: formatFleetWidget(fleet, { maxRows: 8, width: 112 }),
      fleetDetailsAll: formatFleetDetails(fleet, { selector: "all", maxRows: 50 }),
      fleet,
      leases: activeLeases,
      resumableTickets,
      inventory,
      pendingTasks: broker.pendingTasks(),
      profiles: registry.profiles,
      events: recentEvents,
    };
  }

  function close() {
    try {
      broker.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  seedInitialWork();

  return {
    snapshot,
    delegateTask,
    releaseLease,
    blockLease,
    resumeTicket,
    recordBurstUsage,
    setResourceCooldown,
    setResourceHealthy,
    simulateTaskSelection,
    close,
  };
}

let controller = createBrokerControllerState();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pi Delegation Broker Control Plane</title>
  <meta name="description" content="Interactive control plane, SQLite lease broker inspector, capability-aware model selector, and live fleet view for @sars267/pi-delegation-broker." />
  <meta property="og:title" content="Pi Delegation Broker Control Plane" />
  <meta property="og:description" content="Interactive control plane, SQLite lease broker inspector, capability-aware model selector, and live fleet view for @sars267/pi-delegation-broker." />
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #111827;
      --panel-alt: #161f33;
      --border: #26324d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-strong: #0284c7;
      --emerald: #34d399;
      --amber: #fbbf24;
      --rose: #fb7185;
      --mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.5;
    }
    header {
      border-bottom: 1px solid var(--border);
      background: #0d1320;
      padding: 1rem 1.5rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .brand {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .brand-title {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      font-weight: 700;
      font-size: 1.15rem;
      letter-spacing: -0.01em;
    }
    .tag {
      font-family: var(--mono);
      font-size: 0.72rem;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .subtitle {
      font-size: 0.84rem;
      color: var(--muted);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    nav {
      display: flex;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      background: #0e1525;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }
    .tab-btn {
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      padding: 0.45rem 0.9rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
    }
    .tab-btn[aria-selected="true"] {
      color: var(--accent);
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.35);
    }
    main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 1.25rem 1.5rem 2.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.9rem;
    }
    .kpi-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.9rem 1.1rem;
    }
    .kpi-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .kpi-value {
      font-family: var(--mono);
      font-size: 1.4rem;
      font-weight: 700;
      margin-top: 0.25rem;
    }
    .kpi-sub {
      font-size: 0.78rem;
      color: var(--muted);
      margin-top: 0.2rem;
      font-family: var(--mono);
    }
    .grid-2 {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 1.25rem;
    }
    @media (max-width: 1024px) {
      .grid-2 {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .panel {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.15rem;
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.65rem;
    }
    .panel-title {
      margin: 0;
      font-size: 0.98rem;
      font-weight: 600;
    }
    .terminal-box {
      background: #070a10;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 0.85rem 1rem;
      font-family: var(--mono);
      font-size: 0.79rem;
      color: #e2e8f0;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    label {
      font-size: 0.8rem;
      font-weight: 600;
      color: #cbd5e1;
    }
    input, select, textarea {
      background: #090d16;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 0.5rem 0.65rem;
      font-size: 0.85rem;
      font-family: var(--sans);
    }
    input:focus, select:focus, textarea:focus {
      outline: 2px solid var(--accent);
      border-color: transparent;
    }
    .btn {
      background: var(--accent-strong);
      color: #fff;
      border: 1px solid rgba(56, 189, 248, 0.4);
      border-radius: 6px;
      padding: 0.5rem 0.95rem;
      font-size: 0.84rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn:hover {
      background: #0369a1;
    }
    .btn-secondary {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: #1e293b;
    }
    .btn-danger {
      background: rgba(244, 63, 94, 0.16);
      color: var(--rose);
      border: 1px solid rgba(244, 63, 94, 0.4);
    }
    .btn-danger:hover {
      background: rgba(244, 63, 94, 0.26);
    }
    .btn-sm {
      padding: 0.3rem 0.6rem;
      font-size: 0.76rem;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    th, td {
      text-align: left;
      padding: 0.6rem 0.65rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mono {
      font-family: var(--mono);
    }
    .status-dot {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--mono);
      font-size: 0.76rem;
      font-weight: 600;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .dot-healthy, .dot-running, .dot-completed { background: var(--emerald); }
    .dot-waiting, .dot-cooling { background: var(--amber); }
    .dot-failed { background: var(--rose); }
    .banner {
      padding: 0.65rem 0.85rem;
      border-radius: 6px;
      font-size: 0.83rem;
      display: none;
    }
    .banner.show {
      display: block;
    }
    .banner-error {
      background: rgba(244, 63, 94, 0.14);
      border: 1px solid rgba(244, 63, 94, 0.4);
      color: #fda4af;
    }
    .banner-ok {
      background: rgba(52, 211, 153, 0.12);
      border: 1px solid rgba(52, 211, 153, 0.4);
      color: #6ee7b7;
    }
    .hidden {
      display: none !important;
    }
    .action-group {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-title">
        <span>@sars267/pi-delegation-broker</span>
        <span class="tag">v0.1.0-alpha.4 · SQLite WAL</span>
      </div>
      <div class="subtitle">Trusted Controller → Signed Registry → SQLite Lease Broker → Scoped Capability → Isolated Child Policy</div>
    </div>
    <div class="header-actions">
      <button type="button" class="btn btn-secondary" id="refreshBtn">Refresh Snapshot</button>
      <button type="button" class="btn btn-secondary" id="resetBtn">Reset Demo State</button>
    </div>
  </header>

  <nav role="tablist" aria-label="Broker Control Plane Views">
    <button type="button" role="tab" class="tab-btn" id="tab-fleet" aria-selected="true" aria-controls="view-fleet">Live Fleet &amp; SQLite Leases</button>
    <button type="button" role="tab" class="tab-btn" id="tab-inventory" aria-selected="false" aria-controls="view-inventory">Provider Inventory &amp; Cooldown Breakers</button>
    <button type="button" role="tab" class="tab-btn" id="tab-simulator" aria-selected="false" aria-controls="view-simulator">Capability Compiler &amp; Route Simulator</button>
    <button type="button" role="tab" class="tab-btn" id="tab-audit" aria-selected="false" aria-controls="view-audit">Durable SQLite Audit Ledger</button>
  </nav>

  <main>
    <section class="kpi-strip" aria-label="Broker Telemetry Summary">
      <div class="kpi-card">
        <div class="kpi-label">Fleet Status</div>
        <div class="kpi-value" id="kpiFleetStatus">—</div>
        <div class="kpi-sub" id="kpiFleetSummary">Loading fleet projection…</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active SQLite Leases</div>
        <div class="kpi-value" id="kpiActiveLeases">0</div>
        <div class="kpi-sub" id="kpiPendingCount">0 queued tasks</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Healthy Model Routes</div>
        <div class="kpi-value" id="kpiHealthyRoutes">0 / 0</div>
        <div class="kpi-sub" id="kpiCapacityGroups">3 capacity groups</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Ledger Events Recorded</div>
        <div class="kpi-value" id="kpiEventCount">0</div>
        <div class="kpi-sub">BEGIN IMMEDIATE serialized</div>
      </div>
    </section>

    <div id="feedbackBanner" class="banner" role="status" aria-live="polite"></div>

    <!-- VIEW 1: LIVE FLEET & LEASES -->
    <section id="view-fleet" role="tabpanel" aria-labelledby="tab-fleet">
      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Terminal Fleet Widget Projection (formatFleetWidget)</h2>
            <span class="tag">112 cols bounded</span>
          </div>
          <div class="terminal-box" id="widgetOutput" data-testid="fleet-widget-output">Loading terminal widget…</div>

          <div class="panel-header" style="margin-top: 0.4rem;">
            <h2 class="panel-title">Active SQLite Leases &amp; Fencing Tokens</h2>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task / Lease ID</th>
                  <th>Route &amp; Group</th>
                  <th>Fencing</th>
                  <th>Class / Enforcement</th>
                  <th>Tokens (In / Out)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="leasesTableBody"></tbody>
            </table>
          </div>
          <div class="panel-header" style="margin-top: 0.4rem;">
            <h2 class="panel-title">Resumable Blocked Tickets (broker_report → delegate_resume --fork)</h2>
            <span class="tag">0 Leases Held While Blocked</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket ID / Session Fork</th>
                  <th>Blocked Question / Handback</th>
                  <th>Resume Action (Re-acquires SQLite Lease)</th>
                </tr>
              </thead>
              <tbody id="ticketsTableBody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Delegate New Child Task (Thin Router + SQLite Lease)</h2>
          </div>
          <form id="delegateForm" novalidate>
            <div class="field" style="margin-bottom: 0.75rem;">
              <label for="taskDescriptionInput">Task Objective Description</label>
              <textarea id="taskDescriptionInput" rows="2" placeholder="e.g., Audit the entire repository for unused exports and verify test coverage"></textarea>
            </div>
            <div class="field" style="margin-bottom: 0.75rem;">
              <label for="contextFilesInput">Thin Router Context File Pointers (contextFiles, comma-separated)</label>
              <input id="contextFilesInput" type="text" placeholder="src/broker.mjs, src/ipc.mjs" value="src/broker.mjs, src/capability-compiler.mjs" />
            </div>
            <div class="form-grid" style="margin-bottom: 0.75rem;">
              <div class="field">
                <label for="operationClassSelect">Operation Class</label>
                <select id="operationClassSelect">
                  <option value="observe">observe (read-only)</option>
                  <option value="propose_patch">propose_patch (auto-declared worktree)</option>
                  <option value="apply">apply (hard token caps)</option>
                </select>
              </div>
              <div class="field">
                <label for="admissionClassSelect">Admission Class</label>
                <select id="admissionClassSelect">
                  <option value="work">work (standard pool)</option>
                  <option value="control">control (protected reserve)</option>
                  <option value="verify">verify (verification pass)</option>
                </select>
              </div>
              <div class="field">
                <label for="thinkingSelect">Reasoning Effort</label>
                <select id="thinkingSelect">
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="low">low</option>
                  <option value="off">off</option>
                </select>
              </div>
              <div class="field">
                <label for="roleInput">Child Role</label>
                <input id="roleInput" type="text" value="worker" />
              </div>
            </div>
            <div class="field" style="margin-bottom: 0.9rem;">
              <label for="doneWhenInput">Controller Acceptance Criterion (doneWhen)</label>
              <input id="doneWhenInput" type="text" value="Return controller-verifiable evidence references for the delegated task" />
            </div>
            <button type="submit" class="btn">Select Route &amp; Reserve SQLite Lease</button>
          </form>

          <div class="panel-header" style="margin-top: 0.5rem;">
            <h2 class="panel-title">Fleet Drill-Down (/delegation-broker fleet all)</h2>
          </div>
          <div class="terminal-box" id="fleetDetailsOutput">Loading fleet details…</div>
        </div>
      </div>
    </section>

    <!-- VIEW 2: PROVIDER INVENTORY & COOLDOWN BREAKERS -->
    <section id="view-inventory" role="tabpanel" aria-labelledby="tab-inventory" class="hidden">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Registered Provider Catalog &amp; Capacity Group Breakers</h2>
          <span class="tag">broker.inventory(now)</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Resource ID</th>
                <th>Capacity Group</th>
                <th>Capability Profile</th>
                <th>Health / Breaker</th>
                <th>Active / Max Slots</th>
                <th>Provenance / Pool</th>
                <th>Fault Injection / Recovery</th>
              </tr>
            </thead>
            <tbody id="inventoryTableBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- VIEW 3: CAPABILITY COMPILER & ROUTE SIMULATOR -->
    <section id="view-simulator" role="tabpanel" aria-labelledby="tab-simulator" class="hidden">
      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Simulate Capability Derivation &amp; Model Selector</h2>
          </div>
          <form id="simulateForm" novalidate>
            <div class="field" style="margin-bottom: 0.75rem;">
              <label for="simPromptInput">Candidate Task Description</label>
              <textarea id="simPromptInput" rows="3">Inspect screenshot and refactor the authentication module across the entire repository</textarea>
            </div>
            <div class="form-grid" style="margin-bottom: 0.85rem;">
              <div class="field">
                <label for="simOperationClass">Operation Class</label>
                <select id="simOperationClass">
                  <option value="observe">observe</option>
                  <option value="propose_patch" selected>propose_patch</option>
                  <option value="apply">apply</option>
                </select>
              </div>
              <div class="field">
                <label for="simAdmissionClass">Admission Class</label>
                <select id="simAdmissionClass">
                  <option value="work">work</option>
                  <option value="control">control</option>
                  <option value="verify">verify</option>
                </select>
              </div>
            </div>
            <button type="submit" class="btn">Compile Effective Child Capability</button>
          </form>
          <div class="panel-header" style="margin-top: 0.5rem;">
            <h2 class="panel-title">Selector Decision &amp; Derived Requirements</h2>
          </div>
          <div class="terminal-box" id="simDecisionOutput">Run simulation to inspect capability selection…</div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Compiled Child System Prompt Rules (compileEffectiveChildCapability)</h2>
          </div>
          <div class="terminal-box" id="simPromptRulesOutput">Run simulation to inspect compiled prompt rules…</div>
        </div>
      </div>
    </section>

    <!-- VIEW 4: DURABLE SQLITE AUDIT LEDGER -->
    <section id="view-audit" role="tabpanel" aria-labelledby="tab-audit" class="hidden">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">SQLite Broker Transactional Event Log (broker.events)</h2>
          <span class="tag">Redacted &amp; Monotonic</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Seq #</th>
                <th>Timestamp</th>
                <th>Event Type</th>
                <th>Redacted Payload</th>
              </tr>
            </thead>
            <tbody id="eventsTableBody"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <script>
    const tabs = [
      { btn: "tab-fleet", view: "view-fleet" },
      { btn: "tab-inventory", view: "view-inventory" },
      { btn: "tab-simulator", view: "view-simulator" },
      { btn: "tab-audit", view: "view-audit" },
    ];

    tabs.forEach(({ btn, view }) => {
      document.getElementById(btn).addEventListener("click", () => {
        tabs.forEach((t) => {
          const active = t.btn === btn;
          document.getElementById(t.btn).setAttribute("aria-selected", active ? "true" : "false");
          document.getElementById(t.view).classList.toggle("hidden", !active);
        });
      });
    });

    function showBanner(message, isError = false) {
      const banner = document.getElementById("feedbackBanner");
      banner.textContent = message;
      banner.className = "banner show " + (isError ? "banner-error" : "banner-ok");
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    async function loadState() {
      const res = await fetch("/api/state");
      const data = await res.json();
      renderState(data);
    }

    function renderState(data) {
      const counts = data.fleet?.counts ?? {};
      const activeTotal = (counts.running || 0) + (counts.retrying || 0) + (counts.waiting || 0);
      document.getElementById("kpiFleetStatus").textContent = activeTotal > 0 ? activeTotal + " active" : "Idle";
      document.getElementById("kpiFleetSummary").textContent = data.summary || "Delegation idle";
      document.getElementById("kpiActiveLeases").textContent = String(data.leases.length);
      document.getElementById("kpiPendingCount").textContent = data.pendingTasks.length + " tracked in pending_tasks";

      const healthyCount = data.inventory.filter((r) => r.state === "healthy" && r.breakerState === "healthy").length;
      document.getElementById("kpiHealthyRoutes").textContent = healthyCount + " / " + data.inventory.length;
      const uniqueGroups = new Set(data.inventory.map((r) => r.capacityGroup)).size;
      document.getElementById("kpiCapacityGroups").textContent = uniqueGroups + " capacity groups";
      document.getElementById("kpiEventCount").textContent = String(data.events[0]?.sequence ?? data.events.length);

      document.getElementById("widgetOutput").textContent =
        (data.widgetLines && data.widgetLines.length > 0)
          ? data.widgetLines.join("\\n")
          : data.summary + "\\n(No active volatile attempts)";

      document.getElementById("fleetDetailsOutput").textContent = data.fleetDetailsAll || "";

      const leasesBody = document.getElementById("leasesTableBody");
      if (data.leases.length === 0) {
        leasesBody.innerHTML = '<tr><td colspan="6" style="color: var(--muted);">No active SQLite leases. Delegate a task on the right to issue a new lease.</td></tr>';
      } else {
        leasesBody.innerHTML = data.leases.map((lease) => {
          const enf = (lease.enforcement?.input || "—") + " / " + (lease.enforcement?.output || "—");
          const usage = (lease.usage?.input ?? 0) + " / " + (lease.usage?.output ?? 0);
          return \`<tr>
            <td class="mono">
              <div><strong>\${escapeHtml(lease.taskId)}</strong></div>
              <div style="color: var(--muted); font-size: 0.73rem;">\${escapeHtml(lease.leaseId.slice(0, 12))}…</div>
            </td>
            <td class="mono">
              <div>\${escapeHtml(lease.resourceId)}</div>
              <div style="color: var(--muted); font-size: 0.73rem;">\${escapeHtml(lease.capacityGroup)}</div>
            </td>
            <td class="mono">#\${escapeHtml(lease.fencingToken)}</td>
            <td class="mono">
              <div>\${escapeHtml(lease.admissionClass)}</div>
              <div style="color: var(--muted); font-size: 0.73rem;">\${escapeHtml(enf)}</div>
            </td>
            <td class="mono">\${escapeHtml(usage)}</td>
            <td>
              <div class="action-group">
                <button type="button" class="btn btn-secondary btn-sm" data-action="usage" data-lease="\${escapeHtml(lease.leaseId)}" aria-label="Record token usage for \${escapeHtml(lease.taskId)}">+Tokens</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="block" data-lease="\${escapeHtml(lease.leaseId)}" aria-label="Block \${escapeHtml(lease.taskId)} via broker_report">Block (broker_report)</button>
                <button type="button" class="btn btn-sm" data-action="complete" data-lease="\${escapeHtml(lease.leaseId)}" aria-label="Release completed \${escapeHtml(lease.taskId)}">Complete &amp; Release</button>
              </div>
            </td>
          </tr>\`;
        }).join("");
      }

      const ticketsBody = document.getElementById("ticketsTableBody");
      const tickets = data.resumableTickets || [];
      if (tickets.length === 0) {
        ticketsBody.innerHTML = '<tr><td colspan="3" style="color: var(--muted);">No blocked tickets awaiting parent clarification. Click "Block (broker_report)" on an active lease above to test session suspension.</td></tr>';
      } else {
        ticketsBody.innerHTML = tickets.map((t) => \`<tr>
          <td class="mono">
            <div><strong>\${escapeHtml(t.jobId)}</strong> <span class="tag">\${escapeHtml(t.status)}</span></div>
            <div style="color: var(--muted); font-size: 0.72rem;">--fork \${escapeHtml(t.sessionFile)}</div>
          </td>
          <td style="font-size: 0.8rem;">
            <div style="color: var(--amber);">\${escapeHtml(t.question)}</div>
            \${t.contextFiles && t.contextFiles.length ? \`<div class="mono" style="color: var(--muted); font-size: 0.71rem;">contextFiles: \${escapeHtml(t.contextFiles.join(", "))}</div>\` : ""}
          </td>
          <td>
            <button type="button" class="btn btn-sm" data-action="resume-ticket" data-task="\${escapeHtml(t.jobId)}" aria-label="Resume ticket \${escapeHtml(t.jobId)} with --fork">Resume Ticket (--fork)</button>
          </td>
        </tr>\`).join("");
      }

      const invBody = document.getElementById("inventoryTableBody");
      invBody.innerHTML = data.inventory.map((item) => {
        const isHealthy = item.state === "healthy" && item.breakerState === "healthy";
        const dotClass = isHealthy ? "dot-healthy" : "dot-cooling";
        const statusLabel = isHealthy ? "healthy" : \`\${item.state} / \${item.breakerState}\`;
        const pool = item.provenance ? \`\${item.provenance.providerClass} · \${item.provenance.billingPool}\` : "native";
        return \`<tr>
          <td class="mono"><strong>\${escapeHtml(item.resourceId)}</strong></td>
          <td class="mono">\${escapeHtml(item.capacityGroup)}</td>
          <td class="mono" style="font-size: 0.75rem;">\${escapeHtml(item.profile)}</td>
          <td><span class="status-dot"><span class="dot \${dotClass}"></span>\${escapeHtml(statusLabel)}</span></td>
          <td class="mono">\${escapeHtml(item.activeLeases)} / \${escapeHtml(item.maxConcurrent)} (ctrl reserve: \${escapeHtml(item.controlReserve)})</td>
          <td class="mono" style="font-size: 0.75rem;">\${escapeHtml(pool)}</td>
          <td>
            <div class="action-group">
              <button type="button" class="btn btn-danger btn-sm" data-action="cooldown" data-resource="\${escapeHtml(item.resourceId)}" aria-label="Trigger 429 cooldown on \${escapeHtml(item.resourceId)}">Trigger 429 Cooldown</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="recover" data-resource="\${escapeHtml(item.resourceId)}" aria-label="Recover \${escapeHtml(item.resourceId)}">Mark Healthy</button>
            </div>
          </td>
        </tr>\`;
      }).join("");

      const eventsBody = document.getElementById("eventsTableBody");
      eventsBody.innerHTML = data.events.map((ev) => \`<tr>
        <td class="mono">#\${escapeHtml(ev.sequence)}</td>
        <td class="mono">\${escapeHtml(new Date(ev.at).toISOString())}</td>
        <td class="mono"><strong>\${escapeHtml(ev.type)}</strong></td>
        <td class="mono" style="font-size: 0.75rem; color: #cbd5e1;">\${escapeHtml(JSON.stringify(ev.payload))}</td>
      </tr>\`).join("");
    }

    document.getElementById("leasesTableBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const leaseId = btn.getAttribute("data-lease");
      const action = btn.getAttribute("data-action");
      if (action === "complete") {
        const res = await fetch("/api/lease/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leaseId, outcome: "completed" }),
        });
        const out = await res.json();
        showBanner(out.ok ? \`Released lease \${leaseId.slice(0, 8)}… and finalized task.\` : out.error, !out.ok);
        await loadState();
      } else if (action === "block") {
        const res = await fetch("/api/lease/block", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            leaseId,
            question: "Should we preserve legacy fallback or enforce strict schema v1?",
          }),
        });
        const out = await res.json();
        showBanner(
          out.ok
            ? \`Ticket \${out.taskId} settled as blocked via broker_report: SQLite lease released, session saved at \${out.sessionFile}.\`
            : out.error,
          !out.ok,
        );
        await loadState();
      } else if (action === "usage") {
        const res = await fetch("/api/lease/usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leaseId }),
        });
        const out = await res.json();
        showBanner(out.ok ? \`Recorded +2,560 input / +512 output tokens on lease \${leaseId.slice(0, 8)}…\` : out.error, !out.ok);
        await loadState();
      }
    });

    document.getElementById("ticketsTableBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action='resume-ticket']");
      if (!btn) return;
      const taskId = btn.getAttribute("data-task");
      const res = await fetch("/api/ticket/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          message: "Confirmed: use 15-minute TTL and complete the patch.",
        }),
      });
      const out = await res.json();
      showBanner(
        out.ok
          ? \`Resumed ticket \${taskId} via delegate_resume (--fork) on route \${out.lease?.resourceId || "queue"} (fencing token #\${out.lease?.fencingToken ?? "—"}!).\`
          : out.error,
        !out.ok,
      );
      await loadState();
    });

    document.getElementById("inventoryTableBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const resourceId = btn.getAttribute("data-resource");
      const action = btn.getAttribute("data-action");
      if (action === "cooldown") {
        const res = await fetch("/api/resource/rate-limit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceId, retryAfterMs: 90000 }),
        });
        const out = await res.json();
        showBanner(out.ok ? \`Marked \${resourceId} capacity group cooling_down (429 rate limit).\` : out.error, !out.ok);
        await loadState();
      } else if (action === "recover") {
        const res = await fetch("/api/resource/healthy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceId }),
        });
        const out = await res.json();
        showBanner(out.ok ? \`Restored \${resourceId} and its capacity group to healthy.\` : out.error, !out.ok);
        await loadState();
      }
    });

    document.getElementById("delegateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const taskDescription = document.getElementById("taskDescriptionInput").value.trim();
      if (!taskDescription) {
        showBanner("Please enter a non-empty task objective description before delegating.", true);
        return;
      }
      const rawContextFiles = document.getElementById("contextFilesInput").value || "";
      const contextFiles = rawContextFiles.split(",").map((s) => s.trim()).filter(Boolean);
      const payload = {
        taskDescription,
        contextFiles,
        operationClass: document.getElementById("operationClassSelect").value,
        admissionClass: document.getElementById("admissionClassSelect").value,
        thinking: document.getElementById("thinkingSelect").value,
        role: document.getElementById("roleInput").value.trim() || "worker",
        doneWhen: document.getElementById("doneWhenInput").value.trim() || "Return verifiable evidence",
      };
      const res = await fetch("/api/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await res.json();
      if (!out.ok) {
        showBanner(out.error || "Delegation failed", true);
      } else {
        document.getElementById("taskDescriptionInput").value = "";
        showBanner(\`Task \${out.taskId} \${out.status} on route \${out.lease?.resourceId || "queue"} (fencing token #\${out.lease?.fencingToken ?? "—"}).\`);
      }
      await loadState();
    });

    async function runSimulation() {
      const taskDescription = document.getElementById("simPromptInput").value.trim();
      if (!taskDescription) {
        showBanner("Simulation requires a candidate task description.", true);
        return;
      }
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskDescription,
          operationClass: document.getElementById("simOperationClass").value,
          admissionClass: document.getElementById("simAdmissionClass").value,
        }),
      });
      const out = await res.json();
      document.getElementById("simDecisionOutput").textContent = JSON.stringify({
        derivedRequirement: out.derived,
        selectorAction: out.selection?.action,
        selectedProfile: out.selection?.selection?.profile ?? null,
        preferredResource: out.selection?.selection?.resourceId ?? null,
        modelTier: out.selection?.selection?.modelTier ?? null,
        candidateResources: out.selection?.contract?.capability?.allowedResources ?? [],
        budget: out.selection?.contract?.budget ?? null,
      }, null, 2);
      document.getElementById("simPromptRulesOutput").textContent =
        out.compiledCapability?.promptRules || ("Selection denied: " + (out.selection?.reason || "unknown"));
    }

    document.getElementById("simulateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await runSimulation();
    });

    document.getElementById("refreshBtn").addEventListener("click", () => loadState());
    document.getElementById("resetBtn").addEventListener("click", async () => {
      await fetch("/api/reset", { method: "POST" });
      showBanner("Broker SQLite state reset and re-seeded.");
      await loadState();
    });

    loadState();
    runSimulation();
  </script>
</body>
</html>`;

export function createAppServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost:3000");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, controller.snapshot());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/delegate") {
        const body = await readJsonBody(req);
        const result = controller.delegateTask(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/lease/release") {
        const body = await readJsonBody(req);
        const result = controller.releaseLease(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/lease/block") {
        const body = await readJsonBody(req);
        const result = controller.blockLease(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ticket/resume") {
        const body = await readJsonBody(req);
        const result = controller.resumeTicket(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/lease/usage") {
        const body = await readJsonBody(req);
        const result = controller.recordBurstUsage(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/resource/rate-limit") {
        const body = await readJsonBody(req);
        const result = controller.setResourceCooldown(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/resource/healthy") {
        const body = await readJsonBody(req);
        const result = controller.setResourceHealthy(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/simulate") {
        const body = await readJsonBody(req);
        if (!body.taskDescription || typeof body.taskDescription !== "string" || !body.taskDescription.trim()) {
          sendJson(res, 400, { ok: false, error: "taskDescription is required" });
          return;
        }
        const result = controller.simulateTaskSelection(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const old = controller;
        controller = createBrokerControllerState();
        old.close();
        sendJson(res, 200, { ok: true, state: controller.snapshot() });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Pi Delegation Broker Control Plane listening on http://0.0.0.0:${port}`);
  });
}
