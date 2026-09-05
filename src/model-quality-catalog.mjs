/**
 * Research-backed automatic quality floor.
 *
 * Currency answers "not obsolete". It cannot answer "worth delegating work to": an
 * aggregator can publish a brand-new tiny/free model beside a current frontier model. This
 * controller policy admits only researched current families to automatic routing. User tiers
 * still override it; learned affinities can only reorder resources already above this floor.
 *
 * First-party/mixed native routes that a live `/models` listing ranks as generation 0/1
 * are admitted even before the regex table is edited. Aggregators stay allow-listed:
 * a brand-new listing there is not proof of quality.
 */
import { providerClassFor } from "./model-provenance-policy.mjs";

const RULES = Object.freeze([
  // Cursor's own subscription billing pool is separate from third-party Claude/GPT/Gemini
  // routes. Provenance enforcement is the hard gate; these rules only assign quality inside it.
  { provider: /^cursor(-account-\d+)?$/, model: /^(cursor-grok-4\.6|grok-4\.6|composer-2\.5)/, quality: "frontier" },
  { provider: /^cursor(-account-\d+)?$/, model: /^(cursor-grok-4\.5|grok-4\.5|composer-2(?:-|$))/, quality: "standard" },
  // Direct subscription/API routes. GPT API spending remains explicit-policy-only; this table
  // classifies quality but never broadens automatic billing provenance.
  { provider: /^(openai|openai-codex(?:-account-\d+)?)$/, model: /^gpt-6-astra(?:-|$)/, quality: "apex" },
  { provider: /^anthropic(-account-\d+)?$/, model: /^claude-fable-5(?:[-.]1)?(?:-|$)/, quality: "apex" },
  { provider: /^openrouter$/, model: /^(openai\/gpt-6-astra|anthropic\/claude-fable-5(?:[-.]1)?)(?::batch)?$/, quality: "apex" },
  { provider: /^openai-codex/, model: /^gpt-5\.6-sol/, quality: "frontier" },
  { provider: /^openai-codex/, model: /^gpt-5\.6-terra/, quality: "standard" },
  { provider: /^openai-codex/, model: /^gpt-5\.6-luna/, quality: "cheap" },
  { provider: /^openai-codex/, model: /^gpt-5\.(5|4)(?!-(mini|nano))/, quality: "frontier" },
  { provider: /^openai$/, model: /^gpt-5\.6-sol/, quality: "frontier" },
  { provider: /^openai$/, model: /^gpt-5\.6-terra/, quality: "standard" },
  { provider: /^openai$/, model: /^gpt-5\.6-luna/, quality: "cheap" },
  { provider: /^openai$/, model: /^gpt-5\.(5|4)(?!-(mini|nano))/, quality: "standard" },
  { provider: /^openai$/, model: /^gpt-5\.(4-(mini|nano)|3-codex)/, quality: "cheap" },
  { provider: /^kimi-coding$/, model: /^(k3|k3-256k)$/, quality: "frontier" },
  { provider: /^anthropic(-account-\d+)?$/, model: /^claude-opus-5/, quality: "frontier" },
  { provider: /^anthropic(-account-\d+)?$/, model: /^claude-sonnet-5/, quality: "standard" },
  { provider: /^anthropic(-account-\d+)?$/, model: /^claude-haiku-5/, quality: "cheap" },
  { provider: /^zai$/, model: /^glm-5\.(3|2)$/, quality: "frontier" },
  { provider: /^zai$/, model: /^glm-5\.1$/, quality: "standard" },
  { provider: /^minimax$/, model: /^MiniMax-M(3|2\.7)/i, quality: "standard" },
  { provider: /^ollama$/, model: /^(kimi-k3|minimax-m3|deepseek-v4-pro:0813|glm-5\.2|kimi-k2\.7-code)$/, quality: "standard" },
  { provider: /^opencode-go-api$/, model: /^(kimi-k3|minimax-m3|glm-5\.3|glm-5\.2|deepseek-v4-pro|qwen3\.8-max|gpt-5\.6-luna)$/, quality: "standard" },
  // Aggregator routes: explicit current researched families only. Never match :free aliases.
  { provider: /^openrouter$/, model: /^(openai\/gpt-5\.6-(sol|terra|luna)(-pro)?|anthropic\/claude-opus-5(-fast)?|x-ai\/grok-4\.6|moonshotai\/kimi-k3|deepseek\/deepseek-v4-pro-0813|google\/gemini-3\.7-flash)$/, quality: "frontier" },
  { provider: /^openrouter$/, model: /^(z-ai\/glm-5\.2|moonshotai\/kimi-k2\.7-code|minimax\/minimax-m3|deepseek\/deepseek-v4-(pro|flash)|qwen\/qwen3\.8-max|anthropic\/claude-sonnet-5|openai\/gpt-5\.4-mini)$/, quality: "standard" },
  { provider: /^openrouter$/, model: /^(google\/gemini-3\.7-flash|openai\/gpt-5\.4-(mini|nano)|deepseek\/deepseek-v4-flash)$/, quality: "cheap" },
]);
const RANK = Object.freeze({ cheap: 0, standard: 1, frontier: 2, apex: 3 });

export function qualityForModel({ provider, modelId, generation } = {}) {
  if (typeof provider !== "string" || typeof modelId !== "string" || /:free\b/i.test(modelId)) return undefined;
  const match = RULES.find((rule) => rule.provider.test(provider) && rule.model.test(modelId));
  if (match) return match.quality;
  // Freshness is not permission to reinterpret a premium alias as ordinary capacity.
  if (/astra|fable/i.test(modelId)) return undefined;
  const providerClass = providerClassFor(provider);
  if (providerClass !== "first_party_subscription" && providerClass !== "mixed_subscription") return undefined;
  if (generation === 0) return "frontier";
  if (generation === 1) return "standard";
  return undefined;
}

/** A model may serve its own quality tier and less demanding automatic tiers. */
export function meetsQualityFloor(identity, requestedTier) {
  const quality = qualityForModel(identity);
  return quality !== undefined && RANK[quality] >= RANK[requestedTier];
}

export const QUALITY_TIERS = Object.freeze({ ...RANK });
