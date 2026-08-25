import { basename, dirname, isAbsolute } from "node:path";
import { normalizeContract } from "./child-contract.mjs";
import {
  isTerminalJobStatus, readJob, submitJob, updateJob,
} from "./delegation-job-store.mjs";
import {
  admitTeamNodes,
  evaluateTeamJoins,
  normalizeTaskAdmission,
  normalizeTeamJoin,
  normalizeTeamMetadata,
  teamProposalDigest,
  validateTeamState,
} from "./team.mjs";

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
  const joins = Array.isArray(state.team?.joinStates) ? state.team.joinStates.filter((join) => join.status !== "accepted") : [];
  if (!incomplete.length && !joins.length) return `Workflow ${workflowId} completed.`;
  const lines = incomplete.map((node) => {
    const dependency = node.state === "blocked" ? `dependency failed: ${(node.dependsOn ?? []).join(", ") || "unknown"}` : undefined;
    const reason = oneLine(node.error) ?? oneLine(node.result?.error) ?? dependency ?? "no terminal reason recorded";
    const route = Array.isArray(node.result?.route) && node.result.route.length
      ? ` [route: ${node.result.route.map((attempt) => `${attempt.resourceId ?? "unassigned"}:${attempt.outcome ?? "unknown"}`).join(" → ")}]`
      : "";
    const report = typeof node.result?.reportTaskId === "string" ? ` [report: ${node.result.reportTaskId}]` : "";
    return `- ${node.id}: ${node.state} — ${reason}${route}${report}`;
  });
  if (joins.length) lines.push(...joins.map((join) => `- join:${join.id}: ${join.status} — ${join.reason ?? join.policy ?? "join not accepted"}`));
  return `Workflow ${workflowId} has ${incomplete.length} failed/blocked stages${joins.length ? ` and ${joins.length} unresolved joins` : ""}:\n${lines.join("\n")}`;
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

function normalizeAcceptance(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) fail("acceptance must contain 1..20 fixed checks");
  const checks = value.map((check) => {
    if (!check || typeof check !== "object" || !ID.test(check.id ?? "") || typeof check.claim !== "string" || !check.claim.trim()
      || !Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > 32
      || check.argv.some((token) => typeof token !== "string" || !token || token.length > 4096)
      || !Number.isSafeInteger(check.timeoutMs ?? 30_000) || (check.timeoutMs ?? 30_000) < 100 || (check.timeoutMs ?? 30_000) > 120_000) {
      fail("acceptance check is invalid");
    }
    return { id: check.id, claim: check.claim.slice(0, 500), argv: [...check.argv], timeoutMs: check.timeoutMs ?? 30_000 };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) fail("acceptance check ids must be unique");
  return checks;
}

