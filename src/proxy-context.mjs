import { captureLosslessJson } from "./lossless-json.mjs";
import { captureProviderContext } from "./provider-context.mjs";
export { TOOL_CALL_ID, TOOL_NAME } from "./tool-identity.mjs";
import { TOOL_CALL_ID, TOOL_NAME } from "./tool-identity.mjs";

/** Child Pi Context → controller providerStream vocabulary bridge.
 * The provider may request a controller-approved local tool, but the provider
 * never receives an executable function or permission to run that tool. */

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_SCHEMA_METADATA = new Set(["~kind", "~optional", "~readonly"]);
const USER_METADATA = ["role", "content", "timestamp"];
const ASSISTANT_METADATA = ["role", "content", "api", "provider", "model", "responseModel", "responseId", "diagnostics", "usage", "stopReason", "deferred", "errorMessage", "rawStopReason", "endTurn", "timestamp"];
const TOOL_RESULT_METADATA = ["role", "toolCallId", "toolName", "content", "details", "usage", "addedToolNames", "isError", "timestamp"];
const NON_PRINTABLE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_PROVIDER_TEXT = 256 * 1024;

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}

function textContent(content, label) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`${label} must be text`);
  let text = "";
  for (const [index, block] of content.entries()) {
    const blockLabel = `${label}[${index}]`;
    if (!block || typeof block !== "object" || Array.isArray(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error(`${label} contains a non-text block`);
    }
    exactKeys(block, ["type", "text"], blockLabel);
    text += block.text;
  }
  return text;
}

function providerToolResultContent(content, label) {
  const raw = textContent(content, label);
  let escapedCount = 0;
  const escaped = raw.replace(NON_PRINTABLE_TEXT, (character) => {
    escapedCount += 1;
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const notice = escapedCount === 0
    ? ""
    : `[Broker escaped ${escapedCount} non-printable control characters in this tool result.]\n`;
  const projected = `${notice}${escaped}`;
  if (projected.length <= MAX_PROVIDER_TEXT) return projected;
  const marker = `\n[Broker truncated tool result from ${projected.length} to ${MAX_PROVIDER_TEXT} characters.]`;
  return `${projected.slice(0, MAX_PROVIDER_TEXT - marker.length)}${marker}`;
}

function schemaProjection(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object") throw new Error(`${label} contains an unsupported schema value`);
  if (ancestors.has(value)) throw new Error(`${label} contains a schema cycle`);
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use a standard array`);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")
      || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key)))) {
      throw new Error(`${label} must be dense and undecorated`);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(`${label}[${index}] is not a data property`);
      result.push(schemaProjection(descriptor.value, `${label}[${index}]`, nextAncestors));
    }
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // TypeBox's non-enumerable metadata is local schema state, not provider semantics.
    // Keep the projection a plain JSON-compatible schema and do not forward hidden
    // extension-owned values to the controller/provider boundary.
    if (!descriptor?.enumerable && LOCAL_SCHEMA_METADATA.has(key)) continue;
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label}.${key} is not a data property`);
    result[key] = schemaProjection(descriptor.value, `${label}.${key}`, nextAncestors);
  }
  return result;
}

function canonicalToolCall(block, label) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`${label} must be a tool call`);
  for (const key of Object.keys(block)) if (!["type", "id", "name", "arguments", "namespace"].includes(key)) throw new Error(`${label} has unknown field ${key}`);
  if (block.type !== "toolCall" || typeof block.id !== "string" || !TOOL_CALL_ID.test(block.id)
    || typeof block.name !== "string" || !TOOL_NAME.test(block.name)
    || (block.namespace !== undefined && (typeof block.namespace !== "string" || !NAMESPACE.test(block.namespace)))) {
    throw new Error(`${label} has invalid identity`);
  }
  if (!block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) throw new Error(`${label}.arguments must be a JSON object`);
  return {
    type: "toolCall",
    id: block.id,
    name: block.name,
    arguments: schemaProjection(block.arguments, `${label}.arguments`),
    ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
  };
}

