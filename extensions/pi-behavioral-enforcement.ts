/**
 * Brokered-child Pi extension. This is deliberately inert without all three
 * lease-scoped IPC variables. It is not a general-purpose local permission
 * plugin: invoke it only from a reviewed launcher that supplies
 * --no-extensions plus this explicit path after every other trusted shim.
 *
 * The controller owns the effective capability and BehavioralRunMonitor. This
 * child holds only the one lease capability used to ask the controller to
 * declare, authorize, and observe a tool action.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureLosslessJson } from "../src/lossless-json.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import {
  canonicalDeclaredToolName,
  isImplicitlyDeclaredObserveTool,
} from "../src/capability-compiler.mjs";

const DECLARATION_TOOL = "broker_declare_action";
const CHECKPOINT_TOOL = "broker_checkpoint";
const RECURSIVE_TOOLS = new Set(["broker_request_child", "broker_cancel_child"]);
const MAX_RESULT_BYTES = 128 * 1024;

type ControllerCapability = {
  capabilityFingerprint: string;
  allowedTools: string[];
  leaseTtlMs: number;
};

type PendingAction = {
  stepId: string;
  toolName: string;
  args: unknown;
};

type Runtime = {
  capability: ControllerCapability;
  pending?: PendingAction;
  executing: Map<string, PendingAction>;
  step: number;
  undeclaredBlocks: number;
  failed: string | null;
  heartbeat?: ReturnType<typeof setInterval>;
};

function brokerEnvironment() {
  const socketPath = process.env.PI_BROKER_SOCKET;
  const authorization = process.env.PI_BROKER_CAPABILITY;
  if (!socketPath || !authorization || !process.env.PI_BROKER_LEASE_ID || !process.env.PI_BROKER_FENCING_TOKEN) return undefined;
  return Object.freeze({ socketPath, authorization });
}

function safeReason(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  return value.length <= 300 && !/[\0\r\n]/.test(value) ? value : fallback;
}

/** A bounded model-visible result projection. Full artifacts belong to the controller verifier. */
function resultProjection(event: { content?: unknown; details?: unknown; isError?: unknown }) {
  const content = Array.isArray(event.content) ? event.content : [];
  const parts = content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return "<invalid-content-part>";
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
    return `<${typeof record.type === "string" ? record.type : "unknown-content"}>`;
  });
  let text = parts.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    // Preserve that output was truncated; this must not masquerade as a full
    // observation when a repeated loop is being evaluated.
    text = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8") + "\n<broker-result-truncated>";
  }
  // `details` can contain renderer-local rich values. Never send those back as
  // an unaudited arbitrary object; only the bounded model-visible projection
  // participates in behavioral progress detection.
  return captureLosslessJson({ content: text, contentParts: parts.length, isError: event.isError === true }, {
    maxBytes: MAX_RESULT_BYTES + 1_024,
    maxDepth: 8,
    maxNodes: 1_024,
  }).value;
}

