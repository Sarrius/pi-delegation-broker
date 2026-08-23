import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const TIER = new Set(["cheap", "standard", "frontier"]);
function fail(message) { throw new Error(`task orchestrator: ${message}`); }
function save(path, state) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 }); }
function oneLine(value, max = 500) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Human-readable terminal summary. Failures must carry their controller-owned reason in the
 * tool text: callers often do not render the structured details object, and an opaque count
 * turns a recoverable route failure into an eight-minute blind retry. */
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
    return `- ${node.id}: ${node.state} — ${reason}${route}`;
  });
  return `Workflow ${workflowId} has ${incomplete.length} failed/blocked stages:\n${lines.join("\n")}`;
}

/** Workflow nodes are read-only by contract. Pin the operation class instead of letting
 * keyword inference misread negations such as "do not modify files" as a patch request. */
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

/** Durable dependency scheduler. It owns ordering and concurrency; a supplied controller-owned
 * runner owns model routing, child launches, verification, and terminal acceptance. */
export class TaskOrchestrator {
  #path; #run; #concurrency;
  constructor({ path, run, concurrency = 4 } = {}) {
    if (typeof path !== "string" || !isAbsolute(path)) fail("path must be absolute");
    if (typeof run !== "function") fail("run must be a function");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) fail("concurrency must be 1..64");
    this.#path = path; this.#run = run; this.#concurrency = concurrency;
  }
  initialize(nodes) {
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1000) fail("requires 1..1000 nodes");
    const ids = new Set();
    const normalized = nodes.map((node) => {
      if (!node || typeof node !== "object" || !ID.test(node.id ?? "") || typeof node.task !== "string" || !node.task.trim()) fail("node is invalid");
      if (ids.has(node.id)) fail("node ids must be unique"); ids.add(node.id);
      const dependsOn = node.dependsOn ?? [];
      if (!Array.isArray(dependsOn) || dependsOn.some((id) => !ID.test(id)) || new Set(dependsOn).size !== dependsOn.length) fail("dependencies are invalid");
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
        dependsOn,
        state: "pending",
        ...(node.tier !== undefined ? { tier: node.tier } : {}),
        ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {}),
      };
    });
    for (const node of normalized) if (node.dependsOn.some((id) => !ids.has(id) || id === node.id)) fail("dependency is unknown or self-referential");
    const state = { schemaVersion: 1, nodes: normalized }; save(this.#path, state); return state;
  }
  state() { if (!existsSync(this.#path)) return undefined; return JSON.parse(readFileSync(this.#path, "utf8")); }
  async execute() {
    const state = this.state(); if (!state?.nodes) fail("not initialized");
    const byId = new Map(state.nodes.map((node) => [node.id, node])); const running = new Set();
    const launch = async (node) => { node.state = "running"; save(this.#path, state); try { node.result = await this.#run(Object.freeze({ ...node })); node.state = node.result?.status === "completed" ? "completed" : "failed"; } catch (error) { node.state = "failed"; node.error = error instanceof Error ? error.message : "runner failed"; } save(this.#path, state); };
    while (true) {
      for (const node of state.nodes) if (node.state === "pending" && node.dependsOn.some((id) => byId.get(id).state === "failed")) node.state = "blocked";
      const ready = state.nodes.filter((node) => node.state === "pending" && node.dependsOn.every((id) => byId.get(id).state === "completed"));
      while (ready.length && running.size < this.#concurrency) { const p = launch(ready.shift()).finally(() => running.delete(p)); running.add(p); }
      save(this.#path, state);
      if (!running.size) break;
      await Promise.race(running);
    }
    return Object.freeze(this.state());
  }
}
