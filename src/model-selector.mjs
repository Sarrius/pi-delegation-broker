/**
 * Controller-owned capability-aware model selection.
 *
 * The selector never names a model to the broker. It names a **capability class** — the
 * profile a task needs — and lets the broker hand back whichever live resource in that class
 * still has capacity. That indirection is what makes delegation survive a changing provider
 * set: when eight accounts are alive the class resolves to a cheap model, when one survives it
 * resolves to whatever that one offers, and the contract itself never changed.
 *
 * Two rules govern the choice, and they are deliberately asymmetric:
 *
 * - **Downward substitution is forbidden.** A class weaker than the task requires is never
 *   selected, even when it is the only thing left. A silently degraded result is worse than an
 *   honest denial.
 * - **Upward substitution is required.** When the closest sufficient class has no usable
 *   resource right now, the selector escalates to a stronger one rather than denying. A
 *   verified result is the requirement; efficiency is learned from observed consumption.
 *
 * The selector is controller-only. It reads a registry snapshot and an optional live
 * availability snapshot; it never mutates either, never calls a provider, and never reaches a
 * child.
 */

import { preferenceMatches, taskModelTier } from "./model-preferences.mjs";
import { meetsQualityFloor, qualityForModel, QUALITY_TIERS } from "./model-quality-catalog.mjs";
import { evaluateRouteEligibility, modelPolicyGeneration } from "./model-provenance-policy.mjs";

const CONFIDENCE_RANK = Object.freeze({ measured: 0, observed: 1, assumed: 2 });
const OPERATION_CLASSES = Object.freeze(new Set(["observe", "propose_patch", "apply", "external_write"]));
const ADMISSION_CLASSES = Object.freeze(new Set(["control", "verify", "work"]));
const EFFECT_CAPABLE = Object.freeze(new Set(["propose_patch", "apply", "external_write"]));
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// Denial text is surfaced through the launch resolver, which refuses anything outside this
// alphabet. Keeping the reasons inside it means a denial explains itself instead of collapsing
// into a generic "broker policy denied launch".
const SAFE_REASON = /^[A-Za-z0-9 _.-]{1,120}$/;

const DEFAULT_LATENCY_BUDGET_MS = 120_000;
// No money dimension: the broker cannot observe spend, so it budgets what it can enforce.
// Input is cumulative across agent turns and must be reserved before each send using canonical
// UTF-8 bytes — a safe upper bound that is commonly ~4x observed tokens. A 200k default therefore
// rejected healthy multi-step work around 125k observed tokens. One million preserves a finite
// hard ceiling while accommodating one near-context-window request plus preceding tool turns.
const DEFAULT_BUDGET = Object.freeze({ maxInputTokens: 1_000_000, maxOutputTokens: 16_000, maxAttempts: 8 });

/**
 * Keyword evidence for each capability beyond plain text generation. Matching is intentionally
 * shallow: the controller supplies the task description, so this is a convenience derivation,
 * not a security boundary. `constraints.requiredCapabilities` overrides it outright.
 */
const CAPABILITY_EVIDENCE = Object.freeze([
  Object.freeze({
    capability: "code_reasoning",
    pattern: /\b(code|codebase|refactor|patch|diff|debug|bug|implement|function|class|module|api|test|tests|compile|build|lint|type|regression|migrat\w*|schema|query|algorithm)\b/i,
  }),
  Object.freeze({
    capability: "large_context",
    pattern: /\b(whole|entire|full|across|repo|repository|project|codebase|monorepo|audit|survey|sweep|every file|all files|architecture)\b/i,
  }),
  Object.freeze({
    capability: "vision_input",
    pattern: /\b(image|screenshot|screen shot|photo|picture|diagram|chart|figure|visual|ocr|mockup|design)\b/i,
  }),
]);

/** Effect-capable work is never routed to the weakest class, whatever the wording suggests. */
const EFFECT_EVIDENCE = /\b(apply|write|commit|push|deploy|publish|delete|mutate|create file|modify)\b/i;

