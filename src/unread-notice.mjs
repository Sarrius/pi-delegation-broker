/**
 * How settled background reports reach the parent agent without stealing its turn.
 *
 * Pi converts a `before_agent_start` `{ message }` into a `custom` session message, then
 * `convertToLlm` rewrites custom → user and the host appends it AFTER the actual prompt.
 * The last user message is what the model treats as the current task. That collides with
 * pi-multi-account: failover continuation is itself a `sendUserMessage` follow-up, so an
 * unread-report notice in the user stream replaces "continue the interrupted task" with
 * "read these reports" — including reports that settled hours earlier and survived a
 * process restart because unread files are never pruned.
 *
 * Automatic terminal wake uses a controller custom `sendMessage` follow-up. This module is
 * the fallback when that dispatch fails: it adds unread facts through `systemPrompt`, never
 * the user-message stream, and never on a failover continuation turn. Existing legacy unread
 * ids are seeded at session start so an upgrade does not re-blast the historical inbox.
 */

export const FAILOVER_CONTINUATION_MARKERS = Object.freeze([
  "Provider failover activated:",
  "[handoff:interrupted-turn]",
]);

export function isFailoverContinuationPrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  return FAILOVER_CONTINUATION_MARKERS.some((marker) => prompt.includes(marker));
}

export function seedNotifiedUnread(unread) {
  return new Set(
    (Array.isArray(unread) ? unread : [])
      .map((report) => report?.taskId)
      .filter((id) => typeof id === "string" && id.length > 0),
  );
}

export function formatUnreadNotice(unread) {
  const list = Array.isArray(unread) ? unread : [];
  const lines = list.slice(0, 10).map((report) => {
    const taskId = String(report?.taskId ?? "");
    const status = String(report?.status ?? "");
    const error = report?.status === "failed" ? ` (${String(report?.error ?? "").slice(0, 120)})` : "";
    return `${taskId}: ${status}${error}`;
  });
  return (
    `[delegation-broker] ${list.length} background delegation report(s) settled while you were working. ` +
    `This note is NOT the user task — finish the current request first. ` +
    `Then you may call delegate_collect (no argument lists summaries; taskId returns the full report).\n` +
    lines.join("\n")
  );
}

/**
 * Decide whether/how to surface newly settled reports whose automatic wake failed.
 * Never returns a `message` payload: that channel becomes the last user turn.
 */
export function planUnreadNotice({ unread, notifiedIds, prompt, systemPrompt } = {}) {
  const list = Array.isArray(unread) ? unread : [];
  const notified = notifiedIds instanceof Set ? notifiedIds : new Set();
  const fresh = list.filter((report) => report && !notified.has(report.taskId));
  if (fresh.length === 0) {
    if (list.length === 0 && notified.size > 0) return { inject: false, notifiedIds: new Set() };
    return { inject: false, notifiedIds: notified };
  }
  if (isFailoverContinuationPrompt(prompt)) {
    return { inject: false, notifiedIds: notified };
  }
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  const notice = formatUnreadNotice(list);
  return {
    inject: true,
    notifiedIds: new Set(list.map((report) => report.taskId)),
    systemPrompt: base ? `${base}\n\n${notice}` : notice,
  };
}