function normalizeNodes(nodes, { knownIds = [] } = {}) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1000) fail("requires 1..1000 nodes");
  const ids = new Set();
  const known = new Set(knownIds);
  const normalized = nodes.map((node, index) => {
    if (!node || typeof node !== "object" || !ID.test(node.id ?? "") || typeof node.task !== "string" || !node.task.trim()) fail("node is invalid");
    if (node.task.length > 256 * 1024) fail("node task exceeds the bounded size");
    if (ids.has(node.id)) fail("node ids must be unique");
    ids.add(node.id);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => !ID.test(id)) || new Set(dependsOn).size !== dependsOn.length) fail("dependencies are invalid");
    const inputs = node.inputs ?? [];
    if (!Array.isArray(inputs) || inputs.some((id) => !ID.test(id)) || new Set(inputs).size !== inputs.length) fail("inputs are invalid");
    if (node.tier !== undefined && !TIER.has(node.tier)) fail("tier is invalid");
    const acceptance = normalizeAcceptance(node.acceptance);
    const capabilities = node.capabilities;
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities) || capabilities.length > 16
        || capabilities.some((capability) => typeof capability !== "string" || !capability || capability.length > 64)
        || new Set(capabilities).size !== capabilities.length) fail("capabilities are invalid");
    }
    // Node normalization is an allowlist, so a new contract axis must be carried here
    // explicitly: anything omitted is silently dropped and the stage quietly runs on defaults.
    const contract = node.contract !== undefined || node.thinking !== undefined
      || node.route !== undefined || node.role !== undefined || node.skills !== undefined
      ? normalizeContract(node.contract ?? {
        thinking: node.thinking, route: node.route, role: node.role, skills: node.skills,
      })
      : undefined;
    return {
      id: node.id,
      task: node.task,
      dependsOn: [...dependsOn],
      inputs: [...inputs],
      admission: normalizeTaskAdmission(node, index),
      state: "pending",
      ...(node.tier !== undefined ? { tier: node.tier } : {}),
      ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {}),
      ...(acceptance ? { acceptance: structuredClone(acceptance) } : {}),
      ...(contract ? { contract: structuredClone(contract) } : {}),
    };
  });
  for (const node of normalized) {
    if (node.dependsOn.some((id) => (!ids.has(id) && !known.has(id)) || id === node.id)) fail("dependency is unknown or self-referential");
    if (node.inputs.some((id) => !node.dependsOn.includes(id))) fail("every input must also be a dependency");
  }
  const visiting = new Set();
  const visited = new Set(known);
  const byId = new Map(normalized.map((node) => [node.id, node]));
  const visit = (id) => {
    if (known.has(id)) return;
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

export function appendWorkflowNodes(root, jobId, nodes, { joins = [], proposalId, expectedRevision, proposalDigest, now = () => Date.now() } = {}) {
  const current = readJob(root, jobId);
  if (!current || current.kind !== "workflow") fail("workflow does not exist");
  if (isTerminalJobStatus(current.status)) fail("cannot append to a terminal workflow");
  if (!current.team?.dynamic || current.team.acceptingAppends !== true || current.team.sealed === true) fail("workflow is not accepting dynamic appends");
  if (current.status !== "queued" && current.status !== "running") fail("workflow is not running");
  if (current.deadlineAt !== undefined && now() >= current.deadlineAt) fail("workflow deadline has expired");
  const incoming = normalizeNodes(nodes, { knownIds: current.nodes.map((node) => node.id) });
  const additions = joins.map((join, index) => normalizeTeamJoin(join, index));
  const digest = teamProposalDigest(incoming, additions);
  if (proposalDigest !== undefined && proposalDigest !== digest) fail("proposal digest does not match canonical members and joins");
  if (proposalId !== undefined) {
    if (typeof proposalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(proposalId)) fail("proposalId is invalid");
    const prior = current.team.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (prior) {
      if (prior.digest !== digest) fail("proposal id was reused with a different digest");
      return Object.freeze({ job: current, added: Object.freeze([]), reused: Object.freeze(prior.memberIds.map((existingId) => ({ requestedId: existingId, existingId, fingerprint: "proposal-replay" }))), joins: Object.freeze([]), proposalId, proposalDigest: digest, revision: current.team.revision, idempotentReplay: true });
    }
  }
  if (expectedRevision !== undefined && expectedRevision !== current.team.revision) fail(`workflow revision conflict: expected ${expectedRevision}, current ${current.team.revision}`);
  const admitted = admitTeamNodes(current.nodes, incoming, {
    budgets: current.team.budgets,
    appendCount: current.team.appendCount,
    concurrency: current.concurrency,
  });
  const additionIds = new Set(additions.map((join) => join.id));
  if (additionIds.size !== additions.length) fail("appended join ids must be unique");
  const existingJoinIds = new Set(current.team.joins.map((join) => join.id));
  if (additions.some((join) => existingJoinIds.has(join.id))) fail("join id already exists");
  const nextTeam = {
    ...current.team,
    revision: current.team.revision + 1,
    appendCount: current.team.appendCount + (admitted.added.length ? 1 : 0),
    usage: { ...current.team.usage, admittedMembers: current.nodes.length + admitted.added.length },
    joins: [...current.team.joins, ...additions],
    proposals: proposalId ? [...current.team.proposals, {
      proposalId,
      digest,
      status: "admitted",
      memberIds: admitted.added.map((node) => node.id),
      recordedAt: now(),
      decidedAt: now(),
    }] : current.team.proposals,
  };
  const nextNodes = [...current.nodes, ...admitted.added];
  validateTeamState(nextTeam, nextNodes);
  const revision = current.team.revision;
  const updated = updateJob(root, jobId, (job) => {
    if (isTerminalJobStatus(job.status) || job.team?.acceptingAppends !== true || job.team?.sealed === true) fail("workflow changed before append admission");
    if (job.team.revision !== revision) fail("workflow revision changed before append admission");
    return { ...job, nodes: nextNodes, team: nextTeam };
  }, now());
  if (!updated) fail("workflow disappeared during append admission");
  return Object.freeze({
    job: updated,
    added: Object.freeze(admitted.added.map((node) => structuredClone(node))),
    reused: admitted.reused,
    joins: Object.freeze(additions),
    proposalId,
    proposalDigest: digest,
    revision: nextTeam.revision,
  });
}

export function closeWorkflow(root, jobId, expectedRevision, now = () => Date.now()) {
  const updated = updateJob(root, jobId, (job) => {
    if (!job.team?.dynamic) fail("workflow is not dynamic");
    if (isTerminalJobStatus(job.status)) return job;
    if (expectedRevision !== undefined && expectedRevision !== job.team.revision) fail(`workflow revision conflict: expected ${expectedRevision}, current ${job.team.revision}`);
    return { ...job, team: { ...job.team, sealed: true, acceptingAppends: false, revision: job.team.revision + 1 } };
  }, now());
  if (!updated) fail("workflow does not exist");
  return updated;
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
    const normalizedNodes = normalizeNodes(nodes);
    let team = normalizeTeamMetadata({
      jobId: this.#jobId,
      rootId: metadata.rootId,
      dynamic: metadata.dynamic,
      acceptingAppends: metadata.acceptingAppends,
      budgets: metadata.budgets,
      joins: metadata.joins,
      concurrency: this.#concurrency,
    });
    const admitted = admitTeamNodes([], normalizedNodes, {
      budgets: team.budgets,
      concurrency: this.#concurrency,
    });
    if (admitted.reused.length) fail("initial workflow contains duplicate task identities");
    team = { ...team, usage: { ...team.usage, admittedMembers: admitted.added.length } };
    validateTeamState(team, admitted.added);
    const job = {
      schemaVersion: 1,
      jobId: this.#jobId,
      kind: "workflow",
      status: "queued",
      cwd: metadata.cwd ?? process.cwd(),
      concurrency: this.#concurrency,
      nodes: admitted.added,
      team,
      submittedAt,
      updatedAt: submittedAt,
      ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
      ...(metadata.deadlineAt ? { deadlineAt: metadata.deadlineAt } : {}),
      policyGeneration: metadata.policyGeneration ?? "unresolved",
    };
    return submitJob(this.#root, job);
  }

  state() { return readJob(this.#root, this.#jobId); }

  append(nodes, options = {}) {
    return appendWorkflowNodes(this.#root, this.#jobId, nodes, options);
  }

  close() { return closeWorkflow(this.#root, this.#jobId); }

  async execute({ signal } = {}) {
    let state = this.state();
    if (!state?.nodes || state.kind !== "workflow") fail("not initialized");
    if (isTerminalJobStatus(state.status)) return state;
    const startedAt = state.startedAt ?? this.#now();
    state = structuredClone(updateJob(this.#root, this.#jobId, (job) => job.status === "cancellation_requested"
      ? job
      : ({ ...job, status: "running", startedAt }), this.#now()));
    let byId = new Map(state.nodes.map((node) => [node.id, node]));
    const running = new Set();

    const persist = () => {
      state.updatedAt = this.#now();
      const local = structuredClone(state);
      const persisted = updateJob(this.#root, this.#jobId, (current) => {
        if (isTerminalJobStatus(current.status)) return current;
        const localById = new Map(local.nodes.map((node) => [node.id, node]));
        const mergedNodes = current.nodes.map((node) => localById.get(node.id) ?? node);
        for (const node of local.nodes) if (!current.nodes.some((candidate) => candidate.id === node.id)) mergedNodes.push(node);
        const mergedTeam = current.team && local.team ? {
          ...local.team,
          ...current.team,
          revision: Math.max(local.team.revision ?? 0, current.team.revision ?? 0),
          appendCount: Math.max(local.team.appendCount ?? 0, current.team.appendCount ?? 0),
          sealed: current.team.sealed === true || local.team.sealed === true,
          acceptingAppends: current.team.acceptingAppends === false || local.team.acceptingAppends === false ? false : true,
          usage: {
            admittedMembers: Math.max(local.team.usage?.admittedMembers ?? 0, current.team.usage?.admittedMembers ?? 0),
            startedAttempts: Math.max(local.team.usage?.startedAttempts ?? 0, current.team.usage?.startedAttempts ?? 0),
            outputTokens: Math.max(local.team.usage?.outputTokens ?? 0, current.team.usage?.outputTokens ?? 0),
          },
          proposals: current.team.revision > local.team.revision ? current.team.proposals : local.team.proposals,
          joins: current.team.appendCount > local.team.appendCount ? current.team.joins : local.team.joins,
        } : local.team ?? current.team;
        const mergedLocal = { ...local, nodes: mergedNodes, ...(mergedTeam ? { team: mergedTeam } : {}) };
        if (current.status !== "cancellation_requested") return mergedLocal;
        if (local.status === "cancelled") return local;
        const merged = {
          ...mergedLocal,
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
      state.updatedAt = persisted.updatedAt;
      state.status = persisted.status;
      if (persisted.startedAt !== undefined) state.startedAt = persisted.startedAt;
      if (persisted.team) state.team = structuredClone(persisted.team);
      const localIds = new Set(state.nodes.map((node) => node.id));
      for (const node of persisted.nodes) if (!localIds.has(node.id)) state.nodes.push(structuredClone(node));
      byId = new Map(state.nodes.map((node) => [node.id, node]));
      return persisted;
    };
    const launch = async (node) => {
      if (state.team && state.team.usage.startedAttempts >= state.team.budgets.maxAttempts) {
        node.state = "failed";
        node.error = "root team maxAttempts budget exceeded";
        persist();
        return;
      }
      node.state = "running";
      delete node.error;
      delete node.result;
      if (state.team) state.team = {
        ...state.team,
        usage: { ...state.team.usage, startedAttempts: state.team.usage.startedAttempts + 1 },
      };
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
          const outputTokens = Number.isSafeInteger(result?.usage?.output) && result.usage.output >= 0 ? result.usage.output : 0;
          if (state.team) {
            const outputTotal = state.team.usage.outputTokens + outputTokens;
            state.team = { ...state.team, usage: { ...state.team.usage, outputTokens: outputTotal } };
            if (state.team.budgets.maxOutputTokens !== undefined && outputTotal > state.team.budgets.maxOutputTokens) {
              node.state = "failed";
              node.error = "root team maxOutputTokens budget exceeded";
            } else {
              node.state = result?.status === "completed" ? "completed" : "failed";
            }
          } else {
            node.state = result?.status === "completed" ? "completed" : "failed";
          }
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
      const durable = this.state();
      if (durable && durable.updatedAt > state.updatedAt) {
        state = structuredClone(durable);
        byId = new Map(state.nodes.map((node) => [node.id, node]));
      }
      if (signal?.aborted || state.status === "cancellation_requested") break;
      if (state.deadlineAt !== undefined && this.#now() >= state.deadlineAt) break;
      for (const node of state.nodes) {
        if (node.state === "pending" && node.dependsOn.some((id) => ["failed", "blocked"].includes(byId.get(id).state))) node.state = "blocked";
      }
      const ready = state.nodes.filter((node) => node.state === "pending" && node.dependsOn.every((id) => byId.get(id).state === "completed"));
      while (ready.length && running.size < this.#concurrency && !signal?.aborted) {
        const promise = launch(ready.shift()).finally(() => running.delete(promise));
        running.add(promise);
      }
      if (state.team) state.team = { ...state.team, joinStates: evaluateTeamJoins(state.team.joins, state.nodes) };
      persist();
      if (!running.size) {
        const current = this.state();
        const open = current?.team?.dynamic === true && current.team.acceptingAppends === true
          && current.status === "running" && (current.deadlineAt === undefined || this.#now() < current.deadlineAt);
        if (open) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        break;
      }
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
    const joinStates = state.team ? evaluateTeamJoins(state.team.joins, state.nodes) : [];
    if (state.team) state.team = { ...state.team, joinStates };
    const unresolvedJoins = joinStates.filter((join) => join.status !== "accepted");
    state.status = incomplete.length || unresolvedJoins.length ? "failed" : "completed";
    state.completedAt = this.#now();
    state.terminalReason = incomplete.length
      ? "one or more workflow nodes failed or were blocked"
      : unresolvedJoins.length
        ? "one or more team joins were not semantically accepted"
        : "all workflow nodes and joins completed";
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
