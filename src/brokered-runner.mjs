import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnBrokeredChild } from "./child-launcher.mjs";
import { Semaphore } from "./semaphore.mjs";
import { effectiveThinkingLevel } from "./model-thinking-policy.mjs";
import { createWorktree, collectWorktree, cleanupWorktree, WorktreeCollectionError } from "./worktree.mjs";

const SETTLE_GRACE_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;
const MAX_ROUTE_ATTEMPTS = 4;
const CHILD_ID = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * Terminal child failures split by who owns them. A provider that throttled or died is a
 * routing fact — the work is still valid and must be finished elsewhere. A context overflow is
 * nobody's fault: the provider is healthy, the task simply needs a bigger context class. Only
 * the last group is a genuine end of the road.
 */
const FAILURE_SIGNATURES = Object.freeze([
  Object.freeze({ kind: "rate_limited", pattern: /\b(rate[ _-]?limit|too many requests|429|quota exceeded|overloaded|capacity)\b/i }),
  Object.freeze({ kind: "auth_fatal", pattern: /\b(401|403|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication|expired token|revoked)\b/i }),
  Object.freeze({ kind: "context_exhausted", pattern: /\b(context[ _-]?(window|length|limit)|prompt is too long|maximum context|token limit)\b/i }),
  // Capability/organization policy rejection is route-specific: the same task can run on
  // another account/model, so quarantine this resource and let controller failover continue.
  Object.freeze({ kind: "unavailable", pattern: /\b(unsupported_value|reasoning summaries|organization must be verified|model is not supported)\b/i }),
  // A child that never answers is a dead route, not a dead task: fail over instead of hanging.
  Object.freeze({ kind: "unavailable", pattern: /\bcontroller prompt deadline\b/i }),
  // Reasoning-mode refusals are route-specific policy, not a dead task: another route accepts it.
  Object.freeze({ kind: "unavailable", pattern: /reasoning is mandatory|cannot be disabled|always engages in thinking/i }),
  // Exhausted credit/balance is this account's problem, not the task's: cool it and move on.
  Object.freeze({ kind: "auth_fatal", pattern: /\b402\b|requires more credits|insufficient (credits|balance)|purchase credits|upgrade to a paid account/i }),
  Object.freeze({ kind: "unavailable", pattern: /\b(50[0234]|service unavailable|bad gateway|upstream|connection (refused|reset)|econnrefused|etimedout|network)\b/i }),
]);

export function classifyChildFailure(text) {
  if (typeof text !== "string" || !text) return "fatal";
  for (const signature of FAILURE_SIGNATURES) if (signature.pattern.test(text)) return signature.kind;
  return "fatal";
}

const SUBAGENT_FRAMING =
  "You are a subagent: an orchestrating agent spawned you for a single task. Your final message is returned to that agent as a result - it is not shown to a person. Respond with exactly what the task asks for: raw data or findings, no preamble, no markdown code fences unless explicitly requested, no closing questions.";

