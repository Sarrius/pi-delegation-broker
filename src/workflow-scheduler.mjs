import { basename, dirname, isAbsolute } from "node:path";
import {
  isTerminalJobStatus, readJob, submitJob, updateJob,
} from "./delegation-job-store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const TIER = new Set(["cheap", "standard", "frontier"]);
function fail(message) { throw new Error(`task orchestrator: ${message}`); }
function oneLine(value, max = 500) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Human-readable terminal summary with controller-owned reasons and artifact references. */
export function formatWorkflowSummary(workflowId, state) {
  if (typeof workflowId !== "string" || !TASK_ID.test(workflowId)) fail("workflow id is invalid");
  if (!state || !Array.isArray(state.nodes)) fail("workflow state is invalid");
  const incomplete = state.nodes.filter((node) => node.state !== "completed");
  if (!incomplete.length) return `Workflow ${workflowId} completed.`;
  const lines = incomplete.map((node) => {
    const dependency = node.state === "blocked" ? `dependency failed: ${(node.dependsOn ?? []).join(", ") || "unknown"}` : undefined;
    const reason = oneLine(node.error) ?? oneLine(node.result?.error) ?? dependency ?? "no terminal reason recorded";
    const route = Array.isArray(node.result?.route) && node.result.route.length
      ? ` [route: ${node.result.route.map((attempt) => `${attempt.resourceId ?? "unassigned"}:${attempt.outcome ?? "unknown"}`).join(" → ")}]`
      : "";
    const report = typeof node.result?.reportTaskId === "string" ? ` [report: ${node.result.reportTaskId}]` : "";
    return `- ${node.id}: ${node.state} — ${reason}${route}${report}`;
  });
  return `Workflow ${workflowId} has ${incomplete.length} failed/blocked stages:\n${lines.join("\n")}`;
}

