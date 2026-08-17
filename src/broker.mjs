import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createEffectiveChildCapability } from "./capability-compiler.mjs";

const ENFORCEMENT = Object.freeze({ hard: 2, metered_best_effort: 1, unavailable: 0 });
const ADMISSION_CLASSES = new Set(["control", "verify", "work"]);
const INVENTORY_CONFIDENCE = new Set(["measured", "observed", "assumed"]);
const PENDING_STATES = new Set(["waiting", "ready", "claimed", "awaiting_result", "escalated", "completed", "failed"]);
const EFFECT_CAPABLE_OPERATIONS = new Set(["propose_patch", "apply", "external_write"]);
const BEHAVIORAL_ENFORCEMENT = new Set(["unavailable", "blocking_monitor"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const RESOURCE_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_REF = /^controller:[0-9a-f-]{36}$/;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /CANARY_SECRET_[A-Za-z0-9_-]+/g,
];

function redact(value) {
  if (typeof value === "string") return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  return value;
}

function parseJson(value) { return JSON.parse(value); }

function capabilityDigest(capability) {
  return createHash("sha256").update(capability).digest("hex");
}

function enforcementSatisfies(actual, required) {
  return Object.hasOwn(ENFORCEMENT, actual)
    && Object.hasOwn(ENFORCEMENT, required)
    && ENFORCEMENT[actual] >= ENFORCEMENT[required];
}

function normalizeVerificationReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("verification receipt must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["evidenceRefs", "receiptRef", "status", "verifierRunId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("verification receipt has unsupported or missing fields");
  }
  if (value.status !== "accepted" && value.status !== "rejected") throw new Error("verification receipt status must be accepted or rejected");
  if (typeof value.verifierRunId !== "string" || !IDENTIFIER.test(value.verifierRunId)) {
    throw new Error("verification receipt verifierRunId is invalid");
  }
  if (typeof value.receiptRef !== "string" || !EVIDENCE_REF.test(value.receiptRef)) {
    throw new Error("verification receipt receiptRef is invalid");
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 20
    || value.evidenceRefs.some((ref) => typeof ref !== "string" || !EVIDENCE_REF.test(ref))
    || new Set(value.evidenceRefs).size !== value.evidenceRefs.length
    || (value.status === "accepted" && value.evidenceRefs.length < 1)) {
    throw new Error("verification receipt evidenceRefs are invalid");
  }
  return Object.freeze({
    status: value.status,
    verifierRunId: value.verifierRunId,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    receiptRef: value.receiptRef,
  });
}

function asLease(row) {
  return {
    leaseId: row.lease_id,
    taskId: row.task_id,
    resourceId: row.resource_id,
    capacityGroup: row.capacity_group,
    profile: row.profile,
    fencingToken: row.fencing_token,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    enforcement: parseJson(row.enforcement),
    admissionClass: row.admission_class,
    behavioralEnforcement: row.behavioral_enforcement,
    probe: row.is_probe === 1,
    ...(row.max_input_tokens === null || row.max_input_tokens === undefined ? {} : { maxInputTokens: row.max_input_tokens }),
    ...(row.max_output_tokens === null || row.max_output_tokens === undefined ? {} : { maxOutputTokens: row.max_output_tokens }),
  };
}

/**
 * Single-host, synchronous SQLite broker core. All capacity decisions are made
 * in BEGIN IMMEDIATE transactions, so independent local processes sharing the
 * same database file serialize reserve/release/fencing transitions.
 *
 * It deliberately has no HTTP/RPC provider client and holds no credentials.
 */
export class SqliteLeaseBroker {
  #db;
  #maxPendingTasks;
  #agingStepMs;
  #behavioralEnforcement;
  #verificationReceiptVerifier;
  #resourceRanker;
  #reconcileRegistryOnStart;

