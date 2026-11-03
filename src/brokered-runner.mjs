import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnBrokeredChild } from "./child-launcher.mjs";
import { Semaphore } from "./semaphore.mjs";
import { effectiveThinkingLevel } from "./model-thinking-policy.mjs";
import { THINKING_LEVELS } from "./child-contract.mjs";
import { createWorktree, collectWorktree, cleanupWorktree, WorktreeCollectionError } from "./worktree.mjs";
import { applyProposedPatch } from "./proposed-patch.mjs";

const SETTLE_GRACE_MS = 15_000;

/** Bounded preview of partial work. Longest useful tail, never an unbounded transcript. */
const PARTIAL_TEXT_LIMIT = 8_000;

/**
 * Recover the public streaming text a child had already produced. The journal is written by
 * `child-launcher` with an fsync per text delta, so it survives a kill or a crash that leaves no
 * final message. It holds ONLY text deltas — no reasoning, no credentials, no provider payloads —
 * which is what makes it safe to surface to the parent as unverified partial work.
 *
 * Reading it changes no outcome: callers attach it only to results that already failed.
 */
/**
 * Attempt directories that can hold this run's journals: the first attempt uses the plain child id,
 * every retry appends `-rN`. Mirrors how `retained-work` discovers attempts.
 */
function attemptSessionDirs(sessionsRoot, childId) {
  let names;
  try { names = readdirSync(sessionsRoot); } catch { return []; }
  return names
    .filter((name) => name === childId || (name.startsWith(`${childId}-r`) && /^[0-9]+$/.test(name.slice(childId.length + 2))))
    .sort()
    .map((name) => join(sessionsRoot, name, "sessions"));
}

function recoverPartialText(sessionsRoot, childId) {
  let text = "";
  for (const sessionsDir of attemptSessionDirs(sessionsRoot, childId)) {
    let names;
    try { names = readdirSync(sessionsDir); } catch { continue; }
    for (const name of names.filter((entry) => entry.startsWith("partial-") && entry.endsWith(".jsonl")).sort()) {
      let raw;
      try { raw = readFileSync(join(sessionsDir, name), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type === "text_delta" && typeof entry.text === "string") text += entry.text;
      }
    }
  }
  return text;
}

function boundedPartialText(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  if (text.length <= PARTIAL_TEXT_LIMIT) return text;
  return `[…earlier partial output omitted…]\n${text.slice(-PARTIAL_TEXT_LIMIT)}`;
}
// Provider-side reasoning may emit no Pi event for several minutes even while the subscription
// proxy records successful traffic and rising usage. Three minutes killed a live high-thinking
// Epic 59 review at 46% account usage; keep the shorter value available to explicit tests, while
// production relies on a ten-minute liveness window plus the independent absolute attempt cap.
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ATTEMPT_MAX_RUN_MS = 15 * 60_000;
const DEFAULT_CAPACITY_WAIT_MS = 15 * 60_000;
const DEFAULT_CAPACITY_RETRY_MS = 500;
const MAX_ROUTE_ATTEMPTS = 32;
const CHILD_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ROOT_ATTEMPT_BUDGET_CODE = "controller_root_physical_attempt_budget";
const PARENT_HANDOFF_FAILED_CODE = "controller_parent_handoff_failed";

/**
 * Terminal child failures split by who owns them. A provider that throttled or died is a
 * routing fact — the work is still valid and must be finished elsewhere. A context overflow is
 * nobody's fault: the provider is healthy, the task simply needs a bigger context class. Only
 * the last group is a genuine end of the road.
 */
const FAILURE_SIGNATURES = Object.freeze([
  Object.freeze({ kind: "incomplete", pattern: /child stopped with an unresolved tool request|child output ended before completion/i }),
  Object.freeze({ kind: "rate_limited", pattern: /\b(rate[ _-]?limit(?:ed)?|too many requests|429|quota exceeded|overloaded|capacity)\b/i }),
  Object.freeze({ kind: "auth_fatal", pattern: /\b(401|403|auth_fatal|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|invalid_grant|refresh token not found|authentication|expired token|revoked|no api key found)\b/i }),
  Object.freeze({ kind: "context_exhausted", pattern: /\b(context[ _-]?(window|length|limit)|context_window_exceeded|prompt is too long|maximum context|token limit)\b/i }),
  // Capability/organization policy rejection is route-specific: the same task can run on
  // another account/model, so quarantine this resource and let controller failover continue.
  Object.freeze({ kind: "unavailable", pattern: /\b(model_unavailable|unsupported_value|reasoning summaries|organization must be verified|model is not supported)\b/i }),
  // A hard controller input/output cap is a task-budget terminal, not provider health evidence.
  // Retrying the same transcript on another route would spend another lease without repairing
  // the exhausted task budget; the caller needs an explicit bounded failure instead.
  Object.freeze({ kind: "budget_exhausted", pattern: /\bcontroller (?:input|output) budget exhausted:\s*(?:input|output)_budget_exceeded\b/i }),
  // This closed terminal is emitted by the controller boundary itself, not by the provider.
  // Keep it out of provider health accounting and do not churn through unrelated accounts as if
  // changing models could repair the harness. Route-specific preflight failures have their own
  // bounded unavailable reasons before a child starts.
  Object.freeze({ kind: "controller_failure", pattern: /\bcontroller provider terminal:\s*controller_failure\b/i }),
  // Provider catalogs are observations, not authority. A model can disappear between discovery
  // and launch; its 404 is a stale route and must fail over, not kill otherwise valid work.
  Object.freeze({ kind: "unavailable", pattern: /\bmodel\b[^\n]{0,200}\bnot found\b|\b404\b[^\n]{0,300}\bnot_found_error\b/i }),
  // A child that never answers is a dead route, not a dead task: fail over instead of hanging.
  Object.freeze({ kind: "unavailable", pattern: /\bcontroller (prompt|no-progress|attempt) deadline\b/i }),
  // Reasoning-mode refusals are route-specific policy, not a dead task: another route accepts it.
  Object.freeze({ kind: "unavailable", pattern: /reasoning is mandatory|cannot be disabled|always engages in thinking/i }),
  // Exhausted credit/balance is this account's problem, not the task's: cool it and move on.
  Object.freeze({ kind: "account_exhausted", pattern: /\b402\b|\bquota_(fatal|exhausted)\b|extra_usage|requires more credits|insufficient (credits|balance)|purchase credits|upgrade to a paid account|third-party apps now draw from your extra usage|claude\.ai\/settings\/usage/i }),
  Object.freeze({ kind: "account_exhausted", pattern: /usage limit (has been )?reached|plan usage limit|usage limit exceeded/i }),
  Object.freeze({ kind: "unavailable", pattern: /\b(50[0234]|transport_before_headers|service unavailable|bad gateway|upstream|connection (error|refused|reset)|econnrefused|etimedout|network)\b/i }),
  // Empty final text can be route-specific; controller/guard failures are separated below.
  Object.freeze({ kind: "unavailable", pattern: /child completed without a result/i }),
]);

export function classifyChildFailure(text, { readOnly = false } = {}) {
  if (typeof text !== "string" || !text) return "fatal";
  if (/^controller behavioral terminal:|controller lease heartbeat failed|broker behavioral monitor is unavailable|controller behavioral result observation was unavailable/i.test(text)) return "controller_failure";
  // Unattributed aborts may be local guard stops, not provider failures. Never poison health
  // or replay a terminal monitor decision merely because Pi rendered it as an AbortError.
  if (/\boperation was aborted\b|child was aborted|\baborterror\b/i.test(text)) return "fatal";
  // A truncated provider stream is not safe to replay for effects or unknown authority.
  // Only a controller-bound observe policy permits ordinary bounded alternate-route recovery.
  if (/^controller provider terminal:\s*stream_truncated\b/i.test(text)) return readOnly ? "unavailable" : "fatal";
  for (const signature of FAILURE_SIGNATURES) if (signature.pattern.test(text)) return signature.kind;
  return "fatal";
}

