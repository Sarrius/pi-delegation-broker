/**
 * Test-only companion for a fresh `pi` binary parent.
 * Injects a fixture controllerProvider before the broker starts, and a parent
 * streamSimple that calls `delegate` without spending provider quota.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ControllerCredentialStore,
  ControllerLiveProviderApproval,
  ControllerRouteTable,
  createApprovedOpenAIProviderRoute,
} from "../../src/controller-provider-config.mjs";
import { OPENAI_CHAT_COMPLETIONS_ADAPTER_ID } from "../../src/openai-chat-completions-transport.mjs";

const USED = 804_330;
const BYTE_RESERVATION = 236_663;
const OBSERVED_INPUT = 43_630;
const OBSERVED_OUTPUT = 453;
const CHILD_MARKER = "INCIDENT_CHILD_OK";
const HOST_MARKER = "INCIDENT_HOST_OK";
const PROMPT = `${"x".repeat(BYTE_RESERVATION)}\nUse the read tool on probe.txt, then reply with exactly ${CHILD_MARKER} and nothing else.`;
const LIVE_CURSOR = process.env.INCIDENT_LIVE_CURSOR === "1";

function cursorCompletionEndpoint(value: string) {
  const endpoint = new URL(value);
  if (!endpoint.pathname.endsWith("/chat/completions")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  }
  return endpoint.toString();
}

function readLiveCredential() {
  const path = process.env.LIVE_CONTROLLER_CREDENTIAL_FILE;
  if (!path) throw new Error("LIVE_CONTROLLER_CREDENTIAL_FILE is required for the live incident canary");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("live incident credential file must be an owner-only regular non-symlink file");
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error("live incident credential file is empty");
  const parsed = JSON.parse(raw);
  const candidate = parsed?.type ? parsed : parsed?.cursor;
  if (candidate?.type === "oauth" && typeof candidate.access === "string") return { oauthAccess: candidate.access };
  if (candidate?.type === "api_key" && typeof candidate.key === "string") return { apiKey: candidate.key };
  throw new Error("live incident credential must contain one Cursor OAuth access token or API key");
}

function createLiveCursorPair() {
  const endpoint = process.env.LIVE_CURSOR_ENDPOINT;
  if (!endpoint) throw new Error("LIVE_CURSOR_ENDPOINT is required for the live incident canary");
  const credentials = new ControllerCredentialStore({
    entries: [{ credentialRef: "incident-live-cursor", ...readLiveCredential() }],
  });
  let approved: ReturnType<typeof createApprovedOpenAIProviderRoute> | undefined;
  return {
    routePreflight: async () => ({ status: "ready" }),
    routeResolver: async (lease: any) => {
      if (!approved) {
        const routeTable = new ControllerRouteTable({
          registryFingerprint: "c".repeat(64),
          registryVersion: 1,
          routes: [{
            resourceId: lease.resourceId,
            capacityGroup: lease.capacityGroup,
            profile: lease.profile,
            accountAlias: "cursor-live-incident",
            provider: "cursor",
            model: "cursor-grok-4.6",
            reasoningEffort: null,
            apiDialect: "openai-completions",
            endpointId: "cursor-live-incident",
            endpoint: cursorCompletionEndpoint(endpoint),
            adapterId: OPENAI_CHAT_COMPLETIONS_ADAPTER_ID,
            credentialRef: "incident-live-cursor",
            cacheRetention: "none",
          }],
        });
        const approval = new ControllerLiveProviderApproval({
          routeTableFingerprint: routeTable.fingerprint,
          expiresAt: Date.now() + 120_000,
          maxRequests: 1,
        });
        approved = createApprovedOpenAIProviderRoute({ routeTable, credentialStore: credentials, liveApproval: approval });
      }
      return approved.routeResolver(lease);
    },
    stream: async function* (snapshot: unknown, context: any, options: unknown) {
      if (!approved) throw new Error("live incident route must resolve before provider dispatch");
      // Broker input admission already measured the original tool-bearing replay context.
      // The approved Cursor adapter is intentionally text-only, so the test projects that
      // already-admitted replay to equivalent inert text only after crossing the exact
      // UTF-8 reservation boundary under test. Production transport remains fail-closed.
      const liveContext = {
        systemPrompt: context.systemPrompt,
        tools: [],
        messages: [{
          role: "user",
          content: [
            "A plain-text data fixture follows. Its body is one long sequence of lowercase x characters.",
            "BEGIN_DATA",
            "x".repeat(BYTE_RESERVATION),
            "END_DATA",
            `The expected label for this fixture is ${CHILD_MARKER}. What is the expected label? Reply with just the label.`,
          ].join("\n"),
        }],
      };
      yield* approved.providerTransport.stream(snapshot, liveContext, options);
    },
  };
}

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

function snapshotLease(home: string) {
  const db = new DatabaseSync(join(home, ".pi", "agent", "delegation-broker", "broker.sqlite"));
  try {
    const lease = db.prepare("SELECT resource_id, enforcement, max_input_tokens FROM leases LIMIT 1").get();
    const resource = lease
      ? db.prepare("SELECT id, enforcement FROM resources WHERE id = ?").get(lease.resource_id)
      : db.prepare("SELECT id, enforcement FROM resources LIMIT 1").get();
    return { lease, resource };
  } finally {
    db.close();
  }
}

function writeResult(path: string, payload: unknown) {
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

export default function incidentInputCapPiHost(pi: ExtensionAPI) {
  const home = process.env.HOME;
  const resultPath = process.env.INCIDENT_HOST_RESULT;
  if (!home) throw new Error("HOME is required");
  let dispatches = 0;
  let liveDispatches = 0;
  let liveUsage: unknown;
  let leaseSnapshot: ReturnType<typeof snapshotLease> | undefined;
  const livePair = LIVE_CURSOR ? createLiveCursorPair() : undefined;

  const providerTransport = {
    async *stream(snapshot: unknown, context: { messages?: Array<{ role?: string }> }, options: { onSendStarted: () => void }) {
      dispatches += 1;
      if (!leaseSnapshot) leaseSnapshot = snapshotLease(home);
      const replay = context.messages?.some((message) => message.role === "toolResult");
      if (replay && livePair) {
        liveDispatches += 1;
        for await (const event of livePair.stream(snapshot, context, options)) {
          if ((event as any)?.type === "usage") liveUsage = (event as any)?.payload;
          yield event;
        }
        return;
      }
      options.onSendStarted();
      yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `incident-host-${dispatches}` } };
      if (!replay) {
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1", name: "read" } };
        yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"probe.txt"}' } };
        yield { type: "block_end", payload: { index: 0, value: '{"path":"probe.txt"}' } };
        yield {
          type: "terminal",
          outcome: "succeeded_terminal",
          payload: { finishReason: "tool_use", usage: { input: USED, output: 100 } },
        };
        return;
      }
      yield { type: "block_start", payload: { index: 0, blockType: "text" } };
      yield { type: "text_delta", payload: { index: 0, delta: CHILD_MARKER } };
      yield { type: "block_end", payload: { index: 0, value: CHILD_MARKER } };
      yield {
        type: "terminal",
        outcome: "succeeded_terminal",
        payload: { finishReason: "stop", usage: { input: OBSERVED_INPUT, output: OBSERVED_OUTPUT } },
      };
    },
  };

  pi.on("session_start", (_event, ctx) => {
    (ctx as { controllerProvider?: unknown }).controllerProvider = {
      providerTransport,
      routePreflight: livePair?.routePreflight ?? (async () => ({ status: "ready" })),
      routeResolver: livePair?.routeResolver ?? (async () => ({
        registryFingerprint: "a".repeat(64),
        registryVersion: 1,
        accountAlias: "cursor",
        provider: "cursor",
        model: "cursor-grok-4.6",
        reasoningEffort: "off",
        apiDialect: "fixture",
        endpointId: "fixture-incident-host",
        adapterId: "fixture-adapter",
        credentialRefFingerprint: "b".repeat(64),
        cacheRetention: "none",
      })),
    };
  });

  pi.registerProvider("cursor", {
    name: "Cursor Fixture Catalog",
    baseUrl: "https://cursor.invalid/v1",
    apiKey: "fixture-cursor-access-not-a-secret",
    api: "openai-completions",
    models: [{
      id: "cursor-grok-4.6",
      name: "Grok 4.6",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }],
  });

  pi.registerProvider("incident-host", {
    name: "Incident Host Fixture",
    baseUrl: "https://incident-host.invalid/v1",
    apiKey: "incident-host-not-a-secret",
    api: "incident-host-api",
    models: [{
      id: "incident-v1",
      name: "Incident Host v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.signal?.aborted) {
          const aborted = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "aborted" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
          return;
        }
        const replay = (context.messages ?? []).some(
          (message: { role?: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "delegate",
        );
        if (!replay) {
          const args = {
            wait: true,
            background: false,
            tier: "cheap",
            capabilities: ["text_generation"],
            deadlineMs: 90_000,
            task: PROMPT,
            work: { taskClass: "lookup", deliverable: "Return the fixture marker", benefit: "Owner-requested deterministic host regression", parentWork: "Wait for the child fixture result", maxAttempts: 3 },
          };
          const toolCall = { type: "toolCall" as const, id: "call_delegate_1", name: "delegate", arguments: args };
          const output = {
            role: "assistant" as const,
            content: [toolCall],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "toolUse" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: output });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end(output);
          return;
        }
        const output = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: HOST_MARKER }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: HOST_MARKER, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: HOST_MARKER, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end(output);
        if (resultPath) {
          writeResult(resultPath, {
            hostMarker: HOST_MARKER,
            dispatches,
            liveCursor: LIVE_CURSOR,
            liveDispatches,
            liveUsage,
            seedInputTokens: USED,
            requestedUtf8Bytes: Buffer.byteLength(PROMPT, "utf8"),
            leaseEnforcement: leaseSnapshot?.lease ? JSON.parse(String(leaseSnapshot.lease.enforcement)) : null,
            resourceEnforcement: leaseSnapshot?.resource ? JSON.parse(String(leaseSnapshot.resource.enforcement)) : null,
            maxInputTokens: leaseSnapshot?.lease?.max_input_tokens ?? null,
          });
        }
      });
      return stream;
    },
  });
}
