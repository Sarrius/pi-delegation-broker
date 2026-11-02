import { createHash } from "node:crypto";

export const MODEL_POLICY_VERSION = "subscription-and-metered-native-current-only/v5";

const FIRST_PARTY_SUBSCRIPTIONS = Object.freeze({
  "openai-codex": "openai",
  anthropic: "anthropic",
  zai: "zai",
  "kimi-coding": "moonshot",
  minimax: "minimax",
  qwen: "alibaba",
});
const AGGREGATORS = new Set(["openrouter", "ollama", "opencode-go-api", "ollama-cloud"]);
// A vendor's own pay-per-token API. The value is the vendor that owns the models it serves,
// so `nativeToRoute` is derived from the route's vendor instead of a hardcoded model owner.
// Adding a vendor here is a policy statement ("this route is the manufacturer's own API"),
// not a per-model allowlist: every model the vendor advertises on that base inherits it.
const FIRST_PARTY_DIRECT_APIS = Object.freeze({
  openai: "openai",
  deepseek: "deepseek",
});
// Native routes by provenance: subscription bundles and the manufacturer's own metered API.
const NATIVE_PROVIDER_CLASSES = new Set([
  "first_party_subscription",
  "mixed_subscription",
  "metered_native",
]);
// Metered-native routes are admitted automatically at these tiers only. A metered frontier
// call spends real money, so it stays behind explicit admission; cheap/standard is the cheap
// vendor model this class exists for.
const METERED_AUTO_TIERS = new Set(["cheap", "standard"]);

export function baseRouteProvider(provider) {
  return typeof provider === "string" ? provider.replace(/-account-\d+$/, "") : "unknown";
}

export function providerClassFor(provider) {
  const base = baseRouteProvider(provider);
  if (Object.hasOwn(FIRST_PARTY_SUBSCRIPTIONS, base)) return "first_party_subscription";
  if (base === "cursor" || base === "google-antigravity") return "mixed_subscription";
  if (AGGREGATORS.has(base)) return "aggregator";
  if (Object.hasOwn(FIRST_PARTY_DIRECT_APIS, base)) return "metered_native";
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

/**
 * Which of Cursor's separately-metered pools a model bills to.
 *
 * One Cursor subscription bills three independent pools, and the pool split is NOT the
 * provenance split: `cursor-grok-4.6` is admitted as native to a Cursor route yet bills the
 * third-party "other models" pool, while `grok-4.5` bills the included models pool. The
 * membership below is exactly the `auto_bucket_models` list Cursor returns from its own
 * `GetCurrentPeriodUsage` RPC (observed live 2026-09-12); everything else on the account draws
 * the third-party pool. Pool identity is structural — it scopes capacity groups and cooldowns
 * so one pool's exhaustion cannot bench its sibling — and is never a quality or admission
 * decision.
 */
export function cursorBillingPool(modelId) {
  const id = terminalModelId(modelId);
  return /^(?:composer(?:-|$)|vega(?:-|$)|(?:cursor-)?grok-4\.5(?:-|$)|default$)/.test(id)
    ? "models"
    : "other";
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
    nativeToRoute = baseProvider === "google-antigravity" ? modelDeveloper === "google" : cursorNativeModel(modelId);
    // Opt-in Antigravity credentials are subscription-only, with credit opt-in disabled.
    // Inclusion is a billing contract, not a claim Google developed Claude or GPT.
    billingPool = baseProvider === "google-antigravity" && ["google", "anthropic", "openai"].includes(modelDeveloper)
      ? "included_subscription" : nativeToRoute ? "native_subscription" : "third_party_subscription";
  } else if (providerClass === "aggregator") {
    billingPool = "aggregator_payg";
  } else if (providerClass === "metered_native") {
    nativeToRoute = modelDeveloper === FIRST_PARTY_DIRECT_APIS[baseProvider];
    billingPool = nativeToRoute ? "native_metered" : "payg";
  } else if (providerClass === "self_hosted") {
    billingPool = "local";
  }
  return Object.freeze({
    providerClass,
    modelDeveloper,
    routeProvider,
    baseProvider,
    billingPool,
    ...(baseProvider === "google-antigravity" ? { quotaObservationScope: `model:${terminalModelId(modelId)}` } : {}),
    nativeToRoute,
    source: MODEL_POLICY_VERSION,
  });
}

export function freshnessForCurrency(currencyFact, { vendorAdvertisedAuthoritative = false } = {}) {
  if (!currencyFact || typeof currencyFact !== "object") return "unknown";
  if (currencyFact.listed === false || currencyFact.legacy === true || currencyFact.generation >= 2) return "deprecated";
  // A live probe proved this id is served by a different canonical model, so it is a retired
  // alias and not an independent route.
  if (typeof currencyFact.aliasOf === "string" && currencyFact.aliasOf) return "deprecated";
  // A first-party metered vendor's own `/models` is the authoritative current lineup: what it
  // still advertises is current, regardless of the id's version string. This is what stops an
  // id like `deepseek-flash` (unversioned, newest) from being misranked `previous` by the
  // version heuristic. Subscription and aggregator routes are unaffected.
  if (vendorAdvertisedAuthoritative && currencyFact.listed === true) return "current";
  if (currencyFact.generation === 1) return "previous";
  if (currencyFact.generation === 0) return "current";
  return "unknown";
}

/** Hard eligibility. Ranking is forbidden until this controller policy returns eligible=true. */
export function evaluateRouteEligibility({
  identity, resource, currencyFact, explicitlyAllowed = false, requestedTier, meetsQuality = true,
} = {}) {
  const provenance = resource?.provenance ?? deriveModelProvenance(identity);
  const meteredNative = provenance.providerClass === "metered_native";
  const freshness = freshnessForCurrency(currencyFact, {
    vendorAdvertisedAuthoritative: meteredNative,
  });
  const reasons = [];
  if (freshness !== "current") reasons.push(`freshness_${freshness}`);
  if (!explicitlyAllowed) {
    if (!NATIVE_PROVIDER_CLASSES.has(provenance.providerClass)) reasons.push("provider_not_subscription_native_default");
    if (meteredNative) {
      // A metered route must be the vendor's own model, and only cheap/standard work is
      // admitted automatically; a metered frontier call stays explicit-only.
      if (provenance.nativeToRoute !== true) reasons.push("route_not_vendor_native_metered");
      else if (!METERED_AUTO_TIERS.has(requestedTier)) reasons.push("metered_tier_requires_explicit_admission");
    } else if (!(provenance.baseProvider === "google-antigravity" && provenance.providerClass === "mixed_subscription" && provenance.billingPool === "included_subscription")
      && (provenance.billingPool !== "native_subscription" || provenance.nativeToRoute !== true)) {
      reasons.push("route_not_native_subscription_pool");
    }
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
