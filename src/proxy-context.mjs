/**
 * Narrow Pi Context → controller providerStream vocabulary bridge.
 *
 * The controller protocol intentionally accepts only text user/assistant turns and no tool
 * replay state. This adapter rejects everything else rather than dropping a tool result or image
 * and making the controller send a semantically different request than the child saw.
 */
function textContent(content, label) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`${label} must be text`);
  let text = "";
  for (const block of content) {
    if (!block || block.type !== "text" || typeof block.text !== "string") throw new Error(`${label} contains a non-text block`);
    text += block.text;
  }
  return text;
}

/** Convert a tool-free Pi Context into the controller's closed provider context. */
export function proxyCanonicalContext(context) {
  if (!context || typeof context !== "object") throw new Error("proxy context is required");
  if (context.tools !== undefined && (!Array.isArray(context.tools) || context.tools.length > 0)) {
    throw new Error("controller proxy currently requires a tool-free context");
  }
  if (!Array.isArray(context.messages)) throw new Error("proxy context messages are required");
  const messages = context.messages.map((message, index) => {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw new Error(`proxy context messages[${index}] has an unsupported role`);
    }
    return Object.freeze({ role: message.role, content: textContent(message.content, `proxy context messages[${index}]`) });
  });
  if (context.systemPrompt !== undefined && typeof context.systemPrompt !== "string") throw new Error("proxy system prompt must be text");
  return Object.freeze({ systemPrompt: context.systemPrompt ?? "", messages: Object.freeze(messages), tools: Object.freeze([]) });
}

/** Map closed provider terminal outcomes to Pi stop/error semantics without leaking raw bodies. */
export function proxyTerminalError(terminal) {
  const outcome = terminal?.payload?.outcome;
  if (outcome === "succeeded_terminal") return undefined;
  return typeof outcome === "string" && /^[a-z_]+$/.test(outcome)
    ? `controller provider terminal: ${outcome}`
    : "controller provider returned an invalid terminal";
}
