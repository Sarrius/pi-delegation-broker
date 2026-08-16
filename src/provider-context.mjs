import { captureLosslessJson } from "./lossless-json.mjs";

/** Closed, lossless child→controller context vocabulary for all provider
 * transports. Adapter-specific request conversion starts only after this
 * boundary; unknown modalities/options/replay state are rejected here rather
 * than silently dropped by one transport and accepted by another. */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, name, max) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new Error(`${name} must be bounded printable text`);
  }
  return value;
}

function boundedId(value, name, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} must be a bounded identifier`);
  return value;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 1_000) throw new Error("messages must be a bounded array");
  for (const [index, message] of messages.entries()) {
    if (!isPlainObject(message)) throw new Error(`messages[${index}] must be a plain object`);
    for (const key of Object.keys(message)) {
      if (key !== "role" && key !== "content") throw new Error(`messages[${index}] has unknown field ${key}`);
    }
    if (message.role !== "user" && message.role !== "assistant") throw new Error(`messages[${index}].role is unsupported`);
    boundedText(message.content, `messages[${index}].content`, 256 * 1024);
  }
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 128) throw new Error("tools must be a bounded array");
  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool)) throw new Error(`tools[${index}] must be a plain object`);
    for (const key of Object.keys(tool)) {
      if (!["name", "description", "inputSchema"].includes(key)) throw new Error(`tools[${index}] has unknown field ${key}`);
    }
    const name = boundedId(tool.name, `tools[${index}].name`, TOOL_NAME);
    if (names.has(name)) throw new Error(`tools[${index}].name is duplicated`);
    names.add(name);
    boundedText(tool.description, `tools[${index}].description`, 16 * 1024);
    if (!isPlainObject(tool.inputSchema)) throw new Error(`tools[${index}].inputSchema must be a JSON Schema object`);
  }
}

/** Capture, freeze and validate canonical provider context before routing,
 * credential resolution or any provider send. */
export function captureProviderContext(context, { maxBytes = 512 * 1024 } = {}) {
  const captured = captureLosslessJson(context, { maxBytes, maxNodes: 100_000, maxDepth: 32 });
  const value = captured.value;
  if (!isPlainObject(value)) throw new Error("context must be a plain object");
  for (const key of Object.keys(value)) {
    if (!["systemPrompt", "messages", "tools"].includes(key)) throw new Error(`context has unknown field ${key}`);
  }
  boundedText(value.systemPrompt, "systemPrompt", 256 * 1024);
  validateMessages(value.messages);
  validateTools(value.tools);
  return captured;
}
