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

  async acquire(signal) {
    if (signal?.aborted) throw new Error("Semaphore acquire aborted");
    if (this.#active >= this.#limit) {
      await new Promise((resolve, reject) => {
        const waiter = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new Error("Semaphore acquire aborted"));
        };
        this.#queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      this.#active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
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