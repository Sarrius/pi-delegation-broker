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

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
      const { frames, terminal } = await streamProviderIpc({ socketPath, authorization, context: canonical, signal: options.signal });
      const blocks = new Map<number, number>();
      for (const frame of frames) {
        const payload = frame?.payload ?? {};
        if (frame.type === "block_start") {
          if (payload.blockType !== "text" || !Number.isSafeInteger(payload.index)) throw new Error("controller proxy only supports text response blocks");
          const contentIndex = output.content.length;
          blocks.set(payload.index, contentIndex);
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else if (frame.type === "text_delta") {
          const contentIndex = blocks.get(payload.index);
          const block = output.content[contentIndex as number];
          if (contentIndex === undefined || !block || typeof payload.delta !== "string") throw new Error("controller proxy received an invalid text delta");
          block.text += payload.delta;
          stream.push({ type: "text_delta", contentIndex, delta: payload.delta, partial: output });
        } else if (frame.type === "block_end") {
          const contentIndex = blocks.get(payload.index);
          const block = output.content[contentIndex as number];
          if (contentIndex === undefined || !block) throw new Error("controller proxy received an invalid block end");
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else if (frame.type === "usage") {
          output.usage.input = nonNegative(payload.input);
          output.usage.output = nonNegative(payload.output);
          output.usage.cacheRead = nonNegative(payload.cacheRead);
          output.usage.cacheWrite = nonNegative(payload.cacheWrite);
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        }
      }
      const terminalError = proxyTerminalError(terminal);
      if (terminalError) throw new Error(terminalError);
      output.stopReason = "stop";
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
