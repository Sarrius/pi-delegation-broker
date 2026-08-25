import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnBrokeredChild } from "./child-launcher.mjs";
import { Semaphore } from "./semaphore.mjs";
import { effectiveThinkingLevel } from "./model-thinking-policy.mjs";
import { createWorktree, collectWorktree, cleanupWorktree, WorktreeCollectionError } from "./worktree.mjs";

const SETTLE_GRACE_MS = 15_000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 180_000;
const DEFAULT_ATTEMPT_MAX_RUN_MS = 15 * 60_000;
const DEFAULT_CAPACITY_WAIT_MS = 15 * 60_000;
const DEFAULT_CAPACITY_RETRY_MS = 500;
const MAX_ROUTE_ATTEMPTS = 32;
const CHILD_ID = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * Terminal child failures split by who owns them. A provider that throttled or died is a
 * routing fact — the work is still valid and must be finished elsewhere. A context overflow is
 * nobody's fault: the provider is healthy, the task simply needs a bigger context class. Only
 * the last group is a genuine end of the road.
 */
const FAILURE_SIGNATURES = Object.freeze([
  Object.freeze({ kind: "incomplete", pattern: /child stopped with an unresolved tool request|child output ended before completion/i }),
  Object.freeze({ kind: "rate_limited", pattern: /\b(rate[ _-]?limit|too many requests|429|quota exceeded|overloaded|capacity)\b/i }),
  Object.freeze({ kind: "auth_fatal", pattern: /\b(401|403|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|invalid_grant|refresh token not found|authentication|expired token|revoked|no api key found)\b/i }),
  Object.freeze({ kind: "context_exhausted", pattern: /\b(context[ _-]?(window|length|limit)|prompt is too long|maximum context|token limit)\b/i }),
  // Capability/organization policy rejection is route-specific: the same task can run on
  // another account/model, so quarantine this resource and let controller failover continue.
  Object.freeze({ kind: "unavailable", pattern: /\b(unsupported_value|reasoning summaries|organization must be verified|model is not supported)\b/i }),
  // Provider catalogs are observations, not authority. A model can disappear between discovery
  // and launch; its 404 is a stale route and must fail over, not kill otherwise valid work.
  Object.freeze({ kind: "unavailable", pattern: /\bmodel\b[^\n]{0,200}\bnot found\b|\b404\b[^\n]{0,300}\bnot_found_error\b/i }),
  // A child that never answers is a dead route, not a dead task: fail over instead of hanging.
  Object.freeze({ kind: "unavailable", pattern: /\bcontroller (prompt|no-progress|attempt) deadline\b/i }),
  // Reasoning-mode refusals are route-specific policy, not a dead task: another route accepts it.
  Object.freeze({ kind: "unavailable", pattern: /reasoning is mandatory|cannot be disabled|always engages in thinking/i }),
  // Exhausted credit/balance is this account's problem, not the task's: cool it and move on.
  Object.freeze({ kind: "account_exhausted", pattern: /\b402\b|requires more credits|insufficient (credits|balance)|purchase credits|upgrade to a paid account|third-party apps now draw from your extra usage|claude\.ai\/settings\/usage/i }),
  Object.freeze({ kind: "account_exhausted", pattern: /usage limit (has been )?reached|plan usage limit|usage limit exceeded/i }),
  Object.freeze({ kind: "unavailable", pattern: /\b(50[0234]|service unavailable|bad gateway|upstream|connection (error|refused|reset)|econnrefused|etimedout|network)\b/i }),
  // A child that settles with no answer (expired lease IPC, empty final text) is a dead route.
  Object.freeze({ kind: "unavailable", pattern: /child completed without a result|controller lease heartbeat failed|broker behavioral monitor is unavailable/i }),
]);

