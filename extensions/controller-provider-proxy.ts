/**
 * Brokered-child native Pi provider backed by controller `providerStream` IPC.
 *
 * It is inert outside a proxy-enabled leased child. The only token it reads is the lease-scoped
 * broker capability already needed for behavioral IPC; it never receives an upstream API key,
 * OAuth refresh token, parent auth.json, or provider endpoint credential.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamProviderIpc } from "../src/ipc.mjs";
import { proxyCanonicalContext, proxyTerminalError } from "../src/proxy-context.mjs";

const PROVIDER_ID = "broker-proxy";
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function partialToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function streamControllerProxy(model: any, context: any, options: any = {}) {
  const stream = createAssistantMessageEventStream();
  const socketPath = process.env.PI_BROKER_SOCKET;
  const authorization = process.env.PI_BROKER_CAPABILITY;
  const output: any = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      // Pi's provider interface requires this display field. It is fixed to zero and is never
      // emitted back to the broker's policy/efficiency path.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
  void (async () => {
    try {
      if (!socketPath || !authorization) throw new Error("controller proxy lease capability is unavailable");
      const canonical = proxyCanonicalContext(context);
      stream.push({ type: "start", partial: output });
      const reasoningEffort = options.reasoning || "off";
      const { frames, terminal } = await streamProviderIpc({ socketPath, authorization, context: canonical, reasoningEffort, signal: options.signal });
      const blocks = new Map<number, { contentIndex: number; type: "text" | "toolCall"; partialArgs?: string }>();
      for (const frame of frames) {
        const payload = frame?.payload ?? {};
        if (frame.type === "block_start") {
          if (!Number.isSafeInteger(payload.index)) throw new Error("controller proxy received an invalid response block index");
          const contentIndex = output.content.length;
          if (payload.blockType === "text") {
            blocks.set(payload.index, { contentIndex, type: "text" });
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: output });
          } else if (payload.blockType === "tool_call" && typeof payload.id === "string" && TOOL_CALL_ID.test(payload.id)
            && typeof payload.name === "string" && TOOL_NAME.test(payload.name)) {
            blocks.set(payload.index, { contentIndex, type: "toolCall", partialArgs: "" });
            output.content.push({ type: "toolCall", id: payload.id, name: payload.name, arguments: {} });
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
          } else {
            throw new Error("controller proxy received an unsupported response block");
          }
        } else if (frame.type === "text_delta") {
          const state = blocks.get(payload.index);
          const block = output.content[state?.contentIndex as number];
          if (!state || state.type !== "text" || !block || typeof payload.delta !== "string" || payload.delta.length === 0) {
            throw new Error("controller proxy received an invalid text delta");
          }
          block.text += payload.delta;
          stream.push({ type: "text_delta", contentIndex: state.contentIndex, delta: payload.delta, partial: output });
        } else if (frame.type === "tool_call_delta") {
          const state = blocks.get(payload.index);
          const block = output.content[state?.contentIndex as number];
          if (!state || state.type !== "toolCall" || !block || typeof payload.delta !== "string" || payload.delta.length === 0) {
            throw new Error("controller proxy received an invalid tool call delta");
          }
          state.partialArgs = `${state.partialArgs ?? ""}${payload.delta}`;
          block.arguments = partialToolArguments(state.partialArgs);
          stream.push({ type: "toolcall_delta", contentIndex: state.contentIndex, delta: payload.delta, partial: output });
        } else if (frame.type === "block_end") {
          const state = blocks.get(payload.index);
          const block = output.content[state?.contentIndex as number];
          if (!state || !block || typeof payload.value !== "string") throw new Error("controller proxy received an invalid block end");
          if (state.type === "text") {
            if (payload.value !== block.text) throw new Error("controller proxy received a mismatched text block end");
            stream.push({ type: "text_end", contentIndex: state.contentIndex, content: block.text, partial: output });
          } else {
            if (payload.value !== state.partialArgs) throw new Error("controller proxy received a mismatched tool call block end");
            let args: unknown;
            try { args = JSON.parse(payload.value); } catch { throw new Error("controller proxy received invalid tool call arguments"); }
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("controller proxy received invalid tool call arguments");
            block.arguments = args;
            stream.push({ type: "toolcall_end", contentIndex: state.contentIndex, toolCall: block, partial: output });
          }
          blocks.delete(payload.index);
        } else if (frame.type === "usage") {
          output.usage.input = nonNegative(payload.input);
          output.usage.output = nonNegative(payload.output);
          output.usage.cacheRead = nonNegative(payload.cacheRead);
          output.usage.cacheWrite = nonNegative(payload.cacheWrite);
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        }
      }
      if (blocks.size > 0) throw new Error("controller proxy received an unclosed response block");
      const terminalError = proxyTerminalError(terminal);
      if (terminalError) throw new Error(terminalError);
      const hasToolCall = output.content.some((block: any) => block?.type === "toolCall");
      output.stopReason = hasToolCall ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function controllerProviderProxy(pi: ExtensionAPI): void {
  const modelId = process.env.PI_BROKER_PROXY_MODEL_ID;
  if (!modelId || !process.env.PI_BROKER_SOCKET || !process.env.PI_BROKER_CAPABILITY) return;
  const maxTokens = Number.parseInt(process.env.PI_BROKER_MAX_OUTPUT_TOKENS ?? "8192", 10);
  pi.registerProvider(PROVIDER_ID, {
    name: "Controller broker proxy",
    baseUrl: "http://controller.invalid/v1",
    // This is the lease-scoped IPC capability, not an upstream provider credential. streamSimple
    // never makes HTTP and sends it only over the owner-only broker Unix socket.
    apiKey: "$PI_BROKER_CAPABILITY",
    api: "broker-proxy" as any,
    models: [{
      id: modelId,
      name: `Controller proxy: ${modelId}`,
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple: streamControllerProxy,
  } as any);
}
