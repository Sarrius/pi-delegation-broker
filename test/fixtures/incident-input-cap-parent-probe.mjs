import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");

const USED = 804_330;
const BYTE_RESERVATION = 236_663;
const CAP = 1_000_000;
const OBSERVED_INPUT = 43_630;
const OBSERVED_OUTPUT = 453;
const MARKER = "INCIDENT_PARENT_OK";
const PROMPT = `${"x".repeat(BYTE_RESERVATION)}\nUse the read tool on probe.txt, then reply with exactly ${MARKER} and nothing else.`;

const home = process.env.HOME;
const agent = join(home, ".pi", "agent");
const work = join(home, "work");
mkdirSync(agent, { recursive: true, mode: 0o700 });
mkdirSync(work, { recursive: true, mode: 0o700 });
chmodSync(join(home, ".pi"), 0o700);
chmodSync(agent, 0o700);
chmodSync(work, 0o700);
writeFileSync(join(work, "probe.txt"), "INCIDENT_PROBE\n", { mode: 0o600 });
writeFileSync(join(agent, "auth.json"), `${JSON.stringify({
  cursor: {
    type: "oauth",
    access: "fixture-cursor-access-not-a-secret",
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
  },
})}\n`, { mode: 0o600 });
writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always", packages: [] })}\n`, { mode: 0o600 });
writeFileSync(join(agent, "models-store.json"), `${JSON.stringify({
  cursor: {
    models: [{
      id: "cursor-grok-4.6",
      name: "Grok 4.6",
      provider: "cursor",
      api: "openai-completions",
      baseUrl: "https://cursor.invalid/v1",
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  },
})}\n`, { mode: 0o600 });
writeFileSync(join(agent, "models.json"), `${JSON.stringify({ providers: {} })}\n`, { mode: 0o600 });

const cursorModel = {
  provider: "cursor",
  id: "cursor-grok-4.6",
  name: "Grok 4.6",
  api: "openai-completions",
  baseUrl: "https://cursor.invalid/v1",
  contextWindow: 200_000,
  maxTokens: 8_192,
  reasoning: false,
  input: ["text"],
};

let dispatches = 0;
let leaseSnapshot;
const dbPath = () => join(agent, "delegation-broker", "broker.sqlite");
function snapshotLease() {
  const db = new DatabaseSync(dbPath());
  try {
    const lease = db.prepare("SELECT resource_id, enforcement, max_input_tokens FROM leases LIMIT 1").get();
    const resource = lease
      ? db.prepare("SELECT id, enforcement FROM resources WHERE id = ?").get(lease.resource_id)
      : db.prepare("SELECT id, enforcement FROM resources LIMIT 1").get();
    return { lease, resource };
  } finally {
    db.close();
  }
}

const providerTransport = {
  async *stream(_snapshot, context, { onSendStarted }) {
    dispatches += 1;
    if (!leaseSnapshot) leaseSnapshot = snapshotLease();
    onSendStarted();
    yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `incident-parent-${dispatches}` } };
    const replay = context.messages?.some((message) => message.role === "toolResult");
    if (!replay) {
      yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1", name: "read" } };
      yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"probe.txt"}' } };
      yield { type: "block_end", payload: { index: 0, value: '{"path":"probe.txt"}' } };
      yield {
        type: "terminal",
        outcome: "succeeded_terminal",
        payload: { finishReason: "tool_use", usage: { input: USED, output: 100 } },
      };
      return;
    }
    yield { type: "block_start", payload: { index: 0, blockType: "text" } };
    yield { type: "text_delta", payload: { index: 0, delta: MARKER } };
    yield { type: "block_end", payload: { index: 0, value: MARKER } };
    yield {
      type: "terminal",
      outcome: "succeeded_terminal",
      payload: { finishReason: "stop", usage: { input: OBSERVED_INPUT, output: OBSERVED_OUTPUT } },
    };
  },
};

const tools = new Map();
const hooks = new Map();
const eventListeners = new Map();
const pi = {
  events: {
    on(name, handler) { eventListeners.set(name, handler); },
    emit(name, payload) { eventListeners.get(name)?.(payload); },
  },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand() {},
  registerTool(definition) { tools.set(definition.name, definition); },
  sendUserMessage() {},
  sendMessage() {},
};
(await import(extensionPath)).default(pi);

const ctx = {
  cwd: work,
  modelRegistry: { getAll() { return [cursorModel]; } },
  ui: { notify() {} },
  events: pi.events,
  controllerProvider: {
    providerTransport,
    routePreflight: async () => ({ status: "ready" }),
    routeResolver: async () => ({
      registryFingerprint: "a".repeat(64),
      registryVersion: 1,
      accountAlias: "cursor",
      provider: "cursor",
      model: "cursor-grok-4.6",
      reasoningEffort: "off",
      apiDialect: "fixture",
      endpointId: "fixture-incident-parent",
      adapterId: "fixture-adapter",
      credentialRefFingerprint: "b".repeat(64),
      cacheRetention: "none",
    }),
  },
};

await hooks.get("session_start")?.({}, ctx);
const delegate = tools.get("delegate");
assert.ok(delegate, "parent extension must register delegate");
const result = await delegate.execute(
  "incident-parent-tool",
  {
    task: PROMPT,
    wait: true,
    tier: "cheap",
    capabilities: ["text_generation"],
    deadlineMs: 90_000,
  },
  new AbortController().signal,
  undefined,
  ctx,
);

if (result.isError) {
  throw new Error(`parent observe delegate failed: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
}

const text = result.content?.[0]?.text?.trim() ?? "";
assert.equal(text, MARKER, text);
assert.equal(dispatches, 2, "observe default must send the seeded turn and the oversized follow-up");
assert.ok(leaseSnapshot?.lease, "lease must be visible while the fixture stream runs");
assert.deepEqual(JSON.parse(leaseSnapshot.lease.enforcement), { input: "metered_best_effort", output: "hard" });
assert.equal(leaseSnapshot.lease.max_input_tokens, CAP);
assert.equal(JSON.parse(leaseSnapshot.resource.enforcement).input, "hard");

await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({
  marker: text,
  dispatches,
  leaseEnforcement: JSON.parse(leaseSnapshot.lease.enforcement),
  resourceEnforcement: JSON.parse(leaseSnapshot.resource.enforcement),
  maxInputTokens: leaseSnapshot.lease.max_input_tokens,
}));