export function classifyChildFailure(text) {
  if (typeof text !== "string" || !text) return "fatal";
  for (const signature of FAILURE_SIGNATURES) if (signature.pattern.test(text)) return signature.kind;
  return "fatal";
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
  #handles = new Map();
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
    if (typeof now !== "function") throw new Error("BrokeredChildRunner now must be a function");
    this.#noProgressTimeoutMs = noProgressTimeoutMs;
    this.#attemptMaxRunMs = attemptMaxRunMs;
    this.#capacityWaitMs = capacityWaitMs;
    this.#capacityRetryMs = capacityRetryMs;
    this.#now = now;
    this.#resolver = resolver;
    this.#semaphore = semaphore;
    this.#sessionsRoot = sessionsRoot;
    this.#delay = delay;
    this.#spawnChild = spawnChild;
  }

  get semaphore() { return this.#semaphore; }
  get noProgressTimeoutMs() { return this.#noProgressTimeoutMs; }

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

  #observeAttemptEvent(attemptId, event) {
    if (!event || typeof event.type !== "string") return;
    // Keep this list exactly aligned with #promptWithDeadline. Lifecycle chatter such as
    // agent_start/agent_settled is observed, but it is not proof that useful work progressed.
    const progress = [
      "message_update", "message_end", "tool_execution_start", "tool_execution_update",
      "tool_execution_end", "auto_retry_start", "auto_retry_end", "bash_execution_update",
    ].includes(event.type);
    this.#updateAttempt(attemptId, {
      lastEventAt: this.#now(),
      lastEventType: event.type,
      ...(progress ? { lastProgressAt: this.#now() } : {}),
    });
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
  async run({ childId, maxAttempts = MAX_ROUTE_ATTEMPTS, trackForVerification = false, fleet, ...spec }) {
    if (this.#disposed) throw new Error("BrokeredChildRunner is disposed");
    if (!CHILD_ID.test(childId ?? "")) throw new Error("BrokeredChildRunner requires a valid childId");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");
    if (typeof trackForVerification !== "boolean") throw new Error("trackForVerification must be boolean");
    if (fleet !== undefined && (fleet === null || typeof fleet !== "object" || Array.isArray(fleet))) {
      throw new Error("BrokeredChildRunner fleet metadata must be an object");
    }

    const fleetMeta = fleet ?? {};
    const excludeResources = [...(spec.capabilityRequest?.excludeResources ?? [])];
    const route = [];
    const unavailableByCapacityGroup = new Map();
    let requiredCapabilities = spec.capabilityRequest?.requiredCapabilities;
    let capacityWaitDeadline;
    let lastResult;
    let visibleAttemptId;
    const finish = (value) => {
      this.#clearAttempt(visibleAttemptId);
      visibleAttemptId = undefined;
      this.#activeRuns.delete(childId);
      this.#abortedRuns.delete(childId);
      // Carry the requested contract next to the result so the controller can persist what was
      // asked for beside what the provider actually accepted. Without the pair, a silently
      // downgraded effort level is indistinguishable from one that was never requested.
      return Object.freeze({
        ...value,
        requestedThinking: spec.thinkingLevel ?? "off",
        ...(typeof fleetMeta.role === "string" ? { role: fleetMeta.role } : {}),
      });
    };
    // Cancellation must reach a run that owns no child process yet. Without this an abort issued
    // while the route is queued behind live capacity is silently a no-op, and the controller
    // keeps paying for attempts the operator already cancelled.
    const abortedEarly = () => this.#disposed || this.#abortedRuns.has(childId);

    this.#abortedRuns.delete(childId);
    this.#activeRuns.add(childId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (abortedEarly()) return finish(Object.freeze({
        id: childId, status: "aborted", text: "",
        error: this.#disposed ? "brokered runner disposed" : "aborted before a child was launched",
        route: Object.freeze(route),
      }));
      const attemptId = attempt === 1 ? childId : `${childId}-r${attempt}`;
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

      let handle;
      try {
        handle = await this.spawn({ ...spec, childId: attemptId, capabilityRequest, attempts: attempt, deferClosePolicy: true });
      } catch (error) {
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
      this.#updateAttempt(attemptId, { state: "verifying", lastEventAt: this.#now(), lastEventType: "child_terminal" });
      let closure;
      try {
        closure = await this.#closeAttempt(handle, lastResult);
      } catch (error) {
        route.push({ attempt, childId: attemptId, resourceId, outcome: "controller_close_failed", error: error.message });
        return finish(Object.freeze({ ...lastResult, id: childId, status: "failed", error: `controller close failed: ${error.message}`, route: Object.freeze(route) }));
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

      const kind = lastResult.status === "aborted" ? "fatal" : classifyChildFailure(lastResult.error ?? lastResult.text);
      this.#updateAttempt(attemptId, { state: "failed", failureKind: kind, lastEventAt: this.#now(), lastEventType: "attempt_failed" });
      route.push({ attempt, childId: attemptId, resourceId, outcome: kind, error: lastResult.error });

      // Provider health is reported before deciding whether to continue. A throttled or dead
      // account is an observed fact about the fleet no matter which attempt saw it; reporting
      // it only when a retry follows means the route that fails last is never cooled, and the
      // next task selects that same exhausted account first and burns an attempt re-proving it.
      if (resourceId !== undefined && kind !== "fatal" && kind !== "incomplete") {
        if (kind === "rate_limited" || kind === "account_exhausted") await this.#reportRateLimited(resourceId, lastResult.retryAfterMs);
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
          await this.#reportUnavailable(resourceId, "provider unavailable", failures >= 2 ? "capacity_group" : "resource");
        }
        // A context overflow leaves the provider healthy — only this route is wrong.
        if (kind !== "context_exhausted") excludeResources.push(resourceId);
      }
      if (resourceId !== undefined && kind === "incomplete") excludeResources.push(resourceId);
      if (kind === "fatal" || attempt === maxAttempts) break;

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
      ...(result.error ? { error: result.error } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
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

  async #spawn({ childId, promptDigest, model, cwd, isolation = "none", tools, excludeTools, label, thinkingLevel, prompt, capabilityRequest, attempts = 1, deferClosePolicy = false, roleFraming, skills }) {
    if (this.#disposed) throw new Error("BrokeredChildRunner is disposed");
    if (this.#handles.has(childId)) throw new Error(`Duplicate child id: ${childId}`);
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("brokered child attempt count must be a positive safe integer");
    if (typeof deferClosePolicy !== "boolean") throw new Error("deferClosePolicy must be boolean");

    const admission = new AbortController();
    this.#admissions.set(admission, this.#attempts.get(childId)?.baseChildId ?? childId);
    let release;
    try { release = await this.#semaphore.acquire(admission.signal); }
    finally { this.#admissions.delete(admission); }

    try {
      if (this.#disposed) throw new Error("BrokeredChildRunner disposed before launch");
      const decision = await this.#resolver.resolve({
        childId,
        promptDigest,
        requestedCwd: cwd,
        isolation,
        schemaRequested: false,
        // An explicit model is a manual override and is passed straight through. Without one
        // the controller's selector decides, and the resolver checks the child against
        // whatever it selected — so a caller cannot smuggle in an unapproved model either way.
        ...(model ? { model: { provider: model.provider, modelId: model.modelId, thinkingLevel: thinkingLevel ?? "off" } } : {}),
        ...(capabilityRequest ? { capabilityRequest } : {}),
        ...(tools ? { requestedTools: tools } : {}),
        ...(excludeTools ? { excludedTools: excludeTools } : {}),
      });

      if (decision.action === "deny") throw new Error(`Broker denied launch: ${decision.reason}`);

      const policy = decision.policy;
      // A proposed effect is only safe in a disposable Git worktree. Letting an otherwise
      // correctly attested patch tool run against the caller's cwd would turn verification into
      // after-the-fact damage control, so reject before a child process exists.
      if (policy.authorizationPolicy?.effectCapable === true && isolation !== "worktree") {
        await policy.onBeforeChildAbandoned?.("effect_requires_worktree");
        throw new Error("effect-capable brokered launch requires worktree isolation");
      }
      // The lease decides the model, not the request: the contract pins a capability class and
      // the broker picks a live resource inside it, which may not be the one predicted.
      const launchModel = decision.childModel ?? decision.resolvedModel ?? model;
      if (!launchModel?.provider || !launchModel?.modelId) throw new Error("Broker allowed a launch without a resolved model");
      const sessionsDir = join(this.#sessionsRoot, childId, "sessions");

      let worktree;
      let childSpec = {
        model: `${launchModel.provider}/${launchModel.modelId}`,
        // The leased model, not the caller, decides whether "off" is even a legal mode.
        thinkingLevel: effectiveThinkingLevel(launchModel, thinkingLevel ?? "off"),
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
        worktree = { sourceCwd, tree };
        childSpec = { ...childSpec, cwd: tree.cwd };
      }

      let child;
      try {
        child = await this.#spawnChild({
          spec: childSpec,
          parentCwd: cwd,
          sessionsDir,
          launchPolicy: {
            ...policy,
            offline: policy.offline ?? false,
          },
        });
      } catch (error) {
        await policy.onBeforeChildAbandoned?.("child_construction_failed");
        throw error;
      }

      await policy.onChildSessionOpened?.();

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
      const text = assistantText(message);
      const worktreeResult = worktree ? await this.#collectWorktree(worktree) : undefined;
      const answered = text.trim().length > 0 || Boolean(worktreeResult?.patch);
      const unresolvedToolRequest = message?.stopReason === "toolUse" || message?.stopReason === "tool_use";
      const truncated = ["length", "max_tokens", "maxTokens"].includes(message?.stopReason);
      const aborted = message?.stopReason === "aborted";
      if (message?.stopReason === "error" || !answered || unresolvedToolRequest || truncated || aborted) {
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
          usage,
          resolved: handle.resolved,
          resource: handle.resource,
          ...(handle.selection ? { selection: handle.selection } : {}),
          ...(worktreeResult ?? {}),
        };
      }
    } catch (error) {
      result = {
        id: handle.id,
        status: handle.wasExternallyCancelled ? "aborted" : "failed",
        text: "",
        error: error.message,
        usage: session.usage,
        resolved: handle.resolved,
        resource: handle.resource,
        ...(handle.selection ? { selection: handle.selection } : {}),
      };
    } finally {
      // Success must precede dispose, whose shutdown hook releases the lease.
      if (result?.status === "completed") {
        try { await policy.onProviderSucceeded?.(); }
        catch { /* health recovery is best effort; the verified child result still stands */ }
      }
      handle.release();
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
        try { await cleanupWorktree(worktree.sourceCwd, worktree.tree.path); }
        catch { /* worktree retained; child work still on disk */ }
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
    await Promise.allSettled(handles.map((handle) => handle.session?.abort?.()));
  }

  async dispose() {
    this.#disposed = true;
    for (const admission of this.#admissions.keys()) admission.abort("runner disposed");
    this.#admissions.clear();
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