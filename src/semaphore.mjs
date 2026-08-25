export class Semaphore {
  #active = 0;
  #queue = [];
  #limit;

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be positive");
    this.#limit = capacity;
  }

  get capacity() { return this.#limit; }
  get running() { return this.#active; }
  get pending() { return this.#queue.length; }

  resize(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be positive");
    this.#limit = capacity;
    this.#drain();
  }

  async acquire(signal, { priority = false } = {}) {
    if (signal?.aborted) throw new Error("Semaphore acquire aborted");
    if (this.#active >= this.#limit) {
      await new Promise((resolve, reject) => {
        const waiter = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new Error("Semaphore acquire aborted"));
        };
        if (priority) this.#queue.unshift(waiter);
        else this.#queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      this.#active += 1;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
    let resuming;
    release.yield = async (yieldSignal) => {
      if (released) throw new Error("Semaphore permit is already released");
      release();
      if (resuming) return resuming;
      resuming = this.acquire(yieldSignal, { priority: true }).then(() => {
        released = false;
        return release;
      }).catch((error) => {
        released = true;
        throw error;
      }).finally(() => { resuming = undefined; });
      return resuming;
    };
    release.withYieldedCapacity = async (yieldSignal, fn) => {
      if (typeof fn !== "function") throw new Error("Semaphore yielded callback must be a function");
      if (released) throw new Error("Semaphore permit is already released");
      release();
      try { return await fn(yieldSignal); }
      finally {
        await this.acquire(yieldSignal, { priority: true });
        released = false;
      }
    };
    return release;
  }

  #drain() {
    while (this.#active < this.#limit) {
      const next = this.#queue.shift();
      if (!next) return;
      this.#active += 1;
      next();
    }
  }
}