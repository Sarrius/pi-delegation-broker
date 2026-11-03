import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";
import { createEffectiveChildCapability, deriveAllowedTools } from "../src/capability-compiler.mjs";
import {
  markTaskAdmitted,
  readJob,
  resumeTaskJob,
  submitJob,
  updateJob,
} from "../src/delegation-job-store.mjs";
import { composeTaskPrompt, normalizeWork } from "../src/delegation-policy.mjs";
import { buildFleetProjection, formatDelegationStatus, formatFleetDetails } from "../src/fleet-view.mjs";
import { BrokerIpcServer, requestBrokerIpc } from "../src/ipc.mjs";
import { ParentWakeCoordinator } from "../src/parent-wake.mjs";
import {
  claimReportWake,
  markReportRead,
  markReportWoken,
  readReport,
  resetReportForResume,
  unreadReports,
  writeReport,
} from "../src/report-store.mjs";
import { formatUnreadNotice } from "../src/unread-notice.mjs";

import { Semaphore } from "../src/semaphore.mjs";

test("Stage 3: Thin Router normalizeWork provides defaults when benefit/parentWork are omitted, rejects empty strings, and composes contextFiles pointers", () => {
  const normalized = normalizeWork({
    taskClass: "implementation",
    deliverable: "Updated SQLite lease reservation handler",
    contextFiles: [" src/broker.mjs ", "src/ipc.mjs", "src/broker.mjs"],
  });
  assert.equal(
    normalized.benefit,
    "Independent execution in isolated child context",
  );
  assert.equal(
    normalized.parentWork,
    "Coordinate sibling tasks and integrate verified child findings",
  );
  assert.deepEqual(normalized.contextFiles, ["src/broker.mjs", "src/ipc.mjs"]);

  assert.throws(
    () =>
      normalizeWork({
        taskClass: "implementation",
        deliverable: "Patch",
        benefit: "",
      }),
    /work benefit must be bounded single-line text/,
    "explicit empty string benefit must still be rejected",
  );
  assert.throws(
    () =>
      normalizeWork({
        taskClass: "implementation",
        deliverable: "Patch",
        benefit: "valid",
        parentWork: "   ",
      }),
    /work parentWork must be bounded single-line text/,
    "explicit whitespace-only parentWork must still be rejected",
  );

  const composed = composeTaskPrompt("Inspect the lease reservation flow", normalized.contextFiles);
  assert.match(composed, /Inspect the lease reservation flow/);
  assert.match(composed, /Context file pointers \(read directly with your read tool; do not wait for parent summaries\):/);
  assert.match(composed, /- src\/broker\.mjs\n- src\/ipc\.mjs/);
  assert.equal(composeTaskPrompt("Plain task", []), "Plain task");
});

