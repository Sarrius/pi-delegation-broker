import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { SqliteLeaseBroker } from "./broker.mjs";
import { BrokerIpcServer } from "./ipc.mjs";
import { verifySignedRegistry } from "./signed-registry.mjs";
import { DynamicProviderWatcher } from "./dynamic-provider-watcher.mjs";

const SOCKET_NAME = "broker.sock";
const DATABASE_NAME = "broker.sqlite";
const LOCK_NAME = "broker.lock";
// macOS permits roughly 104 bytes for a Unix-domain socket path; stay below
// the narrower common limit so startup fails clearly instead of listen(EINVAL).
const MAX_SOCKET_PATH_BYTES = 100;

function requireOwnerOnlyDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Broker stateDir must be an absolute path");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error("Broker stateDir must not be a symbolic link");
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Broker stateDir must be an owner-only directory: ${canonical}`);
  }
  return canonical;
}

function rejectUnsafeExistingFile(path, label) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Broker ${label} must be a regular non-symlink file: ${path}`);
}

function hardenFile(path) {
  if (existsSync(path)) chmodSync(path, 0o600);
}

function validateControllerToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /[\0\r\n]/.test(token)) {
    throw new Error("Broker controller token must be a bounded non-empty secret of at least 32 characters");
  }
  return token;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

/**
 * Lifecycle owner for the current single-host fake broker MVP.
 *
 * It establishes one fail-closed owner-only state directory, a durable SQLite
 * ledger, a private Unix socket, periodic lease expiry and a bounded shutdown.
 * It intentionally is not a detached production daemon: the controller keeps
 * the object and its bootstrap token in-process. A provider transport may be
 * injected only as an already-approved controller-owned route pair; it never
 * reads credentials or ambient authentication itself.
 */
export class SingleHostBrokerSupervisor {
  #stateDir;
  #registry;
  #registryStatus;
  #controllerToken;
  #fakeProvider;
  #providerTransport;
  #routeResolver;
  #verificationReceiptVerifier;
  #resourceRanker;
  #dynamicProviders;
  #providerWatcher;
  #sweepIntervalMs;
  #shutdownDrainMs;
  #instanceId = randomUUID();
  #broker;
  #server;
  #sweepTimer;
  #state = "new";
  #startedAt;
  #lastSweepAt;
  #lastSweepError;