  constructor({
    path, registry, maxPendingTasks = 1_000, agingStepMs = 30_000,
    behavioralEnforcement = "unavailable", verificationReceiptVerifier, resourceRanker,
    reconcileRegistryOnStart = false,
  }) {
    if (!path) throw new Error("SQLite broker needs a database path");
    if (!Number.isSafeInteger(maxPendingTasks) || maxPendingTasks < 1 || maxPendingTasks > 100_000) {
      throw new Error("maxPendingTasks must be an integer between 1 and 100000");
    }
    if (!Number.isSafeInteger(agingStepMs) || agingStepMs < 1 || agingStepMs > 86_400_000) {
      throw new Error("agingStepMs must be an integer between 1 and 86400000");
    }
    if (!BEHAVIORAL_ENFORCEMENT.has(behavioralEnforcement)) throw new Error("behavioralEnforcement must be unavailable or blocking_monitor");
    if (verificationReceiptVerifier !== undefined && typeof verificationReceiptVerifier !== "function") {
      throw new Error("verificationReceiptVerifier must be a controller-owned function");
    }
    if (resourceRanker !== undefined && typeof resourceRanker !== "function") {
      throw new Error("resourceRanker must be a controller-owned function");
    }
    if (typeof reconcileRegistryOnStart !== "boolean") throw new Error("reconcileRegistryOnStart must be boolean");
    this.#maxPendingTasks = maxPendingTasks;
    this.#agingStepMs = agingStepMs;
    this.#behavioralEnforcement = behavioralEnforcement;
    this.#verificationReceiptVerifier = verificationReceiptVerifier;
    this.#resourceRanker = resourceRanker;
    this.#reconcileRegistryOnStart = reconcileRegistryOnStart;
    this.#db = new DatabaseSync(path);
    try {
      // Configure the connection wait before contending for the database-wide
      // journal-mode lock during independent-process startup.
      this.#db.exec("PRAGMA busy_timeout = 5000;");
      this.#db.exec("PRAGMA foreign_keys = ON;");
      this.#db.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
      this.#seed(registry);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  reserve(contract, now) {
    return this.#transaction(() => {
      this.#expire(now);
      return this.#reserveCore(contract, now);
    });
  }

  /**
   * Try immediate admission and durably queue only contracts that name a
   * recovery owner and deadline. The queue stores contracts, never child
   * processes or model context.
   */
  submit(contract, now) {
    return this.#transaction(() => {
      this.#expire(now);
      const reservation = this.#reserveCore(contract, now);
      if (reservation.status !== "denied_capacity") return reservation;
      const recovery = contract?.recovery;
      if (!recovery || typeof recovery.owner !== "string" || !IDENTIFIER.test(recovery.owner)
        || !Number.isSafeInteger(recovery.deadlineAt) || recovery.deadlineAt <= now) {
        const result = { status: "denied_policy", reasons: ["queued work requires a recovery owner and future deadlineAt"] };
        this.#record(now, "ReservationDenied", { taskId: contract?.taskId, ...result });
        return result;
      }
      const activePending = this.#db.prepare("SELECT count(*) AS count FROM pending_tasks WHERE state IN ('waiting', 'ready', 'claimed', 'awaiting_result', 'escalated')").get().count;
      if (activePending >= this.#maxPendingTasks) {
        const result = {
          status: "denied_capacity",
          reasonCode: "queue_full",
          recoveryOwner: recovery.owner,
          deadlineAt: recovery.deadlineAt,
        };
        this.#record(now, "TaskEscalated", { taskId: contract.taskId, recoveryOwner: recovery.owner, reason: "queue_full" });
        return result;
      }
      const eligibleAt = reservation.earliestCompatibleAt ?? null;
      const durableContract = redact(contract);
      const inserted = this.#db.prepare(`
        INSERT INTO pending_tasks (task_id, contract, admission_class, state, created_at, updated_at, eligible_at, deadline_at, recovery_owner, lease_id)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(task_id) DO NOTHING
      `).run(
        contract.taskId, JSON.stringify(durableContract), contract.admissionClass,
        now, now, eligibleAt, recovery.deadlineAt, recovery.owner,
      );
      if (inserted.changes !== 1) {
        return { status: "denied_policy", reasons: ["taskId already exists in the pending ledger"] };
      }
      this.#record(now, "TaskQueued", {
        taskId: contract.taskId,
        admissionClass: contract.admissionClass,
        eligibleAt,
        deadlineAt: recovery.deadlineAt,
        recoveryOwner: recovery.owner,
      });
      return {
        status: "queued",
        taskId: contract.taskId,
        eligibleAt,
        deadlineAt: recovery.deadlineAt,
        recoveryOwner: recovery.owner,
      };
    });
  }

  /** Atomically retry eligible queued contracts with class preference plus bounded aging. */
  dispatchPending(now, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("dispatch limit must be between 1 and 1000");
    return this.#transaction(() => {
      this.#expire(now);
      const overdue = this.#db.prepare("SELECT task_id, recovery_owner, state FROM pending_tasks WHERE state IN ('waiting', 'awaiting_result') AND deadline_at <= ?").all(now);
      this.#db.prepare("UPDATE pending_tasks SET state = 'escalated', updated_at = ?, eligible_at = NULL WHERE state IN ('waiting', 'awaiting_result') AND deadline_at <= ?").run(now, now);
      for (const task of overdue) this.#record(now, "TaskEscalated", {
        taskId: task.task_id,
        recoveryOwner: task.recovery_owner,
        reason: task.state === "awaiting_result" ? "result_reconciliation_deadline" : "capacity_wait_deadline",
      });

      const eligible = this.#db.prepare(`
        SELECT * FROM pending_tasks
        WHERE state = 'waiting' AND eligible_at IS NOT NULL AND eligible_at <= ? AND deadline_at > ?
      `).all(now, now);
      const classRank = (admissionClass) => admissionClass === "control" ? 0 : admissionClass === "verify" ? 1 : 2;
      const effectiveRank = (pending) => Math.max(0, classRank(pending.admission_class) - Math.floor((now - pending.created_at) / this.#agingStepMs));
      const comparePending = (left, right) => effectiveRank(left) - effectiveRank(right)
        || left.created_at - right.created_at
        || left.task_id.localeCompare(right.task_id);
      const selected = eligible.sort(comparePending).slice(0, limit);
      // The SQL/JS dispatch window is bounded, but a representative from each
      // protected class must remain visible even behind a large aged work
      // backlog. Replace the lowest-priority tail candidate rather than growing
      // the caller's limit.
      const protectedIncluded = new Set(selected.filter((pending) => pending.admission_class !== "work").map((pending) => pending.admission_class));
      for (const protectedClass of ["control", "verify"].slice(0, Math.min(limit, 2))) {
        if (protectedIncluded.has(protectedClass)) continue;
        const representative = eligible.filter((pending) => pending.admission_class === protectedClass).sort(comparePending)[0];
        if (!representative) continue;
        if (selected.length < limit) selected.push(representative);
        else {
          const replaceAt = selected.findLastIndex((pending) => !protectedIncluded.has(pending.admission_class));
          if (replaceAt < 0) continue;
          selected[replaceAt] = representative;
        }
        protectedIncluded.add(protectedClass);
      }
      const queued = [...new Map(selected.map((pending) => [pending.task_id, pending])).values()].sort(comparePending);
      const ready = [];
      for (const pending of queued) {
        const reservation = this.#reserveCore(parseJson(pending.contract), now);
        if (reservation.status === "leased") {
          this.#db.prepare("UPDATE pending_tasks SET state = 'ready', updated_at = ?, lease_id = ? WHERE task_id = ? AND state = 'waiting'")
            .run(now, reservation.lease.leaseId, pending.task_id);
          this.#record(now, "TaskReady", { taskId: pending.task_id, leaseId: reservation.lease.leaseId });
          ready.push({ taskId: pending.task_id, lease: reservation.lease });
        } else if (reservation.status === "denied_capacity") {
          this.#db.prepare("UPDATE pending_tasks SET updated_at = ?, eligible_at = ? WHERE task_id = ? AND state = 'waiting'")
            .run(now, reservation.earliestCompatibleAt ?? null, pending.task_id);
        } else {
          this.#db.prepare("UPDATE pending_tasks SET state = 'escalated', updated_at = ?, eligible_at = NULL WHERE task_id = ? AND state = 'waiting'")
            .run(now, pending.task_id);
          this.#record(now, "TaskEscalated", { taskId: pending.task_id, recoveryOwner: pending.recovery_owner, reason: "policy_changed" });
        }
      }
      return Object.freeze(ready);
    });
  }

  /** Owner action can provide a new deterministic wake-up time after repair. */
  reschedulePending(taskId, recoveryOwner, eligibleAt, now) {
    if (!Number.isSafeInteger(eligibleAt) || eligibleAt <= now) return { status: "denied_policy" };
    return this.#transaction(() => {
      const update = this.#db.prepare(`
        UPDATE pending_tasks SET state = 'waiting', eligible_at = ?, updated_at = ?
        WHERE task_id = ? AND recovery_owner = ? AND state IN ('waiting', 'escalated') AND deadline_at > ?
      `).run(eligibleAt, now, taskId, recoveryOwner, now);
      if (update.changes !== 1) return { status: "denied_policy" };
      this.#record(now, "TaskRescheduled", { taskId, recoveryOwner, eligibleAt });
      return { status: "waiting", eligibleAt };
    });
  }

  finishPending(taskId, state, now) {
    if (!PENDING_STATES.has(state) || (state !== "completed" && state !== "failed")) return { status: "denied_policy" };
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT lease_id FROM pending_tasks WHERE task_id = ? AND state IN ('waiting', 'ready', 'escalated')").get(taskId);
      if (!pending) return { status: "denied_policy" };
      if (pending.lease_id && this.#db.prepare("SELECT 1 FROM leases WHERE lease_id = ?").get(pending.lease_id)) {
        return { status: "denied_lease" };
      }
      const update = this.#db.prepare(`
        UPDATE pending_tasks SET state = ?, updated_at = ?, eligible_at = NULL, lease_id = NULL
        WHERE task_id = ? AND state IN ('waiting', 'ready', 'escalated')
      `).run(state, now, taskId);
      if (update.changes !== 1) return { status: "denied_policy" };
      this.#record(now, "TaskTerminal", { taskId, status: state });
      return { status: state };
    });
  }

  trackLeasedTask(contract, leaseId, fencingToken, now) {
    return this.#transaction(() => {
      this.#expire(now);
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?").get(leaseId, fencingToken, now);
      // A bare denial is undiagnosable in production: the caller cannot tell an expired lease
      // from a contract mismatch from an already-tracked task, and all three need different
      // repairs. The reason code carries no prompt, credential or contract content.
      if (!lease) return { status: "denied_policy", reason: "lease_not_active" };
      if (lease.task_id !== contract?.taskId) return { status: "denied_policy", reason: "lease_task_mismatch" };
      const recovery = contract.recovery ?? {};
      const deadlineAt = Number.isSafeInteger(recovery.deadlineAt) && recovery.deadlineAt > now
        ? recovery.deadlineAt : now + Math.max(300_000, contract.latencyBudgetMs ?? 0);
      const owner = typeof recovery.owner === "string" && IDENTIFIER.test(recovery.owner) ? recovery.owner : "controller";
      const inserted = this.#db.prepare(`INSERT INTO pending_tasks (task_id, contract, admission_class, state, created_at, updated_at, eligible_at, deadline_at, recovery_owner, lease_id)
        VALUES (?, ?, ?, 'claimed', ?, ?, NULL, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING`)
        .run(contract.taskId, JSON.stringify(redact(contract)), contract.admissionClass, now, now, deadlineAt, owner, leaseId);
      if (inserted.changes !== 1) return { status: "denied_policy", reason: "task_already_tracked" };
      this.#record(now, "TaskTracked", { taskId: contract.taskId, leaseId });
      return { status: "tracked" };
    });
  }

  claimReadyTask(taskId, leaseId, contract, now) {
    return this.#transaction(() => {
      this.#expire(now);
      const pending = this.#db.prepare(`
        SELECT p.contract, l.*
        FROM pending_tasks p JOIN leases l ON l.lease_id = p.lease_id
        WHERE p.task_id = ? AND p.lease_id = ? AND p.state = 'ready' AND l.expires_at > ?
      `).get(taskId, leaseId, now);
      if (!pending || pending.task_id !== taskId || JSON.stringify(redact(contract)) !== pending.contract) {
        return { status: "denied_policy", reasons: ["ready task contract or lease does not match"] };
      }
      const claimed = this.#db.prepare("UPDATE pending_tasks SET state = 'claimed', updated_at = ? WHERE task_id = ? AND state = 'ready'")
        .run(now, taskId);
      if (claimed.changes !== 1) return { status: "denied_policy", reasons: ["ready task was already claimed"] };
      const lease = asLease(pending);
      this.#record(now, "TaskClaimed", { taskId, leaseId });
      return { status: "leased", lease };
    });
  }

  abandonClaimedTask(taskId, leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT deadline_at, recovery_owner FROM pending_tasks WHERE task_id = ? AND lease_id = ? AND state = 'claimed'")
        .get(taskId, leaseId);
      if (!pending) return { status: "denied_policy" };
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ?").get(leaseId, fencingToken);
      if (lease) {
        this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
        this.#afterLeaseRemoved(lease, now);
      }
      const state = pending.deadline_at > now ? "waiting" : "escalated";
      this.#db.prepare("UPDATE pending_tasks SET state = ?, eligible_at = ?, updated_at = ?, lease_id = NULL WHERE task_id = ? AND state = 'claimed'")
        .run(state, state === "waiting" ? now : null, now, taskId);
      this.#record(now, state === "waiting" ? "TaskRequeued" : "TaskEscalated", {
        taskId,
        recoveryOwner: pending.recovery_owner,
        reason: "claimed_child_not_handed",
      });
      return { status: state };
    });
  }

  /**
   * End child ownership without letting its exit/self-report complete the task.
   * Capacity is released and the durable task waits for a controller verifier
   * receipt, or escalates at its already registered reconciliation deadline.
   */
  releaseClaimedTaskForVerification(taskId, leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT state FROM pending_tasks WHERE task_id = ? AND lease_id = ? AND state IN ('claimed', 'awaiting_result')")
        .get(taskId, leaseId);
      if (!pending) return { status: "denied_policy" };
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ?").get(leaseId, fencingToken);
      if (lease) {
        this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
        this.#afterLeaseRemoved(lease, now);
      } else if (pending.state === "claimed") {
        return { status: "denied_lease" };
      }
      this.#db.prepare("UPDATE pending_tasks SET state = 'awaiting_result', updated_at = ? WHERE task_id = ? AND lease_id = ? AND state IN ('claimed', 'awaiting_result')")
        .run(now, taskId, leaseId);
      this.#record(now, "TaskAwaitingVerification", { taskId, leaseId, fencingToken });
      return { status: "awaiting_verification" };
    });
  }

  /**
   * Only a controller-owned verifier may make a queued task terminal. A child
   * status, tool result, or provider terminal is intentionally not an input.
   */
  finalizeVerifiedTask(taskId, leaseId, fencingToken, verification, now) {
    const verdict = normalizeVerificationReceipt(verification);
    // The controller IPC token is necessary but insufficient: the receipt
    // must also be rooted in the controller's retained evidence authority.
    // This callback is boot-injected, never serialized or child-configurable.
    let receiptVerified = false;
    try {
      receiptVerified = this.#verificationReceiptVerifier?.(verdict, Object.freeze({ taskId, leaseId, fencingToken })) === true;
    } catch { /* fail closed */ }
    if (!receiptVerified) return { status: "denied_verification" };
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT 1 FROM pending_tasks WHERE task_id = ? AND lease_id = ? AND state = 'awaiting_result'")
        .get(taskId, leaseId);
      if (!pending) return { status: "denied_policy" };
      const lease = this.#db.prepare("SELECT 1 FROM leases WHERE lease_id = ? AND fencing_token = ?").get(leaseId, fencingToken);
      if (lease) return { status: "denied_lease" };
      const terminalState = verdict.status === "accepted" ? "completed" : "failed";
      this.#db.prepare("UPDATE pending_tasks SET state = ?, eligible_at = NULL, updated_at = ?, lease_id = NULL WHERE task_id = ? AND state = 'awaiting_result'")
        .run(terminalState, now, taskId);
      this.#record(now, "TaskTerminal", {
        taskId,
        status: terminalState,
        source: "controller_verifier",
        verifierRunId: verdict.verifierRunId,
        verificationStatus: verdict.status,
        evidenceRefs: verdict.evidenceRefs,
        receiptRef: verdict.receiptRef,
      });
      return { status: terminalState };
    });
  }

  readyTasks() {
    return this.#db.prepare(`
      SELECT p.task_id AS pending_task_id, l.*
      FROM pending_tasks p JOIN leases l ON l.lease_id = p.lease_id
      WHERE p.state = 'ready'
      ORDER BY p.updated_at, p.task_id
    `).all().map((row) => Object.freeze({ taskId: row.pending_task_id, lease: Object.freeze(asLease(row)) }));
  }

  queueWaitMetrics(now) {
    this.#assertNondecreasingTime(now);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("queue wait metrics require a non-negative safe-integer time");
    const rows = this.#db.prepare(`
      SELECT admission_class, created_at FROM pending_tasks
      WHERE state IN ('waiting', 'ready', 'claimed', 'awaiting_result', 'escalated')
      ORDER BY admission_class, created_at
    `).all();
    const metrics = {};
    for (const admissionClass of ADMISSION_CLASSES) {
      const waits = rows.filter((row) => row.admission_class === admissionClass).map((row) => Math.max(0, now - row.created_at)).sort((a, b) => a - b);
      const p95Index = waits.length === 0 ? -1 : Math.ceil(waits.length * 0.95) - 1;
      metrics[admissionClass] = Object.freeze({
        count: waits.length,
        p95WaitMs: p95Index < 0 ? 0 : waits[p95Index],
        maxWaitMs: waits.length === 0 ? 0 : waits[waits.length - 1],
      });
    }
    return Object.freeze(metrics);
  }

  pendingTasks() {
    return this.#db.prepare(`
      SELECT task_id, admission_class, state, created_at, updated_at, eligible_at, deadline_at, recovery_owner, lease_id
      FROM pending_tasks ORDER BY created_at, task_id
    `).all().map((row) => Object.freeze({
      taskId: row.task_id,
      admissionClass: row.admission_class,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      eligibleAt: row.eligible_at,
      deadlineAt: row.deadline_at,
      recoveryOwner: row.recovery_owner,
      leaseId: row.lease_id,
    }));
  }

  heartbeat(leaseId, fencingToken, now, ttlMs = 30_000) {
    return this.#transaction(() => {
      const update = this.#db.prepare("UPDATE leases SET expires_at = ? WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .run(now + ttlMs, leaseId, fencingToken, now);
      if (update.changes !== 1) return { status: "denied_lease" };
      const lease = asLease(this.#db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId));
      this.#record(now, "LeaseHeartbeated", { leaseId, fencingToken, expiresAt: lease.expiresAt });
      return { status: "leased", lease };
    });
  }

  /**
   * Issue a least-privilege IPC capability after a controller has reserved a
   * lease. Only its SHA-256 digest is persisted; the raw capability is never
   * included in audit events and is invalidated by lease release/expiry.
   */
  issueLeaseCapability(leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .get(leaseId, fencingToken, now);
      if (!lease) return { status: "denied_lease" };
      const capability = randomBytes(32).toString("base64url");
      this.#db.prepare("DELETE FROM lease_capabilities WHERE lease_id = ?").run(leaseId);
      this.#db.prepare(`
        INSERT INTO lease_capabilities (capability_hash, lease_id, fencing_token, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(capabilityDigest(capability), leaseId, fencingToken, lease.expires_at);
      this.#record(now, "LeaseCapabilityIssued", { leaseId, fencingToken, expiresAt: lease.expires_at });
      return { status: "issued", capability, expiresAt: lease.expires_at };
    });
  }

  /**
   * Bind the controller-selected EffectiveChildCapability to one active lease.
   * The capability is durable controller state, not a child environment value:
   * children may retrieve their own record through a lease-scoped IPC request,
   * but cannot nominate, replace, or broaden it.
   */
  bindEffectiveChildCapability(leaseId, fencingToken, capability, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .get(leaseId, fencingToken, now);
      if (!lease) return { status: "denied_lease" };
      const { capabilityFingerprint: suppliedFingerprint, ...capabilityInput } = capability ?? {};
      const normalized = createEffectiveChildCapability(capabilityInput);
      if (suppliedFingerprint !== undefined && suppliedFingerprint !== normalized.capabilityFingerprint) {
        throw new Error("Effective child capability fingerprint is invalid");
      }
      if (normalized.taskId !== lease.task_id
        || normalized.admissionClass !== lease.admission_class
        || normalized.behavioralEnforcement !== lease.behavioral_enforcement
        || JSON.stringify(normalized.budget.enforcement ?? {}) !== JSON.stringify(parseJson(lease.enforcement))
        || normalized.budget.maxInputTokens !== (lease.max_input_tokens ?? undefined)
        || normalized.budget.maxOutputTokens !== (lease.max_output_tokens ?? undefined)) {
        throw new Error("Effective child capability does not match its lease");
      }
      const encoded = JSON.stringify(normalized);
      const existing = this.#db.prepare("SELECT capability FROM effective_child_capabilities WHERE lease_id = ?").get(leaseId);
      if (existing && existing.capability !== encoded) throw new Error("Effective child capability is already bound for this lease");
      if (!existing) {
        this.#db.prepare("INSERT INTO effective_child_capabilities (lease_id, fencing_token, capability) VALUES (?, ?, ?)")
          .run(leaseId, fencingToken, encoded);
        this.#record(now, "EffectiveChildCapabilityBound", {
          leaseId,
          fencingToken,
          capabilityFingerprint: normalized.capabilityFingerprint,
          behavioralEnforcement: normalized.behavioralEnforcement,
        });
      }
      return { status: "bound", capabilityFingerprint: normalized.capabilityFingerprint };
    });
  }

  /** Return the exact capability previously bound by the controller for an active lease. */
  effectiveChildCapabilityForLease(leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT c.capability
        FROM effective_child_capabilities c JOIN leases l ON l.lease_id = c.lease_id
        WHERE c.lease_id = ? AND c.fencing_token = ? AND l.fencing_token = ? AND l.expires_at > ?
      `).get(leaseId, fencingToken, fencingToken, now);
      if (!row) return { status: "denied_or_unbound" };
      let stored;
      try { stored = JSON.parse(row.capability); } catch { throw new Error("Persisted effective child capability is malformed"); }
      const { capabilityFingerprint, ...input } = stored ?? {};
      const capability = createEffectiveChildCapability(input);
      if (capability.capabilityFingerprint !== capabilityFingerprint) throw new Error("Persisted effective child capability fingerprint is invalid");
      return { status: "bound", capability };
    });
  }

  /**
   * Hash only controller-owned durable state relevant to this lease. Behavioral
   * observations include this value, never a child-supplied "state digest".
   */
  behavioralStateDigestForLease(leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT l.lease_id, l.fencing_token, l.expires_at, l.task_id, l.resource_id,
               r.state AS resource_state, r.cooldown_until AS resource_cooldown_until,
               g.breaker_state, g.cooldown_until AS group_cooldown_until, g.probe_lease_id
        FROM leases l
        JOIN resources r ON r.id = l.resource_id
        JOIN capacity_groups g ON g.id = l.capacity_group
        WHERE l.lease_id = ? AND l.fencing_token = ? AND l.expires_at > ?
      `).get(leaseId, fencingToken, now);
      if (!row) return { status: "denied_lease" };
      return {
        status: "observed",
        stateDigest: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
      };
    });
  }

  /** Validate a child-scoped IPC capability without exposing controller authority. */
  leaseForCapability(capability, now) {
    this.#assertNondecreasingTime(now);
    if (typeof capability !== "string" || !capability) return { status: "denied_capability" };
    const row = this.#db.prepare(`
      SELECT l.*
      FROM lease_capabilities c JOIN leases l ON l.lease_id = c.lease_id
      WHERE c.capability_hash = ?
        AND c.fencing_token = l.fencing_token
        AND c.expires_at > ?
        AND l.expires_at > ?
    `).get(capabilityDigest(capability), now, now);
    return row ? { status: "authorized", lease: asLease(row) } : { status: "denied_capability" };
  }

  /** Record already-classified provider telemetry without retaining raw child input. */
  recordProviderEvent(leaseId, fencingToken, inputDigest, event, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .get(leaseId, fencingToken, now);
      if (!lease) return { status: "denied_lease" };
      this.#record(now, "ProviderEvent", { leaseId, fencingToken, inputDigest, event });
      return { status: "recorded", lease: asLease(lease) };
    });
  }

  /** Record a controller-observed behavioral gate fact without provider-health semantics. */
  recordBehavioralEvent(leaseId, fencingToken, event, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .get(leaseId, fencingToken, now);
      if (!lease) return { status: "denied_lease" };
      this.#record(now, "BehavioralEvent", { leaseId, fencingToken, event });
      return { status: "recorded" };
    });
  }

  release(leaseId, fencingToken, reason, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ?").get(leaseId, fencingToken);
      if (!lease) return { status: "denied_lease" };
      this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
      this.#afterLeaseRemoved(lease, now);
      this.#db.prepare(`
        UPDATE pending_tasks SET state = 'awaiting_result', updated_at = ?
        WHERE lease_id = ? AND state = 'claimed'
      `).run(now, leaseId);
      this.#record(now, "LeaseReleased", { leaseId, fencingToken, reason });
      return { status: "released" };
    });
  }

  expire(now) {
    return this.#transaction(() => this.#expire(now));
  }

  markRateLimited(resourceId, retryAfterMs, now) {
    return this.#transaction(() => {
      const resource = this.#db.prepare(`
        SELECT r.capacity_group, g.default_cooldown_ms
        FROM resources r JOIN capacity_groups g ON g.id = r.capacity_group
        WHERE r.id = ?
      `).get(resourceId);
      if (!resource) throw new Error(`Unknown resource ${resourceId}`);
      const hasUsableRetryAfter = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= Number.MAX_SAFE_INTEGER - now;
      const duration = hasUsableRetryAfter ? retryAfterMs : resource.default_cooldown_ms;
      const until = now + duration;
      this.#db.prepare(`
        UPDATE capacity_groups
        SET cooldown_until = MAX(cooldown_until, ?), breaker_state = 'cooling_down'
        WHERE id = ?
      `).run(until, resource.capacity_group);
      this.#record(now, "CapacityGroupCooldown", {
        resourceId,
        capacityGroup: resource.capacity_group,
        until,
        source: hasUsableRetryAfter ? "retry_after" : "registry_default",
      });
      return { status: "cooling_down", capacityGroup: resource.capacity_group, until };
    });
  }

  /**
   * `scope` distinguishes what the failure actually proves. A model-specific refusal condemns
   * only that route, but a revoked or expired credential is a property of the account: every
   * resource in the capacity group shares it, so leaving the siblings healthy makes the broker
   * spend its remaining failover attempts re-proving the same dead credential.
   */
  markUnknown(resourceId, now, reason = "unknown", scope = "resource") {
    if (scope !== "resource" && scope !== "capacity_group") throw new Error("markUnknown scope must be resource or capacity_group");
    return this.#transaction(() => {
      const update = this.#db.prepare("UPDATE resources SET state = 'unknown' WHERE id = ?").run(resourceId);
      if (update.changes !== 1) throw new Error(`Unknown resource ${resourceId}`);
      if (scope === "capacity_group") {
        const group = this.#db.prepare("SELECT capacity_group FROM resources WHERE id = ?").get(resourceId).capacity_group;
        const siblings = this.#db.prepare("UPDATE resources SET state = 'unknown' WHERE capacity_group = ? AND state != 'unknown'").run(group);
        this.#record(now, "CapacityGroupUnknown", { resourceId, capacityGroup: group, reason, alsoAffected: siblings.changes });
        return { status: "unknown", resourceId, capacityGroup: group, alsoAffected: siblings.changes };
      }
      this.#record(now, "ResourceUnknown", { resourceId, reason });
      // Return an explicit receipt: a void result is indistinguishable from "no reply" to a
      // controller waiting on the IPC response.
      return { status: "unknown", resourceId };
    });
  }

  markProviderSucceeded(leaseId, fencingToken, now) {
    return this.#transaction(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ? AND expires_at > ?")
        .get(leaseId, fencingToken, now);
      if (!lease) return { status: "denied_lease" };
      const group = this.#db.prepare("SELECT breaker_state, probe_lease_id FROM capacity_groups WHERE id = ?").get(lease.capacity_group);
      this.#db.prepare("UPDATE resources SET state = 'healthy' WHERE id = ?").run(lease.resource_id);
      if (group.breaker_state === "cooling_down" && (lease.is_probe !== 1 || group.probe_lease_id !== lease.lease_id)) {
        this.#record(now, "ProviderSuccessObserved", { leaseId, capacityGroup: lease.capacity_group, breakerClosed: false });
        return { status: "observed", capacityGroup: lease.capacity_group, breakerClosed: false };
      }
      this.#db.prepare(`
        UPDATE capacity_groups SET breaker_state = 'healthy', cooldown_until = 0, probe_lease_id = NULL
        WHERE id = ?
      `).run(lease.capacity_group);
      this.#record(now, "ProviderSuccessObserved", { leaseId, capacityGroup: lease.capacity_group, breakerClosed: true });
      return { status: "observed", capacityGroup: lease.capacity_group, breakerClosed: true };
    });
  }

  /** Explicit controller repair override; ordinary provider success uses markProviderSucceeded. */
  markHealthy(resourceId, now) {
    return this.#transaction(() => {
      const resource = this.#db.prepare("SELECT capacity_group FROM resources WHERE id = ?").get(resourceId);
      if (!resource) throw new Error(`Unknown resource ${resourceId}`);
      this.#db.prepare("UPDATE resources SET state = 'healthy' WHERE id = ?").run(resourceId);
      this.#db.prepare(`
        UPDATE capacity_groups SET breaker_state = 'healthy', cooldown_until = 0, probe_lease_id = NULL
        WHERE id = ?
      `).run(resource.capacity_group);
      this.#record(now, "ResourceHealthy", { resourceId, capacityGroup: resource.capacity_group });
      return { status: "healthy", capacityGroup: resource.capacity_group };
    });
  }

  authorizeEffect(intent, now) {
    this.#assertNondecreasingTime(now);
    const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(intent.leaseId);
    if (!lease || lease.fencing_token !== intent.fencingToken || lease.expires_at <= now || lease.task_id !== intent.taskId) {
      return { status: "denied_lease" };
    }
    if (!intent.approval || intent.approval.expiresAt <= now || intent.approval.targetDigest !== intent.targetDigest) {
      return { status: "denied_policy", reasons: ["effect requires a live approval bound to targetDigest"] };
    }
    if (typeof intent.idempotencyKey !== "string" || !intent.idempotencyKey) {
      return { status: "denied_policy", reasons: ["effect requires an idempotency key"] };
    }
    return { status: "authorized", lease: asLease(lease) };
  }

  /** Durable idempotency ledger boundary; it does not perform an external effect. */
  recordEffect(intent, now) {
    return this.#transaction(() => {
      const authorization = this.authorizeEffect(intent, now);
      if (authorization.status !== "authorized") return authorization;
      const existing = this.#db.prepare("SELECT receipt FROM effect_receipts WHERE idempotency_key = ?").get(intent.idempotencyKey);
      if (existing) return { status: "replayed", receipt: parseJson(existing.receipt) };
      const receipt = { receiptId: randomUUID(), idempotencyKey: intent.idempotencyKey, targetDigest: intent.targetDigest, recordedAt: now };
      this.#db.prepare("INSERT INTO effect_receipts (idempotency_key, receipt) VALUES (?, ?)")
        .run(intent.idempotencyKey, JSON.stringify(receipt));
      this.#record(now, "EffectRecorded", { taskId: intent.taskId, leaseId: intent.leaseId, idempotencyKey: intent.idempotencyKey, targetDigest: intent.targetDigest });
      return { status: "recorded", receipt };
    });
  }

  /**
   * Live controller-side view of what can actually be routed to right now: health, retirement,
   * per-group cooldown and breaker state. The model selector needs this — a registry snapshot
   * alone describes the shape of the world, not which parts of it are currently answering.
   * Read-only and redaction-free: it carries no credential, capability or task data.
   */
  inventory(now) {
    const rows = this.#db.prepare(`
      SELECT
        r.id, r.capacity_group, r.profile, r.state, r.retiring, r.cooldown_until,
        r.inventory_confidence AS resource_confidence, r.enforcement,
        g.inventory_confidence AS group_confidence, g.max_concurrent,
        g.cooldown_until AS group_cooldown_until, g.breaker_state
      FROM resources r JOIN capacity_groups g ON g.id = r.capacity_group
      ORDER BY r.id
    `).all();
    const active = new Map();
    if (Number.isSafeInteger(now)) {
      for (const row of this.#db.prepare("SELECT capacity_group, count(*) AS count FROM leases WHERE expires_at > ? GROUP BY capacity_group").all(now)) {
        active.set(row.capacity_group, row.count);
      }
    }
    return Object.freeze(rows.map((row) => Object.freeze({
      resourceId: row.id,
      capacityGroup: row.capacity_group,
      profile: row.profile,
      state: row.state,
      retiring: row.retiring === 1,
      cooldownUntil: row.cooldown_until,
      groupCooldownUntil: row.group_cooldown_until,
      breakerState: row.breaker_state,
      confidence: row.resource_confidence,
      groupConfidence: row.group_confidence,
      maxConcurrent: row.max_concurrent,
      activeLeases: active.get(row.capacity_group) ?? 0,
      enforcement: parseJson(row.enforcement),
    })));
  }

  leases() {
    return this.#db.prepare("SELECT * FROM leases ORDER BY issued_at, lease_id").all().map(asLease);
  }

  events() {
    return this.#db.prepare("SELECT sequence, at, type, payload FROM events ORDER BY sequence").all()
      .map((row) => ({ sequence: row.sequence, at: row.at, type: row.type, payload: parseJson(row.payload) }));
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        capabilities TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capacity_groups (
        id TEXT PRIMARY KEY,
        max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
        control_reserve INTEGER NOT NULL DEFAULT 1 CHECK (control_reserve >= 0),
        verify_reserve INTEGER NOT NULL DEFAULT 0 CHECK (verify_reserve >= 0),
        inventory_confidence TEXT NOT NULL DEFAULT 'assumed' CHECK (inventory_confidence IN ('measured', 'observed', 'assumed')),
        default_cooldown_ms INTEGER NOT NULL DEFAULT 21600000 CHECK (default_cooldown_ms > 0),
        probe_interval_ms INTEGER NOT NULL DEFAULT 300000 CHECK (probe_interval_ms > 0),
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        breaker_state TEXT NOT NULL DEFAULT 'healthy' CHECK (breaker_state IN ('healthy', 'cooling_down')),
        probe_lease_id TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        CHECK (control_reserve + verify_reserve <= max_concurrent)
      );
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        capacity_group TEXT NOT NULL REFERENCES capacity_groups(id),
        profile TEXT NOT NULL REFERENCES profiles(id),
        state TEXT NOT NULL CHECK (state IN ('healthy', 'unknown')) DEFAULT 'healthy',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        inventory_confidence TEXT NOT NULL DEFAULT 'assumed' CHECK (inventory_confidence IN ('measured', 'observed', 'assumed')),
        enforcement TEXT NOT NULL,
        retiring INTEGER NOT NULL DEFAULT 0 CHECK (retiring IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        resource_id TEXT NOT NULL REFERENCES resources(id),
        capacity_group TEXT NOT NULL REFERENCES capacity_groups(id),
        profile TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        enforcement TEXT NOT NULL,
        max_input_tokens INTEGER,
        max_output_tokens INTEGER,
        max_cost_micros INTEGER,
        admission_class TEXT NOT NULL DEFAULT 'control' CHECK (admission_class IN ('control', 'verify', 'work')),
        behavioral_enforcement TEXT NOT NULL DEFAULT 'unavailable' CHECK (behavioral_enforcement IN ('unavailable', 'blocking_monitor')),
        is_probe INTEGER NOT NULL DEFAULT 0 CHECK (is_probe IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS leases_by_group_expiry ON leases(capacity_group, expires_at);
      CREATE TABLE IF NOT EXISTS lease_capabilities (
        capability_hash TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE REFERENCES leases(lease_id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effective_child_capabilities (
        lease_id TEXT PRIMARY KEY REFERENCES leases(lease_id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        capability TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_tasks (
        task_id TEXT PRIMARY KEY,
        contract TEXT NOT NULL,
        admission_class TEXT NOT NULL CHECK (admission_class IN ('control', 'verify', 'work')),
        state TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'claimed', 'awaiting_result', 'escalated', 'completed', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        eligible_at INTEGER,
        deadline_at INTEGER NOT NULL,
        recovery_owner TEXT NOT NULL,
        lease_id TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_by_wakeup ON pending_tasks(state, eligible_at, deadline_at);
      CREATE TABLE IF NOT EXISTS effect_receipts (
        idempotency_key TEXT PRIMARY KEY,
        receipt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    // Existing development databases predate max_output_tokens. Keep this
    // additive migration explicit rather than silently treating an old lease
    // as a hard-capped one.
    const leaseColumns = this.#db.prepare("PRAGMA table_info(leases)").all().map((column) => column.name);
    if (!leaseColumns.includes("max_input_tokens")) this.#db.exec("ALTER TABLE leases ADD COLUMN max_input_tokens INTEGER");
    if (!leaseColumns.includes("max_output_tokens")) this.#db.exec("ALTER TABLE leases ADD COLUMN max_output_tokens INTEGER");
    if (!leaseColumns.includes("max_cost_micros")) this.#db.exec("ALTER TABLE leases ADD COLUMN max_cost_micros INTEGER");
    if (!leaseColumns.includes("admission_class")) this.#db.exec("ALTER TABLE leases ADD COLUMN admission_class TEXT NOT NULL DEFAULT 'control'");
    if (!leaseColumns.includes("behavioral_enforcement")) this.#db.exec("ALTER TABLE leases ADD COLUMN behavioral_enforcement TEXT NOT NULL DEFAULT 'unavailable'");
    if (!leaseColumns.includes("is_probe")) this.#db.exec("ALTER TABLE leases ADD COLUMN is_probe INTEGER NOT NULL DEFAULT 0");
    const groupColumns = this.#db.prepare("PRAGMA table_info(capacity_groups)").all().map((column) => column.name);
    const groupMigrations = [
      ["control_reserve", "ALTER TABLE capacity_groups ADD COLUMN control_reserve INTEGER NOT NULL DEFAULT 1"],
      ["verify_reserve", "ALTER TABLE capacity_groups ADD COLUMN verify_reserve INTEGER NOT NULL DEFAULT 0"],
      ["inventory_confidence", "ALTER TABLE capacity_groups ADD COLUMN inventory_confidence TEXT NOT NULL DEFAULT 'assumed'"],
      ["default_cooldown_ms", "ALTER TABLE capacity_groups ADD COLUMN default_cooldown_ms INTEGER NOT NULL DEFAULT 21600000"],
      ["probe_interval_ms", "ALTER TABLE capacity_groups ADD COLUMN probe_interval_ms INTEGER NOT NULL DEFAULT 300000"],
      ["cooldown_until", "ALTER TABLE capacity_groups ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0"],
      ["breaker_state", "ALTER TABLE capacity_groups ADD COLUMN breaker_state TEXT NOT NULL DEFAULT 'healthy'"],
      ["probe_lease_id", "ALTER TABLE capacity_groups ADD COLUMN probe_lease_id TEXT"],
    ];
    for (const [column, sql] of groupMigrations) if (!groupColumns.includes(column)) this.#db.exec(sql);
    const resourceColumns = this.#db.prepare("PRAGMA table_info(resources)").all().map((column) => column.name);
    if (!resourceColumns.includes("inventory_confidence")) this.#db.exec("ALTER TABLE resources ADD COLUMN inventory_confidence TEXT NOT NULL DEFAULT 'assumed'");
    // A resource withdrawn by an incremental registry update while it still carries a live
    // lease is retired, not deleted: it stops taking new work immediately and disappears once
    // its last lease ends. Carried as its own column rather than a new `state` value so an
    // existing database migrates additively instead of rebuilding a CHECK constraint.
    if (!resourceColumns.includes("retiring")) this.#db.exec("ALTER TABLE resources ADD COLUMN retiring INTEGER NOT NULL DEFAULT 0");
  }

  #validateRegistry(registry) {
    if (!registry?.profiles || !registry?.capacityGroups || !registry?.resources) throw new Error("Broker registry needs profiles, capacityGroups, and resources");
    for (const [id, group] of Object.entries(registry.capacityGroups)) {
      if (!Number.isSafeInteger(group?.maxConcurrent) || group.maxConcurrent < 1
        || !Number.isSafeInteger(group?.admission?.controlReserve) || group.admission.controlReserve < 1
        || !Number.isSafeInteger(group?.admission?.verifyReserve) || group.admission.verifyReserve < 0
        || group.admission.controlReserve + group.admission.verifyReserve > group.maxConcurrent
        || !Number.isSafeInteger(group?.cooldown?.defaultMs) || group.cooldown.defaultMs < 1
        || !Number.isSafeInteger(group?.cooldown?.probeIntervalMs) || group.cooldown.probeIntervalMs < 1
        || !INVENTORY_CONFIDENCE.has(group?.confidence)) {
        throw new Error(`Invalid capacity group policy: ${id}`);
      }
    }
    for (const [id, resource] of Object.entries(registry.resources)) {
      if (!registry.capacityGroups[resource?.capacityGroup] || !registry.profiles[resource?.profile]
        || !INVENTORY_CONFIDENCE.has(resource?.confidence) || !resource?.enforcement) {
        throw new Error(`Invalid resource policy: ${id}`);
      }
    }
  }

  #insertRegistry(registry) {
      for (const [id, profile] of Object.entries(registry.profiles)) {
        const capabilities = JSON.stringify(profile.supports);
        this.#db.prepare("INSERT OR IGNORE INTO profiles (id, status, capabilities) VALUES (?, ?, ?)")
          .run(id, profile.status, capabilities);
        const persisted = this.#db.prepare("SELECT status, capabilities FROM profiles WHERE id = ?").get(id);
        if (persisted.status !== profile.status || persisted.capabilities !== capabilities) {
          throw new Error(`Persisted profile ${id} differs from the supplied registry; audited migration is required`);
        }
      }
      for (const [id, group] of Object.entries(registry.capacityGroups)) {
        this.#db.prepare(`
          INSERT OR IGNORE INTO capacity_groups (
            id, max_concurrent, control_reserve, verify_reserve, inventory_confidence,
            default_cooldown_ms, probe_interval_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          group.maxConcurrent,
          group.admission.controlReserve,
          group.admission.verifyReserve,
          group.confidence,
          group.cooldown.defaultMs,
          group.cooldown.probeIntervalMs,
        );
        const persisted = this.#db.prepare(`
          SELECT max_concurrent, control_reserve, verify_reserve, inventory_confidence, default_cooldown_ms, probe_interval_ms
          FROM capacity_groups WHERE id = ?
        `).get(id);
        if (persisted.max_concurrent !== group.maxConcurrent
          || persisted.control_reserve !== group.admission.controlReserve
          || persisted.verify_reserve !== group.admission.verifyReserve
          || persisted.inventory_confidence !== group.confidence
          || persisted.default_cooldown_ms !== group.cooldown.defaultMs
          || persisted.probe_interval_ms !== group.cooldown.probeIntervalMs) {
          throw new Error(`Persisted capacity group ${id} differs from the supplied registry; audited migration is required`);
        }
      }
      for (const [id, resource] of Object.entries(registry.resources)) {
        const enforcement = JSON.stringify(resource.enforcement);
        this.#db.prepare(`
          INSERT OR IGNORE INTO resources (id, capacity_group, profile, state, cooldown_until, inventory_confidence, enforcement)
          VALUES (?, ?, ?, 'healthy', 0, ?, ?)
        `).run(id, resource.capacityGroup, resource.profile, resource.confidence, enforcement);
        const persisted = this.#db.prepare(`
          SELECT capacity_group, profile, inventory_confidence, enforcement FROM resources WHERE id = ?
        `).get(id);
        if (persisted.capacity_group !== resource.capacityGroup
          || persisted.profile !== resource.profile
          || persisted.inventory_confidence !== resource.confidence
          || persisted.enforcement !== enforcement) {
          throw new Error(`Persisted resource ${id} differs from the supplied registry; audited migration is required`);
        }
      }
      for (const [table, expected] of [
        ["profiles", Object.keys(registry.profiles)],
        ["capacity_groups", Object.keys(registry.capacityGroups)],
        ["resources", Object.keys(registry.resources)],
      ]) {
        const actual = this.#db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);
        const wanted = [...expected].sort();
        if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
          throw new Error(`Persisted ${table} membership differs from the supplied registry; audited migration is required`);
        }
      }
  }

  #seed(registry) {
    this.#validateRegistry(registry);
    const existing = this.#db.prepare("SELECT count(*) AS count FROM resources").get().count;
    if (existing > 0 && this.#reconcileRegistryOnStart) {
      // A dynamic catalog is expected to change between process lifetimes. Reuse the same
      // add/drain/defer transition used by the live watcher; strict static brokers still refuse
      // any membership surprise below, so this cannot silently broaden a fixed registry.
      this.updateRegistry(registry, Date.now());
      return;
    }
    this.#transaction(() => this.#insertRegistry(registry));
  }

  /**
   * Transactional registry reload: validate the candidate, drain active leases
   * and tasks, atomically delete the old registry and insert the new one. If
   * the transaction fails, SQLite rollback preserves the previous registry.
   */
  reloadRegistry(newRegistry, now) {
    this.#assertNondecreasingTime(now);
    this.#validateRegistry(newRegistry);
    return this.#transaction(() => {
      const activeLeases = this.#db.prepare("SELECT count(*) AS count FROM leases WHERE expires_at > ?").get(now);
      if (activeLeases.count > 0) return { status: "denied", reason: "active_leases_exist", count: activeLeases.count };
      const activeTasks = this.#db.prepare("SELECT count(*) AS count FROM pending_tasks WHERE state IN ('waiting','ready','claimed','awaiting_result')").get();
      if (activeTasks.count > 0) return { status: "denied", reason: "active_tasks_exist", count: activeTasks.count };
      // Observed health is not registry data. A throttled account, a spent balance and a revoked
      // credential are facts about the world that a configuration reload does not repeal, so they
      // are carried across the replacement. Dropping them resurrects every dead account on every
      // reload, and the next task rediscovers them one wasted attempt at a time.
      const groupHealth = this.#db.prepare("SELECT id, cooldown_until, breaker_state FROM capacity_groups").all();
      const resourceHealth = this.#db.prepare("SELECT id, state, cooldown_until FROM resources").all();
      this.#db.prepare("DELETE FROM resources").run();
      this.#db.prepare("DELETE FROM capacity_groups").run();
      this.#db.prepare("DELETE FROM profiles").run();
      this.#insertRegistry(newRegistry);
      let carried = 0;
      for (const group of groupHealth) {
        if (!Object.hasOwn(newRegistry.capacityGroups, group.id)) continue;
        if (group.cooldown_until <= 0 && group.breaker_state === "healthy") continue;
        // probe_lease_id is deliberately not carried: reload requires zero active leases, so any
        // recorded probe is already gone and would otherwise block the half-open probe forever.
        this.#db.prepare("UPDATE capacity_groups SET cooldown_until = ?, breaker_state = ?, probe_lease_id = NULL WHERE id = ?")
          .run(group.cooldown_until, group.breaker_state, group.id);
        carried += 1;
      }
      for (const resource of resourceHealth) {
        if (!Object.hasOwn(newRegistry.resources, resource.id)) continue;
        if (resource.state === "healthy" && resource.cooldown_until <= 0) continue;
        this.#db.prepare("UPDATE resources SET state = ?, cooldown_until = ? WHERE id = ?")
          .run(resource.state, resource.cooldown_until, resource.id);
        carried += 1;
      }
      this.#record(now, "RegistryReloaded", {
        profiles: Object.keys(newRegistry.profiles).length,
        capacityGroups: Object.keys(newRegistry.capacityGroups).length,
        resources: Object.keys(newRegistry.resources).length,
        healthCarried: carried,
      });
      return { status: "reloaded", healthCarried: carried };
    });
  }

  /**
   * Incremental registry update that applies while work is in flight.
   *
   * `reloadRegistry` replaces the whole registry and therefore has to refuse whenever any
   * lease or task is active. Under continuous delegation that moment never arrives, so a
   * newly authenticated account would never become usable. This splits the update by blast
   * radius instead:
   *
   * - **Additions apply immediately.** A profile, capacity group or resource that did not
   *   exist cannot be referenced by anything in flight, so admitting it is safe at any time.
   * - **Withdrawals drain.** A resource that still carries a live lease is marked retiring:
   *   it stops taking new work at once and is deleted when its last lease ends. One with no
   *   live lease is deleted immediately.
   * - **Policy changes to a live capacity group are deferred**, not silently applied, because
   *   admission counters and fencing tokens are already accounted against the old policy.
   *
   * A withdrawn resource that reappears before it finished draining is simply un-retired,
   * which is what a provider recovering mid-drain looks like.
   */
  updateRegistry(candidate, now) {
    this.#assertNondecreasingTime(now);
    this.#validateRegistry(candidate);
    return this.#transaction(() => {
      const summary = { added: [], retired: [], removed: [], restored: [], deferred: [] };

      for (const [id, profile] of Object.entries(candidate.profiles)) {
        const capabilities = JSON.stringify(profile.supports);
        const persisted = this.#db.prepare("SELECT status, capabilities FROM profiles WHERE id = ?").get(id);
        if (!persisted) {
          this.#db.prepare("INSERT INTO profiles (id, status, capabilities) VALUES (?, ?, ?)").run(id, profile.status, capabilities);
          summary.added.push(`profile:${id}`);
        } else if (persisted.status !== profile.status || persisted.capabilities !== capabilities) {
          // A capability tier is an identity, not a mutable record: silently changing what a
          // profile means would retroactively alter every contract already pinned to it.
          summary.deferred.push(`profile:${id}`);
        }
      }

      for (const [id, group] of Object.entries(candidate.capacityGroups)) {
        const persisted = this.#db.prepare("SELECT max_concurrent, control_reserve, verify_reserve, inventory_confidence, default_cooldown_ms, probe_interval_ms FROM capacity_groups WHERE id = ?").get(id);
        if (!persisted) {
          this.#db.prepare(`
            INSERT INTO capacity_groups (id, max_concurrent, control_reserve, verify_reserve, inventory_confidence, default_cooldown_ms, probe_interval_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, group.maxConcurrent, group.admission.controlReserve, group.admission.verifyReserve, group.confidence, group.cooldown.defaultMs, group.cooldown.probeIntervalMs);
          summary.added.push(`capacityGroup:${id}`);
          continue;
        }
        const unchanged = persisted.max_concurrent === group.maxConcurrent
          && persisted.control_reserve === group.admission.controlReserve
          && persisted.verify_reserve === group.admission.verifyReserve
          && persisted.inventory_confidence === group.confidence
          && persisted.default_cooldown_ms === group.cooldown.defaultMs
          && persisted.probe_interval_ms === group.cooldown.probeIntervalMs;
        if (unchanged) continue;
        if (this.#groupHasLiveLease(id, now)) { summary.deferred.push(`capacityGroup:${id}`); continue; }
        this.#db.prepare(`
          UPDATE capacity_groups SET max_concurrent = ?, control_reserve = ?, verify_reserve = ?,
            inventory_confidence = ?, default_cooldown_ms = ?, probe_interval_ms = ?
          WHERE id = ?
        `).run(group.maxConcurrent, group.admission.controlReserve, group.admission.verifyReserve, group.confidence, group.cooldown.defaultMs, group.cooldown.probeIntervalMs, id);
        summary.added.push(`capacityGroup:${id}`);
      }

      for (const [id, resource] of Object.entries(candidate.resources)) {
        const enforcement = JSON.stringify(resource.enforcement);
        const persisted = this.#db.prepare("SELECT capacity_group, profile, inventory_confidence, enforcement, retiring FROM resources WHERE id = ?").get(id);
        if (!persisted) {
          this.#db.prepare(`
            INSERT INTO resources (id, capacity_group, profile, state, cooldown_until, inventory_confidence, enforcement, retiring)
            VALUES (?, ?, ?, 'healthy', 0, ?, ?, 0)
          `).run(id, resource.capacityGroup, resource.profile, resource.confidence, enforcement);
          summary.added.push(`resource:${id}`);
          continue;
        }
        if (persisted.retiring === 1) {
          this.#db.prepare("UPDATE resources SET retiring = 0 WHERE id = ?").run(id);
          summary.restored.push(id);
        }
        const sameShape = persisted.capacity_group === resource.capacityGroup
          && persisted.profile === resource.profile
          && persisted.inventory_confidence === resource.confidence
          && persisted.enforcement === enforcement;
        if (sameShape) continue;
        if (this.#resourceHasLiveLease(id, now)) { summary.deferred.push(`resource:${id}`); continue; }
        this.#db.prepare(`
          UPDATE resources SET capacity_group = ?, profile = ?, inventory_confidence = ?, enforcement = ? WHERE id = ?
        `).run(resource.capacityGroup, resource.profile, resource.confidence, enforcement, id);
        summary.added.push(`resource:${id}`);
      }

      for (const row of this.#db.prepare("SELECT id, retiring FROM resources ORDER BY id").all()) {
        if (Object.hasOwn(candidate.resources, row.id)) continue;
        if (this.#resourceHasLiveLease(row.id, now)) {
          if (row.retiring !== 1) {
            this.#db.prepare("UPDATE resources SET retiring = 1 WHERE id = ?").run(row.id);
            summary.retired.push(row.id);
          }
          continue;
        }
        if (this.#deleteResource(row.id)) summary.removed.push(row.id);
        else if (row.retiring !== 1) {
          this.#db.prepare("UPDATE resources SET retiring = 1 WHERE id = ?").run(row.id);
          summary.retired.push(row.id);
        }
      }

      this.#pruneUnreferencedRegistry(candidate, summary);

      const changed = summary.added.length + summary.retired.length + summary.removed.length + summary.restored.length;
      if (changed > 0) {
        this.#record(now, "RegistryUpdated", {
          added: summary.added.length,
          retired: summary.retired.length,
          removed: summary.removed.length,
          restored: summary.restored.length,
          deferred: summary.deferred.length,
        });
      }
      return Object.freeze({
        status: "updated",
        added: Object.freeze([...summary.added]),
        retired: Object.freeze([...summary.retired]),
        removed: Object.freeze([...summary.removed]),
        restored: Object.freeze([...summary.restored]),
        deferred: Object.freeze([...summary.deferred]),
      });
    });
  }

  #groupHasLiveLease(capacityGroup, now) {
    return this.#db.prepare("SELECT 1 FROM leases WHERE capacity_group = ? AND expires_at > ? LIMIT 1").get(capacityGroup, now) !== undefined;
  }

  #resourceHasLiveLease(resourceId, now) {
    return this.#db.prepare("SELECT 1 FROM leases WHERE resource_id = ? AND expires_at > ? LIMIT 1").get(resourceId, now) !== undefined;
  }

  /**
   * Delete a resource only when nothing references it. An expired-but-not-yet-swept lease row
   * still holds a foreign key, so report failure and let the caller retire it instead.
   */
  #deleteResource(resourceId) {
    if (this.#db.prepare("SELECT 1 FROM leases WHERE resource_id = ? LIMIT 1").get(resourceId) !== undefined) return false;
    this.#db.prepare("DELETE FROM resources WHERE id = ?").run(resourceId);
    return true;
  }

  /** A retiring resource disappears for real once its last lease row is gone. */
  #sweepRetiredResources(now) {
    const retiring = this.#db.prepare("SELECT id FROM resources WHERE retiring = 1").all();
    if (retiring.length === 0) return;
    const dropped = [];
    for (const row of retiring) if (this.#deleteResource(row.id)) dropped.push(row.id);
    if (dropped.length > 0) this.#record(now, "RetiredResourcesRemoved", { resources: dropped });
  }

  /** Capacity groups and profiles outlive their last resource only until nothing points at them. */
  #pruneUnreferencedRegistry(candidate, summary) {
    for (const row of this.#db.prepare("SELECT id FROM capacity_groups ORDER BY id").all()) {
      if (Object.hasOwn(candidate.capacityGroups, row.id)) continue;
      if (this.#db.prepare("SELECT 1 FROM resources WHERE capacity_group = ? LIMIT 1").get(row.id) !== undefined) continue;
      if (this.#db.prepare("SELECT 1 FROM leases WHERE capacity_group = ? LIMIT 1").get(row.id) !== undefined) continue;
      this.#db.prepare("DELETE FROM capacity_groups WHERE id = ?").run(row.id);
      summary.removed.push(`capacityGroup:${row.id}`);
    }
    for (const row of this.#db.prepare("SELECT id FROM profiles ORDER BY id").all()) {
      if (Object.hasOwn(candidate.profiles, row.id)) continue;
      if (this.#db.prepare("SELECT 1 FROM resources WHERE profile = ? LIMIT 1").get(row.id) !== undefined) continue;
      this.#db.prepare("DELETE FROM profiles WHERE id = ?").run(row.id);
      summary.removed.push(`profile:${row.id}`);
    }
  }

  #transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  #expire(now) {
    this.#assertNondecreasingTime(now);
    const rows = this.#db.prepare("SELECT * FROM leases WHERE expires_at <= ?").all(now);
    if (rows.length) {
      this.#db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);
      for (const row of rows) {
        this.#afterLeaseRemoved(row, now);
        this.#db.prepare(`
          UPDATE pending_tasks SET state = 'waiting', eligible_at = ?, updated_at = ?, lease_id = NULL
          WHERE lease_id = ? AND state = 'ready' AND deadline_at > ?
        `).run(now, now, row.lease_id, now);
        this.#db.prepare(`
          UPDATE pending_tasks SET state = 'escalated', eligible_at = NULL, updated_at = ?, lease_id = NULL
          WHERE lease_id = ? AND state = 'ready' AND deadline_at <= ?
        `).run(now, row.lease_id, now);
        const claimed = this.#db.prepare("SELECT task_id, recovery_owner FROM pending_tasks WHERE lease_id = ? AND state = 'claimed'").get(row.lease_id);
        if (claimed) {
          this.#db.prepare(`
            UPDATE pending_tasks SET state = 'escalated', eligible_at = NULL, updated_at = ?, lease_id = NULL
            WHERE task_id = ? AND state = 'claimed'
          `).run(now, claimed.task_id);
          this.#record(now, "TaskEscalated", { taskId: claimed.task_id, recoveryOwner: claimed.recovery_owner, reason: "claimed_lease_expired" });
        }
        this.#record(now, "LeaseExpired", { leaseId: row.lease_id, fencingToken: row.fencing_token });
      }
    }
    return rows.map((row) => row.lease_id);
  }

  #assertNondecreasingTime(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("broker time must be a non-negative safe integer");
    const floor = this.#db.prepare("SELECT at FROM events ORDER BY sequence DESC LIMIT 1").get()?.at;
    if (floor !== undefined && now < floor) throw new Error("clock_regression_detected");
  }

  #afterLeaseRemoved(lease, now) {
    this.#db.prepare(`
      UPDATE pending_tasks SET eligible_at = MIN(eligible_at, ?), updated_at = ?
      WHERE state = 'waiting' AND eligible_at IS NOT NULL
    `).run(now, now);
    this.#sweepRetiredResources(now);
    if (lease.is_probe !== 1) return;
    this.#db.prepare(`
      UPDATE capacity_groups
      SET probe_lease_id = NULL,
          cooldown_until = CASE
            WHEN breaker_state = 'cooling_down' THEN MAX(cooldown_until, ? + probe_interval_ms)
            ELSE cooldown_until
          END
      WHERE id = ? AND probe_lease_id = ?
    `).run(now, lease.capacity_group, lease.lease_id);
  }

  #reserveCore(contract, now) {
    if (EFFECT_CAPABLE_OPERATIONS.has(contract?.operationClass) && this.#behavioralEnforcement !== "blocking_monitor") {
      const result = {
        status: "denied_policy",
        reasonCode: "behavioral_enforcement_unavailable",
        reasons: ["effect-capable contract requires a wired blocking behavioral monitor"],
      };
      this.#record(now, "ReservationDenied", { taskId: contract?.taskId, ...result });
      return result;
    }
    const policyError = this.#validateContract(contract);
    if (policyError) {
      this.#record(now, "ReservationDenied", { taskId: contract?.taskId, status: "denied_policy", reason: policyError });
      return { status: "denied_policy", reasons: [policyError] };
    }

    const requestedProfile = this.#profile(contract.capability.minimumProfile);
    let rows = this.#db.prepare(`
      SELECT
        r.id, r.capacity_group, r.profile, r.state, r.enforcement,
        r.inventory_confidence AS resource_confidence,
        g.max_concurrent, g.control_reserve, g.verify_reserve,
        g.inventory_confidence AS group_confidence,
        g.cooldown_until, g.breaker_state, g.probe_lease_id, g.probe_interval_ms
      FROM resources r JOIN capacity_groups g ON g.id = r.capacity_group
      WHERE r.retiring = 0
      ORDER BY r.id
    `).all();
    rows = this.#rankResources(rows, contract, now);
    let earliestCompatibleAt;
    let assumedInventoryBlocked = false;
    for (const resource of rows) {
      if (!this.#resourceMatchesContract(resource, requestedProfile, contract)) continue;
      if (this.#requiresHardBudget(contract)
        && (resource.group_confidence === "assumed" || resource.resource_confidence === "assumed")) {
        assumedInventoryBlocked = true;
        continue;
      }
      if (resource.state !== "healthy") continue;

      let probe = false;
      if (resource.breaker_state === "cooling_down") {
        if (resource.cooldown_until > now) {
          earliestCompatibleAt = this.#earliest(earliestCompatibleAt, resource.cooldown_until);
          continue;
        }
        if (resource.probe_lease_id) {
          const activeProbe = this.#db.prepare("SELECT expires_at FROM leases WHERE lease_id = ? AND expires_at > ?")
            .get(resource.probe_lease_id, now);
          earliestCompatibleAt = this.#earliest(earliestCompatibleAt, activeProbe?.expires_at ?? now + resource.probe_interval_ms);
          continue;
        }
        probe = true;
      }

      const counts = { control: 0, verify: 0, work: 0, total: 0 };
      for (const row of this.#db.prepare(`
        SELECT admission_class, count(*) AS count
        FROM leases WHERE capacity_group = ? AND expires_at > ?
        GROUP BY admission_class
      `).all(resource.capacity_group, now)) {
        counts[row.admission_class] = row.count;
        counts.total += row.count;
      }
      if (!this.#admissionHasCapacity(resource, contract.admissionClass, counts)) {
        const recovery = this.#db.prepare("SELECT MIN(expires_at) AS at FROM leases WHERE capacity_group = ? AND expires_at > ?")
          .get(resource.capacity_group, now).at;
        if (recovery !== null && recovery !== undefined) earliestCompatibleAt = this.#earliest(earliestCompatibleAt, recovery);
        continue;
      }

      const fenceRow = this.#db.prepare("UPDATE capacity_groups SET fencing_token = fencing_token + 1 WHERE id = ? RETURNING fencing_token")
        .get(resource.capacity_group);
      const lease = {
        leaseId: randomUUID(),
        taskId: contract.taskId,
        resourceId: resource.id,
        capacityGroup: resource.capacity_group,
        profile: resource.profile,
        fencingToken: fenceRow.fencing_token,
        issuedAt: now,
        expiresAt: now + (contract.leaseTtlMs ?? 30_000),
        enforcement: parseJson(resource.enforcement),
        admissionClass: contract.admissionClass,
        behavioralEnforcement: this.#behavioralEnforcement,
        probe,
        ...(Number.isInteger(contract.budget?.maxInputTokens) ? { maxInputTokens: contract.budget.maxInputTokens } : {}),
        ...(Number.isInteger(contract.budget?.maxOutputTokens) ? { maxOutputTokens: contract.budget.maxOutputTokens } : {}),
      };
      this.#db.prepare(`
        INSERT INTO leases (
          lease_id, task_id, resource_id, capacity_group, profile, fencing_token,
          issued_at, expires_at, enforcement, max_input_tokens, max_output_tokens, max_cost_micros, admission_class, behavioral_enforcement, is_probe
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId, lease.taskId, lease.resourceId, lease.capacityGroup, lease.profile,
        lease.fencingToken, lease.issuedAt, lease.expiresAt, JSON.stringify(lease.enforcement),
        // `max_cost_micros` remains in older SQLite files for migration compatibility but is
        // intentionally always NULL: spend is not a broker policy or metric.
        lease.maxInputTokens ?? null, lease.maxOutputTokens ?? null, null,
        lease.admissionClass, lease.behavioralEnforcement, lease.probe ? 1 : 0,
      );
      if (probe) this.#db.prepare("UPDATE capacity_groups SET probe_lease_id = ? WHERE id = ?").run(lease.leaseId, lease.capacityGroup);
      this.#record(now, "LeaseIssued", lease);
      return { status: "leased", lease };
    }

    if (assumedInventoryBlocked) {
      const result = { status: "denied_policy", reasons: ["hard budget enforcement cannot rely on assumed inventory"] };
      this.#record(now, "ReservationDenied", { taskId: contract.taskId, ...result });
      return result;
    }
    const result = { status: "denied_capacity", ...(earliestCompatibleAt === undefined ? {} : { earliestCompatibleAt }) };
    this.#record(now, "ReservationDenied", { taskId: contract.taskId, ...result });
    return result;
  }

  #rankResources(rows, contract, now) {
    if (!this.#resourceRanker || rows.length < 2) return rows;
    const resourceIds = Object.freeze(rows.map((row) => row.id));
    const rankerContract = Object.freeze({ capability: Object.freeze({ required: Object.freeze([...contract.capability.required]) }) });
    const ranking = this.#resourceRanker(Object.freeze({ contract: rankerContract, resourceIds, now }));
    if (!Array.isArray(ranking) || ranking.length !== resourceIds.length
      || ranking.some((resourceId) => typeof resourceId !== "string")
      || new Set(ranking).size !== resourceIds.length
      || ranking.some((resourceId) => !resourceIds.includes(resourceId))) {
      throw new Error("resourceRanker must return an exact resource candidate permutation");
    }
    const order = new Map(ranking.map((resourceId, index) => [resourceId, index]));
    return [...rows].sort((left, right) => order.get(left.id) - order.get(right.id));
  }

  #admissionHasCapacity(group, admissionClass, counts) {
    if (counts.total >= group.max_concurrent) return false;
    if (admissionClass === "control") return true;
    if (admissionClass === "verify") {
      return counts.verify + counts.work < group.max_concurrent - group.control_reserve;
    }
    return counts.work < group.max_concurrent - group.control_reserve - group.verify_reserve;
  }

  #requiresHardBudget(contract) {
    return Object.values(contract.budget?.enforcement ?? {}).includes("hard");
  }

  #earliest(current, candidate) {
    return current === undefined ? candidate : Math.min(current, candidate);
  }

  #validateContract(contract) {
    if (!IDENTIFIER.test(contract?.taskId ?? "") || !contract?.capability?.minimumProfile || !Array.isArray(contract.capability.required)) return "invalid contract";
    if (!ADMISSION_CLASSES.has(contract.admissionClass)) return "contract requires admissionClass control, verify, or work";
    if (!SHA256.test(contract.promptDigest ?? "")) return "contract requires the exact child promptDigest";
    if (!Array.isArray(contract.doneWhen) || contract.doneWhen.length < 1 || contract.doneWhen.length > 20
      || contract.doneWhen.some((criterion) => typeof criterion !== "string" || criterion.length < 1 || criterion.length > 500 || /[\0\r\n]/.test(criterion))) {
      return "contract requires 1-20 bounded child-facing doneWhen criteria";
    }
    if (!Number.isSafeInteger(contract.latencyBudgetMs) || contract.latencyBudgetMs < 1) return "contract requires a positive latencyBudgetMs";
    if (contract.leaseTtlMs !== undefined && (!Number.isSafeInteger(contract.leaseTtlMs) || contract.leaseTtlMs < 1)) return "leaseTtlMs must be a positive safe integer";
    if (contract.capability.downgradePolicy !== "forbid") return "only forbid downgrade policy is implemented in broker MVP";
    const allowedResources = contract.capability.allowedResources;
    if (allowedResources !== undefined) {
      if (!Array.isArray(allowedResources) || allowedResources.length < 1 || allowedResources.length > 5_000
        || allowedResources.some((id) => typeof id !== "string" || !RESOURCE_ID.test(id))
        || new Set(allowedResources).size !== allowedResources.length) {
        return "capability allowedResources must be 1..5000 unique resource identifiers";
      }
    }
    if (!this.#profile(contract.capability.minimumProfile)) return "unknown or unapproved minimum profile";
    const requirements = contract.budget?.enforcement ?? {};
    if (Object.values(requirements).some((value) => !Object.hasOwn(ENFORCEMENT, value))) return "unknown budget enforcement class";
    if (Object.hasOwn(contract.budget ?? {}, "maxCostMicros") || Object.hasOwn(requirements, "cost")) {
      return "money budgets are not supported; use token caps and verified efficiency observations";
    }
    const hardCaps = {
      input: contract.budget?.maxInputTokens,
      output: contract.budget?.maxOutputTokens,
    };
    for (const [dimension, enforcement] of Object.entries(requirements)) {
      if (enforcement === "hard" && (!Number.isSafeInteger(hardCaps[dimension]) || hardCaps[dimension] <= 0)) {
        return `hard ${dimension} enforcement requires a positive declared cap`;
      }
    }
    if (contract.operationClass === "apply" || contract.operationClass === "external_write") {
      if (["input", "output"].some((dimension) => requirements[dimension] !== "hard")) {
        return "high-risk task requires hard token budget enforcement for input and output";
      }
    }
    return undefined;
  }

  #profile(id) {
    const profile = this.#db.prepare("SELECT id, status, capabilities FROM profiles WHERE id = ?").get(id);
    return !profile || profile.status !== "approved" ? undefined : { id: profile.id, capabilities: parseJson(profile.capabilities) };
  }

  #resourceMatchesContract(resource, requestedProfile, contract) {
    if (!requestedProfile || resource.profile !== requestedProfile.id) return false;
    // A controller-vetted allow-list is binding: capability class alone would let the broker
    // lease a resource the selector excluded as legacy or below its quality floor.
    const allowedResources = contract.capability.allowedResources;
    if (Array.isArray(allowedResources) && !allowedResources.includes(resource.id)) return false;
    if (!contract.capability.required.every((capability) => requestedProfile.capabilities.includes(capability))) return false;
    const enforcement = parseJson(resource.enforcement);
    return Object.entries(contract.budget?.enforcement ?? {}).every(([dimension, required]) => enforcementSatisfies(enforcement[dimension], required));
  }

  #record(at, type, payload) {
    this.#assertNondecreasingTime(at);
    this.#db.prepare("INSERT INTO events (at, type, payload) VALUES (?, ?, ?)").run(at, type, JSON.stringify(redact(payload)));
  }
}

