import assert from "node:assert/strict";
import test from "node:test";
import {
  createEffectiveChildCapability,
  compileEffectiveChildCapability,
  canonicalDeclaredToolName,
  isImplicitlyDeclaredObserveTool,
} from "../src/capability-compiler.mjs";
import { BehavioralRunMonitor } from "../src/behavior-monitor.mjs";

const ZERO64 = "0".repeat(64);

function capabilityInput(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "task-cap",
    operationClass: "observe",
    admissionClass: "control",
    doneWhen: ["Return the requested repository finding with controller-verifiable evidence references"],
    allowedTools: ["read", "grep", "ls"],
    profileSupports: ["code_reasoning", "repo_navigation"],
    budget: {
      maxOutputTokens: 100,
      maxInputTokens: 1_000,
      enforcement: { input: "hard", output: "hard" },
    },
    latencyBudgetMs: 120_000,
    leaseTtlMs: 30_000,
    promptDigest: ZERO64,
    behavioralEnforcement: "unavailable",
    downgradePolicy: "forbid",
    ...overrides,
  };
}

test("effective child capability is immutable, fingerprinted, and rejects unknown fields", () => {
  const cap = createEffectiveChildCapability(capabilityInput());
  assert.match(cap.capabilityFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => { cap.operationClass = "apply"; }, TypeError);
  assert.throws(() => createEffectiveChildCapability({ ...capabilityInput(), surprise: true }), /unknown capability field/);
  assert.throws(() => createEffectiveChildCapability(capabilityInput({ budget: { maxInputTokens: 1_000, maxOutputTokens: 100, maxCostMicros: 50, enforcement: { input: "hard", output: "hard" } } })), /unknown budget field/);
  const reordered = createEffectiveChildCapability({ ...capabilityInput(), budget: { enforcement: { output: "hard", input: "hard" }, maxInputTokens: 1_000, maxOutputTokens: 100 } });
  assert.equal(reordered.capabilityFingerprint, cap.capabilityFingerprint);
  const different = createEffectiveChildCapability(capabilityInput({ operationClass: "propose_patch" }));
  assert.notEqual(different.capabilityFingerprint, cap.capabilityFingerprint);
});

test("read-only canary delegation is fingerprinted and depth-2 grants are refused", () => {
  const delegation = {
    mode: "read_only_canary", grantId: "grant-1", rootTaskId: "root-1", parentTaskId: "task-cap",
    depth: 1, maxDepth: 2, maxChildren: 1, maxParallel: 1, maxAttemptsPerChild: 1, maxResultBytes: 4096,
  };
  const cap = createEffectiveChildCapability(capabilityInput({
    allowedTools: ["read", "grep", "ls", "broker_request_child", "broker_cancel_child"], delegation,
  }));
  const compiled = compileEffectiveChildCapability(cap);
  assert.ok(compiled.authorizationPolicy.allowedTools.has("broker_request_child"));
  assert.match(compiled.promptRules, /delegation: read_only_canary depth=1\/2/);
  assert.throws(() => createEffectiveChildCapability(capabilityInput({ delegation: { ...delegation, depth: 2 } })), /delegation grant is invalid/);
  assert.notEqual(cap.capabilityFingerprint, createEffectiveChildCapability(capabilityInput({ delegation: { ...delegation, grantId: "grant-2" } })).capabilityFingerprint);
});

test("capability compiler generates prompt rules and authorization policy from one source", () => {
  const cap = createEffectiveChildCapability(capabilityInput());
  const { promptRules, authorizationPolicy } = compileEffectiveChildCapability(cap);

  assert.equal(typeof promptRules, "string");
  assert.ok(promptRules.includes("allowed_tools: read, grep, ls"));
  assert.ok(promptRules.includes("never the mcp_pi_ prefix"));
  assert.ok(promptRules.includes("Invoke read-only observe tools directly"));
  assert.ok(promptRules.includes("declares and authorizes those read-only actions automatically"));
  assert.ok(!promptRules.includes("Before EVERY allowed tool call"));
  assert.ok(promptRules.includes("operation_class: observe"));
  assert.ok(promptRules.includes("capability_fingerprint:"));

  assert.equal(authorizationPolicy.effectCapable, false);
  assert.equal(authorizationPolicy.requiresBehavioralMonitor, false);
  assert.equal(authorizationPolicy.operationClass, "observe");
  assert.ok(authorizationPolicy.allowedTools.has("read"));
  assert.ok(!authorizationPolicy.allowedTools.has("bash"));
  assert.equal(isImplicitlyDeclaredObserveTool("read"), true);
  assert.equal(isImplicitlyDeclaredObserveTool("grep"), true);
  assert.equal(isImplicitlyDeclaredObserveTool("propose_patch"), false);
});

