import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';

/** Persist public text deltas before returning to the RPC loop. No reasoning,
 * credentials, provider payloads or arbitrary event objects enter this journal. */
export function openPartialOutputJournal(path) {
  const fd = openSync(path, 'ax', 0o600);
  let closed = false;
  return {
    record(event) {
      if (closed || event?.type !== 'message_update') return;
      const update = event.assistantMessageEvent;
      if (update?.type !== 'text_delta' || typeof update.delta !== 'string') return;
      appendFileSync(fd, JSON.stringify({ type: 'text_delta', text: update.delta }) + '\n');
      fsyncSync(fd);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