function defaultDelay(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
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
  #promptTimeoutMs;
  #handles = new Map();

  constructor({ resolver, semaphore = new Semaphore(4), sessionsRoot, delay = defaultDelay, spawnChild = spawnBrokeredChild, promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS }) {
    if (!resolver || typeof resolver.resolve !== "function") throw new Error("BrokeredChildRunner requires a BrokeredLaunchResolver");
    if (!(semaphore instanceof Semaphore)) throw new Error("BrokeredChildRunner requires a Semaphore");
    if (typeof sessionsRoot !== "string") throw new Error("BrokeredChildRunner requires sessionsRoot");
    if (typeof delay !== "function") throw new Error("BrokeredChildRunner requires a delay function");
    if (typeof spawnChild !== "function") throw new Error("BrokeredChildRunner spawnChild must be a function");
    if (!Number.isSafeInteger(promptTimeoutMs) || promptTimeoutMs < 1_000 || promptTimeoutMs > 3_600_000) {
      throw new Error("BrokeredChildRunner promptTimeoutMs must be between 1000 and 3600000");
    }
    this.#promptTimeoutMs = promptTimeoutMs;
    this.#resolver = resolver;
    this.#semaphore = semaphore;
    this.#sessionsRoot = sessionsRoot;
    this.#delay = delay;
    this.#spawnChild = spawnChild;
  }

  get semaphore() { return this.#semaphore; }

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
  async run({ childId, maxAttempts = MAX_ROUTE_ATTEMPTS, ...spec }) {
    if (!CHILD_ID.test(childId ?? "")) throw new Error("BrokeredChildRunner requires a valid childId");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");

    const excludeResources = [...(spec.capabilityRequest?.excludeResources ?? [])];
    const route = [];
    let requiredCapabilities = spec.capabilityRequest?.requiredCapabilities;
    let lastResult;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptId = attempt === 1 ? childId : `${childId}-r${attempt}`;
      const capabilityRequest = {
        ...(spec.capabilityRequest ?? {}),
        ...(excludeResources.length > 0 ? { excludeResources: [...excludeResources] } : {}),
        ...(requiredCapabilities ? { requiredCapabilities: [...requiredCapabilities] } : {}),
      };

      let handle;
      try {
        handle = await this.spawn({ ...spec, childId: attemptId, capabilityRequest });
      } catch (error) {
        // A denial is the broker refusing every live resource for this contract; retrying the
        // same contract cannot change that, so surface it rather than burning attempts.
        route.push({ attempt, childId: attemptId, outcome: "denied", error: error.message });
        return Object.freeze({ id: childId, status: "failed", text: "", error: error.message, route: Object.freeze(route) });
      }

      const resourceId = handle.resource?.id;
      lastResult = await handle.result;
      if (lastResult.status === "completed") {
        route.push({ attempt, childId: attemptId, resourceId, outcome: "completed" });
        return Object.freeze({ ...lastResult, id: childId, route: Object.freeze(route) });
      }

      const kind = lastResult.status === "aborted" ? "fatal" : classifyChildFailure(lastResult.error ?? lastResult.text);
      route.push({ attempt, childId: attemptId, resourceId, outcome: kind, error: lastResult.error });
      if (kind === "fatal" || attempt === maxAttempts) break;

      if (resourceId !== undefined) {
        if (kind === "rate_limited") await this.#reportRateLimited(resourceId, lastResult.retryAfterMs);
        else if (kind === "auth_fatal" || kind === "unavailable") await this.#reportUnavailable(resourceId, `provider ${kind}`);
        // A context overflow leaves the provider healthy — only this route is wrong.
        if (kind !== "context_exhausted") excludeResources.push(resourceId);
      }
      if (kind === "context_exhausted") {
        const widened = new Set([...(requiredCapabilities ?? []), "large_context"]);
        if (requiredCapabilities && widened.size === requiredCapabilities.length) break;
        requiredCapabilities = [...widened];
        if (resourceId !== undefined) excludeResources.push(resourceId);
      }
    }

    return Object.freeze({
      ...(lastResult ?? { id: childId, status: "failed", text: "", error: "no attempt produced a result" }),
      id: childId,
      route: Object.freeze(route),
    });
  }

  async #reportRateLimited(resourceId, retryAfterMs) {
    try { await this.#resolver.reportProviderRateLimited?.(resourceId, retryAfterMs); }
    catch { /* health reporting is best effort; the attempt is already excluded locally */ }
  }

  async #reportUnavailable(resourceId, reason) {
    try { await this.#resolver.reportProviderUnavailable?.(resourceId, reason); }
    catch { /* health reporting is best effort; the attempt is already excluded locally */ }
  }

  /**
   * Spawn one brokered child for a fixed contract. The resolver decides
   * allow/deny before any process starts. Returns a handle whose `result`
   * promise resolves to the child's terminal result (not task acceptance).
   */
  async spawn({ childId, promptDigest, model, cwd, isolation = "none", tools, excludeTools, label, thinkingLevel, prompt, capabilityRequest }) {
    if (this.#handles.has(childId)) throw new Error(`Duplicate child id: ${childId}`);

    const admission = new AbortController();
    const release = await this.#semaphore.acquire(admission.signal);

    try {
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
      // The lease decides the model, not the request: the contract pins a capability class and
      // the broker picks a live resource inside it, which may not be the one predicted.
      const launchModel = decision.resolvedModel ?? model;
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
        appendSystemPrompt: [SUBAGENT_FRAMING, policy.promptRules].filter(Boolean).join("\n\n"),
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
        model: Object.freeze({ ...launchModel }),
        result: null,
      };

      this.#handles.set(childId, handle);

      const resultPromise = this.#runAndClose(handle, childSpec);
      handle.result = resultPromise;
      return handle;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * A provider can accept a prompt and never settle it. Recovery is the controller's job, so
   * bound the wait here: the attempt fails with a route-specific reason and run() fails over.
   */
  async #promptWithDeadline(session, prompt) {
    let timer;
    try {
      await Promise.race([
        session.prompt(prompt),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`controller prompt deadline exceeded after ${this.#promptTimeoutMs}ms`)),
            this.#promptTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #runAndClose(handle, spec) {
    const { session, policy, worktree } = handle;
    let result;
    try {
      await this.#promptWithDeadline(session, spec.prompt ?? "");
      const message = session.latestAssistantMessage;
      const usage = session.usage;
      if (message?.stopReason === "error") {
        result = {
          id: handle.id,
          status: "failed",
          text: assistantText(message),
          error: message.errorMessage ?? "Child model request failed",
          usage,
          resolved: handle.resolved,
        };
      } else {
        result = {
          id: handle.id,
          status: "completed",
          text: assistantText(message),
          usage,
          resolved: handle.resolved,
          ...(worktree ? await this.#collectWorktree(worktree) : {}),
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
      };
    } finally {
      handle.release();
      await session.dispose().catch(() => undefined);
      await policy.onChildSessionClosed?.({ status: result.status, ...(result.error ? { error: result.error } : {}) });
      if (worktree) {
        try { await cleanupWorktree(worktree.sourceCwd, worktree.tree.path); }
        catch { /* worktree retained; child work still on disk */ }
      }
      this.#handles.delete(handle.id);
    }
    return result;
  }

  async #collectWorktree(worktree) {
    try {
      const changes = await collectWorktree(worktree.tree);
      return { patch: changes.patch, changed: changes.changed };
    } catch (error) {
      if (error instanceof WorktreeCollectionError) {
        return { patch: "", changed: [], error: `Worktree retained at ${error.worktreePath}` };
      }
      throw error;
    }
  }

  async abort(childId) {
    const handle = this.#handles.get(childId);
    if (!handle?.session) return;
    await handle.session.abort().catch(() => undefined);
  }

  async dispose() {
    const handles = [...this.#handles.values()];
    for (const handle of handles) {
      await handle.session.abort().catch(() => undefined);
    }
    // Wait for #runAndClose to finish — it calls onChildSessionClosed
    // which releases the broker lease.
    await Promise.allSettled(handles.map((h) => h.result));
    for (const handle of handles) {
      await handle.session.dispose().catch(() => undefined);
    }
    this.#handles.clear();
  }
}