/**
 * Is there explicit connection-failure evidence, rather than merely no observed response?
 *
 * Native SDK failures without status/headers also become transport_before_headers. That terminal
 * alone cannot prove all sibling models are unreachable (e.g. one Antigravity Claude failure
 * must not exclude an untried Gemini). Keep it resource-scoped. Explicit connection failures
 * retain endpoint-wide handling so a dead loopback bridge cannot consume every retry on aliases.
 * Preflight's typed route_endpoint_unreachable path independently retains its group scope.
 */
const ENDPOINT_UNREACHABLE = /\bconnection (error|refused|reset)\b|\b(econnrefused|econnreset|enotfound|eai_again|epipe|etimedout)\b|\bsocket hang up\b/i;

export function isEndpointUnreachable(text) {
  return typeof text === "string" && text.length > 0 && ENDPOINT_UNREACHABLE.test(text);
}

const SUBAGENT_FRAMING =
  "You are a subagent: an orchestrating agent spawned you for a single task. Your final message is returned to that agent as a result - it is not shown to a person. Respond with exactly what the task asks for: raw data or findings, no preamble, no markdown code fences unless explicitly requested, no closing questions.";

function defaultDelay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isTemporaryCapacityDenial(error) {
  return error instanceof Error
    && error.message === "Broker denied launch: compatible broker capacity is temporarily busy";
}

function assistantText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

/**
 * Integrated brokered child runner. One object owns the full lifecycle:
 *
 *   broker reserve → claim → resolve policy → spawn child → run prompt
 *   → close session → release lease for verification → controller verifies
 *   → finalize verified task
 *
 * No external launcher dependency. The broker resolver is the sole launch
 * authority; the child process receives only the lease-scoped policy.
 */
export class BrokeredChildRunner {
  #resolver;
  #semaphore;
  #delay;
  #sessionsRoot;
  #spawnChild;
  #noProgressTimeoutMs;
  #attemptMaxRunMs;
  #capacityWaitMs;
  #capacityRetryMs;
  #now;
  #checkpointStore;
  #defectRecorder;
  #handles = new Map();
  #permits = new Map();
  #admissions = new Map();
  #inflightSpawns = new Map();
  #activeRuns = new Set();
  #abortedRuns = new Set();
  #disposed = false;
  // Volatile controller projection for the live terminal fleet. Durable job/node state remains
  // in delegation-job-store; this map is deliberately lost on process death and is never
  // presented as a checkpoint.
  #attempts = new Map();

