import { createHash } from "node:crypto";
import { captureLosslessJson } from "./lossless-json.mjs";

/**
 * Unified capability compiler: generates prompt-visible tools/rules and
 * executable authorization from one immutable EffectiveChildCapability. The
 * doctrine requires that the child sees exactly the same policy the
 * controller enforces — one source of truth, two projections.
 */

const OPERATION_CLASSES = Object.freeze(new Set(["observe", "propose_patch", "apply", "external_write"]));
const ADMISSION_CLASSES = Object.freeze(new Set(["control", "verify", "work"]));
const EFFECT_CAPABLE = Object.freeze(new Set(["propose_patch", "apply", "external_write"]));
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MCP_PI_PREFIX = "mcp_pi_";

/**
 * Isolated children see unprefixed Pi tools (`read`). Parent sessions often see the same
 * tools as `mcp_pi_read`. A child that declares the prefixed name for an allowed tool is
 * asking for that tool, not for a different one.
 */
export function canonicalDeclaredToolName(toolName, allowedTools) {
  if (typeof toolName !== "string" || !toolName) return toolName;
  const allowed = allowedTools instanceof Set ? allowedTools : new Set(Array.isArray(allowedTools) ? allowedTools : []);
  if (allowed.has(toolName)) return toolName;
  if (toolName.startsWith(MCP_PI_PREFIX)) {
    const inner = toolName.slice(MCP_PI_PREFIX.length);
    if (inner && allowed.has(inner)) return inner;
  }
  return toolName;
}
const CAPABILITY_FIELDS = [
  "schemaVersion", "taskId", "operationClass", "admissionClass", "doneWhen",
  "allowedTools", "profileSupports", "budget", "latencyBudgetMs", "leaseTtlMs", "delegation",
  "promptDigest", "behavioralEnforcement", "downgradePolicy",
];

const OBSERVE_TOOLS = Object.freeze(["read", "grep", "ls", "find", "test"]);
const OBSERVE_TOOL_SET = Object.freeze(new Set(OBSERVE_TOOLS));

export function isImplicitlyDeclaredObserveTool(toolName, allowedTools) {
  const canonical = canonicalDeclaredToolName(toolName, allowedTools);
  return typeof canonical === "string" && OBSERVE_TOOL_SET.has(canonical);
}

/**
 * Derive a default allowed-tools set from the operation class. The observe set
 * is read-only; each higher class adds its namesake tool. Contracts may override
 * this with an explicit allowedTools field.
 */
export function deriveAllowedTools(operationClass) {
  if (!OPERATION_CLASSES.has(operationClass)) throw new Error(`unknown operationClass: ${operationClass}`);
  const tools = [...OBSERVE_TOOLS];
  if (operationClass === "propose_patch" || operationClass === "apply" || operationClass === "external_write") tools.push("propose_patch");
  if (operationClass === "apply" || operationClass === "external_write") tools.push("apply");
  if (operationClass === "external_write") tools.push("external_write");
  return Object.freeze(tools);
}