/** Workflow nodes are read-only by contract. */
export function workflowObserveCapabilityRequest(node, taskId) {
  if (!node || typeof node !== "object" || typeof node.task !== "string" || !node.task.trim()) fail("node is invalid");
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) fail("task id is invalid");
  return Object.freeze({
    taskId,
    taskDescription: node.task,
    operationClass: "observe",
    ...(node.capabilities?.length ? { requiredCapabilities: Object.freeze([...node.capabilities]) } : {}),
    ...(node.tier ? { modelTier: node.tier } : {}),
  });
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1000) fail("requires 1..1000 nodes");
  const ids = new Set();
  const normalized = nodes.map((node) => {
    if (!node || typeof node !== "object" || !ID.test(node.id ?? "") || typeof node.task !== "string" || !node.task.trim()) fail("node is invalid");
    if (node.task.length > 256 * 1024) fail("node task exceeds the bounded size");
    if (ids.has(node.id)) fail("node ids must be unique");
    ids.add(node.id);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => !ID.test(id)) || new Set(dependsOn).size !== dependsOn.length) fail("dependencies are invalid");
    const inputs = node.inputs ?? [];
    if (!Array.isArray(inputs) || inputs.some((id) => !ID.test(id)) || new Set(inputs).size !== inputs.length) fail("inputs are invalid");
    if (node.tier !== undefined && !TIER.has(node.tier)) fail("tier is invalid");
    const capabilities = node.capabilities;
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities) || capabilities.length > 16
        || capabilities.some((capability) => typeof capability !== "string" || !capability || capability.length > 64)
        || new Set(capabilities).size !== capabilities.length) fail("capabilities are invalid");
    }
    return {
      id: node.id,
      task: node.task,
      dependsOn: [...dependsOn],
      inputs: [...inputs],
      state: "pending",
      ...(node.tier !== undefined ? { tier: node.tier } : {}),
      ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {}),
    };
  });
  for (const node of normalized) {
    if (node.dependsOn.some((id) => !ids.has(id) || id === node.id)) fail("dependency is unknown or self-referential");
    if (node.inputs.some((id) => !node.dependsOn.includes(id))) fail("every input must also be a dependency");
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(normalized.map((node) => [node.id, node]));
  const visit = (id) => {
    if (visiting.has(id)) fail("dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return normalized;
}

/** Durable read-only dependency scheduler. Model routing and verification remain controller-owned. */
export class TaskOrchestrator {
  #root; #jobId; #run; #concurrency; #now;
  constructor({ root, jobId, path, run, concurrency = 4, now = () => Date.now() } = {}) {
    if (path !== undefined) {
      if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".json")) fail("path must be an absolute json path");
      root = dirname(path);
      jobId = basename(path, ".json");
    }
    if (typeof root !== "string" || !isAbsolute(root)) fail("root must be absolute");
    if (typeof jobId !== "string" || !TASK_ID.test(jobId)) fail("jobId is invalid");
    if (typeof run !== "function") fail("run must be a function");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) fail("concurrency must be 1..64");
    if (typeof now !== "function") fail("now must be a function");
    this.#root = root; this.#jobId = jobId; this.#run = run; this.#concurrency = concurrency; this.#now = now;
  }

  initialize(nodes, metadata = {}) {
    const submittedAt = metadata.submittedAt ?? this.#now();
    const job = {
      schemaVersion: 1,
      jobId: this.#jobId,
      kind: "workflow",
      status: "queued",
      cwd: metadata.cwd ?? process.cwd(),
      concurrency: this.#concurrency,
      nodes: normalizeNodes(nodes),
      submittedAt,
      updatedAt: submittedAt,
      ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
      ...(metadata.deadlineAt ? { deadlineAt: metadata.deadlineAt } : {}),
      policyGeneration: metadata.policyGeneration ?? "unresolved",
    };
    return submitJob(this.#root, job);
  }

  state() { return readJob(this.#root, this.#jobId); }

  async execute({ signal } = {}) {
    let state = this.state();
    if (!state?.nodes || state.kind !== "workflow") fail("not initialized");
    if (isTerminalJobStatus(state.status)) return state;
    const startedAt = state.startedAt ?? this.#now();
    state = structuredClone(updateJob(this.#root, this.#jobId, (job) => job.status === "cancellation_requested"
      ? job
      : ({ ...job, status: "running", startedAt }), this.#now()));
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const running = new Set();

    const persist = () => {
      state.updatedAt = this.#now();
      const local = structuredClone(state);
      const persisted = updateJob(this.#root, this.#jobId, (current) => {
        if (isTerminalJobStatus(current.status)) return current;
        if (current.status !== "cancellation_requested") return local;
        if (local.status === "cancelled") return local;
        const merged = {
          ...local,
          status: "cancellation_requested",
          cancelRequestedAt: current.cancelRequestedAt,
        };
        delete merged.completedAt;
        return merged;
      }, state.updatedAt);
      if (!persisted) fail("durable job disappeared during execution");
      if (persisted.status === "cancellation_requested") {
        state.status = "cancellation_requested";
        state.cancelRequestedAt = persisted.cancelRequestedAt;
        delete state.completedAt;
      }
      return persisted;
    };
    const launch = async (node) => {
      node.state = "running";
      delete node.error;
      delete node.result;
      persist();
      try {
        const inputResults = node.inputs.map((fromNode) => Object.freeze({
          fromNode,
          result: structuredClone(byId.get(fromNode).result),
        }));
        const result = await this.#run(Object.freeze({ ...structuredClone(node), inputResults: Object.freeze(inputResults) }));
        if (signal?.aborted) {
          node.state = "pending";
        } else {
          node.result = result;
          node.state = result?.status === "completed" ? "completed" : "failed";
        }
      } catch (error) {
        if (signal?.aborted) node.state = "pending";
        else {
          node.state = "failed";
          node.error = error instanceof Error ? error.message : "runner failed";
        }
      }
      persist();
    };

    while (true) {
      if (signal?.aborted || this.state()?.status === "cancellation_requested") break;
      if (state.deadlineAt !== undefined && this.#now() >= state.deadlineAt) break;
      for (const node of state.nodes) {
        if (node.state === "pending" && node.dependsOn.some((id) => ["failed", "blocked"].includes(byId.get(id).state))) node.state = "blocked";
      }
      const ready = state.nodes.filter((node) => node.state === "pending" && node.dependsOn.every((id) => byId.get(id).state === "completed"));
      while (ready.length && running.size < this.#concurrency && !signal?.aborted) {
        const promise = launch(ready.shift()).finally(() => running.delete(promise));
        running.add(promise);
      }
      persist();
      if (!running.size) break;
      await Promise.race(running);
    }
    if (running.size) await Promise.allSettled([...running]);

    const cancellationRequested = this.state()?.status === "cancellation_requested";
    const deadlineExpired = state.deadlineAt !== undefined && this.#now() >= state.deadlineAt;
    if (signal?.aborted || cancellationRequested || deadlineExpired) {
      for (const node of state.nodes) if (node.state === "running") node.state = "pending";
      const reason = signal?.reason;
      if (cancellationRequested || reason === "cancel") {
        state.status = "cancelled";
        state.completedAt = this.#now();
        state.terminalReason = "cancelled by controller";
      } else if (deadlineExpired || reason === "deadline") {
        state.status = "expired";
        state.completedAt = this.#now();
        state.terminalReason = "workflow deadline expired";
      } else {
        state.status = "queued";
        state.terminalReason = "paused for controller shutdown";
      }
      persist();
      return Object.freeze(structuredClone(state));
    }

    const incomplete = state.nodes.filter((node) => node.state !== "completed");
    state.status = incomplete.length ? "failed" : "completed";
    state.completedAt = this.#now();
    state.terminalReason = incomplete.length ? "one or more workflow nodes failed or were blocked" : "all workflow nodes completed";
    persist();
    // A cancellation can arrive between the pre-terminal status check and the terminal write.
    // Preserve it monotonically instead of returning a non-terminal cancellation_requested job.
    if (state.status === "cancellation_requested") {
      state.status = "cancelled";
      state.completedAt = this.#now();
      state.terminalReason = "cancelled by controller";
      persist();
    }
    return Object.freeze(structuredClone(state));
  }
}
