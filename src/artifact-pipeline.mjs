/**
 * Bounded queue for pending controller-side evidence/projection work that must
 * reach quiescence before an attempt terminal is considered durably persisted.
 *
 * The pipeline separates four projections required by the doctrine:
 * - canonical provider value (the full model response, held by the assembler);
 * - bounded child/model projection (frames already sent to the child);
 * - redacted ledger projection (recorded by the broker);
 * - retained full artifact (stored by ControllerEvidenceStore).
 *
 * Under hard caps, queue overflow or drain failure fails closed: the
 * settlement stays at terminal_validated (not terminal_persisted) and the
 * crash-repair class remains terminal_unpersisted. The controller may retry
 * persistence or escalate, but it must not treat the attempt as durably
 * settled while the pipeline is undrained.
 */

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class ArtifactPipeline {
  #pending = [];
  #maxPending;
  #maxTotalBytes;
  #totalBytes = 0;
  #drained = false;
  #failed = null;

  constructor({ maxPending = DEFAULT_MAX_PENDING, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100_000) {
      throw new Error("artifact pipeline maxPending must be a safe integer between 1 and 100000");
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 1024 * 1024 * 1024) {
      throw new Error("artifact pipeline maxTotalBytes must be a safe integer between 1 and 1GiB");
    }
    this.#maxPending = maxPending;
    this.#maxTotalBytes = maxTotalBytes;
  }

  get pending() { return this.#pending.length; }
  get pendingBytes() { return this.#totalBytes; }
  get drained() { return this.#drained; }
  get failure() { return this.#failed; }

  /**
   * Enqueue a bounded work item. The item must have an `execute()` function and
   * a non-negative `bytes` estimate. Overflowing the count or byte cap throws
   * so the caller fails closed instead of silently dropping work.
   */
  enqueue(item) {
    if (this.#drained) throw new Error("artifact_pipeline_already_drained");
    if (!item || typeof item.execute !== "function") throw new Error("pipeline work requires an execute function");
    const bytes = item.bytes ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("pipeline work bytes must be a non-negative safe integer");
    if (this.#pending.length >= this.#maxPending) throw new Error("artifact_queue_full");
    if (this.#totalBytes + bytes > this.#maxTotalBytes) throw new Error("artifact_queue_bytes_exceeded");
    this.#pending.push({ execute: item.execute, bytes, label: item.label ?? null });
    this.#totalBytes += bytes;
    return { status: "enqueued", pending: this.#pending.length, pendingBytes: this.#totalBytes };
  }

  /**
   * Process all pending work in enqueue order. If any work item throws, drain
   * stops immediately: remaining work stays pending and `failure` is set. A
   * failed drain is idempotent — calling drain again re-attempts from the
   * failed item.
   */
  drain() {
    if (this.#drained) return { status: "drained", pending: 0 };
    while (this.#pending.length > 0) {
      const item = this.#pending[0];
      try {
        item.execute();
      } catch (error) {
        this.#failed = error;
        return { status: "failed", pending: this.#pending.length, error: error.message };
      }
      this.#pending.shift();
      this.#totalBytes -= item.bytes;
    }
    this.#drained = true;
    this.#failed = null;
    return { status: "drained", pending: 0 };
  }

  /**
   * Terminal durability barrier: drain all pending work and mark the pipeline
   * as settled. If drain fails, the barrier throws so the caller does not
   * transition the settlement to terminal_persisted.
   */
  barrier() {
    const result = this.drain();
    if (result.status === "failed") {
      throw new Error(`artifact_pipeline_barrier_failed: ${result.error}`);
    }
    return Object.freeze({ status: "barrier_passed", pending: 0 });
  }
}