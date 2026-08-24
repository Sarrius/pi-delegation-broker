import { existsSync, writeFileSync } from "node:fs";
import { claimReportWake } from "../../src/report-store.mjs";

const [root, taskId, barrier, ready] = process.argv.slice(2);
if (!root || !taskId || !barrier || !ready) throw new Error("root, task id, barrier and ready path are required");
writeFileSync(ready, "ready\n");
const deadline = Date.now() + 5_000;
while (!existsSync(barrier)) {
  if (Date.now() > deadline) throw new Error("claim barrier timed out");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
const claimed = claimReportWake(root, taskId);
process.stdout.write(claimed ? "claimed\n" : "not-claimed\n");
