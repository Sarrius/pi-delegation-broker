/**
 * Parent-side Pi extension for the delegation broker.
 *
 * Registers a `delegate` tool that sends a self-contained subtask to an isolated brokered
 * child agent. The broker — not this extension, not the child — decides which account and
 * model the child runs on:
 *
 * - The capability selector picks the weakest sufficient model class for the task.
 * - The broker leases one live resource in that class (escalating upward when the cheap
 *   class is throttled, never downward).
 * - The child authenticates with exactly the leased account's credential, written into its
 *   owner-only agent dir by the resolver's provisioning hook. It never sees this session's
 *   other accounts.
 * - A provider failure mid-task is reported to the broker, the account cools down, and the
 *   task is retried on another account automatically.
 * - The provider catalog is watched live: logging into a new account makes it delegable
 *   without a restart.
 *
 * State (broker database, child agent dirs, sessions) lives in
 * ~/.pi/agent/delegation-broker/ and is owner-only.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — the broker is plain .mjs with no type declarations
import {
  BrokeredChildRunner,
  BrokeredLaunchResolver,
  ControllerAcceptanceVerifier,
  ControllerEvidenceStore,
  ControllerQueuedTaskVerifier,
  ControllerVerificationAuthority,
  ControllerVerifiedRoutingBoard,
  ModelAffinityJournal,
  RoutingBoard,
  SingleHostBrokerSupervisor,
  buildCurrencyMap,
  createSelectContract,
  createControllerVerifierRunId,
  DEFAULT_MODEL_PREFERENCES,
  loadModelPreferences,
  parseResourceModel,
  probeProviderModels,
  readProviderRegistry,
  writeModelPreferences,
  signedRegistryMessage,
  requestBrokerIpc,
  writeScopedChildAuth,
  // @ts-expect-error — resolved relative to this file's real location
} from "../src/index.mjs";

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const EXTENSIONS_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD_SHIM_PATH = join(EXTENSIONS_DIR, "child-shim.ts");
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(PARENT_AGENT_DIR, "delegation-broker");
const KEYS_PATH = join(STATE_DIR, "registry-keys.json");
const PREFERENCES_PATH = join(STATE_DIR, "preferences.json");
const ENABLED_PATH = join(STATE_DIR, "enabled.json");
const REGISTRY_KEY_ID = "controller";
const CURRENCY_REFRESH_MS = 15 * 60 * 1_000;

const CAPABILITIES = ["text_generation", "code_reasoning", "large_context", "vision_input"] as const;

const DELEGATE_PARAMS = Type.Object({
  task: Type.String({
    description: "Complete, self-contained instruction for the child agent. Include everything it needs: file paths, what to read, what to produce. The child sees none of this conversation.",
  }),
  capabilities: Type.Optional(Type.Array(StringEnum([...CAPABILITIES]), {
    description: "Capability requirements if known (e.g. large_context for whole-repo analysis, vision_input for images). Omit to let the selector infer from the task text.",
  })),
  tier: Type.Optional(StringEnum(["cheap", "standard", "frontier"] as const, {
    description: "Optional user task level. Omit for controller inference; frontier respects ~/.pi/agent/delegation-broker/preferences.json.",
  })),
  acceptance: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ description: "Stable controller check id." }),
    claim: Type.String({ description: "Controller-verifiable acceptance claim." }),
    argv: Type.Array(Type.String({ description: "One literal argv token; no shell syntax." }), { minItems: 1, maxItems: 32 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
  }), { minItems: 1, maxItems: 20, description: "Fixed controller-owned checks. Omit when no independent acceptance check exists; such work cannot train routing affinity." })),
});

interface BrokerRuntime {
  supervisor: any;
  runner: any;
  acceptancePlans: Map<string, Array<{ id: string; claim: string; argv: string[]; timeoutMs: number }>>;
  stopCurrencyRefresh: () => void;
}

function runControllerArgv(argv: string[], cwd: string, signal: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(0, 32_000); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(0, 32_000); });
    child.once("error", (error) => resolve({ exitCode: 127, stdout, stderr: String(error.message).slice(0, 32_000) }));
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function loadOrCreateRegistryKeys(): { publicKey: string; privateKey: string } {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const saved = JSON.parse(readFileSync(KEYS_PATH, "utf8"));
    if (typeof saved.publicKey === "string" && typeof saved.privateKey === "string") return saved;
  } catch { /* first run or unreadable — generate fresh */ }
  const pair = generateKeyPairSync("ed25519");
  const keys = {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
  writeFileSync(KEYS_PATH, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function readJson(path: string): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function readEnabled() { return readJson(ENABLED_PATH).enabled !== false; }
function writeEnabled(enabled: boolean) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(ENABLED_PATH, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
}

function registryModels(registry: any): Array<{ provider: string; modelId: string }> {
  return Object.entries(registry.resources ?? {})
    .map(([resourceId, resource]: [string, any]) => resource?.model ?? parseResourceModel(resourceId))
    .filter((model: any) => model?.provider && model?.modelId);
}

/** Controller-only probe routes. These are API endpoints, not model allow-lists. */
function probeRoutes(registry: any) {
  const auth = readJson(join(PARENT_AGENT_DIR, "auth.json"));
  const store = readJson(join(PARENT_AGENT_DIR, "models-store.json"));
  const configured = readJson(join(PARENT_AGENT_DIR, "models.json")).providers ?? {};
  const routes = new Map<string, { baseUrl: string; apiKey: string }>();
  for (const { provider } of registryModels(registry)) {
    if (routes.has(provider)) continue;
    const credential = auth[provider];
    if (credential?.type !== "api_key" || typeof credential.key !== "string" || !credential.key) continue;
    const base = provider.replace(/-account-\d+$/, "");
    const firstModel = store[provider]?.models?.[0] ?? store[base]?.models?.[0];
    let baseUrl = configured[provider]?.baseUrl ?? configured[base]?.baseUrl ?? firstModel?.baseUrl;
    // These Pi routes speak a different inference dialect from their model-list endpoint.
    // The values were verified against the providers' live APIs; they contain no model policy.
    if (provider === "ollama") baseUrl = "https://ollama.com/v1";
    if (provider === "minimax") baseUrl = "https://api.minimax.io/v1";
    if (provider === "kimi-coding") baseUrl = "https://api.kimi.com/coding/v1";
    if (provider === "zai") baseUrl = "https://api.z.ai/api/paas/v4";
    if (typeof baseUrl === "string" && baseUrl.startsWith("https://")) routes.set(provider, { baseUrl, apiKey: credential.key });
  }
  return routes;
}

async function startBroker(): Promise<BrokerRuntime> {
  if (!existsSync(PREFERENCES_PATH)) writeModelPreferences(PREFERENCES_PATH, DEFAULT_MODEL_PREFERENCES);
  const keys = loadOrCreateRegistryKeys();
  const registry = readProviderRegistry(PARENT_AGENT_DIR);
  const now = Date.now();
  const payload = {
    registryVersion: `session-${now}`,
    issuedAt: now - 1_000,
    expiresAt: now + 24 * 60 * 60 * 1_000,
    ...registry,
  };
  const unsigned = { schemaVersion: 2, keyId: REGISTRY_KEY_ID, registry: payload };
  const signedRegistry = {
    ...unsigned,
    signature: sign(null, signedRegistryMessage(unsigned), keys.privateKey).toString("base64url"),
  };

  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: STATE_DIR,
    signedRegistry,
    trustedRegistryKeys: { [REGISTRY_KEY_ID]: keys.publicKey },
    dynamicProviders: true,
    sweepIntervalMs: 1_000,
  });
  await supervisor.start();
  const acceptancePlans = new Map<string, Array<{ id: string; claim: string; argv: string[]; timeoutMs: number }>>();
  const evidenceStore = new ControllerEvidenceStore({ root: join(STATE_DIR, "verification-evidence") });
  const verificationAuthority = new ControllerVerificationAuthority({ evidenceStore });
  const affinityJournal = new ModelAffinityJournal({ path: join(STATE_DIR, "model-affinity.json") });
  const verifiedRouting = new ControllerVerifiedRoutingBoard({
    routingBoard: new RoutingBoard(), verificationAuthority, affinityJournal,
  });
  const queuedTaskVerifier = new ControllerQueuedTaskVerifier({
    authority: verificationAuthority,
    createVerifier: async ({ taskId }: { taskId: string }) => {
      const plan = acceptancePlans.get(taskId);
      if (!plan) throw new Error("no controller acceptance plan registered for tracked task");
      return new ControllerAcceptanceVerifier({
        evidenceStore,
        checks: plan.map(({ id, claim, timeoutMs }) => ({ id, claim, kind: "command", timeoutMs })),
        runCheck: (check: { id: string }, { signal }: { signal: AbortSignal }) => {
          const item = plan.find((entry) => entry.id === check.id);
          if (!item) throw new Error("controller acceptance plan check missing");
          return runControllerArgv(item.argv, PARENT_AGENT_DIR, signal);
        },
      });
    },
    finalize: ({ taskId, leaseId, fencingToken, verification }: any) => requestBrokerIpc({
      socketPath: supervisor.socketPath, authorization: supervisor.controllerToken,
      method: "finalizeVerifiedTask", params: { taskId, leaseId, fencingToken, verification },
    }),
    onFinalized: ({ taskId, leaseId, fencingToken, verification, outcome, routingObservation }: any) => {
      if (!routingObservation) return { status: "not_recorded" };
      return verifiedRouting.recordFinalized({ taskId, leaseId, fencingToken, verification, outcome,
        resourceId: routingObservation.resourceId, capabilities: routingObservation.capabilities,
        latencyMs: routingObservation.latencyMs });
    },
  });

  // The catalog says what Pi knows; the probe says what providers still offer and when each
  // release appeared. Keep credentials here in the controller only — the currency map passed
  // to the selector contains model ids, dates and booleans, never secrets.
  const liveListings = new Map<string, Map<string, number | undefined>>();
  const refreshCurrency = async () => {
    const currentRegistry = supervisor.providerWatcher.currentRegistry();
    const routes = probeRoutes(currentRegistry);
    await Promise.all([...routes].map(async ([provider, route]) => {
      const result = await probeProviderModels({ baseUrl: route.baseUrl, apiKey: route.apiKey });
      if (result.status !== "ok") return; // retain prior listing; an outage is not a delisting
      liveListings.set(provider, new Map(result.models.map((id: string) => [id, result.created?.[id]])));
    }));
  };
  await refreshCurrency().catch(() => undefined);
  const currencyTimer = setInterval(() => { refreshCurrency().catch(() => undefined); }, CURRENCY_REFRESH_MS);
  currencyTimer.unref?.();
  const currency = () => buildCurrencyMap({
    resources: registryModels(supervisor.providerWatcher.currentRegistry()),
    liveListings,
  });

  const baseSelectContract = createSelectContract({
    registry: () => supervisor.providerWatcher.currentRegistry(),
    availability: () => supervisor.inventory(),
    currency,
    preferences: () => loadModelPreferences(PREFERENCES_PATH),
    learnedRanker: (input: any) => affinityJournal.rank(input),
    enforceQuality: true,
  });
  const resolver = new BrokeredLaunchResolver({
    socketPath: supervisor.socketPath,
    controllerToken: supervisor.controllerToken,
    agentRoot: join(STATE_DIR, "child-agents"),
    extensionPaths: [CHILD_SHIM_PATH],
    offline: false,
    selectContract: (request: any) => {
      const selected = baseSelectContract(request);
      return acceptancePlans.has(request.childId) ? { ...selected, trackImmediateTask: true } : selected;
    },
    queuedTaskVerifier,
    trackImmediateTasks: true,
    resolveModelForResource: parseResourceModel,
    provisionChildAuth: ({ agentDir, model }: { agentDir: string; model?: { provider: string; modelId: string } }) => {
      if (!model?.provider) throw new Error("broker leased a resource with no resolvable model");
      return writeScopedChildAuth({ agentDir, provider: model.provider, parentAgentDir: PARENT_AGENT_DIR });
    },
  });

  const runner = new BrokeredChildRunner({
    resolver,
    sessionsRoot: join(STATE_DIR, "sessions"),
  });

  return {
    supervisor,
    runner,
    acceptancePlans,
    stopCurrencyRefresh: () => clearInterval(currencyTimer),
  };
}

