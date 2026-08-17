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
  addModelPreference,
  ControllerAcceptanceVerifier,
  ControllerEvidenceStore,
  ControllerQueuedTaskVerifier,
  ControllerVerificationAuthority,
  ControllerVerifiedRoutingBoard,
  ModelAffinityJournal,
  RoutingBoard,
  RoutingAuditJournal,
  TaskOrchestrator,
  SingleHostBrokerSupervisor,
  buildCurrencyMap,
  createSelectContract,
  createControllerVerifierRunId,
  DEFAULT_MODEL_PREFERENCES,
  loadModelPreferences,
  qualityForModel,
  parseResourceModel,
  probeProviderModels,
  readCurrencyCache,
  readProviderRegistry,
  writeModelPreferences,
  signedRegistryMessage,
  requestBrokerIpc,
  removeModelPreference,
  listingsFromCache,
  verifyProposedPatch,
  writeCurrencyCache,
  writeScopedChildAuth,
  // @ts-expect-error — resolved relative to this file's real location
} from "../src/index.mjs";

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const EXTENSIONS_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD_SHIM_PATH = join(EXTENSIONS_DIR, "child-shim.ts");
const BEHAVIORAL_ENFORCEMENT_PATH = join(EXTENSIONS_DIR, "pi-behavioral-enforcement.ts");
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(PARENT_AGENT_DIR, "delegation-broker");
const KEYS_PATH = join(STATE_DIR, "registry-keys.json");
const PREFERENCES_PATH = join(STATE_DIR, "preferences.json");
const ENABLED_PATH = join(STATE_DIR, "enabled.json");
const CURRENCY_CACHE_PATH = join(STATE_DIR, "currency-cache.json");
const ROUTING_AUDIT_PATH = join(STATE_DIR, "routing-audit.json");
const REGISTRY_KEY_ID = "controller";
const CURRENCY_REFRESH_MS = 15 * 60 * 1_000;
const CURRENCY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const CAPABILITIES = ["text_generation", "code_reasoning", "large_context", "vision_input"] as const;

const WORKFLOW_NODE = Type.Object({
  id: Type.String({ description: "Stable workflow node id." }),
  task: Type.String({ description: "Self-contained child instruction for this stage." }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
  capabilities: Type.Optional(Type.Array(StringEnum([...CAPABILITIES]))),
  tier: Type.Optional(StringEnum(["cheap", "standard", "frontier"] as const)),
});
const WORKFLOW_PARAMS = Type.Object({
  nodes: Type.Array(WORKFLOW_NODE, { minItems: 1, maxItems: 1000 }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
});

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
  proposeChangesIn: Type.Optional(Type.String({
    description: "Absolute path to a git repository the child may edit. The child works in a throwaway worktree; the controller verifies the resulting patch in a scratch tree and returns it for review. Requires acceptance checks. Nothing is applied to this repository.",
  })),
});

interface BrokerRuntime {
  supervisor: any;
  runner: any;
  acceptancePlans: Map<string, Array<{ id: string; claim: string; argv: string[]; timeoutMs: number }>>;
  stopCurrencyRefresh: () => void;
  lastRoute?: { summary: string; at: number };
  routingAudit: any;
}

function formatPreferences(tier: string) {
  const preferences = loadModelPreferences(PREFERENCES_PATH);
  const entries = preferences.tiers[tier as "frontier" | "standard" | "cheap"];
  return entries.length
    ? entries.map((entry) => `${entry.model} via ${entry.via.join(", ")}`).join("\n")
    : `(no explicit ${tier} preferences; controller auto-selection applies)`;
}