export function fixtureRegistry() {
  return {
    profiles: {
      "reasoning-high/v1": { status: "approved", supports: ["code_reasoning", "repo_navigation"] },
      "audit-low/v1": { status: "approved", supports: ["read_only_audit"] },
    },
    capacityGroups: {
      "G-shared": {
        maxConcurrent: 1,
        admission: { controlReserve: 1, verifyReserve: 0 },
        cooldown: { defaultMs: 21_600_000, probeIntervalMs: 300_000 },
        confidence: "observed",
      },
      "G-independent": {
        maxConcurrent: 1,
        admission: { controlReserve: 1, verifyReserve: 0 },
        cooldown: { defaultMs: 21_600_000, probeIntervalMs: 300_000 },
        confidence: "observed",
      },
      "G-cheap": {
        maxConcurrent: 4,
        admission: { controlReserve: 1, verifyReserve: 1 },
        cooldown: { defaultMs: 60_000, probeIntervalMs: 10_000 },
        confidence: "measured",
      },
    },
    resources: {
      R1: { capacityGroup: "G-shared", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard" } },
      R1_ALIAS: { capacityGroup: "G-shared", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard" } },
      R2: { capacityGroup: "G-independent", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard" } },
      R3: { capacityGroup: "G-cheap", profile: "audit-low/v1", confidence: "measured", enforcement: { input: "unavailable", output: "unavailable" } },
    },
  };
}

export function fixtureContract(overrides = {}) {
  return {
    taskId: "task-1",
    admissionClass: "control",
    operationClass: "observe",
    promptDigest: "a".repeat(64),
    doneWhen: ["Return the requested repository finding with controller-verifiable evidence references"],
    latencyBudgetMs: 120_000,
    capability: { minimumProfile: "reasoning-high/v1", required: ["code_reasoning", "repo_navigation"], downgradePolicy: "forbid" },
    budget: { maxInputTokens: 1_000, maxOutputTokens: 100, enforcement: { input: "hard", output: "hard" } },
    leaseTtlMs: 30_000,
    recovery: { owner: "controller", deadlineAt: 4_000_000_000_000 },
    ...overrides,
  };
}
