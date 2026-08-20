import { createHash } from "node:crypto";
import { captureLosslessJson } from "./lossless-json.mjs";

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;

function digestCanonical(canonical) {
  return createHash("sha256").update(canonical).digest("hex");
}

function requireAction(input) {
  if (!input || !STEP_ID.test(input.stepId ?? "") || !TOOL_NAME.test(input.toolName ?? "") || !Object.hasOwn(input, "args")) {
    throw new Error("behavior action requires bounded stepId, toolName, and args");
  }
  // A model may declare args as a JSON string and then invoke the tool with the object form.
  // Same intent, different representation — normalize before hashing or the declaration and
  // the invocation never match (live: every cursor/claude-4.6-opus-* child died exactly here).
  const args = typeof input.args === "string"
    ? (() => { try { const parsed = JSON.parse(input.args); return parsed && typeof parsed === "object" ? parsed : input.args; } catch { return input.args; } })()
    : input.args;
  const captured = captureLosslessJson({ toolName: input.toolName, args });
  return Object.freeze({
    stepId: input.stepId,
    toolName: captured.value.toolName,
    args: captured.value.args,
    actionHash: digestCanonical(captured.canonical),
  });
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/**
 * Deterministic controller/child-shim state for the three dominant MAST modes.
 * Call authorizeAction from Pi's blocking tool_call hook, observeActionResult
 * from tool_result, and let only the controller consume completion claims.
 */
export class BehavioralRunMonitor {
  #doneWhen;
  #repeatLimit;
  #mismatchLimit;
  #plans = new Map();
  #lastObservation;
  #repeatCount = 0;
  #terminal;
  #metrics = {
    actionCount: 0,
    progressTransitions: 0,
    repeatedNoProgress: 0,
    planMismatches: 0,
    completionClaims: 0,
    completionRejected: 0,
  };

  #authorizationPolicy = null;

  constructor({ doneWhen, repeatedNoProgressLimit = 3, planMismatchLimit = 1, authorizationPolicy = null } = {}) {
    if (!Array.isArray(doneWhen) || doneWhen.length < 1 || doneWhen.length > 20
      || doneWhen.some((item) => typeof item !== "string" || item.length < 1 || item.length > 500 || /[\0\r\n]/.test(item))) {
      throw new Error("behavior monitor requires 1-20 bounded doneWhen criteria");
    }
    if (!Number.isSafeInteger(repeatedNoProgressLimit) || repeatedNoProgressLimit < 2 || repeatedNoProgressLimit > 20) {
      throw new Error("repeatedNoProgressLimit must be an integer between 2 and 20");
    }
    if (!Number.isSafeInteger(planMismatchLimit) || planMismatchLimit < 1 || planMismatchLimit > 20) {
      throw new Error("planMismatchLimit must be an integer between 1 and 20");
    }
    this.#doneWhen = Object.freeze([...doneWhen]);
    this.#repeatLimit = repeatedNoProgressLimit;
    this.#mismatchLimit = planMismatchLimit;
    if (authorizationPolicy) {
      if (!authorizationPolicy.allowedTools || !(authorizationPolicy.allowedTools instanceof Set)) {
        throw new Error("authorizationPolicy requires an allowedTools Set");
      }
      this.#authorizationPolicy = authorizationPolicy;
    }
  }

  declareAction(input) {
    if (this.#terminal) return this.#terminal;
    const declaration = requireAction(input);
    this.#plans.set(declaration.stepId, declaration);
    return Object.freeze({ status: "declared", stepId: declaration.stepId, actionHash: declaration.actionHash });
  }

  /** Must run before tool execution; a mismatch is blocked, not merely logged. */
  authorizeAction(input) {
    if (this.#terminal) return this.#terminal;
    const action = requireAction(input);
    if (this.#authorizationPolicy && !this.#authorizationPolicy.allowedTools.has(action.toolName)) {
      this.#terminal = Object.freeze({
        status: "tool_not_allowed",
        block: true,
        terminate: true,
        cause: `tool ${action.toolName} is outside the capability allowedTools`,
        retryable: false,
        nextAction: "use only the tools declared in the effective child capability",
      });
      return this.#terminal;
    }
    if (this.#authorizationPolicy?.effectCapable && !this.#authorizationPolicy.requiresBehavioralMonitor) {
      this.#terminal = Object.freeze({
        status: "behavioral_enforcement_unavailable",
        block: true,
        terminate: true,
        cause: "effect-capable operation without a wired blocking behavioral monitor",
        retryable: false,
        nextAction: "wire a blocking monitor before attempting effects",
      });
      return this.#terminal;
    }
    const declared = this.#plans.get(action.stepId);
    const actualHash = action.actionHash;
    if (!declared || declared.actionHash !== actualHash) {
      this.#metrics.planMismatches += 1;
      const terminal = this.#metrics.planMismatches >= this.#mismatchLimit;
      const result = Object.freeze({
        status: "reasoning_action_mismatch",
        block: true,
        terminate: terminal,
        cause: declared ? "tool invocation differs from declared action" : "tool invocation has no declared action",
        retryable: !terminal,
        nextAction: terminal ? "return status escalated with the mismatch" : "declare a new typed action before retrying",
      });
      if (terminal) this.#terminal = result;
      return result;
    }
    this.#plans.delete(action.stepId);
    this.#metrics.actionCount += 1;
    return Object.freeze({ status: "allowed", block: false, actionHash: actualHash });
  }

  /**
   * Observe the completed result. A repeated tool call is no-progress only when
   * action, semantic result, error state, and controller state digest all stay
   * unchanged; a still-running tool is never passed here.
   */
  observeActionResult({ toolName, args, result, isError = false, stateDigest }) {
    if (this.#terminal) return this.#terminal;
    if (!TOOL_NAME.test(toolName ?? "") || typeof isError !== "boolean" || typeof stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(stateDigest)) {
      throw new Error("behavior result requires toolName, boolean isError, and controller stateDigest");
    }
    const captured = captureLosslessJson({ toolName, args, result, isError, stateDigest });
    const observation = digestCanonical(captured.canonical);
    if (observation === this.#lastObservation) {
      this.#repeatCount += 1;
      this.#metrics.repeatedNoProgress += 1;
    } else {
      this.#lastObservation = observation;
      this.#repeatCount = 1;
      this.#metrics.progressTransitions += 1;
    }
    if (this.#repeatCount < this.#repeatLimit) {
      return Object.freeze({ status: "progress_observed", repeated: this.#repeatCount });
    }
    this.#terminal = Object.freeze({
      status: "no_progress",
      terminate: true,
      cause: `${this.#repeatCount} semantically identical action outcomes with no state change`,
      retryable: false,
      nextAction: "return status no_progress with the repeated action hash for controller escalation",
      actionObservationHash: observation,
    });
    return this.#terminal;
  }

  reconcileChanges({ declaredChanges, controllerActionLog }) {
    if (!Array.isArray(declaredChanges) || !Array.isArray(controllerActionLog)) throw new Error("change reconciliation requires two arrays");
    const declared = new Set(declaredChanges.map((item) => {
      if (typeof item !== "string" || !item) throw new Error("declared change target must be a non-empty string");
      return item;
    }));
    const observed = new Set(controllerActionLog.filter((item) => item?.effect === "mutation").map((item) => {
      if (typeof item.target !== "string" || !item.target) throw new Error("controller mutation event requires target");
      return item.target;
    }));
    if (setEquals(declared, observed)) return Object.freeze({ status: "matched", declared: Object.freeze([...declared]) });
    this.#metrics.planMismatches += 1;
    return Object.freeze({
      status: "reasoning_action_mismatch",
      missingFromResult: Object.freeze([...observed].filter((item) => !declared.has(item))),
      notObservedByController: Object.freeze([...declared].filter((item) => !observed.has(item))),
    });
  }

  /** Worker completion never mutates controller task state. */
  claimCompletion({ evidenceRefs }) {
    if (this.#terminal) return this.#terminal;
    this.#metrics.completionClaims += 1;
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length < 1 || evidenceRefs.some((ref) => typeof ref !== "string" || !ref)) {
      this.#metrics.completionRejected += 1;
      return Object.freeze({
        status: "completion_claim_rejected",
        cause: "completion claim lacks evidence references for doneWhen",
        retryable: true,
        nextAction: "run the declared checks and return their evidence references",
      });
    }
    return Object.freeze({ status: "completion_claimed", doneWhen: this.#doneWhen, evidenceRefs: Object.freeze([...evidenceRefs]) });
  }

  metrics() {
    return Object.freeze({ ...this.#metrics, terminalStatus: this.#terminal?.status ?? null });
  }
}
