import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cursorPoolFactsFromUsageState, readPoolFacts } from "../src/pool-state.mjs";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

test("maps Cursor's usage windows to broker pool ids and ignores the routeless Grok Bot bucket", () => {
  const facts = cursorPoolFactsFromUsageState({
    usageByProvider: {
      cursor: {
        fetchedAt: NOW - 60_000,
        primary: { usedPercent: 97.32, resetAt: NOW + 6 * 86_400_000 },
        secondary: { usedPercent: 35.18, resetAt: NOW + 6 * 86_400_000 },
        tertiary: { usedPercent: 0, resetAt: NOW + 4 * 86_400_000, windowSeconds: 604_800 },
      },
      "cursor-account-2": {
        fetchedAt: NOW - 60_000,
        primary: { usedPercent: 10, resetAt: NOW + 86_400_000 },
      },
    },
  }, { now: NOW });
  assert.deepEqual(Object.keys(facts).sort(), ["cursor-account-2.models", "cursor.models", "cursor.other"]);
  assert.equal(facts["cursor.models"].usedPercent, 97.32);
  assert.equal(facts["cursor.other"].usedPercent, 35.18);
  assert.ok(!("cursor.tertiary" in facts), "the Grok Bot weekly bucket has no model route to guard");
});

test("stale snapshots and malformed windows contribute nothing", () => {
  const facts = cursorPoolFactsFromUsageState({
    usageByProvider: {
      cursor: {
        fetchedAt: NOW - 2 * 60 * 60 * 1_000,
        primary: { usedPercent: 99, resetAt: NOW + 86_400_000 },
      },
      "cursor-account-2": {
        fetchedAt: NOW,
        primary: { usedPercent: 400, resetAt: NOW + 1 },
        secondary: { usedPercent: 20, resetAt: 0 },
      },
    },
  }, { now: NOW });
  assert.deepEqual(facts, {});
});

test("readPoolFacts tolerates a missing or unreadable state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-state-"));
  try {
    assert.deepEqual(readPoolFacts(join(dir, "absent.json")), {});
    writeFileSync(join(dir, "broken.json"), "{not json");
    assert.deepEqual(readPoolFacts(join(dir, "broken.json")), {});
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      usageByProvider: { cursor: { fetchedAt: NOW, primary: { usedPercent: 42, resetAt: NOW + 1_000 } } },
    }));
    assert.equal(readPoolFacts(join(dir, "state.json"), { now: NOW })["cursor.models"].usedPercent, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
