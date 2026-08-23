import { createHash } from "node:crypto";

export const MODEL_POLICY_VERSION = "subscription-native-current-only/v1";

const FIRST_PARTY_SUBSCRIPTIONS = Object.freeze({
  "openai-codex": "openai",
  anthropic: "anthropic",
  zai: "zai",
  "kimi-coding": "moonshot",
  minimax: "minimax",
  qwen: "alibaba",
});
const AGGREGATORS = new Set(["openrouter", "ollama", "opencode-go-api", "ollama-cloud"]);
const DIRECT_APIS = new Set(["openai"]);

export function baseRouteProvider(provider) {
  return typeof provider === "string" ? provider.replace(/-account-\d+$/, "") : "unknown";
}

export function providerClassFor(provider) {
  const base = baseRouteProvider(provider);
  if (Object.hasOwn(FIRST_PARTY_SUBSCRIPTIONS, base)) return "first_party_subscription";
  if (base === "cursor") return "mixed_subscription";
  if (AGGREGATORS.has(base)) return "aggregator";
  if (DIRECT_APIS.has(base)) return "direct_api";
  if (/^(local|localhost|ollama-local|vllm)/.test(base)) return "self_hosted";
  return "unknown";
}

function terminalModelId(modelId) {
  return String(modelId ?? "").toLowerCase().replace(/^~/, "").split("/").at(-1);
}

export function inferModelDeveloper(modelId) {
  const raw = String(modelId ?? "").toLowerCase().replace(/^~/, "");
  const namespace = raw.includes("/") ? raw.split("/")[0] : undefined;
  if (namespace) {
    const owners = {
      openai: "openai", anthropic: "anthropic", "x-ai": "xai", xai: "xai",
      "z-ai": "zai", zai: "zai", moonshotai: "moonshot", moonshot: "moonshot",
      minimax: "minimax", google: "google", deepseek: "deepseek", qwen: "alibaba",
    };
    if (owners[namespace]) return owners[namespace];
  }
  const id = terminalModelId(raw);
  if (/^(gpt-|o\d(?:-|$)|chatgpt-)/.test(id)) return "openai";
  if (/^claude-/.test(id)) return "anthropic";
  if (/^(cursor-)?grok-/.test(id)) return "xai";
  if (/^composer-/.test(id)) return "cursor";
  if (/^glm-/.test(id)) return "zai";
  if (/^(kimi-|k\d(?:-|$))/.test(id)) return "moonshot";
  if (/^minimax-/.test(id)) return "minimax";
  if (/^gemini-/.test(id)) return "google";
  if (/^deepseek-/.test(id)) return "deepseek";
  if (/^qwen/.test(id)) return "alibaba";
  return "unknown";
}

function cursorNativeModel(modelId) {
  const id = terminalModelId(modelId);
  return /^(cursor-grok-|grok-(4\.5|4\.6)(?:-|$)|composer-)/.test(id);
}

export function deriveModelProvenance({ provider, modelId } = {}) {
  const routeProvider = typeof provider === "string" ? provider : "unknown";
  const baseProvider = baseRouteProvider(routeProvider);
  const providerClass = providerClassFor(routeProvider);
  const modelDeveloper = inferModelDeveloper(modelId);
  const firstPartyOwner = FIRST_PARTY_SUBSCRIPTIONS[baseProvider];
  let nativeToRoute = false;
  let billingPool = "unknown";
  if (providerClass === "first_party_subscription") {
    nativeToRoute = modelDeveloper === firstPartyOwner;
    billingPool = nativeToRoute ? "native_subscription" : "third_party_subscription";
  } else if (providerClass === "mixed_subscription") {
    nativeToRoute = cursorNativeModel(modelId);
    billingPool = nativeToRoute ? "native_subscription" : "third_party_subscription";
  } else if (providerClass === "aggregator") {
    billingPool = "aggregator_payg";
  } else if (providerClass === "direct_api") {
    nativeToRoute = modelDeveloper === "openai";
    billingPool = "payg";
  } else if (providerClass === "self_hosted") {
    billingPool = "local";
  }
  return Object.freeze({
    providerClass,
    modelDeveloper,
    routeProvider,
    baseProvider,
    billingPool,
    nativeToRoute,
    source: MODEL_POLICY_VERSION,
  });
}

export function freshnessForCurrency(currencyFact) {
  if (!currencyFact || typeof currencyFact !== "object") return "unknown";
  if (currencyFact.listed === false || currencyFact.legacy === true || currencyFact.generation >= 2) return "deprecated";
  if (currencyFact.generation === 1) return "previous";
  if (currencyFact.generation === 0) return "current";
  return "unknown";
}

/** Hard eligibility. Ranking is forbidden until this controller policy returns eligible=true. */
export function evaluateRouteEligibility({
  identity, resource, currencyFact, explicitlyAllowed = false, requestedTier, meetsQuality = true,
} = {}) {
  const provenance = resource?.provenance ?? deriveModelProvenance(identity);
  const freshness = freshnessForCurrency(currencyFact);
  const reasons = [];
  if (freshness !== "current") reasons.push(`freshness_${freshness}`);
  if (!explicitlyAllowed) {
    if (!new Set(["first_party_subscription", "mixed_subscription"]).has(provenance.providerClass)) reasons.push("provider_not_subscription_native_default");
    if (provenance.billingPool !== "native_subscription" || provenance.nativeToRoute !== true) reasons.push("route_not_native_subscription_pool");
    if (!meetsQuality) reasons.push(`below_${requestedTier ?? "requested"}_quality_floor`);
  }
  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    provenance: Object.freeze({
      ...provenance,
      freshness,
      freshnessSource: currencyFact?.source ?? "unknown",
      ...(Number.isSafeInteger(currencyFact?.evaluatedAt) ? { freshnessEvaluatedAt: currencyFact.evaluatedAt } : {}),
    }),
    explicitlyAllowed,
  });
}

export function modelPolicyGeneration(preferences) {
  const payload = JSON.stringify({ version: MODEL_POLICY_VERSION, preferences });
  return createHash("sha256").update(payload).digest("hex");
}