function boundedText(value, limit = 4_000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function deny(reason) {
  return Object.freeze({ action: "deny", reason: SAFE_REASON.test(reason) ? reason : "model selection failed" });
}

/**
 * Derive what a task needs from its description plus explicit controller constraints.
 * Explicit constraints always win: the description is a hint, never an authority.
 */
export function deriveTaskRequirement(taskDescription, constraints = {}) {
  const text = boundedText(taskDescription);
  const explicit = constraints.requiredCapabilities;
  if (explicit !== undefined && (!Array.isArray(explicit) || explicit.some((capability) => typeof capability !== "string" || !capability))) {
    throw new Error("constraints.requiredCapabilities must be an array of capability names");
  }

  const derived = new Set(["text_generation"]);
  for (const evidence of CAPABILITY_EVIDENCE) {
    if (evidence.pattern.test(text)) derived.add(evidence.capability);
  }

  let operationClass = constraints.operationClass;
  if (operationClass === undefined) operationClass = EFFECT_EVIDENCE.test(text) ? "propose_patch" : "observe";
  if (!OPERATION_CLASSES.has(operationClass)) throw new Error(`unknown operationClass: ${operationClass}`);

  // An effect-capable child changes something outside itself. Whatever the description says,
  // it gets a class that can reason about what it is changing.
  if (EFFECT_CAPABLE.has(operationClass)) derived.add("code_reasoning");

  const admissionClass = constraints.admissionClass ?? "work";
  if (!ADMISSION_CLASSES.has(admissionClass)) throw new Error(`unknown admissionClass: ${admissionClass}`);

  const capabilities = explicit === undefined ? [...derived] : [...new Set(["text_generation", ...explicit])];
  return Object.freeze({
    capabilities: Object.freeze(capabilities.sort()),
    operationClass,
    admissionClass,
    effectCapable: EFFECT_CAPABLE.has(operationClass),
  });
}

/**
 * Normalize the optional live availability snapshot (see SqliteLeaseBroker#inventory) into a
 * lookup. Without it every resource is treated as usable, which is right for a pure
 * registry-shape question and wrong for a routing decision — so callers that route should pass
 * one.
 */
function availabilityIndex(availability) {
  const index = new Map();
  if (availability === undefined) return index;
  const rows = Array.isArray(availability) ? availability : Object.entries(availability).map(([id, value]) => ({ resourceId: id, ...value }));
  for (const row of rows) {
    if (!row || typeof row.resourceId !== "string") continue;
    index.set(row.resourceId, row);
  }
  return index;
}

function usable(resourceId, live, { now, requiresHardBudget, resourceConfidence, groupConfidence }) {
  // Mirrors the broker's own admission checks so the selector does not propose a class the
  // broker will immediately refuse.
  if (requiresHardBudget && (resourceConfidence === "assumed" || groupConfidence === "assumed")) return false;
  if (live === undefined) return true;
  if (live.retiring === true || live.retiring === 1) return false;
  if (live.state !== undefined && live.state !== "healthy" && live.state !== "unknown") return false;
  if (Number.isFinite(live.cooldownUntil) && Number.isFinite(now) && live.cooldownUntil > now) return false;
  // Unknown means the last observation failed, not that the credential can never recover.
  // Once its bounded retry delay expires the broker may admit exactly one half-open probe for
  // the capacity group. Do not select another sibling while that probe is already in flight.
  if (live.state === "unknown" && live.probeLeaseId) return false;
  if (live.breakerState === "cooling_down" && Number.isFinite(live.groupCooldownUntil) && Number.isFinite(now) && live.groupCooldownUntil > now) return false;
  if (live.breakerState === "cooling_down" && live.probeLeaseId) return false;
  return true;
}

/**
 * Cold-start ordering without a price table. A published price is not something this broker can
 * verify it ever paid, so it is not a criterion here; the closest sufficient quality class is.
 * Spending a frontier model on cheap-tier work is the inefficiency that actually shows up in the
 * measure the controller does own — tokens, latency and attempts — and once verified receipts
 * exist the learned ranker overrides this ordering anyway.
 */
function qualityFit(resource, id, modelTier) {
  const identity = resource?.model ?? parseResourceModel(id);
  const quality = identity && qualityForModel(identity);
  if (quality === undefined) return Number.POSITIVE_INFINITY;
  return Math.abs(QUALITY_TIERS[quality] - (QUALITY_TIERS[modelTier] ?? QUALITY_TIERS.standard));
}

/**
 * Rank the usable resources of one capability class. Observed availability precedes cold-start
 * quality fit; once controller receipts exist, measured efficiency supplies the final ordering.
 */
/**
 * Normalize the optional currency map (see provider-probe#buildCurrencyMap) into a lookup.
 * A legacy resource is never selected while anything current can serve the task; only when
 * the entire current fleet is unusable does it become a visible last resort.
 */
function currencyIndex(currency) {
  const index = new Map();
  if (currency === undefined || currency === null) return index;
  for (const [id, fact] of Object.entries(currency)) {
    if (fact && typeof fact === "object") index.set(id, fact);
  }
  return index;
}

function rankResources(entries, learnedRanker, capabilities, modelTier) {
  const baseline = [...entries].sort((left, right) => {
    const confidence = (CONFIDENCE_RANK[left.resource.confidence] ?? 3) - (CONFIDENCE_RANK[right.resource.confidence] ?? 3);
    if (confidence !== 0) return confidence;
    // During the explicit legacy fallback, prefer the newest legacy generation. In normal
    // routing all entries are current already, so this is a no-op.
    const generation = (left.generation ?? 0) - (right.generation ?? 0);
    if (generation !== 0) return generation;
    const fit = qualityFit(left.resource, left.id, modelTier) - qualityFit(right.resource, right.id, modelTier);
    if (fit !== 0) return fit;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  if (typeof learnedRanker !== "function") return baseline;
  let ordered;
  try { ordered = learnedRanker({ resourceIds: baseline.map((entry) => entry.id), capabilities }); } catch { return baseline; }
  if (!Array.isArray(ordered) || ordered.length !== baseline.length || new Set(ordered).size !== baseline.length
    || ordered.some((id) => !baseline.some((entry) => entry.id === id))) return baseline;
  const positions = new Map(ordered.map((id, index) => [id, index]));
  return baseline.sort((left, right) => positions.get(left.id) - positions.get(right.id));
}

/**
 * Order candidate classes weakest-sufficient first. A class only qualifies if it supports every
 * required capability, so walking this order and taking the first with a usable resource
 * implements both rules at once: never weaker than required, escalate when the cheap tier is
 * empty.
 */
function candidateProfiles(registry, required) {
  const candidates = [];
  for (const [id, profile] of Object.entries(registry.profiles ?? {})) {
    if (profile?.status !== "approved") continue;
    const supports = profile.supports ?? [];
    if (!required.every((capability) => supports.includes(capability))) continue;
    candidates.push({ id, supports, extra: supports.length - required.length });
  }
  return candidates.sort((left, right) => (left.extra - right.extra) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function buildBudget(constraints) {
  const budget = { ...DEFAULT_BUDGET, ...(constraints.budget ?? {}) };
  // Token consumption is enforceable: the controller caps input and clamps the child's output
  // request. Money is not — no provider exposes a synchronous spend ledger, and subscription
  // accounts have no per-request price at all. The prior money cap asked resources for a
  // guarantee none could honestly declare, which left the effect path unroutable on the real
  // fleet. What protects an effect is the blocking behavioral monitor, pinned extension
  // attestation, and controller verification of the result; efficiency is measured afterward
  // from verified tokens, latency, and attempts.
  if (!Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1 || budget.maxAttempts > 32) {
    throw new Error("maxAttempts must be an integer between 1 and 32");
  }
  if (Object.hasOwn(budget, "maxCostMicros") || Object.hasOwn(constraints.budget?.enforcement ?? {}, "cost")) {
    throw new Error("money budgets are not supported; constrain input/output tokens and learn efficiency from verified outcomes");
  }
  const enforcement = constraints.budget?.enforcement ?? { input: "hard", output: "hard" };
  return Object.freeze({
    ...(Number.isSafeInteger(budget.maxInputTokens) ? { maxInputTokens: budget.maxInputTokens } : {}),
    ...(Number.isSafeInteger(budget.maxOutputTokens) ? { maxOutputTokens: budget.maxOutputTokens } : {}),
    maxAttempts: budget.maxAttempts,
    enforcement: Object.freeze({ ...enforcement }),
  });
}

function requiresHardBudget(budget) {
  return Object.values(budget.enforcement ?? {}).includes("hard");
}

/**
 * Select the closest sufficient quality contract for a task, then learn measured efficiency.
 *
 * Returns `{action:"allow", contract, expectedModel, selection, alternatives}` or
 * `{action:"deny", reason}`. `alternatives` lists the remaining ranked classes so a caller that
 * hits `denied_capacity` can retry one tier up without re-deriving the requirement.
 */
export function selectModelForTask({ taskDescription, registry, constraints = {}, availability, currency, preferences, learnedRanker, enforceQuality = false, enforceProvenance = false, now } = {}) {
  if (!registry?.profiles || !registry?.resources) throw new Error("selectModelForTask requires a broker registry");
  if (constraints !== undefined && (typeof constraints !== "object" || constraints === null || Array.isArray(constraints))) {
    throw new Error("selectModelForTask constraints must be an object");
  }

  const requirement = deriveTaskRequirement(taskDescription, constraints);
  const budget = buildBudget(constraints);
  const hardBudget = requiresHardBudget(budget);
  const live = availabilityIndex(availability);
  const currencyLookup = currencyIndex(currency);
  const excluded = new Set(Array.isArray(constraints.excludeResources) ? constraints.excludeResources : []);
  // An exact identity request (route=inherit_model) narrows the candidate set and nothing else.
  // It is applied beside every other gate, never instead of one: a model that is legacy,
  // wrongly provenanced, unhealthy or below the quality floor stays rejected when named.
  const requiredIdentity = constraints.requireModelIdentity;
  if (requiredIdentity !== undefined
    && (typeof requiredIdentity?.provider !== "string" || typeof requiredIdentity?.modelId !== "string")) {
    throw new Error("constraints.requireModelIdentity must be {provider, modelId}");
  }
  const allowedProviders = Array.isArray(constraints.allowedProviders) && constraints.allowedProviders.length > 0
    ? new Set(constraints.allowedProviders)
    : undefined;

  const profiles = candidateProfiles(registry, requirement.capabilities);
  if (profiles.length === 0) return deny("no approved profile supports the required capabilities");
  const modelTier = taskModelTier(requirement, constraints.modelTier);
  const preferenceEntries = preferences?.tiers?.[modelTier] ?? [];

  let sawLegacy = false;
  const buildTiers = (includeLegacy, userOnly = false) => {
    const tiers = [];
    for (const profile of profiles) {
      const entries = [];
      for (const [id, resource] of Object.entries(registry.resources)) {
        if (resource?.profile !== profile.id) continue;
        if (excluded.has(id)) continue;
        if (allowedProviders && !allowedProviders.has(resource.model?.provider ?? id)) continue;
        const identity = resource.model ?? parseResourceModel(id);
        if (requiredIdentity
          && (identity?.provider !== requiredIdentity.provider || identity?.modelId !== requiredIdentity.modelId)) continue;
        const explicitlyAllowed = Boolean(userOnly && identity && preferenceMatches(preferenceEntries, identity));
        if (userOnly && !explicitlyAllowed) continue;
        // Empty user tiers mean controller auto mode, not "any model the aggregator happens
        // to list". Require the researched quality floor before efficiency ranking can participate.
        const fact = currencyLookup.get(id);
        const meetsQuality = Boolean(identity && meetsQualityFloor({ ...identity, generation: fact?.generation }, modelTier));
        if (enforceQuality && !userOnly && !meetsQuality) continue;
        let provenance;
        if (enforceProvenance) {
          const eligibility = evaluateRouteEligibility({
            identity, resource, currencyFact: fact, explicitlyAllowed, requestedTier: modelTier, meetsQuality,
          });
          if (!eligibility.eligible) {
            if (eligibility.provenance.freshness !== "current") sawLegacy = true;
            continue;
          }
          provenance = eligibility.provenance;
        } else if (fact?.legacy === true) {
          if (!includeLegacy) { sawLegacy = true; continue; }
        }
        const group = registry.capacityGroups?.[resource.capacityGroup];
        if (!usable(id, live.get(id), {
          now,
          requiresHardBudget: hardBudget,
          resourceConfidence: resource.confidence,
          groupConfidence: group?.confidence,
        })) continue;
        entries.push({ id, resource, generation: fact?.generation, provenance });
      }
      if (entries.length === 0) continue;
      tiers.push(Object.freeze({
        profile: profile.id,
        supports: Object.freeze([...profile.supports]),
        // A class spanning several accounts can absorb one dying; a class living in one account
        // cannot. Surfacing it lets a caller prefer breadth when throughput matters.
        capacityGroups: Object.freeze([...new Set(entries.map((entry) => entry.resource.capacityGroup))]),
        resources: Object.freeze(rankResources(entries, userOnly ? undefined : learnedRanker, requirement.capabilities, modelTier).map((entry) => Object.freeze({
          resourceId: entry.id,
          capacityGroup: entry.resource.capacityGroup,
          confidence: entry.resource.confidence,
          ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
          ...(entry.resource.model ? { model: Object.freeze({ ...entry.resource.model }) } : {}),
          ...(entry.provenance ? { provenance: Object.freeze({ ...entry.provenance }) } : {}),
        }))),
      }));
    }
    return tiers;
  };

  // First pass: current generations only. Legacy models (glm-4.x beside glm-5.3, gpt-4 beside
  // gpt-5.6, davinci beside anything) do not exist as far as this pass is concerned.
  // Explicit user policy wins whenever it has a current, live route. Empty standard/cheap
  // lists deliberately mean "let the controller decide". If every chosen route is unavailable,
  // fall back to automatic selection rather than stranding work on a user preference.
  let preferenceSource = preferenceEntries.length > 0 ? "user" : "auto";
  let tiers = buildTiers(false, preferenceEntries.length > 0);
  if (tiers.length === 0 && preferenceEntries.length > 0 && !enforceProvenance) {
    preferenceSource = "auto_user_tier_unavailable";
    tiers = buildTiers(false);
  }
  let legacyFallback = false;
  if (tiers.length === 0 && sawLegacy && !enforceProvenance) {
    // Last resort, and visible: the whole current fleet is unusable, so history gets one
    // chance — marked, so the route trail shows the harness ran on a stale model knowingly.
    preferenceSource = "legacy_emergency";
    tiers = buildTiers(true);
    legacyFallback = tiers.length > 0;
  }

  if (tiers.length === 0) {
    if (enforceProvenance && preferenceEntries.length > 0) return deny("explicit model pool has no current eligible route");
    if (enforceProvenance) return deny("no current subscription native resource serves the required capabilities");
    return deny(hardBudget
      ? "no live resource with measured or observed inventory serves the required capabilities"
      : "no live resource serves the required capabilities");
  }

  const chosen = tiers[0];
  const preferred = chosen.resources[0];
  const expectedModel = preferred.model ?? parseResourceModel(preferred.resourceId);
  if (!expectedModel) return deny("selected resource carries no provider and model identity");

  // The broker leases inside the contracted class, so the class alone is not enough: without
  // an explicit allow-list it can hand back a resource this selector deliberately filtered out
  // (legacy or below the quality floor). Carry the vetted candidates into the contract.
  const contract = buildContract({
    requirement,
    budget,
    profile: chosen.profile,
    constraints,
    allowedResources: chosen.resources.map((entry) => entry.resourceId),
  });
  if (typeof contract === "string") return deny(contract);

  return Object.freeze({
    action: "allow",
    contract,
    expectedModel: Object.freeze({ ...expectedModel }),
    selection: Object.freeze({
      profile: chosen.profile,
      resourceId: preferred.resourceId,
      capacityGroup: preferred.capacityGroup,
      confidence: preferred.confidence,
      capabilities: requirement.capabilities,
      // True whenever a stronger class was taken because the closest sufficient one had
      // nothing alive. Worth logging: it is the visible symptom of a shrinking provider set.
      escalated: chosen.supports.length > requirement.capabilities.length,
      candidateCount: chosen.resources.length,
      capacityGroupCount: chosen.capacityGroups.length,
      modelTier,
      preferenceSource,
      policyGeneration: modelPolicyGeneration(preferences ?? { schemaVersion: 0 }),
      ...(preferred.provenance ? {
        providerClass: preferred.provenance.providerClass,
        modelDeveloper: preferred.provenance.modelDeveloper,
        billingPool: preferred.provenance.billingPool,
        nativeToRoute: preferred.provenance.nativeToRoute,
        freshness: preferred.provenance.freshness,
        freshnessSource: preferred.provenance.freshnessSource,
        ...(preferred.provenance.freshnessEvaluatedAt ? { freshnessEvaluatedAt: preferred.provenance.freshnessEvaluatedAt } : {}),
      } : {}),
      // Inform the controller that at least one otherwise compatible route was deliberately
      // excluded for currency. This is diagnostic provenance, never a reason to revive it.
      ...(sawLegacy ? { legacyExcluded: true } : {}),
      ...(legacyFallback ? { legacyFallback: true } : {}),
    }),
    alternatives: Object.freeze(tiers.slice(1)),
    tier: chosen,
  });
}

/**
 * A resource id built by catalogToBrokerRegistry is `${provider}/${modelId}` and a model id may
 * itself contain slashes, so the split is on the first separator only.
 */
export function parseResourceModel(resourceId) {
  if (typeof resourceId !== "string") return undefined;
  const separator = resourceId.indexOf("/");
  if (separator < 1 || separator === resourceId.length - 1) return undefined;
  return { provider: resourceId.slice(0, separator), modelId: resourceId.slice(separator + 1) };
}

/** Map a leased resource back to the concrete model the child must run on. */
export function createResourceModelResolver(registry) {
  const table = new Map();
  for (const [id, resource] of Object.entries(registry?.resources ?? {})) {
    const model = resource?.model ?? parseResourceModel(id);
    if (model) table.set(id, Object.freeze({ ...model }));
  }
  return (resourceId) => table.get(resourceId) ?? parseResourceModel(resourceId);
}

function buildContract({ requirement, budget, profile, constraints, allowedResources }) {
  const taskId = constraints.taskId;
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return "contract requires a bounded taskId";
  const promptDigest = constraints.promptDigest;
  if (typeof promptDigest !== "string" || !SHA256.test(promptDigest)) return "contract requires the exact child promptDigest";

  const doneWhen = constraints.doneWhen ?? defaultDoneWhen(requirement.operationClass);
  if (!Array.isArray(doneWhen) || doneWhen.length < 1 || doneWhen.length > 20
    || doneWhen.some((criterion) => typeof criterion !== "string" || criterion.length < 1 || criterion.length > 500 || /[\0\r\n]/.test(criterion))) {
    return "contract requires 1 to 20 bounded doneWhen criteria";
  }

  const latencyBudgetMs = constraints.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
  if (!Number.isSafeInteger(latencyBudgetMs) || latencyBudgetMs < 1) return "contract requires a positive latencyBudgetMs";

  // The broker enforces this too, but failing here names the missing cap instead of returning
  // a generic policy denial after a round trip.
  for (const [dimension, enforcement] of Object.entries(budget.enforcement ?? {})) {
    const cap = { input: budget.maxInputTokens, output: budget.maxOutputTokens }[dimension];
    if (enforcement === "hard" && (!Number.isSafeInteger(cap) || cap <= 0)) return `hard ${dimension} enforcement requires a positive declared cap`;
  }

  return Object.freeze({
    taskId,
    operationClass: requirement.operationClass,
    admissionClass: requirement.admissionClass,
    promptDigest,
    doneWhen: Object.freeze([...doneWhen]),
    latencyBudgetMs,
    capability: Object.freeze({
      minimumProfile: profile,
      required: requirement.capabilities,
      downgradePolicy: "forbid",
      ...(Array.isArray(allowedResources) && allowedResources.length > 0
        ? { allowedResources: Object.freeze([...allowedResources]) }
        : {}),
    }),
    budget,
    ...(constraints.leaseTtlMs === undefined ? {} : { leaseTtlMs: constraints.leaseTtlMs }),
    ...(constraints.recovery === undefined ? {} : { recovery: constraints.recovery }),
  });
}

function defaultDoneWhen(operationClass) {
  return EFFECT_CAPABLE.has(operationClass)
    ? ["Return the proposed change with controller-verifiable evidence for every claimed effect"]
    : ["Return the requested finding with controller-verifiable evidence references"];
}

/**
 * Build the launch resolver's `selectContract` callback.
 *
 * `registry` and `availability` may be functions so a caller re-reads them per launch — the
 * provider set changes underneath a long-lived resolver, and a snapshot captured at
 * construction would route against a stale world.
 *
 * The callback reads only `request.capabilityRequest`, never a prompt: the resolver contract is
 * that a launch request carries no raw task text.
 */
export function createSelectContract({ registry, availability, currency, preferences, learnedRanker, enforceQuality = false, enforceProvenance = false, constraints = {}, now = () => Date.now() } = {}) {
  if (registry === undefined) throw new Error("createSelectContract requires a registry or a registry provider");
  const readRegistry = typeof registry === "function" ? registry : () => registry;
  const readAvailability = typeof availability === "function" ? availability : () => availability;
  const readCurrency = typeof currency === "function" ? currency : () => currency;
  const readPreferences = typeof preferences === "function" ? preferences : () => preferences;
  if (learnedRanker !== undefined && typeof learnedRanker !== "function") throw new Error("createSelectContract learnedRanker must be a function");

  return (request) => {
    const capabilityRequest = request?.capabilityRequest ?? {};
    const merged = {
      ...constraints,
      ...capabilityRequest,
      taskId: capabilityRequest.taskId ?? constraints.taskId ?? request?.childId,
      promptDigest: request?.promptDigest,
    };
    return selectModelForTask({
      taskDescription: capabilityRequest.taskDescription ?? "",
      registry: readRegistry(),
      availability: readAvailability(),
      currency: readCurrency(),
      preferences: readPreferences(),
      learnedRanker,
      enforceQuality,
      enforceProvenance,
      constraints: merged,
      now: now(),
    });
  };
}
