/**
 * Controller-owned reasoning-mode compatibility.
 *
 * A brokered child never chooses its own thinking level, so the controller must not hand a
 * leased model a mode that model rejects. Some current families always reason and refuse an
 * explicit "off" (z.ai GLM-5.x answers 400 "This model always engages in thinking and cannot
 * be disabled"). Denying the launch would be wrong — the route is healthy, only the requested
 * mode is invalid — so the controller raises the mode to the weakest accepted one instead.
 */
const ALWAYS_REASONING = Object.freeze([
  Object.freeze({ provider: /^zai$/, model: /^glm-5\./ }),
  Object.freeze({ provider: /^openrouter$/, model: /^z-ai\/glm-5\./ }),
]);

const LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** True when the model refuses an explicitly disabled reasoning mode. */
export function requiresReasoning({ provider, modelId } = {}) {
  if (typeof provider !== "string" || typeof modelId !== "string") return false;
  return ALWAYS_REASONING.some((rule) => rule.provider.test(provider) && rule.model.test(modelId));
}

/**
 * Resolve the thinking level actually sent to the child. Only an unusable "off"/"minimal" is
 * raised, and only to the weakest level the provider documents as accepted; a caller asking
 * for more reasoning is never silently reduced.
 */
export function effectiveThinkingLevel(identity, requested = "off") {
  const level = LEVELS.includes(requested) ? requested : "off";
  if (!requiresReasoning(identity)) return level;
  return LEVELS.indexOf(level) < LEVELS.indexOf("low") ? "low" : level;
}
