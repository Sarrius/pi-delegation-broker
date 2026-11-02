/**
 * Live pool pressure for providers that meter several independent pools under one account.
 *
 * The broker cannot probe Cursor's dashboard RPCs itself without duplicating credentials and
 * network traffic that pi-multi-account already spends: the extension fetches all three Cursor
 * pools every few minutes and persists them in provider-failover-state.json. This module turns
 * that snapshot into the small fact map the selector consumes — pool id → used percent and reset
 * time — and nothing else. It reads a file; it never calls a provider and never sees a credential.
 *
 * Only pools that a broker resource can bill to are mapped. Cursor's "primary" window is the
 * included models pool and "secondary" is the third-party pool; the Grok Bot weekly bucket is a
 * separate product with no model route, so it is deliberately absent rather than mapped to a
 * resource that would never exist.
 */

import { readFileSync } from "node:fs";

/** A snapshot older than this is not evidence of present pressure; fail open, as before. */
export const POOL_STATE_MAX_AGE_MS = 60 * 60 * 1_000;

function poolFact(window, fetchedAt) {
  if (!window || typeof window !== "object") return undefined;
  const usedPercent = Number(window.usedPercent);
  const resetAt = Number(window.resetAt);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  if (!Number.isSafeInteger(resetAt) || resetAt <= 0) return undefined;
  return Object.freeze({ usedPercent, resetAt, ...(Number.isSafeInteger(fetchedAt) ? { fetchedAt } : {}) });
}

/**
 * Map pi-multi-account's usage snapshots to broker pool ids (`${provider}.${pool}`).
 *
 * `usageByProvider.cursor` → `cursor.models` / `cursor.other`; a numbered slot like
 * `cursor-account-2` maps to its own ids. A snapshot older than `maxAgeMs` contributes nothing:
 * stale percentages must never bench a pool that may have already reset.
 */
export function cursorPoolFactsFromUsageState(state, { now = Date.now(), maxAgeMs = POOL_STATE_MAX_AGE_MS } = {}) {
  const facts = {};
  const usage = state?.usageByProvider;
  if (!usage || typeof usage !== "object") return Object.freeze(facts);
  for (const [provider, snapshot] of Object.entries(usage)) {
    if (String(provider).replace(/-account-\d+$/, "") !== "cursor") continue;
    if (!snapshot || typeof snapshot !== "object") continue;
    if (Number.isSafeInteger(snapshot.fetchedAt) && now - snapshot.fetchedAt > maxAgeMs) continue;
    const models = poolFact(snapshot.primary, snapshot.fetchedAt);
    if (models) facts[`${provider}.models`] = models;
    const other = poolFact(snapshot.secondary, snapshot.fetchedAt);
    if (other) facts[`${provider}.other`] = other;
  }
  return Object.freeze(facts);
}

/** Read the usage state file. Missing or unreadable state is "no pool evidence", not an error. */
export function readPoolFacts(statePath, options = {}) {
  try {
    return cursorPoolFactsFromUsageState(JSON.parse(readFileSync(statePath, "utf8")), options);
  } catch {
    return Object.freeze({});
  }
}
