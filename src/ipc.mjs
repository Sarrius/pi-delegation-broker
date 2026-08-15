import { randomBytes, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { captureLosslessJson } from "./lossless-json.mjs";
import { AttemptSettlement, ProviderStreamAssembler, createAttemptRouteSnapshot } from "./provider-protocol.mjs";
const MAX_REQUEST_BYTES = 1024 * 1024;
const CHILD_METHODS = new Set(["heartbeat", "release", "providerAttempt", "providerStream"]);
const CONTROLLER_METHODS = new Set([
  "reserve", "submit", "dispatchPending", "pendingTasks", "queueWaitMetrics", "readyTasks", "claimReadyTask", "abandonClaimedTask", "finalizeClaimedTask", "reschedulePending", "finishPending",
  "issueLeaseCapability", "markRateLimited", "markUnknown", "markHealthy", "release", "configureFakeProvider",
]);

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
  #controllerEpoch = randomUUID();

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
      void Promise.resolve(this.#dispatch(request, Date.now(), abortController.signal, socket)).then(
        (result) => {
          if (result === undefined) return; // streaming already wrote and ended
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

  #writeLine(socket, response) {
    if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(response)}\n`);
  }

  async #dispatch(request, now, signal, socket) {
    if (!request || typeof request.method !== "string") throw new Error("invalid_request");
    const { method, params = {}, authorization } = request;
    if (sameSecret(authorization, this.#controllerToken)) {
      if (!CONTROLLER_METHODS.has(method)) throw new Error("controller_method_not_allowed");
      if (method === "reserve") return this.#broker.reserve(params.contract, now);
      if (method === "submit") return this.#broker.submit(params.contract, now);
      if (method === "dispatchPending") return this.#broker.dispatchPending(now, params.limit);
      if (method === "pendingTasks") return this.#broker.pendingTasks();
      if (method === "queueWaitMetrics") return this.#broker.queueWaitMetrics(now);
      if (method === "readyTasks") return this.#broker.readyTasks();
      if (method === "claimReadyTask") return this.#broker.claimReadyTask(params.taskId, params.leaseId, params.contract, now);
      if (method === "abandonClaimedTask") return this.#broker.abandonClaimedTask(params.taskId, params.leaseId, params.fencingToken, now);
      if (method === "finalizeClaimedTask") return this.#broker.finalizeClaimedTask(params.taskId, params.leaseId, params.fencingToken, params.terminalState, now);
      if (method === "reschedulePending") return this.#broker.reschedulePending(params.taskId, params.recoveryOwner, params.eligibleAt, now);
      if (method === "finishPending") return this.#broker.finishPending(params.taskId, params.state, now);
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
    if (method === "providerStream") return this.#providerStream(capability.lease, params, signal, socket, request.id);
    return this.#providerAttempt(capability.lease, params.inputDigest, signal);
  }

  async #providerStream(lease, params, signal, socket, requestId) {
    if (!this.#fakeProvider || typeof this.#fakeProvider.routeForLease !== "function") throw new Error("provider_transport_unavailable");
    const context = params?.context;
    if (!context || typeof context !== "object") throw new Error("stream requires typed context");

    // Phase 1: bounded lossless context ingress (synchronous, before any writes)
    const captured = captureLosslessJson(context, { maxBytes: 512 * 1024, maxNodes: 100_000, maxDepth: 32 });
    const inputDigest = createHash("sha256").update(captured.canonical).digest("hex");
    if (typeof captured.value.systemPrompt !== "string") throw new Error("context requires string systemPrompt");
    if (!Array.isArray(captured.value.messages)) throw new Error("context requires array messages");
    if (!Array.isArray(captured.value.tools)) throw new Error("context requires array tools");

    // Phase 2: immutable route snapshot
    const route = this.#fakeProvider.routeForLease(lease);
    const attemptId = randomUUID();
    const streamId = randomUUID();
    const snapshot = createAttemptRouteSnapshot({
      schemaVersion: 1,
      controllerEpoch: this.#controllerEpoch,
      attemptId,
      streamId,
      taskId: lease.taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      registryFingerprint: route.registryFingerprint,
      registryVersion: route.registryVersion,
      resourceId: lease.resourceId,
      capacityGroup: lease.capacityGroup,
      accountAlias: route.accountAlias,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort ?? null,
      apiDialect: route.apiDialect,
      endpointId: route.endpointId,
      adapterId: route.adapterId,
      credentialRefFingerprint: route.credentialRefFingerprint,
      retryOwner: "broker",
      sdkMaxRetries: 0,
      deadlineAt: lease.expiresAt,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxOutputTokens: lease.maxOutputTokens ?? 8_000,
      maxCostMicros: lease.maxCostMicros ?? 500_000,
    });

    const identity = Object.freeze({
      controllerEpoch: snapshot.controllerEpoch,
      attemptId: snapshot.attemptId,
      streamId: snapshot.streamId,
      leaseId: snapshot.leaseId,
      fencingToken: snapshot.fencingToken,
    });
    const assembler = new ProviderStreamAssembler(identity, {
      maxBlocks: 64,
      maxBlockBytes: 256 * 1024,
      maxTotalOutputBytes: 1_000_000,
    });
    const settlement = new AttemptSettlement(snapshot);

    // Phase 3: run fake provider (async, before any frame writes)
    const event = await this.#fakeProvider.attempt(lease, inputDigest, signal);
    if (signal?.aborted) throw new Error("provider_attempt_aborted");
    const observedAt = Date.now();
    const telemetry = this.#broker.recordProviderEvent(lease.leaseId, lease.fencingToken, inputDigest, event, observedAt);
    if (telemetry.status !== "recorded") throw new Error("lease no longer active");

    // Phase 4: generate + validate + write frames
    let seq = 0;
    const emit = (type, payload = {}) => {
      const frame = { protocolVersion: 1, ...identity, seq: seq++, type, payload };
      const validated = assembler.accept(frame);
      this.#writeLine(socket, { id: requestId, ok: true, frame });
      return validated;
    };

    settlement.transition("admitted");
    emit("attempt_accepted");
    settlement.transition("provider_send_started");
    emit("provider_send_started");

    if (event.type === "succeeded") {
      settlement.transition("headers_seen");
      settlement.transition("streaming_tentative");
      const text = event.resultRef;
      emit("block_start", { index: 0, blockType: "text" });
      emit("text_delta", { index: 0, delta: text });
      emit("block_end", { index: 0, value: text });
      emit("usage", { input: event.usage.input, output: event.usage.output, costMicros: event.usage.costMicros });
      if (lease.enforcement.output === "hard" && lease.maxOutputTokens !== undefined && event.usage.output > lease.maxOutputTokens) {
        this.#broker.release(lease.leaseId, lease.fencingToken, "hard output budget exceeded", observedAt);
        emit("terminal", { outcome: "budget_exceeded", usage: event.usage });
        settlement.settleTerminal("budget_exceeded", { facts: { usage: event.usage }, observedAt });
      } else {
        const success = this.#broker.markProviderSucceeded(lease.leaseId, lease.fencingToken, observedAt);
        if (success.status !== "observed") throw new Error("lease no longer active");
        emit("terminal", { outcome: "succeeded_terminal", usage: event.usage });
        settlement.settleTerminal("succeeded_terminal", { facts: { usage: event.usage }, observedAt });
      }
    } else if (event.type === "rate_limited") {
      settlement.transition("headers_seen");
      const cooldown = this.#broker.markRateLimited(lease.resourceId, event.retryAfterMs, observedAt);
      this.#broker.release(lease.leaseId, lease.fencingToken, "provider rate limited", observedAt);
      emit("terminal", { outcome: "rate_limited", retryAfterMs: event.retryAfterMs });
      settlement.settleTerminal("rate_limited", { facts: { retryAfterMs: event.retryAfterMs, capacityGroup: cooldown.capacityGroup }, observedAt });
    } else if (event.type === "auth_fatal") {
      settlement.transition("headers_seen");
      this.#broker.markUnknown(lease.resourceId, observedAt, "provider auth fatal");
      this.#broker.release(lease.leaseId, lease.fencingToken, "provider auth fatal", observedAt);
      emit("terminal", { outcome: "auth_fatal" });
      settlement.settleTerminal("auth_fatal", { observedAt });
    } else {
      this.#broker.release(lease.leaseId, lease.fencingToken, "provider failed before effect", observedAt);
      emit("terminal", { outcome: "transport_before_headers", finishReason: event.reasonCode });
      settlement.settleTerminal("transport_before_headers", { facts: { reasonCode: event.reasonCode }, observedAt });
    }

    socket.end();
    return undefined; // streaming handled: #writeLine + end already done
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
      const success = this.#broker.markProviderSucceeded(lease.leaseId, lease.fencingToken, observedAt);
      if (success.status !== "observed") throw new Error("lease no longer active");
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

/** Streaming client for framed provider responses. Reads NDJSON frames until
 * the controller ends the socket. Returns { frames, terminal } where terminal
 * is the frame whose type is "terminal". An error before streaming throws. */
export function streamProviderIpc({ socketPath, authorization, context, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffered = "";
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error) => { if (settled) return; settled = true; cleanup(); socket.destroy(); reject(error); };
    const succeed = (result) => { if (settled) return; settled = true; cleanup(); resolve(result); };
    const onAbort = () => { socket.destroy(); fail(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      if (!settled) socket.write(`${JSON.stringify({ id: randomBytes(8).toString("hex"), authorization, method: "providerStream", params: { context } })}\n`);
    });
    socket.on("data", (chunk) => { buffered += chunk; });
    socket.once("error", fail);
    socket.once("end", () => {
      try {
        const lines = buffered.trim().split("\n");
        const frames = [];
        let terminal = null;
        for (const line of lines) {
          if (!line) continue;
          const response = JSON.parse(line);
          if (!response.ok) throw new Error(response.error);
          if (response.frame) {
            frames.push(response.frame);
            if (response.frame.type === "terminal") terminal = response.frame;
          }
        }
        if (!terminal) throw new Error("stream ended without a terminal frame");
        succeed({ frames, terminal });
      } catch (error) { fail(error); }
    });
  });
}