test("effect-capable capability requires blocking monitor in prompt rules", () => {
  const cap = createEffectiveChildCapability(capabilityInput({
    operationClass: "propose_patch",
    behavioralEnforcement: "blocking_monitor",
    allowedTools: ["read", "grep", "ls", "propose_patch"],
  }));
  const { promptRules, authorizationPolicy } = compileEffectiveChildCapability(cap);
  assert.equal(authorizationPolicy.effectCapable, true);
  assert.equal(authorizationPolicy.requiresBehavioralMonitor, true);
  assert.ok(promptRules.includes("behavioral_enforcement: blocking_monitor"));
  assert.ok(promptRules.includes("broker_declare_action immediately before every effect-capable tool"));
  assert.ok(!promptRules.includes("WARNING"));
});

test("effect-capable capability without monitor warns and policy denies", () => {
  const cap = createEffectiveChildCapability(capabilityInput({
    operationClass: "apply",
    behavioralEnforcement: "unavailable",
  }));
  const { promptRules, authorizationPolicy } = compileEffectiveChildCapability(cap);
  assert.equal(authorizationPolicy.effectCapable, true);
  assert.equal(authorizationPolicy.requiresBehavioralMonitor, false);
  assert.ok(promptRules.includes("WARNING: effect-capable operation without a wired blocking monitor"));
});

test("behavioral monitor with authorization policy allows declared allowed tools", () => {
  const cap = createEffectiveChildCapability(capabilityInput());
  const { authorizationPolicy } = compileEffectiveChildCapability(cap);
  const monitor = new BehavioralRunMonitor({
    doneWhen: cap.doneWhen,
    authorizationPolicy,
  });
  monitor.declareAction({ stepId: "s1", toolName: "read", args: { path: "/repo/a" } });
  const verdict = monitor.authorizeAction({ stepId: "s1", toolName: "read", args: { path: "/repo/a" } });
  assert.equal(verdict.status, "allowed");
});

test("behavioral monitor with authorization policy denies tools outside the allowed set", () => {
  const cap = createEffectiveChildCapability(capabilityInput());
  const { authorizationPolicy } = compileEffectiveChildCapability(cap);
  const monitor = new BehavioralRunMonitor({
    doneWhen: cap.doneWhen,
    authorizationPolicy,
  });
  monitor.declareAction({ stepId: "s1", toolName: "bash", args: { command: "rm -rf /" } });
  const verdict = monitor.authorizeAction({ stepId: "s1", toolName: "bash", args: { command: "rm -rf /" } });
  assert.equal(verdict.status, "tool_not_allowed");
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true);
  // A terminal denial sticks: further actions are also blocked
  const next = monitor.authorizeAction({ stepId: "s2", toolName: "read", args: {} });
  assert.equal(next.status, "tool_not_allowed");
});

test("behavioral monitor denies effect-capable operations without a wired monitor", () => {
  const cap = createEffectiveChildCapability(capabilityInput({
    operationClass: "apply",
    behavioralEnforcement: "unavailable",
  }));
  const { authorizationPolicy } = compileEffectiveChildCapability(cap);
  const monitor = new BehavioralRunMonitor({
    doneWhen: cap.doneWhen,
    authorizationPolicy,
  });
  monitor.declareAction({ stepId: "s1", toolName: "read", args: {} });
  const verdict = monitor.authorizeAction({ stepId: "s1", toolName: "read", args: {} });
  assert.equal(verdict.status, "behavioral_enforcement_unavailable");
  assert.equal(verdict.terminate, true);
});

test("behavioral monitor allows effect-capable operations when monitor is wired", () => {
  const cap = createEffectiveChildCapability(capabilityInput({
    operationClass: "propose_patch",
    behavioralEnforcement: "blocking_monitor",
    allowedTools: ["read", "propose_patch"],
  }));
  const { authorizationPolicy } = compileEffectiveChildCapability(cap);
  const monitor = new BehavioralRunMonitor({
    doneWhen: cap.doneWhen,
    authorizationPolicy,
  });
  monitor.declareAction({ stepId: "s1", toolName: "propose_patch", args: { target: "src/a.ts" } });
  const verdict = monitor.authorizeAction({ stepId: "s1", toolName: "propose_patch", args: { target: "src/a.ts" } });
  assert.equal(verdict.status, "allowed");
});

test("behavioral monitor without authorization policy works as before", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  monitor.declareAction({ stepId: "s1", toolName: "bash", args: { command: "ls" } });
  const verdict = monitor.authorizeAction({ stepId: "s1", toolName: "bash", args: { command: "ls" } });
  assert.equal(verdict.status, "allowed");
});

test("mcp_pi_ prefix on an allowed tool canonicalizes to the unprefixed name", () => {
  const allowed = ["read", "grep"];
  assert.equal(canonicalDeclaredToolName("read", allowed), "read");
  assert.equal(canonicalDeclaredToolName("mcp_pi_read", allowed), "read");
  assert.equal(canonicalDeclaredToolName("mcp_pi_read", new Set(allowed)), "read");
  assert.equal(canonicalDeclaredToolName("mcp_pi_bash", allowed), "mcp_pi_bash");
  assert.equal(canonicalDeclaredToolName("bash", allowed), "bash");
  assert.equal(isImplicitlyDeclaredObserveTool("mcp_pi_read", allowed), true);
  assert.equal(isImplicitlyDeclaredObserveTool("mcp_pi_bash", allowed), false);
});