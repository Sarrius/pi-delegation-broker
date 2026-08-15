import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";

const [path, taskId] = process.argv.slice(2);
if (!path || !taskId) throw new Error("usage: reserve-worker.mjs <db-path> <task-id>");
const registry = fixtureRegistry();
delete registry.resources.R2;
delete registry.resources.R3;
const broker = new SqliteLeaseBroker({ path, registry });
try {
  console.log(JSON.stringify(broker.reserve(fixtureContract({ taskId, leaseTtlMs: 60_000 }), 1_000)));
} finally {
  broker.close();
}
