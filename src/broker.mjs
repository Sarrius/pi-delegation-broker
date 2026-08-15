import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ENFORCEMENT = Object.freeze({ hard: 2, metered_best_effort: 1, unavailable: 0 });
const ADMISSION_CLASSES = new Set(["control", "verify", "work"]);
const INVENTORY_CONFIDENCE = new Set(["measured", "observed", "assumed"]);
const PENDING_STATES = new Set(["waiting", "ready", "claimed", "awaiting_result", "escalated", "completed", "failed"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
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
    probe: row.is_probe === 1,
    ...(row.max_input_tokens === null || row.max_input_tokens === undefined ? {} : { maxInputTokens: row.max_input_tokens }),
    ...(row.max_output_tokens === null || row.max_output_tokens === undefined ? {} : { maxOutputTokens: row.max_output_tokens }),
    ...(row.max_cost_micros === null || row.max_cost_micros === undefined ? {} : { maxCostMicros: row.max_cost_micros }),
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

  constructor({ path, registry, maxPendingTasks = 1_000, agingStepMs = 30_000 }) {
    if (!path) throw new Error("SQLite broker needs a database path");
    if (!Number.isSafeInteger(maxPendingTasks) || maxPendingTasks < 1 || maxPendingTasks > 100_000) {
      throw new Error("maxPendingTasks must be an integer between 1 and 100000");
    }
    if (!Number.isSafeInteger(agingStepMs) || agingStepMs < 1 || agingStepMs > 86_400_000) {
      throw new Error("agingStepMs must be an integer between 1 and 86400000");
    }
    this.#maxPendingTasks = maxPendingTasks;
    this.#agingStepMs = agingStepMs;
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

      const queued = this.#db.prepare(`
        SELECT * FROM pending_tasks
        WHERE state = 'waiting' AND eligible_at IS NOT NULL AND eligible_at <= ? AND deadline_at > ?
        ORDER BY (
          CASE admission_class WHEN 'control' THEN 0 WHEN 'verify' THEN 1 ELSE 2 END
          - CAST((? - created_at) / ? AS INTEGER)
        ), created_at, task_id
        LIMIT ?
      `).all(now, now, now, this.#agingStepMs, limit);
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

  finalizeClaimedTask(taskId, leaseId, fencingToken, terminalState, now) {
    if (terminalState !== "completed" && terminalState !== "failed") return { status: "denied_policy" };
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT 1 FROM pending_tasks WHERE task_id = ? AND lease_id = ? AND state IN ('claimed', 'awaiting_result')")
        .get(taskId, leaseId);
      if (!pending) return { status: "denied_policy" };
      const lease = this.#db.prepare("SELECT * FROM leases WHERE lease_id = ? AND fencing_token = ?").get(leaseId, fencingToken);
      if (lease) {
        this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
        this.#afterLeaseRemoved(lease, now);
      }
      this.#db.prepare("UPDATE pending_tasks SET state = ?, eligible_at = NULL, updated_at = ?, lease_id = NULL WHERE task_id = ? AND state IN ('claimed', 'awaiting_result')")
        .run(terminalState, now, taskId);
      this.#record(now, "TaskTerminal", { taskId, status: terminalState, source: "claimed_child_result" });
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

  /** Validate a child-scoped IPC capability without exposing controller authority. */
  leaseForCapability(capability, now) {
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

  markUnknown(resourceId, now, reason = "unknown") {
    return this.#transaction(() => {
      const update = this.#db.prepare("UPDATE resources SET state = 'unknown' WHERE id = ?").run(resourceId);
      if (update.changes !== 1) throw new Error(`Unknown resource ${resourceId}`);
      this.#record(now, "ResourceUnknown", { resourceId, reason });
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
        enforcement TEXT NOT NULL
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
        is_probe INTEGER NOT NULL DEFAULT 0 CHECK (is_probe IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS leases_by_group_expiry ON leases(capacity_group, expires_at);
      CREATE TABLE IF NOT EXISTS lease_capabilities (
        capability_hash TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE REFERENCES leases(lease_id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
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
  }

  #seed(registry) {
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
    this.#transaction(() => {
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
    });
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

  #afterLeaseRemoved(lease, now) {
    this.#db.prepare(`
      UPDATE pending_tasks SET eligible_at = MIN(eligible_at, ?), updated_at = ?
      WHERE state = 'waiting' AND eligible_at IS NOT NULL
    `).run(now, now);
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
    const policyError = this.#validateContract(contract);
    if (policyError) {
      this.#record(now, "ReservationDenied", { taskId: contract?.taskId, status: "denied_policy", reason: policyError });
      return { status: "denied_policy", reasons: [policyError] };
    }

    const requestedProfile = this.#profile(contract.capability.minimumProfile);
    const rows = this.#db.prepare(`
      SELECT
        r.id, r.capacity_group, r.profile, r.state, r.enforcement,
        r.inventory_confidence AS resource_confidence,
        g.max_concurrent, g.control_reserve, g.verify_reserve,
        g.inventory_confidence AS group_confidence,
        g.cooldown_until, g.breaker_state, g.probe_lease_id, g.probe_interval_ms
      FROM resources r JOIN capacity_groups g ON g.id = r.capacity_group
      ORDER BY r.id
    `).all();
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
        probe,
        ...(Number.isInteger(contract.budget?.maxInputTokens) ? { maxInputTokens: contract.budget.maxInputTokens } : {}),
        ...(Number.isInteger(contract.budget?.maxOutputTokens) ? { maxOutputTokens: contract.budget.maxOutputTokens } : {}),
        ...(Number.isInteger(contract.budget?.maxCostMicros) ? { maxCostMicros: contract.budget.maxCostMicros } : {}),
      };
      this.#db.prepare(`
        INSERT INTO leases (
          lease_id, task_id, resource_id, capacity_group, profile, fencing_token,
          issued_at, expires_at, enforcement, max_input_tokens, max_output_tokens, max_cost_micros, admission_class, is_probe
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId, lease.taskId, lease.resourceId, lease.capacityGroup, lease.profile,
        lease.fencingToken, lease.issuedAt, lease.expiresAt, JSON.stringify(lease.enforcement),
        lease.maxInputTokens ?? null, lease.maxOutputTokens ?? null, lease.maxCostMicros ?? null,
        lease.admissionClass, lease.probe ? 1 : 0,
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
    if (!this.#profile(contract.capability.minimumProfile)) return "unknown or unapproved minimum profile";
    const requirements = contract.budget?.enforcement ?? {};
    if (Object.values(requirements).some((value) => !Object.hasOwn(ENFORCEMENT, value))) return "unknown budget enforcement class";
    const hardCaps = {
      input: contract.budget?.maxInputTokens,
      output: contract.budget?.maxOutputTokens,
      cost: contract.budget?.maxCostMicros,
    };
    for (const [dimension, enforcement] of Object.entries(requirements)) {
      if (enforcement === "hard" && (!Number.isSafeInteger(hardCaps[dimension]) || hardCaps[dimension] <= 0)) {
        return `hard ${dimension} enforcement requires a positive declared cap`;
      }
    }
    if (contract.operationClass === "apply" || contract.operationClass === "external_write") {
      if (["input", "output", "cost"].some((dimension) => requirements[dimension] !== "hard")) {
        return "high-risk task requires hard budget enforcement for input, output, and cost";
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
    if (!contract.capability.required.every((capability) => requestedProfile.capabilities.includes(capability))) return false;
    const enforcement = parseJson(resource.enforcement);
    return Object.entries(contract.budget?.enforcement ?? {}).every(([dimension, required]) => enforcementSatisfies(enforcement[dimension], required));
  }

  #record(at, type, payload) {
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
      R1: { capacityGroup: "G-shared", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R1_ALIAS: { capacityGroup: "G-shared", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R2: { capacityGroup: "G-independent", profile: "reasoning-high/v1", confidence: "observed", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R3: { capacityGroup: "G-cheap", profile: "audit-low/v1", confidence: "measured", enforcement: { input: "unavailable", output: "unavailable", cost: "unavailable" } },
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
    budget: { maxInputTokens: 1_000, maxOutputTokens: 100, enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
    leaseTtlMs: 30_000,
    recovery: { owner: "controller", deadlineAt: 4_000_000_000_000 },
    ...overrides,
  };
}