test("Stage 1 & 2: BrokeredChildRunner settles blocked and handback via broker_report without failover retry and forwards forkSessionFile on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-hybrid-runner-"));
  const spawnCalls = [];
  let providerSucceededCalls = 0;
  let rateLimitCalls = 0;

  try {
    const resolver = {
      async resolve(request) {
        return {
          action: "allow",
          policy: {
            policyId: `lease-${request.childId}`,
            agentDir: mkdtempSync(join(tmpdir(), "br-agent-")),
            environment: {
              PI_BROKER_SOCKET: "/tmp/test-broker.sock",
              PI_BROKER_LEASE_ID: `lease-${request.childId}`,
              PI_BROKER_FENCING_TOKEN: "1",
              PI_BROKER_CAPABILITY: "test-capability",
            },
            onChildSessionOpened: () => {},
            onChildSessionClosed: () => {},
            onBeforeChildAbandoned: () => {},
            onProviderSucceeded: () => {
              providerSucceededCalls++;
            },
            onRateLimit: () => {
              rateLimitCalls++;
            },
          },
        };
      },
    };

    const runner = new BrokeredChildRunner({
      resolver,
      semaphore: new Semaphore(1),
      sessionsRoot: join(root, "sessions"),
      spawnChild: async (spec) => {
        spawnCalls.push(spec);
        const isSecondTurn = Boolean(spec.forkSessionFile);
        const report = isSecondTurn
          ? {
              state: "ready",
              summary: "Resolved schema migration after parent clarification.",
              at: 2_000,
            }
          : {
              state: "blocked",
              summary: "Inspected src/broker.mjs and found two possible column names.",
              question: "Should we name the column session_file or ticket_session_file?",
              at: 1_000,
            };
        let listener;
        const session = {
          sessionFile: "/tmp/pi-ticket-session-42.jsonl",
          lastChildReport: report,
          latestAssistantMessage: isSecondTurn
            ? {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: "Completed migration cleanly." }],
              }
            : {
                role: "assistant",
                stopReason: "aborted",
                errorMessage: "Operation was aborted",
                content: [],
              },
          usage: { input: 400, output: 120, cacheRead: 0, cacheWrite: 0, turns: 1 },
          subscribe(fn) {
            listener = fn;
            return () => {};
          },
          async prompt() {
            listener?.({
              type: "tool_execution_end",
              toolName: "broker_report",
              result: {
                details: {
                  brokerChildReport: report,
                },
              },
            });
          },
          async dispose() {},
        };
        return {
          session,
          resolved: {
            provider: "broker-fake",
            modelId: "lease-fake",
            sessionFile: "/tmp/pi-ticket-session-42.jsonl",
          },
        };
      },
    });

    const model = { provider: "broker-fake", modelId: "lease-fake" };

    // Turn 1: Worker calls broker_report({ state: "blocked", question })
    const turn1 = await runner.run({
      childId: "ticket-1",
      model,
      prompt: "Add session column",
      cwd: root,
      maxAttempts: 3,
    });

    assert.equal(turn1.status, "blocked");
    assert.equal(turn1.question, "Should we name the column session_file or ticket_session_file?");
    assert.equal(turn1.sessionFile, "/tmp/pi-ticket-session-42.jsonl");
    assert.equal(turn1.route.length, 1, "blocked must not trigger failover retries");
    assert.equal(turn1.route[0].outcome, "blocked");
    assert.equal(providerSucceededCalls, 1, "blocked is a healthy provider completion");
    assert.equal(rateLimitCalls, 0);
    assert.equal(spawnCalls[0].forkSessionFile, undefined);

    // Turn 2: Parent resumes the ticket with forkSessionFile
    const turn2 = await runner.run({
      childId: "ticket-1",
      model,
      prompt: "Use session_file and finish the migration.",
      forkSessionFile: turn1.sessionFile,
      cwd: root,
      maxAttempts: 3,
    });

    assert.equal(turn2.status, "completed");
    assert.equal(turn2.sessionFile, "/tmp/pi-ticket-session-42.jsonl");
    assert.equal(spawnCalls[1].forkSessionFile, "/tmp/pi-ticket-session-42.jsonl");
    assert.equal(providerSucceededCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stage 2: Resumable Ticket lifecycle across delegation-job-store, report-store, parent-wake, unread-notice, and fleet-view", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-lifecycle-"));
  const jobsDir = join(dir, "jobs");
  const reportsDir = join(dir, "reports");
  try {
    const { created, job } = submitJob(jobsDir, {
      schemaVersion: 1,
      jobId: "ticket-auth",
      kind: "task",
      status: "submitted",
      tier: "standard",
      cwd: dir,
      task: "Implement OAuth token refresh",
      ownerSessionId: "parent-session-1",
      contract: {
        thinking: "auto",
        route: "auto",
        work: normalizeWork({
          taskClass: "implementation",
          deliverable: "OAuth refresh token module",
          contextFiles: ["src/scoped-child-auth.mjs"],
        }),
      },
      submittedAt: 1_000,
      updatedAt: 1_000,
    });
    assert.equal(created, true);
    assert.equal(job.status, "submitted");

    markTaskAdmitted(jobsDir, "ticket-auth", 1_100, { maxAttempts: 3 });

    // Worker finishes Turn 1 in "blocked" state with a saved sessionFile
    const blockedJob = updateJob(
      jobsDir,
      "ticket-auth",
      (current) => ({
        ...current,
        status: "blocked",
        completedAt: 1_500,
        sessionFile: "/tmp/session-ticket-auth.jsonl",
        question: "Should refresh tokens expire after 15 minutes or 60 minutes?",
      }),
      1_500,
    );
    assert.equal(blockedJob.status, "blocked");
    assert.equal(blockedJob.sessionFile, "/tmp/session-ticket-auth.jsonl");
    assert.equal(blockedJob.question, "Should refresh tokens expire after 15 minutes or 60 minutes?");

    writeReport(reportsDir, {
      taskId: "ticket-auth",
      logicalId: "ticket-auth",
      task: "Implement OAuth token refresh",
      status: "blocked",
      text: "Blocked on refresh token TTL policy.",
      question: "Should refresh tokens expire after 15 minutes or 60 minutes?",
      sessionFile: "/tmp/session-ticket-auth.jsonl",
      ownerSessionId: "parent-session-1",
      startedAt: 1_100,
      completedAt: 1_500,
    });

    const unread = unreadReports(reportsDir);
    assert.equal(unread.length, 1);
    const notice = formatUnreadNotice(unread);
    assert.match(
      notice,
      /ticket-auth: blocked \(question: Should refresh tokens expire after 15 minutes or 60 minutes\?\)/,
    );

    // ParentWakeCoordinator wakes parent on blocked report
    const sentMessages = [];
    const wake = new ParentWakeCoordinator({
      delayMs: 0,
      sendMessage(msg, opts) {
        sentMessages.push({ msg, opts });
      },
      claimWake: (taskId) => claimReportWake(reportsDir, taskId, 1_550),
      markWoken: (taskId) => markReportWoken(reportsDir, taskId, 1_560),
      loadReport: (taskId) => readReport(reportsDir, taskId),
    });
    assert.equal(wake.enqueue(readReport(reportsDir, "ticket-auth")), true);
    assert.equal(await wake.flush(), true);
    assert.equal(sentMessages.length, 1);
    assert.equal(await wake.acknowledge("ticket-auth"), true);
    assert.notEqual(readReport(reportsDir, "ticket-auth").wakeAt, null);

    markReportRead(reportsDir, "ticket-auth", 1_600);
    assert.notEqual(readReport(reportsDir, "ticket-auth").readAt, null);

    // Check Fleet projection while ticket is blocked
    const fleetBlocked = buildFleetProjection({
      jobs: [readJob(jobsDir, "ticket-auth")],
      reports: [readReport(reportsDir, "ticket-auth")],
      attempts: [],
      now: 1_700,
    });
    assert.equal(fleetBlocked.counts.blocked, 1);
    assert.match(
      formatDelegationStatus(readJob(jobsDir, "ticket-auth"), fleetBlocked),
      /ticket-auth: blocked/,
    );
    assert.match(formatFleetDetails(fleetBlocked, { selector: "all" }), /blocked/);

    // Now parent calls delegate_resume!
    resetReportForResume(reportsDir, "ticket-auth");
    wake.resetTask("ticket-auth");
    assert.equal(readReport(reportsDir, "ticket-auth"), undefined);

    const resumedJob = resumeTaskJob(jobsDir, "ticket-auth", {
      message: "Use 15 minutes TTL and complete the implementation.",
      ownerSessionId: "parent-session-1",
      now: 2_000,
    });
    assert.equal(resumedJob.status, "submitted");
    assert.equal(resumedJob.forkSessionFile, "/tmp/session-ticket-auth.jsonl");
    assert.equal(resumedJob.resumePrompt, "Use 15 minutes TTL and complete the implementation.");
    assert.equal(resumedJob.resumeCount, 1);
    assert.equal(resumedJob.question, undefined);

    // Turn 2 completes and wakes parent a second time cleanly
    markTaskAdmitted(jobsDir, "ticket-auth", 2_100, { maxAttempts: 3 });
    updateJob(
      jobsDir,
      "ticket-auth",
      (current) => ({
        ...current,
        status: "completed",
        completedAt: 2_500,
        sessionFile: "/tmp/session-ticket-auth.jsonl",
      }),
      2_500,
    );
    const finalReport = writeReport(reportsDir, {
      taskId: "ticket-auth",
      logicalId: "ticket-auth",
      task: "Implement OAuth token refresh",
      status: "completed",
      text: "Implemented 15-minute refresh token TTL.",
      sessionFile: "/tmp/session-ticket-auth.jsonl",
      ownerSessionId: "parent-session-1",
      startedAt: 2_100,
      completedAt: 2_500,
    });
    assert.equal(finalReport.readAt, null, "resumed report must start unread");
    assert.equal(wake.enqueue(finalReport), true);
    assert.equal(await wake.flush(), true, "resumed report must wake parent cleanly");
    assert.equal(sentMessages.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stage 1 & 4: pi-behavioral-enforcement registers broker_report and auto-declares propose_patch in propose_patch operationClass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "behavioral-hybrid-"));
  const broker = new SqliteLeaseBroker({
    path: join(directory, "broker.sqlite"),
    registry: fixtureRegistry(),
    behavioralEnforcement: "blocking_monitor",
  });
  const server = new BrokerIpcServer({
    broker,
    socketPath: join(directory, "broker.sock"),
  });
  const hooks = new Map();
  const tools = new Map();
  const saved = {};

  try {
    await server.start();
    const contract = fixtureContract({
      taskId: "propose-patch-ergonomics",
      operationClass: "propose_patch",
    });
    const reservation = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "reserve",
      params: { contract },
    });
    assert.equal(reservation.status, "leased");
    const lease = reservation.lease;
    const capability = createEffectiveChildCapability({
      schemaVersion: 1,
      taskId: "propose-patch-ergonomics",
      operationClass: "propose_patch",
      admissionClass: contract.admissionClass,
      doneWhen: contract.doneWhen,
      allowedTools: deriveAllowedTools("propose_patch"),
      profileSupports: contract.capability.required,
      budget: {
        maxInputTokens: lease.maxInputTokens,
        maxOutputTokens: lease.maxOutputTokens,
        enforcement: lease.enforcement,
      },
      latencyBudgetMs: contract.latencyBudgetMs,
      leaseTtlMs: contract.leaseTtlMs,
      promptDigest: contract.promptDigest,
      behavioralEnforcement: lease.behavioralEnforcement,
      downgradePolicy: contract.capability.downgradePolicy,
    });
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "bindEffectiveChildCapability",
      params: { leaseId: lease.leaseId, fencingToken: lease.fencingToken, capability },
    });
    const issued = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "issueLeaseCapability",
      params: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
    });

    for (const [key, value] of Object.entries({
      PI_BROKER_SOCKET: server.socketPath,
      PI_BROKER_CAPABILITY: issued.capability,
      PI_BROKER_LEASE_ID: lease.leaseId,
      PI_BROKER_FENCING_TOKEN: String(lease.fencingToken),
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    const { default: extension } = await import("../extensions/pi-behavioral-enforcement.ts");
    let active = ["read", "propose_patch"];
    let aborts = 0;
    extension({
      registerTool(def) {
        tools.set(def.name, def);
      },
      on(name, fn) {
        hooks.set(name, fn);
      },
      getActiveTools() {
        return active;
      },
      setActiveTools(names) {
        active = names;
      },
    });

    await hooks.get("session_start")({}, {});
    assert.equal(tools.has("broker_report"), true);
    assert.equal(active.includes("broker_report"), true);

    // 1. Direct propose_patch call without prior broker_declare_action succeeds via auto-declaration
    const patchCall = {
      toolName: "propose_patch",
      toolCallId: "patch-1",
      input: { path: "src/example.mjs", content: "export const x = 1;\n" },
    };
    const gateDecision = await hooks.get("tool_call")(patchCall);
    assert.equal(gateDecision, undefined, "propose_patch should be auto-declared and allowed");
    const obsDecision = await hooks.get("tool_result")(
      {
        ...patchCall,
        content: [{ type: "text", text: "patch written" }],
        details: {},
        isError: false,
      },
      { abort() { aborts++; } },
    );
    assert.equal(obsDecision, undefined);
    assert.equal(aborts, 0);

    // 2. Calling broker_report with state="blocked" records report and aborts the turn cleanly
    const reportTool = tools.get("broker_report");
    const reportExec = await reportTool.execute("report-1", {
      state: "blocked",
      summary: "Prepared initial patch, need confirmation on export name.",
      question: "Should the constant be named x or DEFAULT_X?",
    });
    assert.equal(reportExec.details.brokerChildReport.state, "blocked");
    assert.equal(
      reportExec.details.brokerChildReport.question,
      "Should the constant be named x or DEFAULT_X?",
    );

    const reportCall = {
      toolName: "broker_report",
      toolCallId: "report-1",
      input: {
        state: "blocked",
        summary: "Prepared initial patch, need confirmation on export name.",
        question: "Should the constant be named x or DEFAULT_X?",
      },
    };
    assert.equal(await hooks.get("tool_call")(reportCall), undefined);
    await hooks.get("tool_result")(
      {
        ...reportCall,
        content: reportExec.content,
        details: reportExec.details,
        isError: false,
      },
      { abort() { aborts++; } },
    );
    assert.equal(aborts, 1, "broker_report(blocked) must abort the current child turn cleanly");
  } finally {
    await hooks.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mid-run 429 failover carries over broker_report(progress) and partial git worktree changes to the replacement provider", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { applyProposedPatch } = await import("../src/proposed-patch.mjs");

  const root = mkdtempSync(join(tmpdir(), "br-failover-carryover-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  writeFileSync(join(repoDir, "step1.txt"), "initial\n", "utf8");
  writeFileSync(join(repoDir, "step2.txt"), "initial\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

  const spawnPrompts = [];
  const rateLimitedResources = [];

  try {
    const resolver = {
      async reportProviderRateLimited(resourceId) {
        rateLimitedResources.push(resourceId);
      },
      async resolve(request) {
        const isRetry = request.childId.endsWith("-r2");
        const resourceId = isRetry ? "provider-b:gpt-5" : "provider-a:claude-sonnet";
        return {
          action: "allow",
          resource: { id: resourceId, capacityGroup: isRetry ? "group-b" : "group-a" },
          childModel: {
            provider: isRetry ? "provider-b" : "provider-a",
            modelId: isRetry ? "gpt-5" : "claude-sonnet",
          },
          policy: {
            policyId: `lease-${request.childId}`,
            agentDir: mkdtempSync(join(root, "agent-")),
            authorizationPolicy: {
              operationClass: "propose_patch",
              effectCapable: true,
            },
            environment: {},
            onChildSessionOpened: () => ({ status: "handed" }),
            onChildSessionClosed: () => ({}),
            onBeforeChildAbandoned: () => {},
            onProviderSucceeded: () => {},
          },
        };
      },
    };

    const runner = new BrokeredChildRunner({
      resolver,
      semaphore: new Semaphore(1),
      sessionsRoot: join(root, "sessions"),
      spawnChild: async ({ spec }) => {
        spawnPrompts.push(spec.prompt);
        const isSecondAttempt = spawnPrompts.length === 2;
        if (!isSecondAttempt) {
          // Attempt 1 modifies step1.txt via propose_patch, emits broker_report(progress), then hits 429 mid-run
          applyProposedPatch({
            cwd: spec.cwd,
            patch: [
              "diff --git a/step1.txt b/step1.txt",
              "--- a/step1.txt",
              "+++ b/step1.txt",
              "@@ -1 +1 @@",
              "-initial",
              "+completed-in-attempt-1",
              "",
            ].join("\n"),
          });
          return {
            session: {
              lastChildReport: {
                state: "progress",
                summary: "Updated step1.txt; about to update step2.txt.",
                at: 1_000,
              },
              latestAssistantMessage: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "429 Rate limit exceeded on provider-a",
                content: [],
              },
              usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, turns: 1 },
              async prompt() {},
              async dispose() {},
            },
            resolved: { provider: "provider-a", modelId: "claude-sonnet" },
          };
        }

        // Attempt 2 runs on provider-b: verify step1.txt already has Attempt 1's patch applied!
        const step1Content = readFileSync(join(spec.cwd, "step1.txt"), "utf8");
        assert.equal(step1Content, "completed-in-attempt-1\n", "Attempt 2 worktree must inherit Attempt 1 patch");

        applyProposedPatch({
          cwd: spec.cwd,
          patch: [
            "diff --git a/step2.txt b/step2.txt",
            "--- a/step2.txt",
            "+++ b/step2.txt",
            "@@ -1 +1 @@",
            "-initial",
            "+completed-in-attempt-2",
            "",
          ].join("\n"),
        });

        return {
          session: {
            lastChildReport: {
              state: "ready",
              summary: "Finished step2.txt on replacement provider after inheriting step1.txt.",
              at: 2_000,
            },
            latestAssistantMessage: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Completed both steps across failover." }],
            },
            usage: { input: 220, output: 60, cacheRead: 0, cacheWrite: 0, turns: 1 },
            async prompt() {},
            async dispose() {},
          },
          resolved: { provider: "provider-b", modelId: "gpt-5" },
        };
      },
    });

    const outcome = await runner.run({
      childId: "failover-patch-task",
      prompt: "Update step1.txt and step2.txt",
      cwd: repoDir,
      isolation: "worktree",
      maxAttempts: 3,
    });

    assert.equal(outcome.status, "completed");
    assert.deepEqual(rateLimitedResources, ["provider-a:claude-sonnet"]);
    assert.equal(outcome.route.length, 2);
    assert.equal(outcome.route[0].outcome, "rate_limited");
    assert.equal(outcome.route[1].outcome, "completed");
    assert.deepEqual(outcome.changed.sort(), ["step1.txt", "step2.txt"]);
    assert.match(spawnPrompts[1], /Prior attempt progress before provider failover/);
    assert.match(spawnPrompts[1], /Updated step1\.txt; about to update step2\.txt\./);
    assert.match(spawnPrompts[1], /Carried-over worktree changes already applied in your workspace: step1\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

