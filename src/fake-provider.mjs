const INPUT_DIGEST = /^[a-f0-9]{64}$/;
const EVENT_TYPES = new Set(["succeeded", "rate_limited", "auth_fatal", "failed_before_effect"]);
const FAKE_REGISTRY_FP = "f1".repeat(32);
const FAKE_CRED_FP = "e2".repeat(32);

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function normalizeEvent(event) {
  if (!event || !EVENT_TYPES.has(event.type)) throw new Error("fake provider event type is not allowed");
  const delayMs = event.delayMs === undefined ? 0 : nonNegativeInteger(event.delayMs, "delayMs");
  if (delayMs > 10_000) throw new Error("fake provider delayMs must be at most 10000");
  if (event.type === "succeeded") {
    // resultRef crosses back into the child response; keep it opaque and
    // identifier-shaped so a controller cannot accidentally put text/secrets
    // into an assistant message or durable provider event.
    if (typeof event.resultRef !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(event.resultRef)) throw new Error("succeeded event requires an identifier-shaped resultRef");
    return {
      type: "succeeded",
      resultRef: event.resultRef,
      usage: {
        input: nonNegativeInteger(event.usage?.input ?? 0, "usage.input"),
        output: nonNegativeInteger(event.usage?.output ?? 0, "usage.output"),
        costMicros: nonNegativeInteger(event.usage?.costMicros ?? 0, "usage.costMicros"),
      },
      delayMs,
    };
  }
  if (event.type === "rate_limited") {
    if (!Number.isInteger(event.retryAfterMs) || event.retryAfterMs < 1 || event.retryAfterMs > 86_400_000) throw new Error("rate_limited event requires bounded retryAfterMs");
    return { type: "rate_limited", retryAfterMs: event.retryAfterMs, delayMs };
  }
  if (event.type === "auth_fatal") return { type: "auth_fatal", delayMs };
  return { type: "failed_before_effect", reasonCode: typeof event.reasonCode === "string" ? event.reasonCode.slice(0, 80) : "unknown", delayMs };
}

function waitForDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new Error("provider_attempt_aborted"));
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new Error("provider_attempt_aborted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Controller-configured deterministic provider substitute. It never receives raw input or credentials. */
export class ScriptedFakeProvider {
  #plans = new Map();

  configure(taskId, events) {
    if (typeof taskId !== "string" || !taskId || !Array.isArray(events) || events.length === 0) {
      throw new Error("fake provider plan needs taskId and at least one event");
    }
    this.#plans.set(taskId, events.map(normalizeEvent));
    return { status: "configured", taskId, eventCount: events.length };
  }

  async attempt(lease, inputDigest, signal) {
    if (typeof inputDigest !== "string" || !INPUT_DIGEST.test(inputDigest)) throw new Error("provider attempt requires a SHA-256 input digest");
    const plan = this.#plans.get(lease.taskId);
    if (!plan || plan.length === 0) throw new Error("no fake provider event configured for task");
    // Do not consume the scripted outcome until its cancellable pre-effect
    // delay completes. A disconnected/aborted child therefore records no
    // provider event and cannot turn cancellation into a hidden side effect.
    const planned = plan[0];
    await waitForDelay(planned.delayMs, signal);
    if (signal?.aborted) throw new Error("provider_attempt_aborted");
    plan.shift();
    const { delayMs: _delayMs, ...event } = planned;
    return structuredClone(event);
  }

  /** Test-only route info for the fake streaming path. A real adapter replaces this. */
  routeForLease(lease) {
    return {
      provider: "fake",
      model: lease.profile,
      reasoningEffort: null,
      apiDialect: "fake-stream",
      endpointId: `fake-${lease.resourceId}`,
      adapterId: "fake-adapter@0",
      credentialRefFingerprint: FAKE_CRED_FP,
      accountAlias: "fake-account",
      registryFingerprint: FAKE_REGISTRY_FP,
      registryVersion: 1,
    };
  }
}
