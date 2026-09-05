import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHILD_MARKER = "VISUAL_CHILD_OK";
const WAIT_MARKER = "AWAITING_VISUAL_WAKE";
const PARENT_MARKER = "VISUAL_PARENT_WAKE_OK";
const WAKE_MARKER = "[delegation-broker:wake:v1]";

function emptyUsage() {
  return {
    input: 8,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(model: any, content: any[], stopReason: "stop" | "toolUse") {
  return {
    role: "assistant" as const,
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("");
}

function emitText(stream: any, model: any, text: string) {
  const output = assistant(model, [{ type: "text", text }], "stop");
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end(output);
}

function emitTool(stream: any, model: any, name: string, id: string, args: Record<string, unknown>) {
  const toolCall = { type: "toolCall" as const, id, name, arguments: args };
  const output = assistant(model, [toolCall], "toolUse");
  stream.push({ type: "start", partial: output });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end(output);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export default function incidentVisualPiHost(pi: ExtensionAPI) {
  const resultPath = process.env.VISUAL_HOST_RESULT;
  if (!resultPath) throw new Error("VISUAL_HOST_RESULT is required");
  let unavailableResource: string | undefined;
  let actualResource: string | undefined;
  let imageDigest: string | undefined;
  let childDispatches = 0;
  let childCompletedAt: number | undefined;
  let parentCompletedAt: number | undefined;
  const parentObservations: Array<Record<string, unknown>> = [];

  const writeResult = () => {
    writeFileSync(resultPath, `${JSON.stringify({
      unavailableResource,
      actualResource,
      imageDigest,
      childDispatches,
      childCompletedAt,
      parentCompletedAt,
      parentObservations,
    })}\n`, { mode: 0o600 });
  };

  const providerTransport = {
    async *stream(snapshot: any, context: any, options: { onSendStarted: () => void }) {
      actualResource = snapshot.resourceId;
      if (actualResource === unavailableResource) throw new Error("preflight-unavailable route was dispatched");
      childDispatches += 1;
      options.onSendStarted();
      yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `visual-child-${childDispatches}` } };
      const toolResult = context.messages?.find((message: any) => message.role === "toolResult");
      if (!toolResult) {
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_visual_read", name: "read" } };
        yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"pixel.png"}' } };
        yield { type: "block_end", payload: { index: 0, value: '{"path":"pixel.png"}' } };
        yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "tool_use", usage: { input: 20, output: 8 } } };
        return;
      }
      if (!Array.isArray(toolResult.content)) throw new Error("visual tool result was stringified");
      const image = toolResult.content.find((block: any) => block?.type === "image");
      if (!image || image.mimeType !== "image/png" || typeof image.data !== "string" || image.data.length < 16) {
        throw new Error("visual tool result lost its image block");
      }
      imageDigest = createHash("sha256").update(image.data).digest("hex");
      yield { type: "block_start", payload: { index: 0, blockType: "text" } };
      yield { type: "text_delta", payload: { index: 0, delta: CHILD_MARKER } };
      yield { type: "block_end", payload: { index: 0, value: CHILD_MARKER } };
      childCompletedAt = Date.now();
      writeResult();
      yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "stop", usage: { input: 40, output: 4 } } };
    },
  };

  pi.on("session_start", (_event, ctx) => {
    (ctx as any).controllerProvider = {
      providerTransport,
      routePreflight: async ({ resourceId }: { resourceId: string }) => {
        if (!unavailableResource) {
          unavailableResource = resourceId;
          return { status: "unavailable", reason: "fixture_first_route_unavailable", scope: "resource" };
        }
        return { status: "ready" };
      },
      routeResolver: async (lease: any) => {
        const separator = lease.resourceId.indexOf("/");
        return {
          registryFingerprint: "a".repeat(64),
          registryVersion: 1,
          accountAlias: lease.resourceId.slice(0, separator),
          provider: lease.resourceId.slice(0, separator),
          model: lease.resourceId.slice(separator + 1),
          reasoningEffort: "off",
          apiDialect: "fixture-native",
          endpointId: `visual-${lease.leaseId}`.slice(0, 127),
          adapterId: "fixture-native-adapter",
          credentialRefFingerprint: "b".repeat(64),
          cacheRetention: "none",
        };
      },
    };
  });

  for (const [provider, id] of [
    ["anthropic-account-91", "claude-opus-5"],
    ["openai-codex-account-91", "gpt-5.6-sol"],
  ]) {
    pi.registerProvider(provider, {
      name: `Visual fixture ${provider}`,
      baseUrl: "https://visual.invalid/v1",
      apiKey: `fixture-${provider}`,
      api: provider.startsWith("anthropic") ? "anthropic-messages" : "openai-codex-responses",
      models: [{
        id,
        name: id,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272_000,
        maxTokens: 32_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    } as any);
  }

  pi.registerProvider("visual-host", {
    name: "Visual incident host",
    baseUrl: "https://visual-host.invalid/v1",
    apiKey: "fixture-visual-host",
    api: "visual-host-api",
    models: [{
      id: "visual-host-v1",
      name: "Visual host v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 64_000,
      maxTokens: 1_024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const messages = context.messages ?? [];
          const allText = messages.map((message: any) => textOf(message.content)).join("\n");
          const lastTool = [...messages].reverse().find((message: any) => message.role === "toolResult");
          parentObservations.push({
            roles: messages.map((message: any) => message.role),
            lastToolName: lastTool?.toolName,
            hasWake: allText.includes(WAKE_MARKER),
            tail: allText.slice(-300),
          });
          writeResult();
          if (lastTool?.toolName === "delegate_collect") {
            if (!textOf(lastTool.content).includes(CHILD_MARKER)) throw new Error("collected report omitted the child marker");
            emitText(stream, model, PARENT_MARKER);
            parentCompletedAt = Date.now();
            writeResult();
            return;
          }
          if (allText.includes(WAKE_MARKER)) {
            const taskId = allText.match(/^- ([A-Za-z0-9][A-Za-z0-9._-]{0,159}): completed$/m)?.[1];
            if (!taskId) throw new Error("wake omitted a completed task id");
            emitTool(stream, model, "delegate_collect", "call_collect_visual", { taskId });
            return;
          }
          if (lastTool?.toolName === "delegate") {
            if (!await waitUntil(() => childCompletedAt !== undefined, 10_000)) throw new Error("visual child did not settle while parent was busy");
            await new Promise((resolve) => setTimeout(resolve, 300));
            emitText(stream, model, WAIT_MARKER);
            return;
          }
          emitTool(stream, model, "delegate", "call_delegate_visual", {
            task: "Use the read tool on pixel.png, inspect the image, and return exactly VISUAL_CHILD_OK.",
            work: { taskClass: "lookup", deliverable: "Return the fixture marker", benefit: "Owner-requested deterministic host regression", parentWork: "Wait for the child fixture result", maxAttempts: 3 },
            tier: "frontier",
            capabilities: ["text_generation", "vision_input"],
            background: true,
            idempotencyKey: "incident-visual-busy-parent",
            deadlineMs: 30_000,
          });
        } catch (error) {
          const failed = assistant(model, [], "stop");
          failed.stopReason = "error" as any;
          failed.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end(failed);
        }
      });
      return stream;
    },
  } as any);
}
