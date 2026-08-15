import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
const MAX_REQUEST_BYTES = 64 * 1024;
const CHILD_METHODS = new Set(["heartbeat", "release", "providerAttempt"]);
const CONTROLLER_METHODS = new Set(["reserve", "issueLeaseCapability", "markRateLimited", "markUnknown", "markHealthy", "release", "configureFakeProvider"]);

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function privateSocketParent(socketPath) {
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = statSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Broker socket parent must be an owner-only directory: ${parent}`);
  }
}

function validateTtl(value) {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) throw new Error("heartbeat ttlMs must be an integer between 1000 and 60000");
  return value;
}

/**
 * Line-delimited JSON IPC for the local controller and a lease-scoped child.
 * The controller token is never returned to a child. A child capability can
 * only heartbeat/release the one currently active lease it represents.
 */
export class BrokerIpcServer {
  #broker;
  #socketPath;
  #controllerToken;
  #fakeProvider;
  #server;
  #connections = new Set();

  constructor({ broker, socketPath, controllerToken = randomBytes(32).toString("base64url"), fakeProvider }) {
    if (!broker || !socketPath) throw new Error("Broker IPC server needs broker and socketPath");
    this.#broker = broker;
    this.#socketPath = socketPath;
    this.#controllerToken = controllerToken;
    this.#fakeProvider = fakeProvider;
    this.#server = createServer((socket) => {
      this.#connections.add(socket);
      socket.once("close", () => this.#connections.delete(socket));
      this.#handle(socket);
    });
  }

  get socketPath() { return this.#socketPath; }
  /** Parent-only bootstrap secret. Do not pass to child environment or logs. */
  get controllerToken() { return this.#controllerToken; }

  async start() {
    privateSocketParent(this.#socketPath);
    if (existsSync(this.#socketPath)) {
      if (!lstatSync(this.#socketPath).isSocket()) throw new Error(`Refusing to remove non-socket broker path: ${this.#socketPath}`);
      rmSync(this.#socketPath);
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.#server.off("listening", onListening); reject(error); };
      const onListening = () => { this.#server.off("error", onError); resolve(); };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#socketPath);
    });
    chmodSync(this.#socketPath, 0o600);
    return { socketPath: this.#socketPath };
  }

  /**
   * Drain local requests briefly, then destroy remaining sockets. Destroying a
   * delayed child attempt also aborts its fake pre-effect transport, avoiding
   * a daemon shutdown that waits indefinitely for an untrusted child.
   */
  async stop({ drainMs = 2_000 } = {}) {
    if (!Number.isInteger(drainMs) || drainMs < 0 || drainMs > 60_000) throw new Error("drainMs must be an integer between 0 and 60000");
    if (this.#server.listening) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          for (const socket of this.#connections) socket.destroy();
        }, drainMs);
        timer.unref?.();
        this.#server.close((error) => {
          clearTimeout(timer);
          error ? reject(error) : resolve();
        });
      });
    }
    if (existsSync(this.#socketPath) && lstatSync(this.#socketPath).isSocket()) rmSync(this.#socketPath);
  }

  #handle(socket) {
    socket.setEncoding("utf8");
    let buffered = "";
    let handling = false;
    let responded = false;
    const abortController = new AbortController();
    // requestBrokerIpc keeps its write side open until the response. A client
    // abort destroys the connection; race that against a delayed fake attempt
    // so cancellation is observed before the scripted outcome is consumed.
    socket.once("close", () => {
      if (!responded) abortController.abort();
    });
    socket.on("data", (chunk) => {
      if (handling) return;
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) {
        responded = true;
        return this.#respond(socket, { id: null, ok: false, error: "request_too_large" });
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handling = true;
      const line = buffered.slice(0, newline);
      buffered = "";
      let request;
      try { request = JSON.parse(line); } catch {
        responded = true;
        return this.#respond(socket, { id: null, ok: false, error: "invalid_json" });
      }
      void Promise.resolve(this.#dispatch(request, Date.now(), abortController.signal)).then(
        (result) => {
          if (abortController.signal.aborted) return;
          responded = true;
          this.#respond(socket, { id: request?.id ?? null, ok: true, result });
        },
        (error) => {
          if (abortController.signal.aborted) return;
          responded = true;
          // Do not stringify raw request fields or authorization in an error.
          this.#respond(socket, { id: request?.id ?? null, ok: false, error: error instanceof Error ? error.message : "internal_error" });
        },
      );
    });
    socket.on("error", () => socket.destroy());
  }

  #respond(socket, response) {
    if (!socket.destroyed && !socket.writableEnded) socket.end(`${JSON.stringify(response)}\n`);
  }

  async #dispatch(request, now, signal) {
    if (!request || typeof request.method !== "string") throw new Error("invalid_request");
    const { method, params = {}, authorization } = request;
    if (sameSecret(authorization, this.#controllerToken)) {
      if (!CONTROLLER_METHODS.has(method)) throw new Error("controller_method_not_allowed");
      if (method === "reserve") return this.#broker.reserve(params.contract, now);
      if (method === "issueLeaseCapability") return this.#broker.issueLeaseCapability(params.leaseId, params.fencingToken, now);
      if (method === "markRateLimited") return this.#broker.markRateLimited(params.resourceId, params.retryAfterMs, now);
      if (method === "markUnknown") return this.#broker.markUnknown(params.resourceId, now, params.reason);
      if (method === "markHealthy") return this.#broker.markHealthy(params.resourceId, now);
      if (method === "release") return this.#broker.release(params.leaseId, params.fencingToken, "controller release", now);
      if (method === "configureFakeProvider") {
        if (!this.#fakeProvider) throw new Error("fake_provider_unavailable");
        return this.#fakeProvider.configure(params.taskId, params.events);
      }
    }
    if (!CHILD_METHODS.has(method)) throw new Error("unauthorized");
    const capability = this.#broker.leaseForCapability(authorization, now);
    if (capability.status !== "authorized") throw new Error("unauthorized");
    if (method === "heartbeat") return this.#broker.heartbeat(capability.lease.leaseId, capability.lease.fencingToken, now, validateTtl(params.ttlMs));
    if (method === "release") return this.#broker.release(capability.lease.leaseId, capability.lease.fencingToken, "child release", now);
    return this.#providerAttempt(capability.lease, params.inputDigest, signal);
  }

  async #providerAttempt(lease, inputDigest, signal) {
    // Publishing this core must not turn an absent real provider proxy into a
    // successful fake model call. Tests opt into ScriptedFakeProvider explicitly.
    if (!this.#fakeProvider) throw new Error("provider_transport_unavailable");
    const event = await this.#fakeProvider.attempt(lease, inputDigest, signal);
    if (signal?.aborted) throw new Error("provider_attempt_aborted");
    // A delayed attempt must re-check the lease at observation time, not at
    // socket admission time. Otherwise a result arriving after TTL could be
    // recorded/returned under an already expired fencing boundary.
    const observedAt = Date.now();
    const telemetry = this.#broker.recordProviderEvent(lease.leaseId, lease.fencingToken, inputDigest, event, observedAt);
    if (telemetry.status !== "recorded") throw new Error("lease no longer active");
    if (event.type === "succeeded") {
      if (lease.enforcement.output === "hard" && lease.maxOutputTokens !== undefined && event.usage.output > lease.maxOutputTokens) {
        this.#broker.release(lease.leaseId, lease.fencingToken, "hard output budget exceeded", observedAt);
        return { status: "budget_exceeded", maxOutputTokens: lease.maxOutputTokens };
      }
      return { status: "succeeded", resultRef: event.resultRef, usage: event.usage };
    }
    if (event.type === "rate_limited") {
      const cooldown = this.#broker.markRateLimited(lease.resourceId, event.retryAfterMs, observedAt);
      this.#broker.release(lease.leaseId, lease.fencingToken, "provider rate limited", observedAt);
      return { status: "rate_limited", retryAfterMs: event.retryAfterMs, capacityGroup: cooldown.capacityGroup, retryAt: cooldown.until };
    }
    if (event.type === "auth_fatal") {
      this.#broker.markUnknown(lease.resourceId, observedAt, "provider auth fatal");
      this.#broker.release(lease.leaseId, lease.fencingToken, "provider auth fatal", observedAt);
      return { status: "auth_fatal" };
    }
    this.#broker.release(lease.leaseId, lease.fencingToken, "provider failed before effect", observedAt);
    return { status: "failed_before_effect", reasonCode: event.reasonCode };
  }
}

/** One-request-per-connection client used by fake controller/provider tests. */
export function requestBrokerIpc({ socketPath, authorization, method, params = {}, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffered = "";
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      socket.destroy();
      fail(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      // Keep the write side open until the broker replies. That lets an abort
      // be distinguishable from a normal one-request/one-response exchange.
      if (!settled) socket.write(`${JSON.stringify({ id: randomBytes(8).toString("hex"), authorization, method, params })}\n`);
    });
    socket.on("data", (chunk) => { buffered += chunk; });
    socket.once("error", fail);
    socket.once("end", () => {
      try {
        const response = JSON.parse(buffered.trim());
        if (!response.ok) throw new Error(response.error);
        succeed(response.result);
      } catch (error) { fail(error); }
    });
  });
}