function canonicalAssistantContent(content, label) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`${label} must be text or tool-call blocks`);
  const blocks = content.map((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`${label}[${index}] must be a block`);
    if (block.type === "text") {
      for (const key of Object.keys(block)) if (!["type", "text"].includes(key)) throw new Error(`${label}[${index}] has unknown field ${key}`);
      if (typeof block.text !== "string") throw new Error(`${label}[${index}].text must be text`);
      return { type: "text", text: block.text };
    }
    return canonicalToolCall(block, `${label}[${index}]`);
  });
  return blocks.every((block) => block.type === "text") ? blocks.map((block) => block.text).join("") : blocks;
}

function canonicalMessage(message, index) {
  const label = `proxy context messages[${index}]`;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error(`${label} must be an object`);
  if (message.role === "user") {
    exactKeys(message, USER_METADATA, label);
    return { role: "user", content: textContent(message.content, `${label}.content`) };
  }
  if (message.role === "assistant") {
    exactKeys(message, ASSISTANT_METADATA, label);
    return { role: "assistant", content: canonicalAssistantContent(message.content, `${label}.content`) };
  }
  if (message.role === "toolResult") {
    exactKeys(message, TOOL_RESULT_METADATA, label);
    if (typeof message.toolCallId !== "string" || !TOOL_CALL_ID.test(message.toolCallId)
      || typeof message.toolName !== "string" || !TOOL_NAME.test(message.toolName)
      || typeof message.isError !== "boolean") throw new Error(`${label} has invalid tool result identity`);
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      // Pi's read tool can return binary files as strings (for example `.git/index`). The raw
      // result remains in the child transcript and behavioral digest, while the provider-facing
      // replay gets a deterministic printable projection instead of terminating the whole task.
      content: providerToolResultContent(message.content, `${label}.content`),
      isError: message.isError,
    };
  }
  throw new Error(`${label} has an unsupported role`);
}

function canonicalTool(tool, index) {
  const label = `proxy context tools[${index}]`;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`${label} must be a tool`);
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || typeof tool.description !== "string") {
    throw new Error(`${label} has invalid identity or description`);
  }
  if (tool.parameters === undefined) throw new Error(`${label}.parameters is required`);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schemaProjection(tool.parameters, `${label}.parameters`),
  };
}

/** Convert a Pi Context into a detached, closed provider context. */
export function proxyCanonicalContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("proxy context is required");
  exactKeys(context, ["systemPrompt", "messages", "tools"], "proxy context");
  if (!Array.isArray(context.messages)) throw new Error("proxy context messages are required");
  if (context.systemPrompt !== undefined && typeof context.systemPrompt !== "string") throw new Error("proxy system prompt must be text");
  if (context.tools !== undefined && !Array.isArray(context.tools)) throw new Error("proxy context tools must be an array");
  const tools = (context.tools ?? []).map(canonicalTool);
  const messages = context.messages.map(canonicalMessage);
  return captureProviderContext({
    systemPrompt: context.systemPrompt ?? "",
    messages,
    tools,
  }).value;
}

/** Map closed provider terminal outcomes to Pi stop/error semantics without leaking raw bodies. */
export function proxyTerminalError(terminal) {
  const outcome = terminal?.payload?.outcome;
  if (outcome === "succeeded_terminal") return undefined;
  if (typeof outcome !== "string" || !/^[a-z_]+$/.test(outcome)) return "controller provider returned an invalid terminal";
  const status = terminal?.payload?.httpStatus;
  const reason = terminal?.payload?.providerReason;
  const safeReason = typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : undefined;
  const detail = [
    Number.isSafeInteger(status) && status >= 100 && status <= 599 ? String(status) : undefined,
    safeReason,
  ].filter(Boolean).join(", ");
  return detail ? `controller provider terminal: ${outcome} (${detail})` : `controller provider terminal: ${outcome}`;
}