function explainRoute(result: any) {
  const selection = result?.selection ?? {};
  const spent = result?.resource?.id ?? (result?.resolved?.provider && result?.resolved?.modelId ? `${result.resolved.provider}/${result.resolved.modelId}` : "unknown");
  const hops = Array.isArray(result?.route) ? result.route : [];
  const prior = hops.slice(0, -1).map((hop: any) => `${hop.resourceId ?? "unknown"}:${hop.outcome}`).join(", ");
  const fields = [
    `tier=${selection.modelTier ?? "unknown"}`,
    `source=${selection.preferenceSource ?? "unknown"}`,
    `leased=${spent}`,
    `candidates=${selection.candidateCount ?? "unknown"}`,
  ];
  if (selection.legacyExcluded === true) fields.push("legacy=current policy excluded legacy candidates");
  if (selection.legacyFallback === true) fields.push("legacy=emergency fallback");
  if (prior) fields.push(`failover=${prior}`);
  return fields.join("; ");
}

function formatModels(registry: any, inventory: any[] | undefined, providerFilter?: string) {
  const health = new Map((inventory ?? []).map((row: any) => [row.resourceId, row]));
  const resources = Object.entries(registry?.resources ?? {}).map(([resourceId, resource]: [string, any]) => {
    const model = resource?.model ?? parseResourceModel(resourceId);
    const live = health.get(resourceId);
    return { resourceId, model, live };
  }).filter((entry) => !providerFilter || entry.model?.provider === providerFilter);
  if (providerFilter) {
    const lines = resources.slice(0, 80).map(({ resourceId, model, live }) => {
      const quality = model ? qualityForModel(model) ?? "unrated" : "unknown";
      const state = live ? `${live.state}/${live.breakerState}${live.groupCooldownUntil > Date.now() ? " cooldown" : ""}` : "catalog-only";
      return `${resourceId} | ${quality} | ${state} | ${live ? `${live.activeLeases}/${live.maxConcurrent}` : "-"}`;
    });
    return lines.length ? `${providerFilter}:\n${lines.join("\n")}${resources.length > lines.length ? `\n… ${resources.length - lines.length} more` : ""}` : `No catalog resources for provider ${providerFilter}.`;
  }
  const summary = new Map<string, { total: number; healthy: number; cooling: number; quality: Record<string, number> }>();
  for (const { model, live } of resources) {
    const provider = model?.provider ?? "unknown";
    const entry = summary.get(provider) ?? { total: 0, healthy: 0, cooling: 0, quality: {} };
    entry.total += 1;
    if (live?.state === "healthy" && live?.breakerState === "healthy") entry.healthy += 1;
    if (live?.breakerState === "cooling_down" || live?.state !== "healthy") entry.cooling += 1;
    const quality = model ? qualityForModel(model) ?? "unrated" : "unknown";
    entry.quality[quality] = (entry.quality[quality] ?? 0) + 1;
    summary.set(provider, entry);
  }
  return [...summary.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([provider, entry]) => {
    const qualities = Object.entries(entry.quality).sort(([left], [right]) => left.localeCompare(right)).map(([quality, count]) => `${quality}:${count}`).join(", ");
    return `${provider}: ${entry.total} models; healthy ${entry.healthy}; cooling/unavailable ${entry.cooling}; ${qualities}`;
  }).join("\n") || "No catalog resources available.";
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

  // Built before the supervisor: the broker refuses to make any task terminal unless a receipt
  // authenticates against this authority, so it has to exist at supervisor construction.
  const evidenceStore = new ControllerEvidenceStore({ root: join(STATE_DIR, "verification-evidence") });
  const verificationAuthority = new ControllerVerificationAuthority({ evidenceStore });
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: STATE_DIR,
    // Without this the controller token alone would be trusted, and every verified completion
    // would be denied instead — the acceptance path would exist but never finish a task.
    verificationReceiptVerifier: (receipt: any, binding: any) => verificationAuthority.verify(receipt, binding),
    // Every child is launched with the attested behavioral enforcement extension, which is what
    // makes effect-capable contracts admissible at all.
    behavioralEnforcement: "blocking_monitor",
    signedRegistry,
    trustedRegistryKeys: { [REGISTRY_KEY_ID]: keys.publicKey },
    dynamicProviders: true,
    sweepIntervalMs: 1_000,
  });
  await supervisor.start();
  const acceptancePlans = new Map<string, Array<{ id: string; claim: string; argv: string[]; timeoutMs: number }>>();
  const affinityJournal = new ModelAffinityJournal({ path: join(STATE_DIR, "model-affinity.json") });
  const routingAudit = new RoutingAuditJournal({ path: ROUTING_AUDIT_PATH });
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
        latencyMs: routingObservation.latencyMs,
        ...(routingObservation.tokens === undefined ? {} : { tokens: routingObservation.tokens }),
        ...(routingObservation.attempts === undefined ? {} : { attempts: routingObservation.attempts }) });
    },
  });

  // The catalog says what Pi knows; the probe says what providers still offer and when each
  // release appeared. Keep credentials here in the controller only — the currency map passed
  // to the selector contains model ids, dates and booleans, never secrets.
  const liveListings = new Map<string, Map<string, number | undefined>>();
  // Reuse only a recent successful listing after restart. It is an availability hint, never a
  // credential proof; the next live probe replaces it and stale cache is deliberately ignored.
  const cachedCurrency = readCurrencyCache(CURRENCY_CACHE_PATH);
  if (cachedCurrency && Number.isSafeInteger(cachedCurrency.probedAt) && Date.now() - cachedCurrency.probedAt <= CURRENCY_CACHE_MAX_AGE_MS) {
    for (const [provider, ids] of listingsFromCache(cachedCurrency)) {
      liveListings.set(provider, new Map([...ids].map((id) => [id, undefined])));
    }
  }
  const currency = () => buildCurrencyMap({
    resources: registryModels(supervisor.providerWatcher.currentRegistry()),
    liveListings,
  });
  const refreshCurrency = async () => {
    const currentRegistry = supervisor.providerWatcher.currentRegistry();
    const routes = probeRoutes(currentRegistry);
    const successfullyRefreshed = new Map<string, Map<string, number | undefined>>();
    await Promise.all([...routes].map(async ([provider, route]) => {
      const result = await probeProviderModels({ baseUrl: route.baseUrl, apiKey: route.apiKey });
      if (result.status !== "ok") {
        // A listing outage is not a delisting. Only controller-observed credential denial or
        // throttling changes broker health; transport failures retain the prior route state.
        if (result.status === "http_error" && (result.code === 401 || result.code === 403 || result.code === 429)) {
          const resources = Object.entries(currentRegistry.resources ?? {})
            .filter(([resourceId, resource]: [string, any]) => (resource.model ?? parseResourceModel(resourceId))?.provider === provider);
          await Promise.all(resources.map(([resourceId]) => requestBrokerIpc({
            socketPath: supervisor.socketPath, authorization: supervisor.controllerToken,
            method: result.code === 429 ? "markRateLimited" : "markUnknown",
            params: result.code === 429 ? { resourceId } : { resourceId, reason: "controller provider listing credential denied" },
          })));
        }
        return;
      }
      const listing = new Map(result.models.map((id: string) => [id, result.created?.[id]]));
      liveListings.set(provider, listing);
      successfullyRefreshed.set(provider, listing);
    }));
    // Persist only facts freshly observed in this pass. A provider that is currently unreachable
    // cannot refresh its old cache timestamp into a false declaration of liveness.
    if (successfullyRefreshed.size > 0) writeCurrencyCache(CURRENCY_CACHE_PATH, successfullyRefreshed);
    // Metrics cannot change selection. If the local journal is unavailable, the fresh probe
    // facts still route normally and are retried next refresh.
    try { routingAudit.recordCurrency(currency()); } catch { /* observability is best effort */ }
  };
  await refreshCurrency().catch(() => undefined);
  const currencyTimer = setInterval(() => { refreshCurrency().catch(() => undefined); }, CURRENCY_REFRESH_MS);
  currencyTimer.unref?.();
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
    extensionPaths: [CHILD_SHIM_PATH, BEHAVIORAL_ENFORCEMENT_PATH],
    launcherAttestationConfig: {
      behavioralExtensionPath: BEHAVIORAL_ENFORCEMENT_PATH,
      trustedExtensionDigests: [CHILD_SHIM_PATH, BEHAVIORAL_ENFORCEMENT_PATH]
        .map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
    },
    offline: false,
    // Tracking happens only after the runner knows which failover attempt actually completed.
    // Marking the first attempt here could verify stale work before a later route succeeds.
    selectContract: (request: any) => baseSelectContract(request),
    queuedTaskVerifier,
    trackImmediateTasks: false,
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
    lastRoute: undefined,
    routingAudit,
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
    description: "Control delegation: start|stop|status|models [provider]|tier <frontier|standard|cheap> <list|add|remove>",
    handler: async (args: string, ctx: any) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = (tokens[0] ?? "").toLowerCase();
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
        const last = runtime?.lastRoute ? ` Last route: ${runtime.lastRoute.summary}` : "";
        const metrics = runtime?.routingAudit?.summary?.().metrics;
        const audit = metrics ? ` Audit: ${metrics.routes} routes, ${metrics.failovers} failovers, ${metrics.legacyTransitions} legacy transitions.` : "";
        ctx.ui.notify(`Delegation broker: ${enabled ? "enabled" : "stopped"}; runtime: ${state}; frontier preferences: ${preferences.tiers.frontier.length}; standard: ${preferences.tiers.standard.length}; cheap: ${preferences.tiers.cheap.length}.${audit}${last} Use /delegation-broker models [provider] or tier <tier> <list|add|remove>.`, "info");
        return;
      }
      if (action === "models") {
        const provider = tokens[1];
        const active = runtime;
        const catalog = active?.supervisor.providerWatcher?.currentRegistry?.() ?? readProviderRegistry(PARENT_AGENT_DIR);
        const inventory = active ? active.supervisor.inventory() : undefined;
        const prefix = active ? "Live broker inventory" : "Catalog only (broker is not running)";
        ctx.ui.notify(`${prefix}:\n${formatModels(catalog, inventory, provider)}`, "info");
        return;
      }
      if (action === "tier") {
        const tier = tokens[1];
        const verb = tokens[2]?.toLowerCase();
        if (!tier || !verb || !["frontier", "standard", "cheap"].includes(tier)) {
          ctx.ui.notify("Usage: /delegation-broker tier <frontier|standard|cheap> <list|add|remove> [model] [provider ...]", "warning");
          return;
        }
        if (verb === "list") {
          ctx.ui.notify(`${tier} preferences:\n${formatPreferences(tier)}`, "info");
          return;
        }
        const model = tokens[3];
        const via = tokens.slice(4);
        try {
          if (verb === "add") {
            if (!model || via.length === 0) throw new Error("add requires a model and at least one provider pattern");
            const updated = addModelPreference(loadModelPreferences(PREFERENCES_PATH), { tier, model, via });
            writeModelPreferences(PREFERENCES_PATH, updated);
            ctx.ui.notify(`Saved ${tier} preference: ${model} via ${via.join(", ")}.`, "info");
            return;
          }
          if (verb === "remove") {
            if (!model) throw new Error("remove requires a model; omit providers to remove the model completely");
            const updated = removeModelPreference(loadModelPreferences(PREFERENCES_PATH), { tier, model, ...(via.length ? { via } : {}) });
            writeModelPreferences(PREFERENCES_PATH, updated);
            ctx.ui.notify(`Updated ${tier} preferences: removed ${model}${via.length ? ` via ${via.join(", ")}` : ""}.`, "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`Preference update rejected: ${(error as Error).message}`, "error");
          return;
        }
        ctx.ui.notify("Usage: /delegation-broker tier <tier> list | add <model> <provider...> | remove <model> [provider...]", "warning");
        return;
      }
      ctx.ui.notify("Usage: /delegation-broker start|stop|status|models [provider]|tier <tier> <list|add|remove>", "warning");
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate subtask",
    description:
      "Delegate a self-contained subtask to an isolated brokered child agent. "
      + "The broker selects a current, quality-sufficient model/account and learns efficiency only from controller-verified outcomes, then spawns an isolated Pi child with only that account's credential, "
      + "and retries on another account if the provider throttles mid-task. Returns the child's final answer.",
    promptSnippet: "Delegate a self-contained subtask to an isolated brokered child agent",
    promptGuidelines: [
      "Use delegate when a subtask is self-contained: reading or summarizing files, answering a focused question, drafting text that does not need this conversation's context.",
      "Do not use delegate for work that needs this conversation's history or your judgement about the user's intent.",
      "To get a code change, pass proposeChangesIn with the repository path and acceptance checks: the child edits an isolated worktree and the controller returns a verified patch that you or the user still have to apply.",
      "Write the delegate task as a complete brief: the child sees nothing of this conversation, so include file paths, context, and exactly what output you expect.",
    ],
    parameters: DELEGATE_PARAMS,
    async execute(_toolCallId: string, params: { task: string; capabilities?: string[]; tier?: "cheap" | "standard" | "frontier"; acceptance?: Array<{ id: string; claim: string; argv: string[]; timeoutMs?: number }>; proposeChangesIn?: string }, _signal: AbortSignal, onUpdate: any, ctx: any) {
      // An effect nobody can check is not delegable: without controller-owned checks the only
      // evidence a patch is good would be the child's own word for it.
      if (params.proposeChangesIn && !params.acceptance?.length) {
        return {
          content: [{ type: "text", text: "proposeChangesIn requires at least one acceptance check: the controller must be able to verify the proposed patch itself." }],
          isError: true,
        };
      }
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

      let result: any;
      try {
        result = await broker.runner.run({
          childId,
          promptDigest,
          // Preserve one logical controller task id across provider failover. The resolver
          // tracks only the terminal successful attempt under this id, which finds this plan.
          trackForVerification: Boolean(params.acceptance?.length && !params.proposeChangesIn),
          cwd: params.proposeChangesIn ?? ctx.cwd,
          ...(params.proposeChangesIn ? { isolation: "worktree" as const } : {}),
          thinkingLevel: "off",
          prompt: params.task,
          capabilityRequest: {
            taskId: childId,
            taskDescription: params.task,
            ...(params.proposeChangesIn ? { operationClass: "propose_patch" } : {}),
            ...(params.capabilities?.length ? { requiredCapabilities: params.capabilities } : {}),
            ...(params.tier ? { modelTier: params.tier } : {}),
          },
        });
      } finally {
        broker.acceptancePlans.delete(childId);
      }
      const route = (result.route ?? [])
        .map((hop: any) => `${hop.outcome}${hop.resourceId ? ` ${hop.resourceId}` : ""}`)
        .join(" → ");
      const routeExplanation = explainRoute(result);
      broker.lastRoute = { summary: routeExplanation, at: Date.now() };
      // Persist facts observed by the controller/runner, never a child narrative. A denied
      // attempt has no leased resource and is intentionally not fabricated into an audit route.
      try {
        if (result.resource?.id && Array.isArray(result.route) && result.route.length > 0
          && result.route.every((hop: any) => typeof hop.resourceId === "string")) {
          broker.routingAudit.recordRoute({
            status: result.status,
            resourceId: result.resource.id,
            selection: result.selection,
            route: result.route,
            usage: result.usage,
          });
        }
      } catch { /* audit storage must never change task completion semantics */ }

      if (result.status === "completed" && params.proposeChangesIn) {
        onUpdate?.({ content: [{ type: "text", text: "Verifying the proposed patch in a controller-owned scratch tree…" }] });
        const receipt = await verifyProposedPatch({
          repoCwd: params.proposeChangesIn,
          baseCommit: result.baseCommit,
          patch: result.patch,
          changed: result.changed,
          checks: params.acceptance!.map((check) => ({ id: check.id, claim: check.claim, argv: check.argv, timeoutMs: check.timeoutMs ?? 30_000 })),
        });
        const summary = receipt.checks.map((entry: any) => `${entry.ok ? "pass" : `fail(${entry.exitCode})`} ${entry.id}`).join(", ");
        if (!receipt.verified) {
          return {
            content: [{ type: "text", text: `Proposed change rejected by controller verification (${receipt.reason}).${summary ? `\nChecks: ${summary}` : ""}\nRoute: ${route}\nSelection: ${routeExplanation}` }],
            isError: true,
            details: { route, routeExplanation, receipt },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Controller-verified patch against ${receipt.baseCommit.slice(0, 12)} — NOT applied to ${params.proposeChangesIn}.\n`
              + `Files: ${receipt.changed.join(", ")}\nChecks: ${summary}\nRoute: ${route}\nSelection: ${routeExplanation}\n\n${result.patch}`,
          }],
          details: { route, routeExplanation, receipt, patch: result.patch, applied: false },
        };
      }

      if (result.status === "completed") {
        const usage = result.usage ? ` (${result.usage.input} in / ${result.usage.output} out)` : "";
        return {
          content: [{ type: "text", text: result.text }],
          details: { route, routeExplanation, usage: result.usage, note: `Completed via ${route}${usage}; ${routeExplanation}` },
        };
      }
      return {
        content: [{
          type: "text",
          text: `Delegation failed after ${(result.route ?? []).length} attempt(s): ${result.error ?? "unknown error"}${route ? `\nRoute: ${route}` : ""}\nSelection: ${routeExplanation}`,
        }],
        isError: true,
        details: { route, routeExplanation },
      };
    },
  });

  pi.registerTool({
    name: "delegate_workflow",
    label: "Delegate workflow",
    description: "Run a durable dependency graph of isolated brokered subtasks.",
    parameters: WORKFLOW_PARAMS,
    async execute(_id: string, params: { nodes: any[]; concurrency?: number }, _signal: AbortSignal, onUpdate: any, ctx: any) {
      if (!enabled) return { content: [{ type: "text", text: "Delegation broker is stopped." }], isError: true };
      const broker = await ensureBroker();
      const workflowId = `workflow-${Date.now().toString(36)}-${++counter}`;
      const orchestrator = new TaskOrchestrator({
        path: join(STATE_DIR, "workflows", `${workflowId}.json`), concurrency: params.concurrency ?? 4,
        run: async (node: any) => {
          const task = node.task;
          onUpdate?.({ content: [{ type: "text", text: `Running workflow stage ${node.id}…` }] });
          return broker.runner.run({ childId: `${workflowId}-${node.id}`, prompt: task, cwd: ctx.cwd, thinkingLevel: "off",
            promptDigest: createHash("sha256").update(task).digest("hex"),
            capabilityRequest: { taskDescription: task, ...(node.capabilities?.length ? { requiredCapabilities: node.capabilities } : {}), ...(node.tier ? { modelTier: node.tier } : {}) } });
        },
      });
      orchestrator.initialize(params.nodes);
      const state = await orchestrator.execute();
      const incomplete = state.nodes.filter((node: any) => node.state !== "completed");
      return { content: [{ type: "text", text: incomplete.length ? `Workflow ${workflowId} has ${incomplete.length} failed/blocked stages.` : `Workflow ${workflowId} completed.` }], isError: incomplete.length > 0, details: state };
    },
  });
}
