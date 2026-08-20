import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILOVER_CONTINUATION_MARKERS,
  formatUnreadNotice,
  isFailoverContinuationPrompt,
  planUnreadNotice,
  seedNotifiedUnread,
} from "../src/unread-notice.mjs";

const CONTINUATION = [
  "Provider failover activated: switched to kimi-coding/k3 after openai-codex/gpt-5.6-sol hit a quota or rate limit.",
  "Continue the interrupted task from where it stopped.",
  "The interrupted turn itself is preserved verbatim in this session as a [handoff:interrupted-turn] record — read it before acting.",
].join(" ");

function report(taskId, overrides = {}) {
  return { taskId, status: "failed", error: "no capacity", ...overrides };
}

test("Pi host contract: a before_agent_start message would become the last user turn, so the plan never returns one", () => {
  const planned = planUnreadNotice({
    unread: [report("delegate-old-1")],
    notifiedIds: new Set(),
    prompt: "why did failover go to kimi?",
    systemPrompt: "You are the parent agent.",
  });
  assert.equal(planned.inject, true);
  assert.equal("message" in planned, false, "message is the channel convertToLlm rewrites to user");
  assert.match(planned.systemPrompt, /You are the parent agent/);
  assert.match(planned.systemPrompt, /NOT the user task/);
  assert.match(planned.systemPrompt, /delegate-old-1/);
});

test("session start seeds existing unread so a restart does not dump yesterday's inbox onto the first prompt", () => {
  const unread = [report("delegate-msycnz68-2"), report("delegate-msycnz67-1")];
  const notified = seedNotifiedUnread(unread);
  const planned = planUnreadNotice({
    unread,
    notifiedIds: notified,
    prompt: "continue from where you stopped",
    systemPrompt: "base",
  });
  assert.equal(planned.inject, false);
});

test("a report that settles after session start surfaces on the next genuine user prompt", () => {
  const seeded = seedNotifiedUnread([report("already-there")]);
  const planned = planUnreadNotice({
    unread: [report("already-there"), report("just-settled")],
    notifiedIds: seeded,
    prompt: "what broke?",
    systemPrompt: "base",
  });
  assert.equal(planned.inject, true);
  assert.match(planned.systemPrompt, /just-settled/);
  assert.deepEqual([...planned.notifiedIds].sort(), ["already-there", "just-settled"]);
});

test("multi-account failover continuation does not receive the notice; ids stay unnotified for the next real turn", () => {
  assert.equal(isFailoverContinuationPrompt(CONTINUATION), true);
  for (const marker of FAILOVER_CONTINUATION_MARKERS) {
    assert.equal(isFailoverContinuationPrompt(`x ${marker} y`), true);
  }
  const planned = planUnreadNotice({
    unread: [report("just-settled")],
    notifiedIds: new Set(),
    prompt: CONTINUATION,
    systemPrompt: "base",
  });
  assert.equal(planned.inject, false);
  assert.equal(planned.notifiedIds.size, 0, "skipping must not mark notified or the agent never learns");
});

test("after a skipped continuation, the following genuine prompt still gets the notice", () => {
  const skipped = planUnreadNotice({
    unread: [report("just-settled")],
    notifiedIds: new Set(),
    prompt: CONTINUATION,
    systemPrompt: "base",
  });
  const next = planUnreadNotice({
    unread: [report("just-settled")],
    notifiedIds: skipped.notifiedIds,
    prompt: "так, копай",
    systemPrompt: "base",
  });
  assert.equal(next.inject, true);
  assert.match(next.systemPrompt, /just-settled/);
});

test("notice wording refuses to impersonate the user request", () => {
  const text = formatUnreadNotice([report("delegate-a-1")]);
  assert.match(text, /NOT the user task/);
  assert.doesNotMatch(text, /^\[delegation-broker\].*Read them with delegate_collect/s);
});