  constructor({
    resolver, semaphore = new Semaphore(4), sessionsRoot, delay = defaultDelay,
    spawnChild = spawnBrokeredChild, promptTimeoutMs,
    noProgressTimeoutMs = promptTimeoutMs ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS,
    attemptMaxRunMs = DEFAULT_ATTEMPT_MAX_RUN_MS,
    capacityWaitMs = DEFAULT_CAPACITY_WAIT_MS,
    capacityRetryMs = DEFAULT_CAPACITY_RETRY_MS,
    checkpointStore,
    defectRecorder,
    now = () => Date.now(),
  }) {
    if (!resolver || typeof resolver.resolve !== "function") throw new Error("BrokeredChildRunner requires a BrokeredLaunchResolver");
    if (!(semaphore instanceof Semaphore)) throw new Error("BrokeredChildRunner requires a Semaphore");
    if (typeof sessionsRoot !== "string") throw new Error("BrokeredChildRunner requires sessionsRoot");
    if (typeof delay !== "function") throw new Error("BrokeredChildRunner requires a delay function");
    if (typeof spawnChild !== "function") throw new Error("BrokeredChildRunner spawnChild must be a function");
    if (!Number.isSafeInteger(noProgressTimeoutMs) || noProgressTimeoutMs < 1_000 || noProgressTimeoutMs > 3_600_000) {
      throw new Error("BrokeredChildRunner noProgressTimeoutMs must be between 1000 and 3600000");
    }
    if (!Number.isSafeInteger(attemptMaxRunMs) || attemptMaxRunMs < noProgressTimeoutMs || attemptMaxRunMs > 24 * 60 * 60_000) {
      throw new Error("BrokeredChildRunner attemptMaxRunMs must be at least noProgressTimeoutMs and at most 24 hours");
    }
    if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 0 || capacityWaitMs > 60 * 60_000) {
      throw new Error("BrokeredChildRunner capacityWaitMs must be between 0 and 3600000");
    }
    if (!Number.isSafeInteger(capacityRetryMs) || capacityRetryMs < 1 || capacityRetryMs > 60_000) {
      throw new Error("BrokeredChildRunner capacityRetryMs must be between 1 and 60000");
    }
    if (checkpointStore !== undefined && typeof checkpointStore.renderAccepted !== "function") throw new Error("BrokeredChildRunner checkpointStore must render accepted checkpoints");
    if (defectRecorder !== undefined && typeof defectRecorder !== "function") throw new Error("BrokeredChildRunner defectRecorder must be a function");
    if (typeof now !== "function") throw new Error("BrokeredChildRunner now must be a function");
    this.#noProgressTimeoutMs = noProgressTimeoutMs;
    this.#attemptMaxRunMs = attemptMaxRunMs;
    this.#capacityWaitMs = capacityWaitMs;
    this.#capacityRetryMs = capacityRetryMs;
    this.#now = now;
    this.#checkpointStore = checkpointStore;
    this.#defectRecorder = defectRecorder;
    this.#resolver = resolver;
    this.#semaphore = semaphore;
    this.#sessionsRoot = sessionsRoot;
    this.#delay = delay;
    this.#spawnChild = spawnChild;
  }

  get semaphore() { return this.#semaphore; }
  get noProgressTimeoutMs() { return this.#noProgressTimeoutMs; }

  hasLiveWork() {
    return this.#activeRuns.size > 0
      || this.#inflightSpawns.size > 0
      || this.#handles.size > 0
      || this.#admissions.size > 0;
  }

  activeAttempts() {
    return [...this.#attempts.values()].map((attempt) => {
      const handle = this.#handles.get(attempt.attemptId);
      const usage = handle?.session?.usage ?? attempt.usage ?? {};
      return Object.freeze({ ...attempt, usage: Object.freeze({ ...usage }) });
    }).sort((left, right) => left.startedAt - right.startedAt || left.attemptId.localeCompare(right.attemptId));
  }

  #publishAttempt(attempt) {
    this.#attempts.set(attempt.attemptId, Object.freeze({ ...attempt }));
  }

  #updateAttempt(attemptId, patch) {
    const current = this.#attempts.get(attemptId);
    if (!current) return;
    this.#attempts.set(attemptId, Object.freeze({ ...current, ...patch }));
  }

  #clearAttempt(attemptId) {
    if (attemptId) this.#attempts.delete(attemptId);
  }

  #recordDefect(defect) {
    try { this.#defectRecorder?.(defect); } catch { /* defect capture cannot change task settlement */ }
  }

  #acceptedCheckpointPrompt(taskId, rootId) {
    if (!this.#checkpointStore) return "";
    try { return this.#checkpointStore.renderAccepted({ taskId, ...(typeof rootId === "string" ? { rootId } : {}) }); }
    catch (error) {
      this.#recordDefect({
        kind: "checkpoint", origin: "controller", taskId, rootId,
        phase: "replacement_context", message: "accepted checkpoint rendering failed", retryable: false,
        details: { error: String(error?.message ?? error).slice(0, 500) },
      });
      return "";
    }
  }

  #observeAttemptEvent(attemptId, event) {
    if (!event || typeof event.type !== "string") return;
    // Keep this list exactly aligned with #promptWithDeadline. Lifecycle chatter such as
    // agent_start/agent_settled is observed, but it is not proof that useful work progressed.
    const progress = [
      "message_update", "message_end", "tool_execution_start", "tool_execution_update",
      "tool_execution_end", "auto_retry_start", "auto_retry_end", "bash_execution_update",
    ].includes(event.type);
    const observedAt = this.#now();
    const childReport = event.type === "tool_execution_end" ? event.result?.details?.brokerChildReport : undefined;
    this.#updateAttempt(attemptId, {
      lastEventAt: observedAt,
      lastEventType: event.type,
      ...(progress ? { lastProgressAt: observedAt } : {}),
      ...(typeof childReport?.summary === "string" ? { lastProgressSummary: childReport.summary.slice(0, 240) } : {}),
    });
    if ((event.type === "tool_execution_end" || event.type === "tool_result") && (event.isError === true || event.error)) {
      const attempt = this.#attempts.get(attemptId);
      this.#recordDefect({
        kind: "tool", origin: "child", rootId: attempt?.rootId, taskId: attempt?.logicalId ?? attempt?.baseChildId,
        attemptId, tool: typeof event.toolName === "string" ? event.toolName.slice(0, 256) : "unknown",
        phase: event.type, message: "child tool execution reported an error", retryable: true,
        observedAt, details: { eventType: event.type, hasError: true },
      });
    }
  }

  /**
   * Run one delegated task to completion across a changing provider set.
   *
   * `spawn` places a child on one resource. When that resource throttles or dies mid-run the
   * task itself is still valid, so this reports the provider health to the broker, excludes
   * that resource, and launches again — the selector picks whatever is alive on the next pass.
   * A context overflow re-routes without blaming the provider: it asks for a larger context
   * class instead, because the account is healthy and the task simply outgrew the model.
   *
   * Returns the terminal child result, plus a `route` trail of every attempt made.
   */
  async run({ childId, maxAttempts = MAX_ROUTE_ATTEMPTS, trackForVerification = false, fleet, attemptBudget, onAttemptStarted, ...spec }) {
    if (this.#disposed) throw new Error("BrokeredChildRunner is disposed");
    if (!CHILD_ID.test(childId ?? "")) throw new Error("BrokeredChildRunner requires a valid childId");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");
    if (typeof trackForVerification !== "boolean") throw new Error("trackForVerification must be boolean");
    if (attemptBudget !== undefined && (!attemptBudget || typeof attemptBudget.acquire !== "function")) throw new Error("attemptBudget must provide a controller-owned acquire function");
    if (onAttemptStarted !== undefined && typeof onAttemptStarted !== "function") throw new Error("onAttemptStarted must be a controller-owned callback");
    if (fleet !== undefined && (fleet === null || typeof fleet !== "object" || Array.isArray(fleet))) {
      throw new Error("BrokeredChildRunner fleet metadata must be an object");
    }

    const fleetMeta = fleet ?? {};
    const excludeResources = [...(spec.capabilityRequest?.excludeResources ?? [])];
    const requestedBudget = spec.capabilityRequest?.budget;
    if (requestedBudget?.maxAttempts !== undefined
      && (!Number.isSafeInteger(requestedBudget.maxAttempts) || requestedBudget.maxAttempts < 1 || requestedBudget.maxAttempts > MAX_ROUTE_ATTEMPTS)) {
      throw new Error(`maxAttempts must be an integer between 1 and ${MAX_ROUTE_ATTEMPTS}`);
    }
    let routeAttemptLimit = Math.min(maxAttempts, requestedBudget?.maxAttempts ?? maxAttempts);
    const cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    let usageObserved = false;
    let effectiveBudget = requestedBudget ?? {};
    const addUsage = (usage) => {
      if (!usage || typeof usage !== "object") return;
      usageObserved = true;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "turns"]) {
        if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) {
          cumulativeUsage[key] = Math.min(Number.MAX_SAFE_INTEGER, cumulativeUsage[key] + usage[key]);
        }
      }
    };
    const budgetExceeded = () => {
      const inputUsed = cumulativeUsage.input + cumulativeUsage.cacheRead + cumulativeUsage.cacheWrite;
      if (effectiveBudget.enforcement?.input === "hard" && Number.isSafeInteger(effectiveBudget.maxInputTokens) && inputUsed > effectiveBudget.maxInputTokens) {
        return `controller cumulative input budget exceeded (${inputUsed} > ${effectiveBudget.maxInputTokens}); raise the task's maxInputTokens budget to continue it`;
      }
      if (effectiveBudget.enforcement?.output === "hard" && Number.isSafeInteger(effectiveBudget.maxOutputTokens) && cumulativeUsage.output > effectiveBudget.maxOutputTokens) {
        return `controller cumulative output budget exceeded (${cumulativeUsage.output} > ${effectiveBudget.maxOutputTokens}); raise the task's maxOutputTokens budget to continue it`;
      }
      return undefined;
    };
    const route = [];
    let childHandoffs = 0; // Count only actual post-admission Pi session handoffs, not denied route hops.
    const unavailableByCapacityGroup = new Map();
    let requiredCapabilities = spec.capabilityRequest?.requiredCapabilities;
    let capacityWaitDeadline;
    let lastResult;
    let carryoverProgress = "";
    let carryoverPatch = "";
    let carryoverChanged = [];
    let visibleAttemptId;
    const finish = (value) => {
      this.#clearAttempt(visibleAttemptId);
      visibleAttemptId = undefined;
      this.#activeRuns.delete(childId);
      this.#abortedRuns.delete(childId);
      // Carry the requested contract next to the result so the controller can persist what was
      // asked for beside what the provider actually accepted. Without the pair, a silently
      // downgraded effort level is indistinguishable from one that was never requested.
      // A terminal result must never hide work that already exists. Several failure branches build a
      // fresh `{ text: "" }` object — that is how three killed audits reported an empty result while
      // their children had already streamed findings. Recovering here covers every branch at once.
      // It still never promotes partial work: a completed result keeps its own text untouched, and
      // what is attached is marked unverified downstream.
      const recovered = value.status === "completed" || value.text
        ? ""
        : boundedPartialText(recoverPartialText(this.#sessionsRoot, childId));
      return Object.freeze({
        ...value,
        ...(recovered ? { text: recovered } : {}),
        ...(usageObserved ? { usage: Object.freeze({ ...cumulativeUsage }) } : {}),
        requestedThinking: spec.thinkingLevel ?? "off",
        childHandoffs,
        ...(typeof fleetMeta.role === "string" ? { role: fleetMeta.role } : {}),
      });
    };
    // Cancellation must reach a run that owns no child process yet. Without this an abort issued
    // while the route is queued behind live capacity is silently a no-op, and the controller
    // keeps paying for attempts the operator already cancelled.
    const abortedEarly = () => this.#disposed || this.#abortedRuns.has(childId);

    this.#abortedRuns.delete(childId);
    this.#activeRuns.add(childId);
    for (let attempt = 1; attempt <= routeAttemptLimit; attempt++) {
      const attemptId = attempt === 1 ? childId : `${childId}-r${attempt}`;
      if (abortedEarly()) return finish(Object.freeze({
        id: childId, status: "aborted", text: "",
        error: this.#disposed ? "brokered runner disposed" : "aborted before a child was launched",
        route: Object.freeze(route),
      }));
      visibleAttemptId = attemptId;
      const attemptStartedAt = this.#now();
      this.#publishAttempt({
        attemptId,
        baseChildId: childId,
        logicalId: typeof fleetMeta.logicalId === "string" ? fleetMeta.logicalId : childId,
        rootId: typeof fleetMeta.rootId === "string" ? fleetMeta.rootId : childId,
        ...(typeof fleetMeta.workflowId === "string" ? { workflowId: fleetMeta.workflowId } : {}),
        ...(typeof fleetMeta.nodeId === "string" ? { nodeId: fleetMeta.nodeId } : {}),
        kind: typeof fleetMeta.kind === "string" ? fleetMeta.kind : "task",
        role: typeof fleetMeta.role === "string" ? fleetMeta.role : "worker",
        attempt,
        state: "selecting",
        requestedThinking: spec.thinkingLevel ?? "off",
        startedAt: attemptStartedAt,
        lastEventAt: attemptStartedAt,
        lastEventType: "selecting",
        usage: {},
      });
      const capabilityRequest = {
        ...(spec.capabilityRequest ?? {}),
        ...(excludeResources.length > 0 ? { excludeResources: [...excludeResources] } : {}),
        ...(requiredCapabilities ? { requiredCapabilities: [...requiredCapabilities] } : {}),
        // An exact identity has to reach the selector, not only the resolver. The resolver
        // requires an explicit model to equal what the selector independently chose, so asking
        // for one without constraining selection would deny every honourable request instead.
        ...(spec.model?.provider && spec.model?.modelId
          ? { requireModelIdentity: { provider: spec.model.provider, modelId: spec.model.modelId } }
          : {}),
      };

      // Checkpoints are keyed to the controller lease task id. The child may declare lineage
      // metadata, but it cannot choose which other root's accepted artifacts enter its prompt.
      const checkpointPrompt = this.#acceptedCheckpointPrompt(childId);
      const continuityLines = [];
      if (carryoverProgress) {
        continuityLines.push(`Last structured progress report: ${carryoverProgress}`);
      }
      if (carryoverChanged.length > 0) {
        continuityLines.push(`Carried-over worktree changes already applied in your workspace: ${carryoverChanged.join(", ")}`);
      }
      const continuityPrompt = continuityLines.length > 0
        ? `Prior attempt progress before provider failover (unverified child progress — verify and continue from this state without redoing completed steps):\n- ${continuityLines.join("\n- ")}`
        : "";
      const replacementContext = [checkpointPrompt, continuityPrompt].filter(Boolean).join("\n\n");
      if (replacementContext) capabilityRequest.routingActiveBriefComplete = false;
      const attemptPrompt = replacementContext
        ? `${spec.prompt ?? ""}\n\n${replacementContext}`
        : spec.prompt;
      const attemptPromptDigest = replacementContext && typeof attemptPrompt === "string"
        ? createHash("sha256").update(attemptPrompt).digest("hex")
        : spec.promptDigest;
      let handle;
      try {
        handle = await this.spawn({
          ...spec, childId: attemptId, prompt: attemptPrompt, promptDigest: attemptPromptDigest,
          capabilityRequest, attempts: attempt, attemptBudget, deferClosePolicy: true,
          ...(carryoverPatch ? { seedPatch: carryoverPatch } : {}),
          onAttemptStarted: async (event) => {
            await onAttemptStarted?.(event); // Keep the original durable gate before counting a handoff.
            childHandoffs++;
          },
        });
      } catch (error) {
        if (error?.code === PARENT_HANDOFF_FAILED_CODE) {
          const message = "controller could not durably record parent-to-child admission";
          route.push({ attempt, childId: attemptId, outcome: "controller_handoff_failed", error: message });
          return finish(Object.freeze({ id: childId, status: "failed", text: "", error: message, route: Object.freeze(route) }));
        }
        if (error?.code === ROOT_ATTEMPT_BUDGET_CODE) {
          const message = "controller root physical-attempt budget exceeded";
          route.push({ attempt, childId: attemptId, outcome: "root_budget_exceeded", error: message });
          return finish(Object.freeze({ id: childId, status: "failed", text: "", error: message, route: Object.freeze(route) }));
        }
        if (abortedEarly()) return finish(Object.freeze({
          id: childId, status: "aborted", text: "",
          error: this.#disposed ? "brokered runner disposed" : "aborted before a child was launched",
          route: Object.freeze(route),
        }));
        // Busy live capacity waits; it is not a spent provider attempt.
        if (isTemporaryCapacityDenial(error)) {
          const now = this.#now();
          capacityWaitDeadline ??= now + this.#capacityWaitMs;
          if (now < capacityWaitDeadline) {
            this.#updateAttempt(attemptId, {
              state: "waiting_capacity", lastEventAt: now, lastEventType: "capacity_wait",
              waitUntil: Math.min(capacityWaitDeadline, now + this.#capacityRetryMs),
            });
            await this.#delay(Math.min(this.#capacityRetryMs, Math.max(1, capacityWaitDeadline - now)));
            attempt -= 1; // capacity contention did not spend a provider attempt
            continue;
          }
          const message = `compatible broker capacity remained busy for ${this.#capacityWaitMs}ms`;
          route.push({ attempt, childId: attemptId, outcome: "capacity_wait_timeout", error: message });
          return finish(Object.freeze({ id: childId, status: "failed", text: "", error: message, route: Object.freeze(route) }));
        }
        // A policy/capability denial cannot be repaired by replaying the same contract.
        route.push({ attempt, childId: attemptId, outcome: "denied", error: error.message });
        return finish(Object.freeze({ id: childId, status: "failed", text: "", error: error.message, route: Object.freeze(route) }));
      }
      // Cancellation can land after the semaphore grant but before a handle existed, i.e. while
      // the resolver was still choosing a route. The child is real now, so stop it through the
      // normal close path instead of leaving the operator paying for cancelled work.
      if (abortedEarly()) {
        await handle.session?.abort?.().catch(() => undefined);
        const aborted = await handle.result.catch(() => ({ status: "aborted" }));
        // run() owns lease closure for its attempts (deferClosePolicy), so an early return has
        // to close it here or the account stays leased for the rest of the session.
        await this.#closeAttempt(handle, aborted).catch(() => undefined);
        route.push({ attempt, childId: attemptId, resourceId: handle.resource?.id, outcome: "aborted" });
        return finish(Object.freeze({
          id: childId, status: "aborted", text: "",
          error: this.#disposed ? "brokered runner disposed" : "aborted after launch admission",
          route: Object.freeze(route),
        }));
      }

      const resourceId = handle.resource?.id;
      this.#updateAttempt(attemptId, {
        state: "running",
        resourceId,
        provider: handle.model?.provider,
        modelId: handle.model?.modelId,
        effectiveThinking: handle.resolved?.thinkingLevel ?? spec.thinkingLevel ?? "off",
        tier: handle.selection?.modelTier,
        lastEventAt: this.#now(),
        lastEventType: "child_started",
      });
      const policyBudget = handle.policy?.authorizationPolicy?.budget;
      if (policyBudget && typeof policyBudget === "object") {
        effectiveBudget = policyBudget;
        if (Number.isSafeInteger(policyBudget.maxAttempts)) routeAttemptLimit = Math.min(routeAttemptLimit, policyBudget.maxAttempts);
      }
      if (trackForVerification) {
        // The child releases its own lease when its session ends, so durable tracking has to
        // happen while the child is still running. Tracking is not acceptance: a failed attempt
        // requeues this task, and only a completed one reaches the verifier.
        try {
          const tracked = await handle.policy.trackForVerification?.();
          if (tracked?.status !== "tracked") {
            const reason = typeof tracked?.reason === "string" ? tracked.reason : (tracked?.status ?? "no_response");
            throw new Error(`controller could not durably track this attempt: ${reason}`);
          }
        } catch (error) {
          await this.#closeAttempt(handle, { status: "failed" }).catch(() => undefined);
          route.push({ attempt, childId: attemptId, resourceId, outcome: "controller_track_failed", error: error.message });
          return finish(Object.freeze({ id: childId, status: "failed", text: "", error: error.message, route: Object.freeze(route) }));
        }
      }
      lastResult = await handle.result;
      addUsage(lastResult.usage);
      // A killed attempt never produces a final message, so without this the terminal report is an
      // empty "failed" and every token the child spent is invisible to the parent. The child's
      // fd-synced journal holds the public text it had already streamed; recover it as UNVERIFIED
      // partial work. Classification deliberately still runs on the ORIGINAL failure evidence: a
      // child's own prose mentioning "429" or "quota" must not turn a budget kill into a provider
      // rate-limit verdict against an innocent account.
      const failureEvidenceText = lastResult.error ?? lastResult.text;
      if (lastResult.status !== "completed" && !lastResult.text) {
      const partial = boundedPartialText(recoverPartialText(this.#sessionsRoot, childId));
        if (partial) lastResult = { ...lastResult, text: partial };
      }
      const exceeded = budgetExceeded();
      this.#updateAttempt(attemptId, {
        state: exceeded ? "failed" : "verifying",
        lastEventAt: this.#now(),
        lastEventType: exceeded ? "budget_exceeded" : "child_terminal",
        usage: { ...cumulativeUsage },
      });
      if (exceeded) {
        const budgetResult = { ...lastResult, id: childId, status: "failed", error: exceeded };
        await this.#closeAttempt(handle, budgetResult).catch(() => undefined);
        route.push({ attempt, childId: attemptId, resourceId, outcome: "budget_exceeded", error: exceeded });
        return finish(Object.freeze({ ...budgetResult, route: Object.freeze(route) }));
      }
      let closure;
      try {
        closure = await this.#closeAttempt(handle, lastResult);
      } catch (error) {
        route.push({ attempt, childId: attemptId, resourceId, outcome: "controller_close_failed", error: error.message });
        return finish(Object.freeze({ ...lastResult, id: childId, status: "failed", error: `controller close failed: ${error.message}`, route: Object.freeze(route) }));
      }
      if (lastResult.status === "blocked" || lastResult.status === "handback") {
        route.push({ attempt, childId: attemptId, resourceId, outcome: lastResult.status });
        return finish(Object.freeze({ ...lastResult, id: childId, route: Object.freeze(route) }));
      }
      if (lastResult.status === "completed") {
        const verification = closure?.verification;
        if (verification?.outcome?.status && verification.outcome.status !== "completed") {
          route.push({ attempt, childId: attemptId, resourceId, outcome: "verification_rejected" });
          return finish(Object.freeze({ ...lastResult, id: childId, status: "failed", error: "controller acceptance verification rejected the completed child result", verification, route: Object.freeze(route) }));
        }
        route.push({ attempt, childId: attemptId, resourceId, outcome: "completed" });
        return finish(Object.freeze({ ...lastResult, id: childId, ...(verification ? { verification } : {}), route: Object.freeze(route) }));
      }

      const kind = lastResult.status === "aborted" || abortedEarly()
        ? "fatal"
        : classifyChildFailure(failureEvidenceText, {
          readOnly: handle.policy?.authorizationPolicy?.operationClass === "observe"
            && handle.policy.authorizationPolicy.effectCapable === false,
        });
      this.#updateAttempt(attemptId, { state: "failed", failureKind: kind, lastEventAt: this.#now(), lastEventType: "attempt_failed" });
      route.push({ attempt, childId: attemptId, resourceId, outcome: kind, error: lastResult.error });

      // Provider health is reported before deciding whether to continue. A throttled or dead
      // account is an observed fact about the fleet no matter which attempt saw it; reporting
      // it only when a retry follows means the route that fails last is never cooled, and the
      // next task selects that same exhausted account first and burns an attempt re-proving it.
      if (resourceId !== undefined && kind !== "fatal" && kind !== "incomplete" && kind !== "controller_failure") {
        if (kind === "rate_limited" || (kind === "account_exhausted" && Number.isSafeInteger(lastResult.retryAfterMs) && lastResult.retryAfterMs > 0)) {
          await this.#reportRateLimited(resourceId, lastResult.retryAfterMs);
        } else if (kind === "account_exhausted") {
          // Replenishable credit without a provider reset hint is not a known multi-hour quota
          // window. Use the existing bounded half-open interval, not the default 6-hour 429 delay.
          await this.#reportUnavailable(resourceId, "provider quota_exhausted", "capacity_group");
        }
        // A revoked/expired credential belongs to the account, not the model: condemning only
        // this resource makes the next hop retry a sibling model on the same dead credential.
        else if (kind === "auth_fatal") await this.#reportUnavailable(resourceId, "provider auth_fatal", "capacity_group");
        else if (kind === "unavailable") {
          const capacityGroup = handle.resource?.capacityGroup;
          const failures = capacityGroup ? (unavailableByCapacityGroup.get(capacityGroup) ?? 0) + 1 : 1;
          if (capacityGroup) unavailableByCapacityGroup.set(capacityGroup, failures);
          // One model can be stale while its account remains healthy. Two independent route
          // failures on the same account are account-level evidence: quarantine the group so a
          // catalog with many aliases cannot consume every bounded attempt before failover.
          // A route that never reached the provider needs no second sample: the unreachable
          // endpoint is shared by the account, so escalate on the first observation.
          const unreachable = isEndpointUnreachable(lastResult.error ?? lastResult.text);
          await this.#reportUnavailable(
            resourceId,
            unreachable ? "provider endpoint unreachable" : "provider unavailable",
            unreachable || failures >= 2 ? "capacity_group" : "resource",
          );
        }
        // A context overflow leaves the provider healthy — only this route is wrong.
        if (kind !== "context_exhausted" && kind !== "budget_exhausted") excludeResources.push(resourceId);
      }
      if (resourceId !== undefined && kind === "incomplete") excludeResources.push(resourceId);
      if (kind === "fatal" || kind === "budget_exhausted" || kind === "controller_failure" || attempt === routeAttemptLimit) break;

      if (typeof lastResult?.childReport?.summary === "string" && lastResult.childReport.summary.trim().length > 0) {
        carryoverProgress = lastResult.childReport.summary.trim().slice(0, 1_000);
      }
      if (typeof lastResult?.patch === "string" && lastResult.patch.trim().length > 0) {
        carryoverPatch = lastResult.patch;
        carryoverChanged = Array.isArray(lastResult.changed) ? [...lastResult.changed] : [];
      }
      this.#clearAttempt(attemptId);
      visibleAttemptId = undefined;
      if (kind === "context_exhausted") {
        const widened = new Set([...(requiredCapabilities ?? []), "large_context"]);
        if (requiredCapabilities && widened.size === requiredCapabilities.length) break;
        requiredCapabilities = [...widened];
        if (resourceId !== undefined) excludeResources.push(resourceId);
      }
    }

    // An abort that lands on the final attempt is still an abort, not a provider failure.
    if (abortedEarly() && lastResult?.status !== "completed") {
      return finish(Object.freeze({
        id: childId, status: "aborted", text: "",
        error: this.#disposed ? "brokered runner disposed" : "aborted during the final attempt",
        route: Object.freeze(route),
      }));
    }
    return finish(Object.freeze({
      ...(lastResult ?? { id: childId, status: "failed", text: "", error: "no attempt produced a result" }),
      id: childId,
      route: Object.freeze(route),
    }));
  }

  async #reportRateLimited(resourceId, retryAfterMs) {
    try { await this.#resolver.reportProviderRateLimited?.(resourceId, retryAfterMs); }
    catch { /* health reporting is best effort; the attempt is already excluded locally */ }
  }

  async #reportUnavailable(resourceId, reason, scope) {
    try { await this.#resolver.reportProviderUnavailable?.(resourceId, reason, scope); }
    catch { /* health reporting is best effort; the attempt is already excluded locally */ }
  }

  /**
   * Spawn one brokered child for a fixed contract. The resolver decides
   * allow/deny before any process starts. Returns a handle whose `result`
   * promise resolves to the child's terminal result (not task acceptance).
   */
  async #closeAttempt(handle, result) {
    // Closing the resolver admission both frees capacity and decides the tracked task's next
    // state: a completed child moves toward controller verification, any other outcome requeues
    // the task so a later route can claim the same logical work.
    return handle.policy.onChildSessionClosed?.({
      status: result.status,
      // Preserve only the exact bounded completed answer for controller-owned result checks.
      // The child's text is evidence to compare, never authority to accept itself; incomplete,
      // failed and oversized output cannot accidentally satisfy answer-equals.
      ...(result.status === "completed" && typeof result.text === "string"
        && Buffer.byteLength(result.text, "utf8") <= 4_096 ? { text: result.text } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(THINKING_LEVELS.includes(handle.resolved?.thinkingLevel)
        ? { effectiveThinking: handle.resolved.thinkingLevel } : {}),
      attempts: handle.attempts,
    });
  }

  /**
   * Track the whole launch, not just the queue wait: between the semaphore grant and handle
   * registration there is a window with no admission and no handle, and dispose() must still
   * be able to wait for it instead of returning while a child is being born.
   */
  /**
   * Role framing is appended after the controller's own framing and the lease's prompt rules,
   * so a role can never restate or weaken them: it is the last, least authoritative voice.
   */
  async spawn(request) {
    const promise = this.#spawn(request);
    this.#inflightSpawns.set(promise, request?.childId);
    try { return await promise; }
    finally { this.#inflightSpawns.delete(promise); }
  }

  async #spawn({ childId, promptDigest, model, cwd, isolation = "none", tools, excludeTools, label, thinkingLevel, prompt, capabilityRequest, recursion, attempts = 1, attemptBudget, deferClosePolicy = false, roleFraming, skills, forkSessionFile, seedPatch, onAttemptStarted }) {
    if (this.#disposed) throw new Error("BrokeredChildRunner is disposed");
    if (this.#handles.has(childId)) throw new Error(`Duplicate child id: ${childId}`);
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("brokered child attempt count must be a positive safe integer");
    if (typeof deferClosePolicy !== "boolean") throw new Error("deferClosePolicy must be boolean");

    const admission = new AbortController();
    this.#admissions.set(admission, this.#attempts.get(childId)?.baseChildId ?? childId);
    let release;
    try { release = await this.#semaphore.acquire(admission.signal); }
    finally { this.#admissions.delete(admission); }
    this.#permits.set(childId, release);

    try {
      if (this.#disposed) throw new Error("BrokeredChildRunner disposed before launch");
      // Keep cancellation reachable during optional pre-lease advice. A task cancelled while
      // Jev is waiting must not reserve a resource when that answer finally arrives.
      const selecting = new AbortController();
      this.#admissions.set(selecting, this.#attempts.get(childId)?.baseChildId ?? childId);
      let decision;
      try { decision = await this.#resolver.resolve({
        childId,
        signal: selecting.signal,
        promptDigest,
        requestedCwd: cwd,
        isolation,
        schemaRequested: false,
        // An explicit model is a manual override and is passed straight through. Without one
        // the controller's selector decides, and the resolver checks the child against
        // whatever it selected — so a caller cannot smuggle in an unapproved model either way.
        ...(model ? { model: { provider: model.provider, modelId: model.modelId, thinkingLevel: thinkingLevel ?? "off" } } : {}),
        ...(capabilityRequest ? { capabilityRequest } : {}),
        ...(recursion ? { recursion } : {}),
        ...(tools ? { requestedTools: tools } : {}),
        ...(excludeTools ? { excludedTools: excludeTools } : {}),
      }); } finally { this.#admissions.delete(selecting); }

      if (decision.action === "deny") throw new Error(`Broker denied launch: ${decision.reason}`);

      const policy = decision.policy;
      const cancellationOwner = this.#attempts.get(childId)?.baseChildId ?? childId;
      const cancelledBeforePrompt = () => selecting.signal.aborted || this.#disposed || this.#abortedRuns.has(cancellationOwner);
      const abandonCancelledLease = async () => {
        if (!cancelledBeforePrompt()) return;
        await Promise.resolve(policy.onBeforeChildAbandoned?.("cancelled_before_handoff")).catch(() => undefined);
        throw new Error("brokered child launch cancelled before handoff");
      };
      await abandonCancelledLease();
      if (decision.selectedThinking !== undefined
        && (decision.selectedThinking !== "low" || thinkingLevel !== "off"
          || capabilityRequest?.routingThinkingMode !== "auto" || capabilityRequest?.routingRouteMode !== "auto"
          || decision.selection?.jevActive?.applied !== true)) {
        await Promise.resolve(policy.onBeforeChildAbandoned?.("invalid_active_thinking_override")).catch(() => undefined);
        throw new Error("Broker rejected an active thinking override outside the caller auto contract");
      }
      // A proposed effect is only safe in a disposable Git worktree. Letting an otherwise
      // correctly attested patch tool run against the caller's cwd would turn verification into
      // after-the-fact damage control, so reject before a child process exists.
      if (policy.authorizationPolicy?.effectCapable === true && isolation !== "worktree") {
        await policy.onBeforeChildAbandoned?.("effect_requires_worktree");
        throw new Error("effect-capable brokered launch requires worktree isolation");
      }
      // Count a physical attempt only after provider snapshot/preflight and exact lease admission
      // have succeeded. A denied/stale route must not consume the workflow root's attempt budget.
      if (attemptBudget) {
        let grant;
        try { grant = await attemptBudget.acquire({ childId, attempt: attempts }); }
        catch (error) {
          await Promise.resolve(policy.onBeforeChildAbandoned?.("root_attempt_budget_gate_failed")).catch(() => undefined);
          throw error;
        }
        if (!grant?.granted) {
          await Promise.resolve(policy.onBeforeChildAbandoned?.("root_attempt_budget_exceeded")).catch(() => undefined);
          const error = new Error("controller root physical-attempt budget exceeded");
          error.code = ROOT_ATTEMPT_BUDGET_CODE;
          throw error;
        }
      }
      await abandonCancelledLease();
      // The lease decides the model, not the request: the contract pins a capability class and
      // the broker picks a live resource inside it, which may not be the one predicted.
      const launchModel = decision.childModel ?? decision.resolvedModel ?? model;
      if (!launchModel?.provider || !launchModel?.modelId) throw new Error("Broker allowed a launch without a resolved model");
      const sessionsDir = join(this.#sessionsRoot, childId, "sessions");

      let worktree;
      let childSpec = {
        model: `${launchModel.provider}/${launchModel.modelId}`,
        // The leased model, not the caller, decides whether "off" is even a legal mode.
        thinkingLevel: effectiveThinkingLevel(launchModel, decision.selectedThinking ?? thinkingLevel ?? "off"),
        cwd,
        prompt,
        ...(tools ? { tools } : {}),
        ...(excludeTools ? { excludeTools } : {}),
        label: label ?? "brokered-child",
        // Controller framing first, caller role next (quoted, non-authoritative), lease rules
        // last so they win any conflict with role prose that imitates a policy section.
        appendSystemPrompt: [SUBAGENT_FRAMING, roleFraming, policy.promptRules].filter(Boolean).join("\n\n"),
        ...(skills ? { skills } : {}),
      };

      if (isolation === "worktree") {
        const sourceCwd = cwd;
        const tree = await createWorktree(sourceCwd, join(this.#sessionsRoot, childId, "worktree"));
        if (typeof seedPatch === "string" && seedPatch.trim().length > 0) {
          try {
            applyProposedPatch({ cwd: tree.cwd, patch: seedPatch });
          } catch {
            // Best-effort carryover: if the prior partial patch cannot apply cleanly, keep the fresh worktree.
          }
        }
        worktree = { sourceCwd, tree };
        childSpec = { ...childSpec, cwd: tree.cwd };
      }
      if (cancelledBeforePrompt()) {
        if (worktree) await cleanupWorktree(worktree.sourceCwd, worktree.tree.path).catch(() => undefined);
        await abandonCancelledLease();
      }

      let child;
      try {
        child = await this.#spawnChild({
          spec: childSpec,
          parentCwd: cwd,
          sessionsDir,
          ...(forkSessionFile ? { forkSessionFile } : {}),
          launchPolicy: {
            ...policy,
            offline: policy.offline ?? false,
          },
        });
      } catch (error) {
        await policy.onBeforeChildAbandoned?.("child_construction_failed");
        throw error;
      }

      const closeCancelledChild = async (handed) => {
        if (!cancelledBeforePrompt()) return;
        await Promise.resolve(child.session?.abort?.()).catch(() => undefined);
        await Promise.resolve(child.session?.dispose?.()).catch(() => undefined);
        if (handed) await Promise.resolve(policy.onChildSessionClosed?.({ status: "aborted", attempts })).catch(() => undefined);
        else await Promise.resolve(policy.onBeforeChildAbandoned?.("cancelled_before_handoff")).catch(() => undefined);
        if (worktree) await cleanupWorktree(worktree.sourceCwd, worktree.tree.path).catch(() => undefined);
        throw new Error("brokered child launch cancelled before prompt");
      };
      await closeCancelledChild(false);
      try {
        const handoff = await policy.onChildSessionOpened?.();
        // A controller may revoke the active choice after child construction but before
        // handoff. Its refusal is not advisory: no provider prompt may follow it.
        if (handoff !== undefined && handoff?.status !== "handed") {
          throw new Error(`broker denied child handoff: ${handoff?.status ?? "unknown"}`);
        }
      } catch (error) {
        await Promise.resolve(child.session?.abort?.()).catch(() => undefined);
        await Promise.resolve(child.session?.dispose?.()).catch(() => undefined);
        await Promise.resolve(policy.onBeforeChildAbandoned?.("handoff_rejected")).catch(() => undefined);
        if (worktree) await cleanupWorktree(worktree.sourceCwd, worktree.tree.path).catch(() => undefined);
        throw error;
      }
      await closeCancelledChild(true);

      // This is the last controller-owned gate before the first provider request. Opening a
      // Pi session does not send the task prompt; only #runAndClose does that. Persist the
      // parent-to-child handoff here, never after the prompt has already begun.
      if (onAttemptStarted) {
        try {
          await onAttemptStarted(Object.freeze({ childId, resourceId: decision.resource?.id, attempt: attempts }));
        } catch {
          await Promise.resolve(child.session?.abort?.()).catch(() => undefined);
          await Promise.resolve(child.session?.dispose?.()).catch(() => undefined);
          await Promise.resolve(policy.onChildSessionClosed?.({ status: "failed", attempts })).catch(() => undefined);
          if (worktree) await cleanupWorktree(worktree.sourceCwd, worktree.tree.path).catch(() => undefined);
          const error = new Error("controller could not durably record parent-to-child admission");
          error.code = PARENT_HANDOFF_FAILED_CODE;
          throw error;
        }
      }

      await closeCancelledChild(true);
      const handle = {
        id: childId,
        session: child.session,
        resolved: child.resolved,
        policy,
        release,
        worktree,
        // Which account this attempt actually spent from — the runner needs it to report health
        // and to exclude the resource on the next pass.
        resource: decision.resource,
        selection: decision.selection,
        attempts,
        deferClosePolicy,
        model: Object.freeze({ ...launchModel }),
        result: null,
      };

      this.#updateAttempt(childId, {
        state: "running",
        resourceId: decision.resource?.id,
        provider: launchModel.provider,
        modelId: launchModel.modelId,
        effectiveThinking: child.resolved?.thinkingLevel ?? childSpec.thinkingLevel,
        tier: decision.selection?.modelTier,
        lastEventAt: this.#now(),
        lastEventType: "child_started",
      });
      this.#handles.set(childId, handle);
      if (typeof child.session.subscribe === "function") {
        handle.fleetUnsubscribe = child.session.subscribe((event) => this.#observeAttemptEvent(childId, event));
      }

      const resultPromise = this.#runAndClose(handle, childSpec);
      handle.result = resultPromise;
      return handle;
    } catch (error) {
      this.#permits.delete(childId);
      release();
      throw error;
    }
  }

  /**
   * Timeout is controller safety, not parent waiting. Real child progress resets the watchdog;
   * a separate absolute attempt ceiling prevents an endlessly chatty child from living forever.
   */
  async #promptWithDeadline(session, prompt) {
    let progressTimer;
    let attemptTimer;
    let unsubscribe;
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const abortFor = (message) => {
      void Promise.resolve(session.abort?.()).catch(() => undefined);
      rejectDeadline(new Error(message));
    };
    const resetProgress = () => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(
        () => abortFor(`controller no-progress deadline exceeded after ${this.#noProgressTimeoutMs}ms`),
        this.#noProgressTimeoutMs,
      );
    };
    try {
      if (typeof session.subscribe === "function") {
        unsubscribe = session.subscribe((event) => {
          if ([
            "message_update", "message_end", "tool_execution_start", "tool_execution_update",
            "tool_execution_end", "auto_retry_start", "auto_retry_end", "bash_execution_update",
          ].includes(event?.type)) resetProgress();
        });
      }
      resetProgress();
      attemptTimer = setTimeout(
        () => abortFor(`controller attempt deadline exceeded after ${this.#attemptMaxRunMs}ms`),
        this.#attemptMaxRunMs,
      );
      await Promise.race([session.prompt(prompt), deadline]);
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      if (attemptTimer) clearTimeout(attemptTimer);
      try { unsubscribe?.(); } catch { /* event observation is best effort */ }
    }
  }

  async #runAndClose(handle, spec) {
    const { session, policy, worktree } = handle;
    let result;
    try {
      await this.#promptWithDeadline(session, spec.prompt ?? "");
      const message = session.latestAssistantMessage;
      const usage = session.usage;
      const rawText = assistantText(message);
      const childReport = session.lastChildReport;
      const sessionFile = typeof session.sessionFile === "string" && session.sessionFile
        ? session.sessionFile
        : (typeof handle.resolved?.sessionFile === "string" && handle.resolved.sessionFile ? handle.resolved.sessionFile : undefined);
      const worktreeResult = worktree ? await this.#collectWorktree(worktree) : undefined;
      if (message?.stopReason !== "error" && !handle.wasExternallyCancelled && childReport?.state === "blocked") {
        const question = typeof childReport.question === "string" ? childReport.question : "";
        const text = rawText.trim() ? rawText : (childReport.summary ? `${childReport.summary}\n\nQuestion: ${question}` : question);
        result = {
          id: handle.id,
          status: "blocked",
          text,
          question,
          childReport,
          ...(sessionFile ? { sessionFile } : {}),
          usage,
          resolved: handle.resolved,
          resource: handle.resource,
          ...(handle.selection ? { selection: handle.selection } : {}),
          ...(worktreeResult ?? {}),
        };
      } else if (message?.stopReason !== "error" && !handle.wasExternallyCancelled && childReport?.state === "handback") {
        const reason = typeof childReport.reason === "string" ? childReport.reason : "child handed back task";
        const text = rawText.trim() ? rawText : (childReport.summary ? `${childReport.summary}\n\nReason: ${reason}` : reason);
        result = {
          id: handle.id,
          status: "handback",
          text,
          reason,
          error: `child handback: ${reason}`,
          childReport,
          ...(sessionFile ? { sessionFile } : {}),
          usage,
          resolved: handle.resolved,
          resource: handle.resource,
          ...(handle.selection ? { selection: handle.selection } : {}),
          ...(worktreeResult ?? {}),
        };
      } else {
        const text = !rawText.trim() && childReport?.state === "ready" && typeof childReport.summary === "string"
          ? childReport.summary
          : rawText;
        const answered = text.trim().length > 0 || Boolean(worktreeResult?.patch);
        const unresolvedToolRequest = message?.stopReason === "toolUse" || message?.stopReason === "tool_use";
        const truncated = ["length", "max_tokens", "maxTokens"].includes(message?.stopReason);
        const aborted = message?.stopReason === "aborted";
        if (message?.stopReason === "error" || !answered || unresolvedToolRequest || truncated || aborted) {
          this.#recordDefect({
            kind: "lifecycle", origin: "controller", rootId: this.#attempts.get(handle.id)?.rootId,
            taskId: this.#attempts.get(handle.id)?.logicalId ?? handle.id, attemptId: handle.id,
            phase: "child_settlement", message: String(message?.errorMessage ?? (unresolvedToolRequest
              ? "child stopped with unresolved tool request" : truncated ? "child output was truncated" : aborted ? "child was aborted" : "child completed without a result")).replace(/\s+/g, " ").slice(0, 2_000),
            retryable: true, details: { stopReason: message?.stopReason ?? "empty_result" },
          });
          result = {
            id: handle.id,
            status: "failed",
            text,
            error: message?.stopReason === "error"
              ? (message.errorMessage ?? "Child model request failed")
              : unresolvedToolRequest
                ? "child stopped with an unresolved tool request"
                : truncated
                  ? "child output ended before completion"
                  : aborted
                    ? "child was aborted before completion"
                    : "child completed without a result",
            ...(childReport ? { childReport } : {}),
            ...(sessionFile ? { sessionFile } : {}),
            usage,
            resolved: handle.resolved,
            resource: handle.resource,
            ...(handle.selection ? { selection: handle.selection } : {}),
            ...(worktreeResult ?? {}),
          };
        } else {
          result = {
            id: handle.id,
            status: "completed",
            text,
            ...(childReport ? { childReport } : {}),
            ...(sessionFile ? { sessionFile } : {}),
            usage,
            resolved: handle.resolved,
            resource: handle.resource,
            ...(handle.selection ? { selection: handle.selection } : {}),
            ...(worktreeResult ?? {}),
          };
        }
      }
    } catch (error) {
      const childReport = session.lastChildReport;
      const sessionFile = typeof session.sessionFile === "string" && session.sessionFile
        ? session.sessionFile
        : (typeof handle.resolved?.sessionFile === "string" && handle.resolved.sessionFile ? handle.resolved.sessionFile : undefined);
      const worktreeResult = worktree ? await this.#collectWorktree(worktree).catch(() => undefined) : undefined;
      this.#recordDefect({
        kind: "lifecycle", origin: "controller", rootId: this.#attempts.get(handle.id)?.rootId,
        taskId: this.#attempts.get(handle.id)?.logicalId ?? handle.id, attemptId: handle.id,
        phase: "child_settlement", message: String(error?.message ?? "child execution failed").replace(/\s+/g, " ").slice(0, 2_000),
        retryable: true, details: { error: String(error?.name ?? "Error") },
      });
      result = {
        id: handle.id,
        status: handle.wasExternallyCancelled ? "aborted" : "failed",
        text: "",
        error: error.message,
        ...(childReport ? { childReport } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        usage: session.usage,
        resolved: handle.resolved,
        resource: handle.resource,
        ...(handle.selection ? { selection: handle.selection } : {}),
        ...(worktreeResult ?? {}),
      };
    } finally {
      // Success must precede dispose, whose shutdown hook releases the lease.
      if (["completed", "blocked", "handback"].includes(result?.status)) {
        try { await policy.onProviderSucceeded?.(); }
        catch { /* health recovery is best effort; the verified child result still stands */ }
      }
      handle.release();
      this.#permits.delete(handle.id);
      await session.dispose().catch(() => undefined);
      // Consumption is the measure the controller can actually observe, so it travels with the
      // close event: the verifier turns it into a routing observation once a receipt exists.
      if (!handle.deferClosePolicy) {
        await policy.onChildSessionClosed?.({
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          attempts: handle.attempts,
        });
      }
      if (worktree) {
        // Never delete an isolated attempt until its patch is recoverable,
        // including exceptions, cancellation and unsuccessful verification.
        try {
          const captured = await this.#collectWorktree(worktree);
          if (captured.error) throw new Error(captured.error);
          const evidenceDir = join(this.#sessionsRoot, handle.id, "sessions");
          mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
          writeFileSync(join(evidenceDir, `patch-${randomUUID()}.jsonl`),
            JSON.stringify({ kind: "proposed_patch", verificationStatus: "unverified", ...captured }) + "\n",
            { mode: 0o600, flag: "wx", flush: true });
          await cleanupWorktree(worktree.sourceCwd, worktree.tree.path);
        } catch { /* capture failed: retain the original worktree, never discard it */ }
      }
      try { handle.fleetUnsubscribe?.(); } catch { /* fleet observation is best effort */ }
      this.#handles.delete(handle.id);
    }
    return result;
  }

  async #collectWorktree(worktree) {
    try {
      const changes = await collectWorktree(worktree.tree);
      // The base commit travels with the patch: without it a verifier cannot rebuild the exact
      // tree the child started from, and "it applies to HEAD" is a different claim entirely.
      return { patch: changes.patch, changed: changes.changed, baseCommit: worktree.tree.baseCommit };
    } catch (error) {
      if (error instanceof WorktreeCollectionError) {
        return { patch: "", changed: [], error: `Worktree retained at ${error.worktreePath}` };
      }
      throw error;
    }
  }

  async withYieldedCapacity(childId, fn, signal) {
    if (this.#disposed) throw new Error("BrokeredChildRunner is disposed");
    if (typeof fn !== "function") throw new Error("withYieldedCapacity requires a callback");
    const permit = this.#permits.get(childId) ?? [...this.#permits.entries()].find(([id]) => id.replace(/-r[0-9]+$/, "") === childId)?.[1];
    if (!permit?.withYieldedCapacity) throw new Error("no runnable permit is bound to this child");
    return permit.withYieldedCapacity(signal, fn);
  }

  async abort(childId) {
    // Only a live run may be flagged. Recording an abort for a finished id would leak entries
    // for the session and could pre-kill a later legitimate run that reuses the same id.
    if (this.#activeRuns.has(childId)) this.#abortedRuns.add(childId);
    for (const [admission, owner] of this.#admissions) {
      if (owner === childId) admission.abort("run aborted");
    }
    const handles = [...this.#handles.values()].filter((handle) => {
      if (handle.id === childId) return true;
      const attempt = this.#attempts.get(handle.id);
      return attempt?.baseChildId === childId || attempt?.logicalId === childId;
    });
    await Promise.allSettled(handles.map((handle) => {
      handle.wasExternallyCancelled = true;
      return handle.session?.abort?.();
    }));
  }

  async dispose() {
    this.#disposed = true;
    for (const admission of this.#admissions.keys()) admission.abort("runner disposed");
    this.#admissions.clear();
    this.#permits.clear();
    // A launch already past admission can still register a handle after this point, so drain
    // in-flight spawns and newly registered handles until neither remains.
    for (let pass = 0; pass < 8; pass += 1) {
      await Promise.allSettled([...this.#inflightSpawns.keys()]);
      const handles = [...this.#handles.values()];
      if (handles.length === 0 && this.#inflightSpawns.size === 0) break;
      // A handle registered microseconds ago may not carry its result promise yet. Awaiting it
      // would be a no-op, so leave it for the next pass instead of disposing it half-born.
      const settled = handles.filter((handle) => handle.result);
      await Promise.allSettled(settled.map((handle) => handle.session?.abort?.()));
      // Wait for #runAndClose to finish — it calls onChildSessionClosed
      // which releases the broker lease.
      await Promise.allSettled(settled.map((h) => h.result));
      for (const handle of settled) await handle.session.dispose().catch(() => undefined);
      for (const handle of settled) this.#handles.delete(handle.id);
    }
    this.#handles.clear();
    this.#attempts.clear();
    this.#abortedRuns.clear();
    this.#activeRuns.clear();
  }
}