function boundedStringArray(value, name, max = 20, maxLen = 500) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`${name} must be an array of 1..${max} strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > maxLen || /[\0\r\n]/.test(item)) {
      throw new Error(`${name} entries must be bounded strings without control characters`);
    }
  }
  return Object.freeze([...value]);
}

function boundedToolArray(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error("allowedTools must be an array of 1..128 tool names");
  }
  for (const tool of value) {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool)) throw new Error(`allowedTools entry is not a bounded tool name: ${tool}`);
  }
  return Object.freeze([...value]);
}

/**
 * Validate and deep-freeze the one immutable child-facing capability. The
 * returned capabilityFingerprint commits to every field; a replacement
 * attempt must create a new capability rather than mutate this one.
 */
export function createEffectiveChildCapability(input) {
  if (!input || typeof input !== "object") throw new Error("capability input must be an object");
  if (input.schemaVersion !== 1) throw new Error("capability schemaVersion must be 1");
  for (const key of Object.keys(input)) {
    if (!CAPABILITY_FIELDS.includes(key)) throw new Error(`unknown capability field: ${key}`);
  }
  const cap = {
    schemaVersion: 1,
    taskId: typeof input.taskId === "string" && TOOL_NAME.test(input.taskId) ? input.taskId : (() => { throw new Error("taskId must be a bounded identifier"); })(),
    operationClass: OPERATION_CLASSES.has(input.operationClass) ? input.operationClass : (() => { throw new Error("operationClass must be observe, propose_patch, apply, or external_write"); })(),
    admissionClass: ADMISSION_CLASSES.has(input.admissionClass) ? input.admissionClass : (() => { throw new Error("admissionClass must be control, verify, or work"); })(),
    doneWhen: boundedStringArray(input.doneWhen, "doneWhen"),
    allowedTools: boundedToolArray(input.allowedTools),
    profileSupports: boundedStringArray(input.profileSupports, "profileSupports", 64, 64),
    budget: validateBudget(input.budget),
    latencyBudgetMs: Number.isSafeInteger(input.latencyBudgetMs) && input.latencyBudgetMs > 0 ? input.latencyBudgetMs : (() => { throw new Error("latencyBudgetMs must be a positive safe integer"); })(),
    leaseTtlMs: Number.isSafeInteger(input.leaseTtlMs) && input.leaseTtlMs > 0 ? input.leaseTtlMs : (() => { throw new Error("leaseTtlMs must be a positive safe integer"); })(),
    promptDigest: typeof input.promptDigest === "string" && HEX64.test(input.promptDigest) ? input.promptDigest : (() => { throw new Error("promptDigest must be a SHA-256 hex digest"); })(),
    behavioralEnforcement: input.behavioralEnforcement === "unavailable" || input.behavioralEnforcement === "blocking_monitor" ? input.behavioralEnforcement : (() => { throw new Error("behavioralEnforcement must be unavailable or blocking_monitor"); })(),
    downgradePolicy: input.downgradePolicy === "forbid" ? input.downgradePolicy : (() => { throw new Error("only forbid downgrade policy is implemented"); })(),
    ...(validateDelegation(input.delegation) ? { delegation: validateDelegation(input.delegation) } : {}),
  };
  const captured = captureLosslessJson(cap);
  const capabilityFingerprint = createHash("sha256").update(captured.canonical).digest("hex");
  return Object.freeze({ ...captured.value, capabilityFingerprint });
}

function validateDelegation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("delegation must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["depth", "grantId", "maxAttemptsPerChild", "maxChildren", "maxDepth", "maxParallel", "maxResultBytes", "mode", "parentTaskId", "rootTaskId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("delegation has unsupported or missing fields");
  if (value.mode !== "read_only_canary" || typeof value.grantId !== "string" || !TOOL_NAME.test(value.grantId)
    || typeof value.rootTaskId !== "string" || !TOOL_NAME.test(value.rootTaskId)
    || typeof value.parentTaskId !== "string" || !TOOL_NAME.test(value.parentTaskId)
    || value.depth !== 1 || value.maxDepth !== 2
    || !Number.isSafeInteger(value.maxChildren) || value.maxChildren < 1 || value.maxChildren > 4
    || !Number.isSafeInteger(value.maxParallel) || value.maxParallel < 1 || value.maxParallel > 4
    || !Number.isSafeInteger(value.maxAttemptsPerChild) || value.maxAttemptsPerChild < 1 || value.maxAttemptsPerChild > 4
    || !Number.isSafeInteger(value.maxResultBytes) || value.maxResultBytes < 1 || value.maxResultBytes > 256 * 1024) throw new Error("delegation grant is invalid");
  return Object.freeze({ ...value });
}

function validateBudget(budget) {
  if (!budget || typeof budget !== "object") throw new Error("budget must be an object");
  for (const key of Object.keys(budget)) {
    if (!["maxOutputTokens", "maxInputTokens", "maxAttempts", "enforcement"].includes(key)) {
      throw new Error(`unknown budget field: ${key}`);
    }
  }
  const result = {};
  if (budget.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(budget.maxOutputTokens) || budget.maxOutputTokens < 1) throw new Error("maxOutputTokens must be a positive safe integer");
    result.maxOutputTokens = budget.maxOutputTokens;
  }
  if (budget.maxInputTokens !== undefined) {
    if (!Number.isSafeInteger(budget.maxInputTokens) || budget.maxInputTokens < 1) throw new Error("maxInputTokens must be a positive safe integer");
    result.maxInputTokens = budget.maxInputTokens;
  }
  if (budget.maxAttempts !== undefined) {
    if (!Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1 || budget.maxAttempts > 32) throw new Error("maxAttempts must be an integer between 1 and 32");
    result.maxAttempts = budget.maxAttempts;
  }
  if (budget.enforcement !== undefined) {
    if (!budget.enforcement || typeof budget.enforcement !== "object") throw new Error("enforcement must be an object");
    for (const key of Object.keys(budget.enforcement)) {
      if (!["input", "output"].includes(key)) throw new Error(`unknown enforcement field: ${key}`);
    }
    result.enforcement = Object.freeze({
      input: budget.enforcement.input,
      output: budget.enforcement.output,
    });
  }
  return Object.freeze(result);
}

/**
 * Compile an EffectiveChildCapability into two projections:
 * - promptRules: bounded text injected into the child's system prompt so the
 *   model sees exactly the same constraints the controller enforces.
 * - authorizationPolicy: frozen executable rules used by BehavioralRunMonitor
 *   to revalidate at every blocking pre-tool hook.
 */
export function compileEffectiveChildCapability(cap) {
  if (!cap || typeof cap.capabilityFingerprint !== "string" || !HEX64.test(cap.capabilityFingerprint)) {
    throw new Error("compileEffectiveChildCapability requires a capability from createEffectiveChildCapability");
  }
  const effectCapable = EFFECT_CAPABLE.has(cap.operationClass);
  const requiresBehavioralMonitor = effectCapable && cap.behavioralEnforcement === "blocking_monitor";

  const effectTools = cap.allowedTools.filter((tool) => EFFECT_CAPABLE.has(tool));
  const lines = [
    "## Brokered child capability",
    `operation_class: ${cap.operationClass}`,
    `admission_class: ${cap.admissionClass}`,
    `allowed_tools: ${cap.allowedTools.join(", ")}`,
    ...(cap.delegation ? [`delegation: read_only_canary depth=${cap.delegation.depth}/${cap.delegation.maxDepth} children=${cap.delegation.maxChildren}`] : []),
    "Invoke tools by the names above, never the mcp_pi_ prefix.",
    "Invoke read-only observe tools directly; the broker declares and authorizes those read-only actions automatically.",
    ...(effectTools.length > 0 ? [
      `effect_tools_requiring_explicit_declaration: ${effectTools.join(", ")}`,
      "Call broker_declare_action immediately before every effect-capable tool, with that exact tool name and exact arguments.",
      "After calling it, wait for that declaration to succeed; only then invoke the declared effect tool in the next step, never in the same response.",
    ] : [
      "No effect-capable tools are allowed. Do not call broker_declare_action; invoke observe tools directly.",
    ]),
    `done_when:`,
    ...cap.doneWhen.map((c) => `  - ${c}`),
    `latency_budget_ms: ${cap.latencyBudgetMs}`,
    `lease_ttl_ms: ${cap.leaseTtlMs}`,
  ];
  if (cap.budget.maxOutputTokens !== undefined) lines.push(`max_output_tokens: ${cap.budget.maxOutputTokens}`);
  if (cap.budget.maxInputTokens !== undefined) lines.push(`max_input_tokens: ${cap.budget.maxInputTokens}`);
  if (cap.budget.maxAttempts !== undefined) lines.push(`max_attempts: ${cap.budget.maxAttempts}`);
  if (cap.budget.enforcement) {
    lines.push(`budget_enforcement: input=${cap.budget.enforcement.input} output=${cap.budget.enforcement.output}`);
  }
  if (effectCapable) {
    lines.push(`behavioral_enforcement: ${cap.behavioralEnforcement}`);
    if (!requiresBehavioralMonitor) {
      lines.push("WARNING: effect-capable operation without a wired blocking monitor; effects will be denied.");
    }
  }
  lines.push(`downgrade_policy: ${cap.downgradePolicy}`);
  lines.push(`capability_fingerprint: ${cap.capabilityFingerprint}`);
  const promptRules = lines.join("\n");

  const authorizationPolicy = Object.freeze({
    allowedTools: Object.freeze(new Set(cap.allowedTools)),
    effectCapable,
    requiresBehavioralMonitor,
    operationClass: cap.operationClass,
    admissionClass: cap.admissionClass,
    doneWhen: cap.doneWhen,
    capabilityFingerprint: cap.capabilityFingerprint,
    promptDigest: cap.promptDigest,
    budget: cap.budget,
  });

  return Object.freeze({ promptRules, authorizationPolicy });
}