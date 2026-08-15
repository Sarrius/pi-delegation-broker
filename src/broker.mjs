import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ENFORCEMENT = Object.freeze({ hard: 2, metered_best_effort: 1, unavailable: 0 });
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

  constructor({ path, registry }) {
    if (!path) throw new Error("SQLite broker needs a database path");
    this.#db = new DatabaseSync(path);
    // Configure the connection wait before contending for the database-wide
    // journal-mode lock during independent-process startup.
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.#seed(registry);
  }

  close() { this.#db.close(); }

  reserve(contract, now) {
    return this.#transaction(() => {
      this.#expire(now);
      const policyError = this.#validateContract(contract);
      if (policyError) {
        this.#record(now, "ReservationDenied", { taskId: contract?.taskId, status: "denied_policy", reason: policyError });
        return { status: "denied_policy", reasons: [policyError] };
      }

      const requestedProfile = this.#profile(contract.capability.minimumProfile);
      const rows = this.#db.prepare(`
        SELECT r.id, r.capacity_group, r.profile, r.state, r.cooldown_until, r.enforcement, g.max_concurrent
        FROM resources r JOIN capacity_groups g ON g.id = r.capacity_group
        ORDER BY r.id
      `).all();
      let earliestCompatibleAt;
      for (const resource of rows) {
        if (resource.state !== "healthy") continue;
        if (resource.cooldown_until > now) {
          if (this.#resourceMatchesContract(resource, requestedProfile, contract)) {
            earliestCompatibleAt = earliestCompatibleAt === undefined ? resource.cooldown_until : Math.min(earliestCompatibleAt, resource.cooldown_until);
          }
          continue;
        }
        if (!this.#resourceMatchesContract(resource, requestedProfile, contract)) continue;
        const active = this.#db.prepare("SELECT count(*) AS count FROM leases WHERE capacity_group = ? AND expires_at > ?")
          .get(resource.capacity_group, now).count;
        if (active >= resource.max_concurrent) continue;

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
          ...(Number.isInteger(contract.budget?.maxOutputTokens) ? { maxOutputTokens: contract.budget.maxOutputTokens } : {}),
        };
        this.#db.prepare(`
          INSERT INTO leases (lease_id, task_id, resource_id, capacity_group, profile, fencing_token, issued_at, expires_at, enforcement, max_output_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lease.leaseId, lease.taskId, lease.resourceId, lease.capacityGroup, lease.profile,
          lease.fencingToken, lease.issuedAt, lease.expiresAt, JSON.stringify(lease.enforcement), lease.maxOutputTokens ?? null,
        );
        this.#record(now, "LeaseIssued", lease);
        return { status: "leased", lease };
      }
      const result = { status: "denied_capacity", ...(earliestCompatibleAt === undefined ? {} : { earliestCompatibleAt }) };
      this.#record(now, "ReservationDenied", { taskId: contract.taskId, ...result });
      return result;
    });
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
      const deleted = this.#db.prepare("DELETE FROM leases WHERE lease_id = ? AND fencing_token = ?").run(leaseId, fencingToken);
      if (deleted.changes !== 1) return { status: "denied_lease" };
      this.#record(now, "LeaseReleased", { leaseId, fencingToken, reason });
      return { status: "released" };
    });
  }

  expire(now) {
    return this.#transaction(() => this.#expire(now));
  }

  markRateLimited(resourceId, retryAfterMs, now) {
    return this.#transaction(() => {
      const resource = this.#db.prepare("SELECT capacity_group FROM resources WHERE id = ?").get(resourceId);
      if (!resource) throw new Error(`Unknown resource ${resourceId}`);
      const until = now + Math.max(1, Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000);
      this.#db.prepare("UPDATE resources SET cooldown_until = MAX(cooldown_until, ?) WHERE capacity_group = ?")
        .run(until, resource.capacity_group);
      this.#record(now, "CapacityGroupCooldown", { resourceId, capacityGroup: resource.capacity_group, until });
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

  markHealthy(resourceId, now) {
    return this.#transaction(() => {
      const update = this.#db.prepare("UPDATE resources SET state = 'healthy' WHERE id = ?").run(resourceId);
      if (update.changes !== 1) throw new Error(`Unknown resource ${resourceId}`);
      this.#record(now, "ResourceHealthy", { resourceId });
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
        fencing_token INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        capacity_group TEXT NOT NULL REFERENCES capacity_groups(id),
        profile TEXT NOT NULL REFERENCES profiles(id),
        state TEXT NOT NULL CHECK (state IN ('healthy', 'unknown')) DEFAULT 'healthy',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
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
        max_output_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS leases_by_group_expiry ON leases(capacity_group, expires_at);
      CREATE TABLE IF NOT EXISTS lease_capabilities (
        capability_hash TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE REFERENCES leases(lease_id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
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
    const columns = this.#db.prepare("PRAGMA table_info(leases)").all().map((column) => column.name);
    if (!columns.includes("max_output_tokens")) this.#db.exec("ALTER TABLE leases ADD COLUMN max_output_tokens INTEGER");
  }

  #seed(registry) {
    if (!registry?.profiles || !registry?.capacityGroups || !registry?.resources) throw new Error("Broker registry needs profiles, capacityGroups, and resources");
    this.#transaction(() => {
      for (const [id, profile] of Object.entries(registry.profiles)) {
        this.#db.prepare("INSERT OR IGNORE INTO profiles (id, status, capabilities) VALUES (?, ?, ?)")
          .run(id, profile.status, JSON.stringify(profile.supports));
      }
      for (const [id, group] of Object.entries(registry.capacityGroups)) {
        this.#db.prepare("INSERT OR IGNORE INTO capacity_groups (id, max_concurrent) VALUES (?, ?)").run(id, group.maxConcurrent);
      }
      for (const [id, resource] of Object.entries(registry.resources)) {
        this.#db.prepare(`
          INSERT OR IGNORE INTO resources (id, capacity_group, profile, state, cooldown_until, enforcement)
          VALUES (?, ?, ?, 'healthy', 0, ?)
        `).run(id, resource.capacityGroup, resource.profile, JSON.stringify(resource.enforcement));
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
    const rows = this.#db.prepare("SELECT lease_id, fencing_token FROM leases WHERE expires_at <= ?").all(now);
    if (rows.length) {
      this.#db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);
      for (const row of rows) this.#record(now, "LeaseExpired", { leaseId: row.lease_id, fencingToken: row.fencing_token });
    }
    return rows.map((row) => row.lease_id);
  }

  #validateContract(contract) {
    if (!contract?.taskId || !contract?.capability?.minimumProfile || !Array.isArray(contract.capability.required)) return "invalid contract";
    if (contract.capability.downgradePolicy !== "forbid") return "only forbid downgrade policy is implemented in broker MVP";
    if (!this.#profile(contract.capability.minimumProfile)) return "unknown or unapproved minimum profile";
    const requirements = contract.budget?.enforcement ?? {};
    if (Object.values(requirements).some((value) => !Object.hasOwn(ENFORCEMENT, value))) return "unknown budget enforcement class";
    if ((contract.operationClass === "apply" || contract.operationClass === "external_write")
      && Object.values(requirements).some((value) => value !== "hard")) {
      return "high-risk task requires hard budget enforcement for every declared dimension";
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
      "G-shared": { maxConcurrent: 1 },
      "G-independent": { maxConcurrent: 1 },
      "G-cheap": { maxConcurrent: 4 },
    },
    resources: {
      R1: { capacityGroup: "G-shared", profile: "reasoning-high/v1", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R1_ALIAS: { capacityGroup: "G-shared", profile: "reasoning-high/v1", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R2: { capacityGroup: "G-independent", profile: "reasoning-high/v1", enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
      R3: { capacityGroup: "G-cheap", profile: "audit-low/v1", enforcement: { input: "unavailable", output: "unavailable", cost: "unavailable" } },
    },
  };
}

export function fixtureContract(overrides = {}) {
  return {
    taskId: "task-1",
    operationClass: "observe",
    capability: { minimumProfile: "reasoning-high/v1", required: ["code_reasoning", "repo_navigation"], downgradePolicy: "forbid" },
    budget: { maxOutputTokens: 100, enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
    leaseTtlMs: 30_000,
    ...overrides,
  };
}