export default function piDelegationBroker(pi: any) {
  let runtime: BrokerRuntime | undefined;
  let starting: Promise<BrokerRuntime> | undefined;
  let enabled = readEnabled();
  let counter = 0;

  const ensureBroker = (): Promise<BrokerRuntime> => {
    if (runtime) return Promise.resolve(runtime);
    starting ??= startBroker()
      .then((started) => { runtime = started; return started; })
      .catch((error) => { starting = undefined; throw error; });
    return starting;
  };

  pi.on("session_start", () => {
    ensureBroker().catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    starting = undefined;
    if (!current) return;
    current.stopCurrencyRefresh();
    await current.runner.dispose().catch(() => undefined);
    await current.supervisor.stop().catch(() => undefined);
  });

  pi.registerCommand("delegation-broker", {
    description: "Control the delegation broker: /delegation-broker start|stop|status",
    handler: async (args: string, ctx: any) => {
      const action = args.trim().toLowerCase();
      if (action === "start") {
        enabled = true;
        writeEnabled(true);
        await ensureBroker().catch(() => undefined);
        ctx.ui.notify("Delegation broker enabled", "info");
        return;
      }
      if (action === "stop") {
        enabled = false;
        writeEnabled(false);
        ctx.ui.notify("Delegation broker stopped: no new children will launch; running children may finish", "info");
        return;
      }
      if (action === "status") {
        const preferences = loadModelPreferences(PREFERENCES_PATH);
        const state = runtime ? runtime.supervisor.status().state : "not_started";
        ctx.ui.notify(`Delegation broker: ${enabled ? "enabled" : "stopped"}; runtime: ${state}; frontier preferences: ${preferences.tiers.frontier.length}; standard: ${preferences.tiers.standard.length}; cheap: ${preferences.tiers.cheap.length}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /delegation-broker start|stop|status", "warning");
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate subtask",
    description:
      "Delegate a self-contained subtask to an isolated brokered child agent. "
      + "The broker selects the cheapest sufficient model/account, spawns an isolated Pi child with only that account's credential, "
      + "and retries on another account if the provider throttles mid-task. Returns the child's final answer.",
    promptSnippet: "Delegate a self-contained subtask to an isolated brokered child agent",
    promptGuidelines: [
      "Use delegate when a subtask is self-contained: reading or summarizing files, answering a focused question, drafting text that does not need this conversation's context.",
      "Do not use delegate for work that needs this conversation's history, your judgement about the user's intent, or edits to the user's project — children are observe-class and cannot apply changes.",
      "Write the delegate task as a complete brief: the child sees nothing of this conversation, so include file paths, context, and exactly what output you expect.",
    ],
    parameters: DELEGATE_PARAMS,
    async execute(_toolCallId: string, params: { task: string; capabilities?: string[]; tier?: "cheap" | "standard" | "frontier"; acceptance?: Array<{ id: string; claim: string; argv: string[]; timeoutMs?: number }> }, _signal: AbortSignal, onUpdate: any, ctx: any) {
      if (!enabled) {
        return { content: [{ type: "text", text: "Delegation broker is stopped. Run /delegation-broker start to allow new children." }], isError: true };
      }
      let broker: BrokerRuntime;
      try {
        broker = await ensureBroker();
      } catch (error) {
        return {
          content: [{ type: "text", text: `Delegation unavailable: broker failed to start (${(error as Error).message})` }],
          isError: true,
        };
      }

      const childId = `delegate-${Date.now().toString(36)}-${++counter}`;
      const promptDigest = createHash("sha256").update(params.task).digest("hex");
      if (params.acceptance) broker.acceptancePlans.set(childId, params.acceptance.map((check) => ({ ...check, timeoutMs: check.timeoutMs ?? 30_000 })));
      onUpdate?.({ content: [{ type: "text", text: "Selecting model and spawning child…" }] });

      const result = await broker.runner.run({
        childId,
        promptDigest,
        cwd: ctx.cwd,
        thinkingLevel: "off",
        prompt: params.task,
        capabilityRequest: {
          taskDescription: params.task,
          ...(params.capabilities?.length ? { requiredCapabilities: params.capabilities } : {}),
          ...(params.tier ? { modelTier: params.tier } : {}),
        },
      });

      broker.acceptancePlans.delete(childId);
      const route = (result.route ?? [])
        .map((hop: any) => `${hop.outcome}${hop.resourceId ? ` ${hop.resourceId}` : ""}`)
        .join(" → ");

      if (result.status === "completed") {
        const usage = result.usage ? ` (${result.usage.input} in / ${result.usage.output} out)` : "";
        return {
          content: [{ type: "text", text: result.text }],
          details: { route, usage: result.usage, note: `Completed via ${route}${usage}` },
        };
      }
      return {
        content: [{
          type: "text",
          text: `Delegation failed after ${(result.route ?? []).length} attempt(s): ${result.error ?? "unknown error"}${route ? `\nRoute: ${route}` : ""}`,
        }],
        isError: true,
        details: { route },
      };
    },
  });
}
