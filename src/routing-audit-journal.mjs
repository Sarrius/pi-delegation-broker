import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 2_000;
const MAX_RESOURCES = 10_000;
const RESOURCE_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/;
const OUTCOME = /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/;

function fresh() {
  return {
    schemaVersion: SCHEMA_VERSION,
    metrics: { routes: 0, completed: 0, failed: 0, aborted: 0, failovers: 0, legacyExcluded: 0, legacyFallback: 0, legacyTransitions: 0 },
    currency: {},
    events: [],
  };
}

function load(path) {
  if (!existsSync(path)) return fresh();
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.schemaVersion !== SCHEMA_VERSION || !state.metrics || !state.currency || !Array.isArray(state.events)) return fresh();
    return state;
  } catch { return fresh(); }
}

function boundedResource(value, name) {
  if (typeof value !== "string" || !RESOURCE_ID.test(value)) throw new Error(`routing audit ${name} must be a resource id`);
  return value;
}

function boundedOutcome(value) {
  if (typeof value !== "string" || !OUTCOME.test(value)) throw new Error("routing audit outcome must be a bounded identifier");
  return value;
}

function nonNegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`routing audit ${name} must be a non-negative safe integer`);
  return value;
}

/**
 * Durable, controller-only observability for routing facts. It deliberately stores resource ids,
 * outcomes and consumption — never prompt text, provider responses, credentials, or price.
 */
export class RoutingAuditJournal {
  #path;
  #state;
  #now;

  constructor({ path, now = () => Date.now() } = {}) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("routing audit journal requires an absolute path");
    if (typeof now !== "function") throw new Error("routing audit journal requires a clock");
    this.#path = path;
    this.#state = load(path);
    this.#now = now;
  }

  /** Record the route actually attempted by the runner, not a child self-report. */
  recordRoute({ status, selection, resourceId, route, usage } = {}) {
    if (!["completed", "failed", "aborted"].includes(status)) throw new Error("routing audit route status must be completed, failed, or aborted");
    const leased = boundedResource(resourceId, "resourceId");
    if (!Array.isArray(route) || route.length < 1 || route.length > 64) throw new Error("routing audit route must contain 1..64 attempts");
    const hops = route.map((hop) => Object.freeze({
      resourceId: boundedResource(hop?.resourceId, "route resourceId"),
      outcome: boundedOutcome(hop?.outcome),
    }));
    const input = usage?.input === undefined ? 0 : nonNegative(usage.input, "usage.input");
    const output = usage?.output === undefined ? 0 : nonNegative(usage.output, "usage.output");
    const at = nonNegative(this.#now(), "clock");
    const event = Object.freeze({
      type: "route",
      at,
      status,
      resourceId: leased,
      hops: Object.freeze(hops),
      ...(selection?.modelTier ? { tier: String(selection.modelTier).slice(0, 32) } : {}),
      ...(selection?.preferenceSource ? { source: String(selection.preferenceSource).slice(0, 64) } : {}),
      ...(selection?.legacyExcluded === true ? { legacyExcluded: true } : {}),
      ...(selection?.legacyFallback === true ? { legacyFallback: true } : {}),
      tokens: input + output,
    });
    this.#state.metrics.routes += 1;
    this.#state.metrics[status] += 1;
    this.#state.metrics.failovers += Math.max(0, hops.length - 1);
    if (event.legacyExcluded) this.#state.metrics.legacyExcluded += 1;
    if (event.legacyFallback) this.#state.metrics.legacyFallback += 1;
    this.#append(event);
    this.#persist();
    return event;
  }

  /** Record current-vs-legacy transitions, not raw provider listings or credentials. */
  recordCurrency(currency) {
    if (!currency || typeof currency !== "object" || Array.isArray(currency)) throw new Error("routing audit currency must be an object");
    const entries = Object.entries(currency);
    if (entries.length > MAX_RESOURCES) throw new Error("routing audit currency resource limit exceeded");
    const at = nonNegative(this.#now(), "clock");
    for (const [resourceId, fact] of entries) {
      boundedResource(resourceId, "currency resourceId");
      if (!fact || typeof fact !== "object" || typeof fact.legacy !== "boolean") throw new Error("routing audit currency fact requires boolean legacy");
      const previous = this.#state.currency[resourceId];
      const next = { legacy: fact.legacy, ...(Number.isSafeInteger(fact.generation) ? { generation: fact.generation } : {}) };
      if (previous && previous.legacy !== next.legacy) {
        this.#state.metrics.legacyTransitions += 1;
        this.#append(Object.freeze({ type: "legacy_transition", at, resourceId, fromLegacy: previous.legacy, toLegacy: next.legacy }));
      }
      this.#state.currency[resourceId] = next;
    }
    this.#persist();
  }

  summary() {
    return Object.freeze({
      metrics: Object.freeze({ ...this.#state.metrics }),
      recent: Object.freeze(this.#state.events.slice(-20).map((event) => Object.freeze({ ...event }))),
    });
  }

  #append(event) {
    this.#state.events.push(event);
    if (this.#state.events.length > MAX_EVENTS) this.#state.events.splice(0, this.#state.events.length - MAX_EVENTS);
  }

  #persist() {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
