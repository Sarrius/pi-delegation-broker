import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnBrokeredChild } from "./child-launcher.mjs";
import { Semaphore } from "./semaphore.mjs";
import { createWorktree, collectWorktree, cleanupWorktree, WorktreeCollectionError } from "./worktree.mjs";

const SETTLE_GRACE_MS = 15_000;
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
  #handles = new Map();

  constructor({ resolver, semaphore = new Semaphore(4), sessionsRoot, delay = defaultDelay }) {
    if (!resolver || typeof resolver.resolve !== "function") throw new Error("BrokeredChildRunner requires a BrokeredLaunchResolver");
    if (!(semaphore instanceof Semaphore)) throw new Error("BrokeredChildRunner requires a Semaphore");
    if (typeof sessionsRoot !== "string") throw new Error("BrokeredChildRunner requires sessionsRoot");
    if (typeof delay !== "function") throw new Error("BrokeredChildRunner requires a delay function");
    this.#resolver = resolver;
    this.#semaphore = semaphore;
    this.#sessionsRoot = sessionsRoot;
    this.#delay = delay;
  }

  get semaphore() { return this.#semaphore; }

  /**
   * Spawn one brokered child for a fixed contract. The resolver decides
   * allow/deny before any process starts. Returns a handle whose `result`
   * promise resolves to the child's terminal result (not task acceptance).
   */
  async spawn({ childId, promptDigest, model, cwd, isolation = "none", tools, excludeTools, label, thinkingLevel }) {
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
        model: { provider: model.provider, modelId: model.modelId, thinkingLevel: thinkingLevel ?? "off" },
        ...(tools ? { requestedTools: tools } : {}),
        ...(excludeTools ? { excludedTools: excludeTools } : {}),
      });

      if (decision.action === "deny") throw new Error(`Broker denied launch: ${decision.reason}`);

      const policy = decision.policy;
      const sessionsDir = join(this.#sessionsRoot, childId, "sessions");

      let worktree;
      let childSpec = {
        model: `${model.provider}/${model.modelId}`,
        thinkingLevel: thinkingLevel ?? "off",
        cwd,
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
        child = await spawnBrokeredChild({
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

  async #runAndClose(handle, spec) {
    const { session, policy, worktree } = handle;
    let result;
    try {
      await session.prompt(spec.prompt ?? "");
      const message = session.latestAssistantMessage;
      const usage = session.usage;
      result = {
        id: handle.id,
        status: "completed",
        text: assistantText(message),
        usage,
        resolved: handle.resolved,
        ...(worktree ? await this.#collectWorktree(worktree) : {}),
      };
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