  constructor({
    stateDir,
    registry,
    signedRegistry,
    trustedRegistryKeys,
    /** Explicit test-only escape hatch. Production callers must use signedRegistry. */
    allowUnsignedFixture = false,
    controllerToken = randomBytes(32).toString("base64url"),
    fakeProvider,
    providerTransport,
    routeResolver,
    verificationReceiptVerifier,
    resourceRanker,
    sweepIntervalMs = 1_000,
    shutdownDrainMs = 2_000,
    dynamicProviders = false,
  }) {
    if (signedRegistry !== undefined && registry !== undefined) {
      throw new Error("Broker supervisor accepts either signedRegistry or unsigned fixture registry, not both");
    }
    if (signedRegistry !== undefined) {
      const verified = verifySignedRegistry(signedRegistry, { trustedKeys: trustedRegistryKeys });
      this.#registry = verified.brokerRegistry;
      this.#registryStatus = Object.freeze({
        source: "signed",
        keyId: verified.keyId,
        registryVersion: verified.registryVersion,
        fingerprint: verified.fingerprint,
        expiresAt: verified.expiresAt,
      });
    } else {
      if (!allowUnsignedFixture || !registry) {
        throw new Error("Broker supervisor requires a signedRegistry; unsigned fixture registry needs allowUnsignedFixture: true");
      }
      this.#registry = registry;
      this.#registryStatus = Object.freeze({ source: "unsigned_fixture" });
    }
    this.#stateDir = requireOwnerOnlyDirectory(stateDir);
    if (Buffer.byteLength(join(this.#stateDir, SOCKET_NAME)) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`Broker stateDir makes Unix socket path exceed ${MAX_SOCKET_PATH_BYTES} bytes`);
    }
    if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 100 || sweepIntervalMs > 60_000) {
      throw new Error("Broker sweepIntervalMs must be an integer between 100 and 60000");
    }
    if (!Number.isInteger(shutdownDrainMs) || shutdownDrainMs < 0 || shutdownDrainMs > 60_000) {
      throw new Error("Broker shutdownDrainMs must be an integer between 0 and 60000");
    }
    this.#controllerToken = validateControllerToken(controllerToken);
    if ((providerTransport && !routeResolver) || (!providerTransport && routeResolver)) {
      throw new Error("Broker supervisor real provider transport requires both providerTransport and routeResolver");
    }
    if (providerTransport && fakeProvider) throw new Error("Broker supervisor chooses either fakeProvider or real provider transport");
    if (providerTransport && typeof providerTransport.stream !== "function") throw new Error("Broker supervisor providerTransport requires stream");
    if (routeResolver && typeof routeResolver !== "function") throw new Error("Broker supervisor routeResolver must be a function");
    if (verificationReceiptVerifier !== undefined && typeof verificationReceiptVerifier !== "function") {
      throw new Error("Broker supervisor verificationReceiptVerifier must be a function");
    }
    if (resourceRanker !== undefined && typeof resourceRanker !== "function") {
      throw new Error("Broker supervisor resourceRanker must be a function");
    }
    this.#fakeProvider = fakeProvider;
    this.#providerTransport = providerTransport;
    this.#routeResolver = routeResolver;
    this.#verificationReceiptVerifier = verificationReceiptVerifier;
    this.#resourceRanker = resourceRanker;
    this.#sweepIntervalMs = sweepIntervalMs;
    this.#shutdownDrainMs = shutdownDrainMs;
    this.#dynamicProviders = dynamicProviders;
  }

  get stateDir() { return this.#stateDir; }
  get socketPath() { return join(this.#stateDir, SOCKET_NAME); }
  get databasePath() { return join(this.#stateDir, DATABASE_NAME); }
  /** Controller-only bootstrap capability; never put this in a child policy. */
  get controllerToken() { return this.#controllerToken; }

  /**
   * The dynamic provider watcher, when dynamicProviders is enabled. The controller needs it
   * to hand the model selector a live registry view. Undefined otherwise.
   */
  get providerWatcher() { return this.#providerWatcher; }

  /**
   * Controller-side live routing inventory (health, cooldowns, breakers) for the model
   * selector. Read-only, credential-free; never exposed through child IPC.
   */
  inventory() {
    if (!this.#broker) throw new Error("Broker supervisor is not running");
    return this.#broker.inventory(Date.now());
  }

  /** Controller-local redacted read-only state; never exposed through child IPC. */
  auditSnapshot() {
    if (!this.#broker) throw new Error("Broker supervisor is not running");
    return deepFreeze(structuredClone({
      leases: this.#broker.leases(),
      pendingTasks: this.#broker.pendingTasks(),
      queueWait: this.#broker.queueWaitMetrics(Date.now()),
      events: this.#broker.events(),
    }));
  }

  status() {
    return Object.freeze({
      state: this.#state,
      stateDir: this.#stateDir,
      registry: this.#registryStatus,
      ...(this.#state === "running" ? { socketPath: this.socketPath, startedAt: this.#startedAt, lastSweepAt: this.#lastSweepAt } : {}),
      ...(this.#lastSweepError ? { lastSweepError: "broker_sweep_failed" } : {}),
    });
  }

  async start() {
    if (this.#state !== "new") throw new Error(`Broker supervisor cannot start from state ${this.#state}`);
    this.#state = "starting";
    try {
      this.#acquireLock();
      rejectUnsafeExistingFile(this.databasePath, "database");
      this.#broker = new SqliteLeaseBroker({
        path: this.databasePath,
        registry: this.#registry,
        ...(this.#verificationReceiptVerifier === undefined ? {} : { verificationReceiptVerifier: this.#verificationReceiptVerifier }),
        ...(this.#resourceRanker === undefined ? {} : { resourceRanker: this.#resourceRanker }),
      });
      hardenFile(this.databasePath);
      this.#server = new BrokerIpcServer({
        broker: this.#broker,
        socketPath: this.socketPath,
        controllerToken: this.#controllerToken,
        ...(this.#fakeProvider === undefined ? {} : { fakeProvider: this.#fakeProvider }),
        ...(this.#providerTransport === undefined ? {} : { providerTransport: this.#providerTransport, routeResolver: this.#routeResolver }),
      });
      await this.#server.start();
      // SQLite may create WAL/SHM beside the DB. The owner-only directory is
      // the primary protection; harden files too when present.
      hardenFile(this.databasePath);
      hardenFile(`${this.databasePath}-wal`);
      hardenFile(`${this.databasePath}-shm`);
      this.#startedAt = Date.now();
      this.#runSweep();
      this.#sweepTimer = setInterval(() => this.#runSweep(), this.#sweepIntervalMs);
      this.#sweepTimer.unref?.();
      this.#state = "running";
      if (this.#dynamicProviders) {
        this.#providerWatcher = new DynamicProviderWatcher({
          agentDir: join(homedir(), ".pi", "agent"),
          broker: this.#broker,
          onReload: () => { /* provider set changed; broker registry updated */ },
        });
        this.#providerWatcher.start();
      }
      return this.status();
    } catch (error) {
      await this.#cleanupAfterFailedStart();
      this.#state = "failed";
      throw error;
    }
  }

  async stop() {
    if (this.#state === "stopped") return this.status();
    if (this.#state !== "running" && this.#state !== "failed") {
      throw new Error(`Broker supervisor cannot stop from state ${this.#state}`);
    }
    this.#state = "stopping";
    clearInterval(this.#sweepTimer);
    this.#providerWatcher?.stop();
    let failure;
    try {
      await this.#server?.stop({ drainMs: this.#shutdownDrainMs });
    } catch (error) {
      failure = error;
    }
    try {
      this.#broker?.close();
      this.#broker = undefined;
    } catch (error) {
      failure ??= error;
    }
    try {
      this.#releaseOwnLock();
    } catch (error) {
      failure ??= error;
    }
    this.#state = "stopped";
    if (failure) throw failure;
    return this.status();
  }

  #lockPath() { return join(this.#stateDir, LOCK_NAME); }

  #acquireLock() {
    const lockPath = this.#lockPath();
    rejectUnsafeExistingFile(lockPath, "lock");
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new Error("Broker stateDir is already locked or has a stale lock; manual recovery is required");
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify({ instanceId: this.#instanceId, pid: process.pid, startedAt: Date.now() })}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    hardenFile(lockPath);
  }

  #releaseOwnLock() {
    const lockPath = this.#lockPath();
    if (!existsSync(lockPath)) return;
    rejectUnsafeExistingFile(lockPath, "lock");
    let parsed;
    try { parsed = JSON.parse(readFileSync(lockPath, "utf8")); } catch {
      throw new Error("Broker lock contents are invalid; refusing to remove lock");
    }
    if (parsed?.instanceId !== this.#instanceId) {
      throw new Error("Broker lock ownership changed; refusing to remove lock");
    }
    rmSync(lockPath);
  }

  #runSweep() {
    try {
      const now = Date.now();
      this.#broker?.expire(now);
      this.#broker?.dispatchPending(now);
      this.#lastSweepAt = Date.now();
      this.#lastSweepError = undefined;
    } catch {
      // Status surfaces the failure without copying SQLite/path details into a
      // child-visible channel or an audit event.
      this.#lastSweepError = true;
    }
  }

  async #cleanupAfterFailedStart() {
    clearInterval(this.#sweepTimer);
    try { await this.#server?.stop({ drainMs: 0 }); } catch { /* cleanup only */ }
    try { this.#broker?.close(); } catch { /* cleanup only */ }
    this.#broker = undefined;
    try { this.#releaseOwnLock(); } catch { /* preserve uncertain lock */ }
  }
}
