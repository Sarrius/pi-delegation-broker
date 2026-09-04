import { captureLosslessJson } from "./lossless-json.mjs";

/** Closed, lossless child→controller context vocabulary. Provider adapters may
 * project this value only after the controller has validated its replay state. */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// OpenAI Responses composes tool ids as `${call_id}|${item.id}`. The optional
// delimiter is valid only here; controller/snapshot identifiers remain stricter.
const TOOL_CALL_ID = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:\|[A-Za-z0-9][A-Za-z0-9._:-]*)?$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, name, max) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be bounded printable text`);
  }
  return value;
}

function boundedId(value, name, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} must be a bounded identifier`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}

function validateToolArguments(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
  try {
    captureLosslessJson(value, { maxBytes: 256 * 1024, maxNodes: 10_000, maxDepth: 32 });
  } catch (error) {
    throw new Error(`${label} are not lossless JSON: ${error instanceof Error ? error.message : "invalid value"}`);
  }
}

function validateToolCall(block, label, toolNames) {
  if (!isPlainObject(block)) throw new Error(`${label} must be a plain object`);
  exactKeys(block, ["type", "id", "name", "arguments", "namespace"], label);
  if (block.type !== "toolCall") throw new Error(`${label}.type is unsupported`);
  boundedId(block.id, `${label}.id`, TOOL_CALL_ID);
  boundedId(block.name, `${label}.name`, TOOL_NAME);
  if (block.namespace !== undefined) boundedId(block.namespace, `${label}.namespace`, ID);
  if (!toolNames.has(block.name)) throw new Error(`${label}.name is not an approved tool`);
  validateToolArguments(block.arguments, `${label}.arguments`);
}

function validateAssistantContent(content, label, toolNames, pending) {
  if (typeof content === "string") {
    boundedText(content, label, 256 * 1024);
    return;
  }
  if (!Array.isArray(content) || content.length > 128) throw new Error(`${label} must be text or a bounded block array`);
  for (const [index, block] of content.entries()) {
    const blockLabel = `${label}[${index}]`;
    if (!isPlainObject(block)) throw new Error(`${blockLabel} must be a plain object`);
    if (block.type === "text") {
      exactKeys(block, ["type", "text"], blockLabel);
      boundedText(block.text, `${blockLabel}.text`, 256 * 1024);
      continue;
    }
    validateToolCall(block, blockLabel, toolNames);
    if (pending.has(block.id)) throw new Error(`${blockLabel}.id is duplicated or unresolved`);
    pending.set(block.id, block.name);
  }
}

function validateMessages(messages, toolNames) {
  if (!Array.isArray(messages) || messages.length > 1_000) throw new Error("messages must be a bounded array");
  const pending = new Map();
  for (const [index, message] of messages.entries()) {
    const label = `messages[${index}]`;
    if (!isPlainObject(message)) throw new Error(`${label} must be a plain object`);
    if (!MESSAGE_ROLES.has(message.role)) throw new Error(`${label}.role is unsupported`);
    if (message.role === "user") {
      exactKeys(message, ["role", "content"], label);
      boundedText(message.content, `${label}.content`, 256 * 1024);
      continue;
    }
    if (message.role === "assistant") {
      exactKeys(message, ["role", "content"], label);
      validateAssistantContent(message.content, `${label}.content`, toolNames, pending);
      continue;
    }
    exactKeys(message, ["role", "toolCallId", "toolName", "content", "isError"], label);
    boundedId(message.toolCallId, `${label}.toolCallId`, TOOL_CALL_ID);
    boundedId(message.toolName, `${label}.toolName`, TOOL_NAME);
    boundedText(message.content, `${label}.content`, 256 * 1024);
    if (typeof message.isError !== "boolean") throw new Error(`${label}.isError must be boolean`);
    if (!pending.has(message.toolCallId)) throw new Error(`${label}.toolCallId has no matching assistant tool call`);
    if (pending.get(message.toolCallId) !== message.toolName) throw new Error(`${label}.toolName does not match its assistant tool call`);
    pending.delete(message.toolCallId);
  }
  if (pending.size > 0) throw new Error("messages end with unresolved tool calls");
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 128) throw new Error("tools must be a bounded array");
  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    const label = `tools[${index}]`;
    if (!isPlainObject(tool)) throw new Error(`${label} must be a plain object`);
    exactKeys(tool, ["name", "description", "inputSchema"], label);
    const name = boundedId(tool.name, `${label}.name`, TOOL_NAME);
    if (names.has(name)) throw new Error(`${label}.name is duplicated`);
    names.add(name);
    boundedText(tool.description, `${label}.description`, 16 * 1024);
    if (!isPlainObject(tool.inputSchema)) throw new Error(`${label}.inputSchema must be a JSON Schema object`);
  }
  return names;
}

/** Capture, freeze and validate canonical provider context before routing,
 * credential resolution or any provider send. Tool calls/results are replay
 * metadata, not permission: the controller separately binds tool names to the
 * effective child capability before admitting a tool-bearing stream. */
export function captureProviderContext(context, { maxBytes = 512 * 1024 } = {}) {
  const captured = captureLosslessJson(context, { maxBytes, maxNodes: 100_000, maxDepth: 32 });
  const value = captured.value;
  if (!isPlainObject(value)) throw new Error("context must be a plain object");
  exactKeys(value, ["systemPrompt", "messages", "tools"], "context");
  boundedText(value.systemPrompt, "systemPrompt", 256 * 1024);
  const toolNames = validateTools(value.tools);
  validateMessages(value.messages, toolNames);
  return captured;
}