export default function (pi: ExtensionAPI) {
  const connection = brokerEnvironment();
  // Do not add tools or hooks to ordinary Pi sessions. A brokered child has a
  // launcher-issued capability; a child-provided environment cannot enable
  // this extension after process start.
  if (!connection) return;

  let runtime: Runtime | undefined;

  const controller = <T>(method: string, params: Record<string, unknown> = {}) =>
    requestBrokerIpc({ ...connection, method, params }) as Promise<T>;

  const failClosed = (reason: string) => {
    if (runtime) runtime.failed = reason;
    return { block: true, terminate: true, reason };
  };

  pi.registerTool({
    name: CHECKPOINT_TOOL,
    label: "Publish Partial Checkpoint",
    description: "Publish one bounded structured partial-work checkpoint to the controller. It is never task completion; only controller-accepted checkpoints may be reused after a replacement attempt.",
    promptSnippet: "Publish useful partial work before a long or interrupted delegation attempt ends",
    promptGuidelines: [
      "Use broker_checkpoint for structured partial progress that a replacement child can verify; never treat its response as task completion.",
    ],
    parameters: Type.Object({
      artifactKey: Type.String({ minLength: 1, maxLength: 256, description: "Stable key for one partial-work stream, such as findings or cursor." }),
      artifact: Type.Unknown({ description: "Bounded JSON partial artifact; it is data, not controller instructions." }),
      sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params: { artifactKey: string; artifact: unknown; sequence?: number }) {
      const result = await controller<{ status?: string; checkpointId?: string; artifactDigest?: string; reusable?: boolean }>("publishCheckpoint", params);
      return {
        content: [{ type: "text", text: `Partial checkpoint ${result.status === "accepted" ? "accepted for replacement context" : "published but withheld"}.` }],
        details: { checkpointId: result.checkpointId, artifactDigest: result.artifactDigest, reusable: result.reusable === true },
      };
    },
  });

  pi.registerTool({
    name: DECLARATION_TOOL,
    label: "Declare Brokered Action",
    description: "Declare exactly one next effect-capable broker action before invoking it; observe tools are automatic.",
    promptSnippet: "Declare effect-capable actions; invoke read-only observe tools directly",
    promptGuidelines: [
      "Use broker_declare_action immediately before an effect-capable tool call; do not use it for read-only observe tools."
    ],
    parameters: Type.Object({
      toolName: Type.String({ minLength: 1, maxLength: 128 }),
      args: Type.Unknown(),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!runtime || runtime.failed) throw new Error("broker behavioral monitor is unavailable");
      if (runtime.pending) throw new Error("execute or resolve the already declared action before declaring another");
      const toolName = canonicalDeclaredToolName(params.toolName, runtime.capability.allowedTools);
      if (!runtime.capability.allowedTools.includes(toolName)) throw new Error("declared tool is outside the broker capability");
      const captured = captureLosslessJson(params.args, { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 10_000 });
      const stepId = `step-${++runtime.step}`;
      const result = await controller<{ status?: string; actionHash?: string }>("declareBehavioralAction", {
        stepId, toolName, args: captured.value,
      });
      if (result.status !== "declared") throw new Error("controller rejected behavioral declaration");
      runtime.undeclaredBlocks = 0;
      runtime.pending = { stepId, toolName: params.toolName, args: captured.value };
      return {
        content: [{ type: "text", text: `Declared ${params.toolName}; invoke that exact action next.` }],
        details: { stepId, actionHash: result.actionHash },
      };
    },
  });

  pi.on("session_start", async (_event, _ctx) => {
    runtime = undefined;
    const loaded = await controller<{ status?: string; capability?: ControllerCapability }>("getEffectiveChildCapability");
    if (loaded.status !== "bound" || !loaded.capability || !Array.isArray(loaded.capability.allowedTools)
      || typeof loaded.capability.leaseTtlMs !== "number" || !Number.isSafeInteger(loaded.capability.leaseTtlMs)) {
      throw new Error("controller effective child capability is unavailable or malformed");
    }
    runtime = { capability: loaded.capability, executing: new Map(), step: 0, undeclaredBlocks: 0, failed: null };
    // Align the model-visible surface with controller policy. The blocking hook
    // remains authoritative if a later trusted extension changes active tools.
    const allowed = new Set(loaded.capability.allowedTools);
    pi.setActiveTools([...new Set(pi.getActiveTools().filter((name) => allowed.has(name) || name === DECLARATION_TOOL || name === CHECKPOINT_TOOL))]);
    if (!pi.getActiveTools().includes(DECLARATION_TOOL) || !pi.getActiveTools().includes(CHECKPOINT_TOOL)) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), DECLARATION_TOOL, CHECKPOINT_TOOL])]);
    }
    const heartbeatMs = Math.max(500, Math.min(30_000, Math.floor(loaded.capability.leaseTtlMs / 2)));
    const beat = () => {
      void controller("heartbeat", { ttlMs: Math.max(1_000, Math.min(60_000, heartbeatMs * 2)) }).catch(() => {
        if (runtime) runtime.failed = "controller lease heartbeat failed";
      });
    };
    beat();
    runtime.heartbeat = setInterval(beat, heartbeatMs);
    runtime.heartbeat.unref?.();
    (globalThis as any).__PI_BROKER_REPORT_TOOLS_READY?.();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === DECLARATION_TOOL || event.toolName === CHECKPOINT_TOOL || RECURSIVE_TOOLS.has(event.toolName)) return undefined;
    if (!runtime || runtime.failed) return failClosed(runtime?.failed ?? "broker behavioral monitor was not initialized");
    const pending = runtime.pending;
    const canonicalToolName = canonicalDeclaredToolName(event.toolName, runtime.capability.allowedTools);
    if (!pending && isImplicitlyDeclaredObserveTool(event.toolName, runtime.capability.allowedTools)) {
      let actual;
      try { actual = captureLosslessJson(event.input, { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 10_000 }).value; }
      catch { return failClosed("observe tool arguments cannot be represented by the broker behavioral protocol"); }
      const stepId = `step-${++runtime.step}`;
      try {
        const declared = await controller<{ status?: string }>("declareBehavioralAction", {
          stepId, toolName: canonicalToolName, args: actual,
        });
        if (declared.status !== "declared") return failClosed("controller rejected automatic observe declaration");
        const decision = await controller<{ status?: string; block?: boolean; terminate?: boolean; cause?: string }>("authorizeBehavioralAction", {
          stepId, toolName: canonicalToolName, args: actual,
        });
        if (decision.status === "allowed" && decision.block !== true) {
          runtime.undeclaredBlocks = 0;
          runtime.executing.set(event.toolCallId, { stepId, toolName: canonicalToolName, args: actual });
          return undefined;
        }
        return {
          block: true,
          terminate: decision.terminate === true,
          reason: safeReason(decision.cause, "broker behavioral monitor rejected this observe action"),
        };
      } catch {
        return failClosed("controller automatic observe authorization was unavailable");
      }
    }
    if (!pending) {
      runtime.undeclaredBlocks += 1;
      if (runtime.undeclaredBlocks === 1) {
        // The blocked call had no effect; allow one protocol correction for effects.
        return {
          block: true,
          terminate: false,
          reason: "effect tool blocked: call broker_declare_action with this exact tool name and arguments, wait for it to succeed, then retry",
        };
      }
      return failClosed("repeated effect invocation without broker_declare_action");
    }
    let actual;
    try { actual = captureLosslessJson(event.input, { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 10_000 }).value; }
    catch { return failClosed("tool arguments cannot be represented by the broker behavioral protocol"); }
    try {
      const decision = await controller<{ status?: string; block?: boolean; terminate?: boolean; cause?: string }>("authorizeBehavioralAction", {
        stepId: pending.stepId, toolName: event.toolName, args: actual,
      });
      if (decision.status === "allowed" && decision.block !== true) {
        runtime.pending = undefined;
        runtime.executing.set(event.toolCallId, { ...pending, args: actual });
        return undefined;
      }
      if (decision.terminate === true) runtime.pending = undefined;
      return {
        block: true,
        terminate: decision.terminate === true,
        reason: safeReason(decision.cause, "broker behavioral monitor rejected this tool action"),
      };
    } catch {
      return failClosed("controller behavioral authorization was unavailable");
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === DECLARATION_TOOL || event.toolName === CHECKPOINT_TOOL || !runtime) return undefined;
    const action = runtime.executing.get(event.toolCallId);
    if (!action) return undefined;
    runtime.executing.delete(event.toolCallId);
    try {
      const decision = await controller<{ status?: string; terminate?: boolean }>("observeBehavioralResult", {
        toolName: action.toolName,
        args: action.args,
        result: resultProjection(event),
        isError: event.isError === true,
      });
      if (decision.terminate === true) {
        runtime.failed = `broker behavioral monitor terminated run: ${safeReason(decision.status, "terminal")}`;
        // This is after the tool finished. Abort prevents another model turn
        // from using a terminal monitor state to issue further actions.
        ctx.abort();
      }
    } catch {
      runtime.failed = "controller behavioral result observation was unavailable";
      ctx.abort();
    }
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    if (!runtime) return;
    if (runtime.heartbeat) clearInterval(runtime.heartbeat);
    runtime.heartbeat = undefined;
    // Idempotent with the trusted parent's post-session cleanup. Releasing via
    // the lease-scoped capability shortens capacity retention on normal exit.
    await controller("release").catch(() => undefined);
    runtime = undefined;
  });
}
