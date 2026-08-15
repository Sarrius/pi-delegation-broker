import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { provisionBrokeredAgentDir } from "./isolated-child-config.mjs";
import { requestBrokerIpc } from "./ipc.mjs";

const CHILD_ID = /^[A-Za-z0-9_-]{1,160}$/;

function ownerOnlyDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error(`${label} must be an owner-only directory`);
  return canonical;
}

function expectedModel(selection) {
  const model = selection?.expectedModel;
  if (!model || typeof model.provider !== "string" || !model.provider || typeof model.modelId !== "string" || !model.modelId) {
    throw new Error("Broker launch selection needs an explicit expectedModel");
  }
  return model;
}

/**
 * Controller-side implementation of pi-subagent-workflow's trusted resolver.
 * It is intentionally separate from child code: only this object can use the
 * supervisor controller token to reserve/release; a child receives only the
 * lease-scoped capability placed into its normalized launch policy.
 */
export class BrokeredLaunchResolver {
  #socketPath;
  #controllerToken;
  #agentRoot;
  #extensionPaths;
  #offline;
  #selectContract;
  #admissions = new Map();

  constructor({
    socketPath,
    controllerToken,
    agentRoot,
    extensionPaths,
    offline = false,
    selectContract,
  }) {
    if (typeof socketPath !== "string" || !isAbsolute(socketPath)) throw new Error("Broker launch resolver needs an absolute socketPath");
    if (typeof controllerToken !== "string" || controllerToken.length < 32) throw new Error("Broker launch resolver needs a controller-only token");
    if (!Array.isArray(extensionPaths) || extensionPaths.length === 0 || extensionPaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
      throw new Error("Broker launch resolver needs non-empty absolute explicit extension paths");
    }
    if (typeof offline !== "boolean") throw new Error("Broker launch resolver offline must be boolean");
    if (typeof selectContract !== "function") throw new Error("Broker launch resolver needs a controller selectContract function");
    this.#socketPath = socketPath;
    this.#controllerToken = controllerToken;
    this.#agentRoot = ownerOnlyDirectory(agentRoot, "Broker child agent root");
    this.#extensionPaths = Object.freeze([...extensionPaths]);
    this.#offline = offline;
    this.#selectContract = selectContract;
  }

