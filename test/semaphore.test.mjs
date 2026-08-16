import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../src/semaphore.mjs";

test("semaphore admits up to capacity and queues the rest", async () => {
  const sem = new Semaphore(2);
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.running, 2);
  assert.equal(sem.pending, 0);

  let acquired3 = false;
  const p3 = sem.acquire().then((r) => { acquired3 = true; return r; });
  assert.equal(sem.pending, 1);
  assert.equal(acquired3, false);

  r1();
  const r3 = await p3;
  assert.equal(acquired3, true);
  assert.equal(sem.running, 2);

  r2();
  r3();
  assert.equal(sem.running, 0);
});

test("semaphore abort cancels a queued acquire without granting a slot", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  const ac = new AbortController();
  let rejected = false;
  let rejection;
  sem.acquire(ac.signal).catch((error) => { rejected = true; rejection = error; });
  ac.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(rejected, true);
  assert.match(rejection.message, /aborted/);
  assert.equal(sem.pending, 0);
  assert.equal(sem.running, 1);
  r1();
  assert.equal(sem.running, 0);
});

test("semaphore resize admits queued waiters when capacity increases", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  let acquired2 = false;
  const p2 = sem.acquire().then((r) => { acquired2 = true; return r; });
  assert.equal(acquired2, false);
  sem.resize(2);
  const r2 = await p2;
  assert.equal(acquired2, true);
  assert.equal(sem.running, 2);
  r1();
  r2();
  assert.equal(sem.running, 0);
});