  /** Compatible with TrustedChildLaunchResolver; request has no raw prompt. */
  async resolve(request) {
    if (!request || !CHILD_ID.test(request.childId ?? "")) throw new Error("Broker launch request has an invalid childId");
    if (this.#admissions.has(request.childId)) return { action: "deny", reason: "duplicate child admission" };
    const selection = await this.#selectContract(Object.freeze({ ...request }));
    if (selection?.action === "deny") return { action: "deny", reason: safeReason(selection.reason) };
    if (!selection?.contract) throw new Error("Broker launch selection did not return a contract");
    if (selection.contract.promptDigest !== request.promptDigest) {
      return { action: "deny", reason: "child prompt is not bound to the selected broker contract" };
    }
    const expected = expectedModel(selection);
    if (request.model?.provider !== expected.provider || request.model?.modelId !== expected.modelId) {
      return { action: "deny", reason: "resolved model is not approved for this broker contract" };
    }

    let queuedTaskId;
    let reservation;
    if (selection.readyTask !== undefined) {
      if (!selection.readyTask || selection.readyTask.taskId !== selection.contract.taskId
        || typeof selection.readyTask.leaseId !== "string" || !selection.readyTask.leaseId) {
        return { action: "deny", reason: "ready task selection does not match broker contract" };
      }
      queuedTaskId = selection.readyTask.taskId;
      reservation = await this.#controller("claimReadyTask", {
        taskId: queuedTaskId,
        leaseId: selection.readyTask.leaseId,
        contract: selection.contract,
      });
    } else {
      reservation = await this.#controller("reserve", { contract: selection.contract });
    }
    if (reservation?.status !== "leased") return { action: "deny", reason: reservation?.status === "denied_capacity" ? "no compatible broker capacity" : "broker policy denied launch" };
    const lease = reservation.lease;
    let agentDir;
    try {
      const issued = await this.#controller("issueLeaseCapability", { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
      if (issued?.status !== "issued" || typeof issued.capability !== "string") throw new Error("Broker declined lease capability issuance");
      agentDir = provisionBrokeredAgentDir(join(this.#agentRoot, request.childId)).agentDir;
      const admission = {
        lease,
        agentDir,
        capability: issued.capability,
        phase: "pending_handoff",
        ...(queuedTaskId === undefined ? {} : { queuedTaskId }),
      };
      this.#admissions.set(request.childId, admission);
      return {
        action: "allow",
        policy: {
          policyId: lease.leaseId,
          agentDir,
          offline: this.#offline,
          extensionPaths: this.#extensionPaths,
          environment: {
            PI_BROKER_SOCKET: this.#socketPath,
            PI_BROKER_LEASE_ID: lease.leaseId,
            PI_BROKER_FENCING_TOKEN: String(lease.fencingToken),
            PI_BROKER_CAPABILITY: issued.capability,
          },
          onBeforeChildAbandoned: async () => this.releaseUnhanded(request.childId),
          onChildSessionOpened: async () => this.markChildHanded(request.childId),
          onChildSessionClosed: async (result) => this.finalizeHandedChild(request.childId, result),
        },
      };
    } catch (error) {
      if (queuedTaskId === undefined) await this.#releaseLease(lease).catch(() => undefined);
      else await this.#abandonClaimed(queuedTaskId, lease).catch(() => undefined);
      if (agentDir) this.#removeAgentDir(agentDir);
      throw error;
    }
  }

  /** Idempotent pre-handoff cleanup called only by the trusted parent runner. */
  async releaseUnhanded(childId) {
    return this.#releaseAdmission(childId, "release_pending");
  }

  /** Called after the trusted runner has a real ChildSession/process. */
  async markChildHanded(childId) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "already_released" };
    if (admission.phase === "pending_handoff") admission.phase = "handed";
    return { status: admission.phase };
  }

  /** Idempotent post-session cleanup called only after trusted runner disposal. */
  async finalizeHandedChild(childId, result) {
    return this.#releaseAdmission(childId, "closed_release_pending", result?.status === "completed" ? "completed" : "failed");
  }

  /** Retry only records explicitly known to be unhanded or session-closed. */
  async reconcilePendingReleases() {
    const outcomes = [];
    for (const [childId, admission] of this.#admissions) {
      if (admission.phase !== "release_pending" && admission.phase !== "closed_release_pending") continue;
      try {
        outcomes.push(Object.freeze({ childId, ...(await this.#releaseAdmission(childId, admission.phase, admission.terminalState)) }));
      } catch {
        outcomes.push(Object.freeze({ childId, status: "pending" }));
      }
    }
    return Object.freeze(outcomes);
  }

  /** Redacted controller-local visibility; capabilities/controller token stay private. */
  admissions() {
    return Object.freeze([...this.#admissions.entries()].map(([childId, admission]) => Object.freeze({
      childId,
      leaseId: admission.lease.leaseId,
      fencingToken: admission.lease.fencingToken,
      expiresAt: admission.lease.expiresAt,
      phase: admission.phase,
      ...(admission.queuedTaskId === undefined ? {} : { queuedTaskId: admission.queuedTaskId }),
    })));
  }

  async #releaseAdmission(childId, pendingPhase, terminalState) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "already_released" };
    admission.phase = pendingPhase;
    if (terminalState !== undefined) admission.terminalState = terminalState;
    // Do not forget an admission before controller IPC confirms. On a broker
    // transport failure the controller retains a redacted record and agent dir
    // for explicit retry/reconciliation instead of silently relying on TTL.
    let result;
    if (admission.queuedTaskId === undefined) {
      await this.#releaseLease(admission.lease);
      result = { status: "released" };
    } else if (pendingPhase === "release_pending") {
      result = await this.#abandonClaimed(admission.queuedTaskId, admission.lease);
    } else {
      result = await this.#finalizeClaimed(admission.queuedTaskId, admission.lease, admission.terminalState ?? "failed");
    }
    this.#removeAgentDir(admission.agentDir);
    this.#admissions.delete(childId);
    return result;
  }

  async #controller(method, params) {
    return requestBrokerIpc({
      socketPath: this.#socketPath,
      authorization: this.#controllerToken,
      method,
      params,
    });
  }

  async #releaseLease(lease) {
    await this.#controller("release", { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
  }

  async #abandonClaimed(taskId, lease) {
    return this.#controller("abandonClaimedTask", {
      taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
  }

  async #finalizeClaimed(taskId, lease, terminalState) {
    return this.#controller("finalizeClaimedTask", {
      taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      terminalState,
    });
  }

  #removeAgentDir(agentDir) {
    // agentDir was constructed from a validated child ID under the canonical
    // root. Refuse a surprising path rather than recursively removing outside.
    if (join(this.#agentRoot, agentDir.slice(this.#agentRoot.length + 1)) !== agentDir || !agentDir.startsWith(`${this.#agentRoot}/`)) {
      throw new Error("Broker resolver refused to remove an agent directory outside its root");
    }
    if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
  }
}

function safeReason(reason) {
  if (typeof reason !== "string") return "broker policy denied launch";
  // Denial enters a child-visible runner error; do not pass controller detail.
  return /^[A-Za-z0-9 _.-]{1,120}$/.test(reason) ? reason : "broker policy denied launch";
}
