import { createHash, randomUUID } from "node:crypto";
import { retryAfterMs } from "./provider-probe.mjs";
import { connect } from "node:net";
import * as piAI from "@earendil-works/pi-ai";

/**
 * Parent-owned controller provider adapter.
 *
 * The child only receives the lease-scoped IPC route. The child never
 * receives a Pi model registry, credential store, or provider object.  The route resolver binds one
 * lease to one exact Pi model plus the already-resolved credential, and the transport consumes that
 * binding once.  This keeps all subscription families on Pi's native provider implementations
 * (including API dialects this extension does not need to reimplement) while keeping credentials in
 * the parent process.
 */
export const CONTROLLER_PROVIDER_ADAPTER_ID = "pi-native-provider@1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,159}$/;
const PROVIDER_REASON = /^[a-z_]{1,64}$/;
// Native providers expose compound tool ids in two observed forms: OpenAI Responses joins
// `${call_id}|${item.id}`, while Cursor's Grok SSE adapter joins the same two bounded components
// with one LF. Keep both delimiters scoped to tool-call ids; route/snapshot ids stay stricter.
const TOOL_CALL_ID = /^(?=[\s\S]{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:(?:\||\n)[A-Za-z0-9][A-Za-z0-9._:-]*)?$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ROUTE_CACHE_LIMIT = 256;
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
// A loopback reachability answer is only worth caching for seconds: the whole point is to notice a
// bridge that died under a running controller, while still not opening a socket per preflight.
const LOOPBACK_PROBE_TIMEOUT_MS = 250;
const LOOPBACK_PROBE_TTL_MS = 5_000;
const SUPPORTED_CACHE_RETENTION = new Set(["none", "short", "long"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Pi's OpenAI-Completions adapter needs positive reasoning/effort metadata to send
 * reasoning_effort. Missing/false support is not proof of an executable non-off level.
 * Other declared thinking formats can carry it in separate fields; do not infer those here. */
function cursorEffortUnsupported(provider: string, model: any, apiDialect: string, requested: unknown): boolean {
	return /^cursor(?:-account-\d+)?$/.test(provider)
		&& apiDialect === "openai-completions"
		&& typeof requested === "string" && requested !== "off" && THINKING_LEVELS.has(requested)
		&& (model?.reasoning !== true || (model?.compat?.supportsReasoningEffort !== true
			&& (!model?.compat?.thinkingFormat || model.compat.thinkingFormat === "openai")));
}

// An active low recommendation needs positive route evidence, not Pi's permissive default.
// Codex Responses maps low to the explicit reasoning.effort field on this attested path.
function codexLowAttested(provider: string, model: any, apiDialect: string): boolean {
	return /^openai-codex(?:-account-\d+)?$/.test(provider)
		&& apiDialect === "openai-codex-responses" && model?.reasoning === true
		&& model?.thinkingLevelMap?.low === "low";
}

const FIXED_REASONS = Object.freeze({
	unsupportedTools: "unsupported_tools",
	invalidBlockStart: "invalid_block_start",
	invalidBlockDelta: "invalid_block_delta",
	invalidBlockEnd: "invalid_block_end",
	unsupportedStreamEvent: "unsupported_stream_event",
	truncatedBlock: "truncated_block",
	invalidModel: "invalid_model",
	invalidRequest: "invalid_request",
	modelUnavailable: "model_unavailable",
	contextWindow: "context_window_exceeded",
	subscriptionExtraUsage: "subscription_extra_usage_required",
	quota: "quota_exhausted",
	rateLimit: "rate_limited",
	auth: "auth_failed",
});

type Registry = {
	getAll?: () => readonly any[];
	find?: (provider: string, modelId: string) => any;
	getProvider?: (provider: string) => any;
	getApiKeyAndHeaders?: (model: any) => Promise<any>;
	getRegisteredProviderConfig?: (provider: string) => any;
};

type RouteBinding = {
	leaseId: string;
	resourceId: string;
	provider: string;
	modelId: string;
	model: any;
	providerRuntime: any;
	auth: {
		apiKey: string;
		headers?: Record<string, string | null>;
		env?: Record<string, string>;
		baseUrl?: string;
	};
	createdAt: number;
};

type NormalizedEvent =
	| { type: "headers"; payload: Record<string, unknown> }
	| { type: "block_start" | "text_delta" | "reasoning_delta" | "tool_call_delta" | "block_end" | "usage"; payload: Record<string, unknown> }
	| { type: "terminal"; outcome: string; payload: Record<string, unknown> };

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixedProviderReason(value: string): string | undefined {
	return PROVIDER_REASON.test(value) ? value : undefined;
}

function parseResourceId(resourceId: unknown): { provider: string; modelId: string } | undefined {
	if (typeof resourceId !== "string") return undefined;
	const separator = resourceId.indexOf("/");
	if (separator < 1 || separator === resourceId.length - 1) return undefined;
	const provider = resourceId.slice(0, separator);
	const modelId = resourceId.slice(separator + 1);
	if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(modelId)) return undefined;
	return { provider, modelId };
}

function boundedRouteText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0-\x1f]/.test(value)
		? value
		: fallback;
}

function endpointFor(model: any, providerRuntime: any, auth: any): string {
	return boundedRouteText(
		auth?.baseUrl ?? model?.baseUrl ?? providerRuntime?.baseUrl,
		"native-provider",
	);
}

/** A loopback route published by a local slot proxy (`http://127.0.0.1:<port>/<slot>`). */
export function isLoopbackRoute(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
	try {
		const { hostname, protocol } = new URL(baseUrl);
		if (protocol !== "http:" && protocol !== "https:") return false;
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Which routes must not attempt Pi's default WebSocket-first transport?
 *
 * The controller dispatches with `maxRetries: 0`, so Pi's own WS→SSE fallback never runs: a failed
 * upgrade surfaces as `transport_before_headers` with zero tokens and is then misread as a dead
 * account. Cursor's bridge was already known to need SSE, but every numbered Anthropic/Codex slot
 * is published on the same kind of loopback HTTP shim, which cannot serve a WebSocket upgrade
 * either. Deciding by endpoint shape rather than by provider name covers all of them.
 */
export function requiresSseTransport(provider: string, baseUrl?: unknown): boolean {
	return /^(?:cursor|cursor-account-\d+)$/.test(provider) || isLoopbackRoute(baseUrl);
}

/**
 * Is the local bridge behind a loopback route still accepting connections?
 *
 * A slot proxy or Cursor bridge belongs to one host process. When that process exits — or when the
 * canonical port is taken over by a different session — `models.json` keeps advertising the route,
 * the broker keeps listing its models as available capacity, and every child dies before headers.
 * A bounded TCP connect is enough to tell "nobody is listening" from "the provider answered", and
 * it is the only part of the route that can be checked without spending a request or a credential.
 */
export async function probeLoopbackRoute(
	baseUrl: string,
	timeoutMs = LOOPBACK_PROBE_TIMEOUT_MS,
	connectImpl: typeof connect = connect,
): Promise<boolean> {
	let url: URL;
	try { url = new URL(baseUrl); } catch { return false; }
	const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const done = (reachable: boolean) => {
			if (settled) return;
			settled = true;
			try { socket.destroy(); } catch { /* the probe owns this socket and nothing else reads it */ }
			resolve(reachable);
		};
		const socket = connectImpl({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
		socket.setTimeout?.(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

function modelApi(model: any, provider: string, registry: Registry): string | undefined {
	if (typeof model?.api === "string" && model.api.length > 0) return model.api;
	const configured = registry.getRegisteredProviderConfig?.(provider);
	return typeof configured?.api === "string" && configured.api.length > 0 ? configured.api : undefined;
}

function modelIdentity(model: any, provider: string, modelId: string): Record<string, unknown> {
	return {
		provider,
		modelId,
		api: typeof model?.api === "string" ? model.api : undefined,
		baseUrl: typeof model?.baseUrl === "string" ? model.baseUrl : undefined,
		contextWindow: Number.isSafeInteger(model?.contextWindow) ? model.contextWindow : undefined,
		maxTokens: Number.isSafeInteger(model?.maxTokens) ? model.maxTokens : undefined,
		input: Array.isArray(model?.input) ? model.input.filter((value: unknown) => value === "text" || value === "image") : undefined,
	};
}

function poolFingerprint(registry: Registry, selected: Record<string, unknown>): string {
	let models: any[] = [];
	try {
		models = [...(registry.getAll?.() ?? [])]
			.filter((model) => typeof model?.provider === "string" && typeof model?.id === "string")
			.map((model) => modelIdentity(model, model.provider, model.id))
			.slice(0, 10_000);
	} catch {
		models = [];
	}
	if (models.length === 0 || !models.some((model) => model.provider === selected.provider && model.modelId === selected.modelId)) {
		models.push(selected);
	}
	models.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return digest(JSON.stringify(models));
}

function endpointId(provider: string, modelId: string, endpoint: string): string {
	return `pi-native-${digest(`${provider}\0${modelId}\0${endpoint}`).slice(0, 32)}`;
}

function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	if (typeof (headers as any).get === "function") {
		const value = (headers as any).get(name);
		return typeof value === "string" ? value : undefined;
	}
	const record = headers as Record<string, unknown>;
	const exact = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
	return typeof exact === "string" ? exact : undefined;
}

function responsePayload(status: unknown, headers: unknown): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) {
		payload.httpStatus = Number(status);
	}
	const requestId = headerValue(headers, "request-id") ?? headerValue(headers, "x-request-id");
	if (typeof requestId === "string" && ID.test(requestId)) payload.providerRequestId = requestId;
	return payload;
}

function usageFrom(value: any): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const read = (key: string): number =>
		Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
	return {
		input: read("input"),
		output: read("output"),
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
	};
}

function messageText(value: any): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		if (typeof value.errorMessage === "string") return value.errorMessage;
		if (typeof value.message === "string") return value.message;
	}
	return "";
}

function unsupportedRequestMessage(message: string, status: number): boolean {
	// Only direct SDK/provider error text, never a transport diagnostic quoting an old error.
	if (message.length > 8_192) return false;
	let body = message.trim();
	if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_[A-Z_]+)\b|\b(?:connection|socket)\s+(?:reset|refused|closed|timed\s+out)|\bfetch\s+failed/i.test(body)) return false;
	if (body.startsWith(`${status}:`)) body = body.slice(String(status).length + 1).trim();
	const direct = (value: unknown) => typeof value === "string" && /^unsupported (?:parameter|value):\s*\S/i.test(value.trim());
	if (direct(body)) return true;
	try {
		const value = JSON.parse(body);
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const requestTypes = new Set(["invalid_request", "invalid_request_error"]);
		const requestCodes = new Set(["invalid_request", "invalid_request_error", "unsupported_parameter", "unsupported_value"]);
		for (const container of [value, value.error]) {
			if (!container || typeof container !== "object") continue;
			if (container.type != null && !requestTypes.has(container.type)) return false;
			if (container.code != null && !requestCodes.has(container.code)) return false;
		}
		const fields = [value.detail, value.message, value.error?.message, value.error?.detail].filter(field => typeof field === "string");
		return fields.length > 0 && fields.every(direct);
	} catch { return false; }
}

function errorClassification(status: number | undefined, message: string, aborted: boolean, headersSeen: boolean, nativeContentStarted = false) {
	const lower = message.toLowerCase();
	if (aborted) return { outcome: "cancelled_after_send", reason: undefined };
	// Provider-owned outcomes are legal only after controller-observed response evidence. Native
	// SDK error text is not authoritative by itself: classifying "401" before headers as
	// auth_fatal makes AttemptSettlement reject the impossible provider_send_started→auth_fatal
	// transition, which then gets rewritten to opaque controller_failure. More importantly, it
	// lets an SDK/controller defect poison account health. Without headers/status the only fact is
	// that dispatch failed before a provider response became observable.
	const providerResponseObserved = headersSeen || status !== undefined;
	if (!providerResponseObserved) {
		return { outcome: "transport_before_headers", reason: undefined };
	}
	if (lower.includes("context window") || lower.includes("context length") || lower.includes("too many tokens")) {
		return { outcome: "context_window_exceeded", reason: FIXED_REASONS.contextWindow };
	}
	if (lower.includes("extra usage") || lower.includes("plan limits")) {
		return { outcome: "rejected_before_send", reason: FIXED_REASONS.subscriptionExtraUsage };
	}
	if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
		return { outcome: "rate_limited", reason: FIXED_REASONS.rateLimit };
	}
	if (status === 402 || lower.includes("insufficient balance") || lower.includes("quota exhausted") || lower.includes("usage limit")) {
		return { outcome: "quota_fatal", reason: FIXED_REASONS.quota };
	}
	if (status === 401 || status === 403 || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
		return { outcome: "auth_fatal", reason: FIXED_REASONS.auth };
	}
	if (status === 404 || lower.includes("model not found") || lower.includes("model is not supported")) {
		return { outcome: "rejected_before_send", reason: FIXED_REASONS.modelUnavailable };
	}
	// A direct2xx request rejection is definite only before native content starts.
	// Partial SSE stays ambiguous: rejected_before_send is illegal after streaming_tentative.
	if (status !== undefined && status >= 200 && status < 300 && unsupportedRequestMessage(message, status)) {
		return nativeContentStarted
			? { outcome: "stream_truncated", reason: undefined }
			: { outcome: "rejected_before_send", reason: FIXED_REASONS.invalidRequest };
	}
	if (status !== undefined && status >= 400 && status < 500) {
		return { outcome: "rejected_before_send", reason: FIXED_REASONS.invalidRequest };
	}
	return { outcome: "stream_truncated", reason: undefined };
}

function verifySnapshot(snapshot: any): void {
	if (!snapshot || typeof snapshot !== "object") throw new Error("controller provider snapshot is unavailable");
	if (snapshot.adapterId !== CONTROLLER_PROVIDER_ADAPTER_ID) throw new Error("controller provider snapshot uses an unsupported adapter");
	if (typeof snapshot.leaseId !== "string" || !ID.test(snapshot.leaseId)) throw new Error("controller provider snapshot lease is invalid");
	if (typeof snapshot.resourceId !== "string" || !MODEL_ID.test(snapshot.resourceId.slice(snapshot.resourceId.indexOf("/") + 1))) throw new Error("controller provider snapshot resource is invalid");
	if (typeof snapshot.provider !== "string" || !PROVIDER_ID.test(snapshot.provider)) throw new Error("controller provider snapshot provider is invalid");
	if (typeof snapshot.model !== "string" || !MODEL_ID.test(snapshot.model)) throw new Error("controller provider snapshot model is invalid");
	if (!SUPPORTED_CACHE_RETENTION.has(snapshot.cacheRetention)) throw new Error("controller provider snapshot cache retention is invalid");
	for (const key of ["maxInputBytes", "maxOutputBytes", "maxOutputTokens"]) {
		if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 1) throw new Error(`controller provider snapshot ${key} is invalid`);
	}
}

function sameBinding(snapshot: any, binding: RouteBinding): boolean {
	return snapshot.leaseId === binding.leaseId
		&& snapshot.resourceId === binding.resourceId
		&& snapshot.provider === binding.provider
		&& snapshot.model === binding.modelId;
}

function contentHasImage(content: any): boolean {
	return Array.isArray(content) && content.some((block: any) => block?.type === "image");
}

function ensureSupportedContext(context: any, model: any): void {
	if (!Array.isArray(context?.messages) || context.messages.length === 0) {
		throw new Error("controller provider requires replayable messages");
	}
	if (context.tools !== undefined && !Array.isArray(context.tools)) {
		throw new Error("controller provider tool context is invalid");
	}
	const hasImage = context.messages.some((message: any) => contentHasImage(message?.content));
	if (hasImage && (!Array.isArray(model?.input) || !model.input.includes("image"))) {
		throw new Error("controller provider route does not support image input");
	}
}

function nativeMessage(message: any): any {
	if (message.role === "system") {
		return {
			role: "system", content: message.content, timestamp: 0,
			...(message.sections === undefined ? {} : { sections: message.sections }),
			...(message.toolsAdded === undefined ? {} : { toolsAdded: message.toolsAdded.map((tool: any) => ({
				name: tool.name, description: tool.description, parameters: tool.inputSchema,
			})) }),
			...(message.toolsRemoved === undefined ? {} : { toolsRemoved: message.toolsRemoved }),
		};
	}
	if (message.role === "assistant" && Array.isArray(message.content)) {
		return {
			role: "assistant",
			content: message.content.map((block: any) => block.type === "toolCall"
				? {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.arguments,
					...(block.namespace === undefined ? {} : { namespace: block.namespace }),
				}
				: { type: "text", text: block.text }),
		};
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			content: Array.isArray(message.content)
				? message.content.map((block: any) => block.type === "image"
					? { type: "image", data: block.data, mimeType: block.mimeType }
					: { type: "text", text: block.text })
				: [{ type: "text", text: message.content }],
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}
	return { role: message.role, content: message.content };
}

function nativeContext(context: any): any {
	// Host aliases bind this namespace to the running AI module. Old native
	// providers need Context; new ones require TranscriptContext. Never flatten
	// chronological updates or send legacy prompt/tools to a native1.x provider.
	const normalize = (piAI as unknown as { normalizeContext?: (value: any) => any }).normalizeContext;
	if (context.messages.some((message: any) => message.role === "system")) {
		if (typeof normalize !== "function") throw new Error("native transcript context is unsupported by this host");
		return { messages: context.messages.map(nativeMessage) };
	}
	const legacyContext = {
		...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}),
		messages: context.messages.map(nativeMessage),
		tools: (Array.isArray(context.tools) ? context.tools : []).map((tool: any) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		})),
	};
	return typeof normalize === "function" ? normalize(legacyContext) : legacyContext;
}

function blockTypeFor(eventType: string): "text" | "reasoning" | undefined {
	if (eventType.startsWith("text_")) return "text";
	if (eventType.startsWith("thinking_")) return "reasoning";
	return undefined;
}

/**
 * Build the credentialless provider pair consumed by the delegation broker.
 * `resolveModel` is an optional host adapter. By default the public Pi model registry
 * resolves the exact model; no other extension supplies or initializes this transport.
 */
export function createControllerProvider({
	modelRegistry,
	resolveModel,
	preparePayload,
	cleanupSession,
	now = () => Date.now(),
}: {
	modelRegistry: Registry;
	resolveModel?: (provider: string, modelId: string) => any;
	preparePayload?: (payload: unknown, model: any, snapshot: any) => unknown | undefined;
	cleanupSession?: (sessionId: string, provider: string) => void;
	now?: () => number;
}): { providerTransport: { stream: (snapshot: any, context: any, options?: any) => AsyncIterable<NormalizedEvent> }; routeResolver: (lease: any, request?: any) => Promise<Record<string, unknown>>; routePreflight: (request: any) => Promise<Record<string, unknown>>; inferenceProbe: (request: any) => Promise<Record<string, unknown>> } {
	if (!modelRegistry || typeof modelRegistry !== "object") throw new Error("controller provider requires a model registry");
	const resolveAuth = typeof modelRegistry.getApiKeyAndHeaders === "function"
		? modelRegistry.getApiKeyAndHeaders.bind(modelRegistry)
		: undefined;
	if (!resolveAuth) throw new Error("controller provider requires Pi auth resolution");
	if (typeof now !== "function") throw new Error("controller provider clock is invalid");

	const bindings = new Map<string, RouteBinding>();
	let registryVersion = 0;
	let lastRegistryFingerprint = "";

	// Briefly memoize per endpoint so a burst of preflights costs one connect, not one per route.
	const loopbackProbes = new Map<string, { at: number; reachable: Promise<boolean> }>();
	const loopbackReachable = (baseUrl: string): Promise<boolean> => {
		const at = now();
		const cached = loopbackProbes.get(baseUrl);
		if (cached && at - cached.at < LOOPBACK_PROBE_TTL_MS) return cached.reachable;
		for (const [key, entry] of loopbackProbes) {
			if (at - entry.at >= LOOPBACK_PROBE_TTL_MS) loopbackProbes.delete(key);
		}
		const reachable = probeLoopbackRoute(baseUrl).catch(() => false);
		loopbackProbes.set(baseUrl, { at, reachable });
		return reachable;
	};

	/**
	 * Check the exact route that the broker is about to lease without opening a
	 * provider stream. This is deliberately a safe readiness result: no model
	 * object, endpoint, credential, or provider error crosses the boundary.
	 */
	const routePreflight = async (request: any): Promise<Record<string, unknown>> => {
		const parsed = parseResourceId(request?.resourceId);
		if (!parsed) return Object.freeze({ status: "unavailable", reason: "invalid_route", scope: "resource" });
		let model: any;
		try {
			model = resolveModel?.(parsed.provider, parsed.modelId) ?? modelRegistry.find?.(parsed.provider, parsed.modelId);
		} catch {
			return Object.freeze({ status: "unavailable", reason: "model_lookup_failed", scope: "resource" });
		}
		if (!model || model.provider !== parsed.provider || model.id !== parsed.modelId) {
			return Object.freeze({ status: "unavailable", reason: "model_not_registered", scope: "resource" });
		}
		let providerRuntime: any;
		try { providerRuntime = modelRegistry.getProvider?.(parsed.provider); } catch {
			return Object.freeze({ status: "unavailable", reason: "provider_runtime_unavailable", scope: "resource" });
		}
		if (!providerRuntime || typeof providerRuntime.streamSimple !== "function") {
			return Object.freeze({ status: "unavailable", reason: "provider_runtime_unavailable", scope: "resource" });
		}
		let auth: any;
		try { auth = await resolveAuth(model); } catch {
			return Object.freeze({ status: "unavailable", reason: "credential_resolution_failed", scope: "resource" });
		}
		if (!auth || auth.ok !== true || typeof auth.apiKey !== "string" || auth.apiKey.length < 1 || auth.apiKey.length > 4_096 || /[\0\r\n]/.test(auth.apiKey)) {
			return Object.freeze({ status: "unavailable", reason: "credential_unavailable", scope: "resource" });
		}
		let apiDialect: string | undefined;
		try { apiDialect = modelApi(model, parsed.provider, modelRegistry); } catch {
			return Object.freeze({ status: "unavailable", reason: "api_dialect_unavailable", scope: "resource" });
		}
		if (!apiDialect) return Object.freeze({ status: "unavailable", reason: "api_dialect_unavailable", scope: "resource" });
		if (cursorEffortUnsupported(parsed.provider, model, apiDialect, request?.requestedThinking)
			|| ((/^openai-codex(?:-account-\d+)?$/.test(parsed.provider) && request?.requestedThinking === "low"
				|| (request?.requireExactEffortSupport === true && request?.requestedThinking !== "off"))
				&& !codexLowAttested(parsed.provider, model, apiDialect))) {
			return Object.freeze({ status: "unavailable", reason: "reasoning_effort_unsupported", scope: "resource" });
		}
		// The last thing a lease needs is an endpoint that still exists on paper. A dead local bridge
		// is an account-wide fact, so report `capacity_group`: every sibling model is published behind
		// the same port and would otherwise consume the remaining attempts one alias at a time.
		const routeUrl = auth.baseUrl ?? model.baseUrl;
		if (isLoopbackRoute(routeUrl) && !(await loopbackReachable(routeUrl))) {
			return Object.freeze({ status: "unavailable", reason: "route_endpoint_unreachable", scope: "capacity_group" });
		}
		// Only an opaque binding leaves the controller. Cached conformance must not survive
		// a credential, endpoint, API/model configuration or requested-effort change.
		return Object.freeze({ status: "ready",
			// Internal readiness needs an executable minimum, not SDK1.1's none default.
			// Positive exact API/model low support only; work effort remains untouched.
			...(codexLowAttested(parsed.provider, model, apiDialect) ? { minimumReadinessThinking: "low" } : {}),
			routeFingerprint: digest(JSON.stringify({
			model, apiDialect, endpoint: endpointFor(model, providerRuntime, auth),
			auth: digest(JSON.stringify(auth)), thinking: request?.requestedThinking ?? "off",
		})) });
	};

	/** One real, bounded native inference before a parent decides to delegate. No task text, tools,
	 * credential, model output, or raw provider error crosses into the returned observation. */
	const inferenceProbe = async (request: any): Promise<Record<string, unknown>> => {
		const parsed = parseResourceId(request?.resourceId);
		if (!parsed) return { status: "unknown", reason: "invalid_route" };
		if (request.signal?.aborted) return { status: "unknown", reason: "cancelled" };
		const timeoutMs = request?.timeoutMs === undefined ? 12_000 : request.timeoutMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000) {
			return { status: "unknown", reason: "invalid_probe_timeout" };
		}
		const admissionSignal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
		const admissionStopped: Promise<{ probeStopped: true }> = new Promise(resolve => {
			if (admissionSignal.aborted) resolve({ probeStopped: true });
			else admissionSignal.addEventListener("abort", () => resolve({ probeStopped: true }), { once: true });
		});
		// A stalled Pi credential refresh cannot hold the parent's decision open indefinitely.
		const preflight: any = await Promise.race([routePreflight({ resourceId: request.resourceId }), admissionStopped]);
		if (preflight.probeStopped || admissionSignal.aborted) return { status: "unknown", reason: request.signal?.aborted ? "cancelled" : "probe_timeout" };
		if (preflight.status !== "ready") return { status: "failed", reason: preflight.reason ?? "route_preflight_unavailable",
			scope: preflight.scope === "capacity_group" ? "capacity_group" : "resource" };
		if (request.signal?.aborted) return { status: "unknown", reason: "cancelled" };
		let model: any, providerRuntime: any, auth: any;
		try {
			model = resolveModel?.(parsed.provider, parsed.modelId) ?? modelRegistry.find?.(parsed.provider, parsed.modelId);
			providerRuntime = modelRegistry.getProvider?.(parsed.provider);
			auth = await Promise.race([resolveAuth(model), admissionStopped]);
		} catch { return { status: "unknown", reason: "route_changed" }; }
		if (auth?.probeStopped || admissionSignal.aborted) return { status: "unknown", reason: request.signal?.aborted ? "cancelled" : "probe_timeout" };
		if (!model || model.provider !== parsed.provider || model.id !== parsed.modelId
			|| typeof providerRuntime?.streamSimple !== "function" || auth?.ok !== true
			|| typeof auth.apiKey !== "string" || !auth.apiKey || auth.apiKey.length > 4_096
			|| /[\0\r\n]/.test(auth.apiKey)) return { status: "unknown", reason: "route_changed" };
		if (request.signal?.aborted) return { status: "unknown", reason: "cancelled" };
		const controller = new AbortController();
		const abort = () => controller.abort();
		request.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, timeoutMs);
		let responseStatus: number | undefined;
		let retryDelay: number | undefined;
		let nativeContentStarted = false;
		const failure = (text: string): Record<string, unknown> => {
			if (request.signal?.aborted) return { status: "unknown", reason: "cancelled" };
			const classification = errorClassification(responseStatus, text, false, responseStatus !== undefined, nativeContentStarted);
			if (classification.outcome === "rate_limited") return { status: "failed", reason: "rate_limited",
				scope: "capacity_group", ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }) };
			if (classification.outcome === "quota_fatal") return { status: "failed", reason: "quota_exhausted", scope: "capacity_group" };
			if (classification.outcome === "auth_fatal") return { status: "failed", reason: "auth_failed", scope: "capacity_group" };
			if (classification.outcome === "transport_before_headers" && !controller.signal.aborted)
				return { status: "failed", reason: "transport_before_headers", scope: "resource" };
			if (classification.reason === FIXED_REASONS.invalidRequest
				|| (responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500))
				return { status: "failed", reason: "model_request_rejected", scope: "resource" };
			return { status: "unknown", reason: controller.signal.aborted ? "probe_timeout" : "inference_incomplete" };
		};
		try {
			const apiDialect = modelApi(model, parsed.provider, modelRegistry);
			const stream = providerRuntime.streamSimple(
				{ ...model, api: apiDialect, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) },
				{ messages: [{ role: "user", content: [{ type: "text", text: "Reply OK." }] }], tools: [] },
				{ apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}),
					...(auth.env ? { env: auth.env } : {}), signal: controller.signal, maxTokens: 32,
					maxRetries: 0, timeoutMs, cacheRetention: "none", sessionId: `broker-readiness-${randomUUID()}`,
					...(codexLowAttested(parsed.provider, model, apiDialect) ? { reasoning: "low" } : {}),
					...(requiresSseTransport(parsed.provider, auth.baseUrl ?? model.baseUrl) ? { transport: "sse" } : {}),
					onResponse: (response: any) => {
						responseStatus = Number.isSafeInteger(response?.status) ? response.status : undefined;
						const headers = response?.headers;
						retryDelay = retryAfterMs(headers?.get?.("retry-after") ?? headers?.["retry-after"], now());
					},
				},
			);
			let textSeen = false;
			const iterator = stream[Symbol.asyncIterator]();
			const stopped: Promise<{ stopped: true }> = new Promise(resolve => {
				if (controller.signal.aborted) resolve({ stopped: true });
				else controller.signal.addEventListener("abort", () => resolve({ stopped: true }), { once: true });
			});
			try { while (true) {
				// A provider SDK can ignore AbortSignal while iterator.next() never settles. Never strand
				// a parent planning decision or mistake that silence for successful availability.
				const step: any = await Promise.race([iterator.next(), stopped]);
				if (step?.stopped || controller.signal.aborted) return failure("");
				if (step.done) return failure("");
				const event = step.value;
				if (typeof event?.type === "string" && /^(?:text|thinking|toolcall)_(?:start|delta|end)$/.test(event.type)) nativeContentStarted = true;
				if (event?.type === "error") return failure(messageText(event.error));
				if ((event?.type === "text_delta" && typeof event.delta === "string" && event.delta.length > 0)
					|| (event?.type === "text_end" && typeof event.content === "string" && event.content.length > 0)) textSeen = true;
				if (event?.type === "done") {
					if (responseStatus !== undefined && responseStatus >= 400) return failure("");
					const content = event.message?.content;
					if (event.reason === "stop" && (textSeen || (Array.isArray(content)
						&& content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0)))) {
						return { status: "verified", checkedAt: now(), evidence: "native_inference" };
					}
					return { status: "unknown", reason: "inference_incomplete" };
				}
			} } finally { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* best effort SDK teardown */ } }
		} catch (error) { return failure(messageText(error)); }
		finally { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); controller.abort(); }
	};

	function pruneBindings(at = now()): void {
		for (const [leaseId, binding] of bindings) {
			if (at - binding.createdAt > ROUTE_CACHE_TTL_MS) bindings.delete(leaseId);
		}
		while (bindings.size > ROUTE_CACHE_LIMIT) {
			const oldest = bindings.keys().next().value;
			if (typeof oldest !== "string") break;
			bindings.delete(oldest);
		}
	}

	const routeResolver = async (lease: any, request: any = {}): Promise<Record<string, unknown>> => {
		pruneBindings();
		const requestedReasoning = request?.reasoningEffort;
		if (requestedReasoning !== undefined && (typeof requestedReasoning !== "string" || !THINKING_LEVELS.has(requestedReasoning))) {
			throw new Error("controller reasoning effort is invalid");
		}
		const parsed = parseResourceId(lease?.resourceId);
		if (!parsed || typeof lease?.leaseId !== "string" || !ID.test(lease.leaseId)) {
			throw new Error("controller provider lease is not bound to a model route");
		}
		const model = resolveModel?.(parsed.provider, parsed.modelId) ?? modelRegistry.find?.(parsed.provider, parsed.modelId);
		if (!model || model.provider !== parsed.provider || model.id !== parsed.modelId) {
			throw new Error("controller provider model is no longer registered");
		}
		const providerRuntime = modelRegistry.getProvider?.(parsed.provider);
		if (!providerRuntime || typeof providerRuntime.streamSimple !== "function") {
			throw new Error("controller provider runtime is unavailable");
		}
		let auth: any;
		try {
			auth = await resolveAuth(model);
		} catch {
			throw new Error("controller provider credential resolution failed");
		}
		if (!auth || auth.ok !== true || typeof auth.apiKey !== "string" || auth.apiKey.length < 1 || auth.apiKey.length > 4_096 || /[\0\r\n]/.test(auth.apiKey)) {
			throw new Error("controller provider credential is unavailable");
		}
		const apiDialect = modelApi(model, parsed.provider, modelRegistry);
		if (!apiDialect) throw new Error("controller provider model API dialect is unavailable");
		if (cursorEffortUnsupported(parsed.provider, model, apiDialect, requestedReasoning)
			|| (/^openai-codex(?:-account-\d+)?$/.test(parsed.provider) && requestedReasoning === "low"
				&& !codexLowAttested(parsed.provider, model, apiDialect))) {
			throw new Error("controller reasoning effort is unsupported by the selected model");
		}
		const nativeModel = Object.freeze({ ...model, api: apiDialect });
		const endpoint = endpointFor(nativeModel, providerRuntime, auth);
		const selected = modelIdentity(nativeModel, parsed.provider, parsed.modelId);
		const fingerprint = poolFingerprint(modelRegistry, selected);
		if (fingerprint !== lastRegistryFingerprint) {
			lastRegistryFingerprint = fingerprint;
			registryVersion = Math.min(Number.MAX_SAFE_INTEGER, registryVersion + 1);
		}
		const binding: RouteBinding = {
			leaseId: lease.leaseId,
			resourceId: lease.resourceId,
			provider: parsed.provider,
			modelId: parsed.modelId,
			model: nativeModel,
			providerRuntime,
			auth: Object.freeze({
				apiKey: auth.apiKey,
				...(auth.headers && typeof auth.headers === "object" ? { headers: Object.freeze({ ...auth.headers }) } : {}),
				...(auth.env && typeof auth.env === "object" ? { env: Object.freeze({ ...auth.env }) } : {}),
				...(typeof auth.baseUrl === "string" ? { baseUrl: auth.baseUrl } : {}),
			}),
			createdAt: now(),
		};
		bindings.set(lease.leaseId, binding);
		pruneBindings(binding.createdAt);
		return Object.freeze({
			registryFingerprint: fingerprint,
			registryVersion: Math.max(1, registryVersion),
			accountAlias: parsed.provider,
			provider: parsed.provider,
			model: parsed.modelId,
			reasoningEffort: requestedReasoning ?? "off",
			apiDialect,
			endpointId: endpointId(parsed.provider, parsed.modelId, endpoint),
			adapterId: CONTROLLER_PROVIDER_ADAPTER_ID,
			credentialRefFingerprint: digest(`native:${auth.apiKey}`),
			cacheRetention: "none",
		});
	};

	const providerTransport = {
		async *stream(snapshot: any, context: any, options: any = {}): AsyncIterable<NormalizedEvent> {
			verifySnapshot(snapshot);
			const binding = bindings.get(snapshot.leaseId);
			if (!binding || !sameBinding(snapshot, binding)) throw new Error("controller provider route binding is unavailable");
			bindings.delete(snapshot.leaseId);
			try {
			let responseStatus: number | undefined;
			let responseHeaders: unknown;
			let headersSeen = false;
			let terminalSeen = false;
			let semanticOutputSeen = false;
			let nativeContentStarted = false;
			let toolCallSeen = false;
			let totalOutputBytes = 0;
			const toolNames = new Set((Array.isArray(context.tools) ? context.tools : []).map((tool: any) => tool?.name));
			const seenToolCallIds = new Set<string>();
			const openBlocks = new Map<number, { type: "text" | "reasoning" | "tool_call"; value: string; bytes: number }>();
			const headerPayload = () => {
				const delay = retryAfterMs((responseHeaders as any)?.get?.("retry-after")
					?? (responseHeaders as any)?.["retry-after"], now());
				return { ...responsePayload(responseStatus, responseHeaders),
					...(delay === undefined ? {} : { retryAfterMs: delay }) };
			};
			const terminal = (outcome: string, reason?: string, finishReason?: string): NormalizedEvent => ({
				type: "terminal",
				outcome,
				payload: {
					...headerPayload(),
					...(finishReason === undefined ? {} : { finishReason }),
					...(reason && fixedProviderReason(reason) ? { providerReason: reason } : {}),
				},
			});
			try {
				ensureSupportedContext(context, binding.model);
			} catch (error) {
				const reason = Array.isArray(context?.tools) && context.tools.length > 0
					? FIXED_REASONS.unsupportedTools
					: FIXED_REASONS.invalidRequest;
				yield terminal("rejected_before_send", reason);
				return;
			}
			if (options.signal?.aborted) {
				yield terminal("cancelled_before_send");
				return;
			}
			if (Number.isSafeInteger(snapshot.deadlineAt) && snapshot.deadlineAt <= now()) {
				yield terminal("deadline_exceeded_before_send");
				return;
			}

			const onResponse = (response: any) => {
				responseStatus = Number.isInteger(response?.status) ? response.status : undefined;
				responseHeaders = response?.headers;
			};
			let stream: AsyncIterable<any>;
			try {
				// Native providers are lazy streams: invoking streamSimple prepares the request, and
				// iteration performs the one network dispatch. Acknowledging immediately before both
				// keeps the controller's send phase ahead of either implementation detail.
				const requestContext = nativeContext(context);
				options.onSendStarted?.();
				stream = binding.providerRuntime.streamSimple(
					{
						...binding.model,
						...(binding.auth.baseUrl ? { baseUrl: binding.auth.baseUrl } : {}),
					},
					requestContext,
					{
						apiKey: binding.auth.apiKey,
						...(binding.auth.headers ? { headers: binding.auth.headers } : {}),
						...(binding.auth.env ? { env: binding.auth.env } : {}),
						signal: options.signal,
						maxTokens: snapshot.maxOutputTokens,
						maxRetries: 0,
						timeoutMs: Math.max(1, snapshot.deadlineAt - now()),
						cacheRetention: snapshot.cacheRetention,
						sessionId: snapshot.taskId,
						...(requiresSseTransport(binding.provider, binding.auth.baseUrl ?? binding.model?.baseUrl)
							? { transport: "sse" }
							: {}),
						...(snapshot.reasoningEffort && snapshot.reasoningEffort !== "off" ? { reasoning: snapshot.reasoningEffort } : {}),
						...(preparePayload ? {
							onPayload: (payload: unknown, model: any) => preparePayload(payload, model, snapshot),
						} : {}),
						onResponse,
					},
				);
			} catch (error) {
				if (responseStatus !== undefined && !headersSeen) {
					headersSeen = true;
					yield { type: "headers", payload: headerPayload() };
				}
				const classification = errorClassification(responseStatus, messageText(error), Boolean(options.signal?.aborted), headersSeen);
				yield terminal(classification.outcome, classification.reason);
				return;
			}

			try {
				for await (const event of stream) {
					if (terminalSeen) break;
					if (event?.type === "error") {
						if (responseStatus !== undefined && !headersSeen) {
							headersSeen = true;
							yield { type: "headers", payload: headerPayload() };
						}
						const classification = errorClassification(
							responseStatus,
							messageText(event.error),
							event.reason === "aborted" || Boolean(options.signal?.aborted),
							headersSeen,
							nativeContentStarted,
						);
						terminalSeen = true;
						yield terminal(classification.outcome, classification.reason);
						return;
					}
					if (!headersSeen) {
						headersSeen = true;
						yield { type: "headers", payload: headerPayload() };
					}
					const type = typeof event?.type === "string" ? event.type : "";
					if (type === "start") continue;
					if (type === "text_start" || type === "thinking_start") {
						const index = event.contentIndex;
						const blockType = blockTypeFor(type);
						if (!Number.isSafeInteger(index) || index < 0 || !blockType || openBlocks.has(index)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockStart);
							return;
						}
						nativeContentStarted = true;
						openBlocks.set(index, { type: blockType, value: "", bytes: 0 });
						if (blockType === "reasoning") continue;
						yield { type: "block_start", payload: { index, blockType } };
						continue;
					}
					if (type === "text_delta" || type === "thinking_delta") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const expected = type === "text_delta" ? "text" : "reasoning";
						if (!block || block.type !== expected || typeof event.delta !== "string" || event.delta.length === 0) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockDelta);
							return;
						}
						const bytes = Buffer.byteLength(event.delta, "utf8");
						if (block.bytes + bytes > snapshot.maxOutputBytes || totalOutputBytes + bytes > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame");
							return;
						}
						block.value += event.delta;
						block.bytes += bytes;
						totalOutputBytes += bytes;
						if (expected === "reasoning") continue;
						yield { type, payload: { index, delta: event.delta } };
						continue;
					}
					if (type === "text_end" || type === "thinking_end") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const expected = type === "text_end" ? "text" : "reasoning";
						const contentBytes = typeof event.content === "string" ? Buffer.byteLength(event.content, "utf8") : Infinity;
						// OpenAI Responses streams one reasoning representation, then may replace it with
						// a summarized form at output_item.done. Reasoning never crosses this controller
						// boundary, so validate/bound the final value but do not require byte equality.
						const contentMatches = expected === "reasoning" || event.content === block?.value;
						if (!block || block.type !== expected || typeof event.content !== "string"
							|| contentBytes > snapshot.maxOutputBytes || !contentMatches) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockEnd);
							return;
						}
						openBlocks.delete(index);
						if (block.type === "reasoning") continue;
						if (event.content.length > 0) semanticOutputSeen = true;
						yield { type: "block_end", payload: { index, value: event.content } };
						continue;
					}
					if (type === "toolcall_start") {
						const index = event.contentIndex;
						if (!Number.isSafeInteger(index) || index < 0 || openBlocks.has(index)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						nativeContentStarted = true;
						toolCallSeen = true;
						openBlocks.set(index, { type: "tool_call", value: "", bytes: 0 });
						continue;
					}
					if (type === "toolcall_delta") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						if (!block || block.type !== "tool_call" || typeof event.delta !== "string") {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						const bytes = Buffer.byteLength(event.delta, "utf8");
						if (block.bytes + bytes > snapshot.maxOutputBytes || totalOutputBytes + bytes > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						block.value += event.delta;
						block.bytes += bytes;
						totalOutputBytes += bytes;
						continue;
					}
					if (type === "toolcall_end") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const toolCall = event.toolCall;
						const unsupportedField = toolCall && typeof toolCall === "object"
							? Object.keys(toolCall).find((key) => !["type", "id", "name", "arguments"].includes(key))
							: undefined;
					if (!block || block.type !== "tool_call" || !toolCall || typeof toolCall !== "object"
							|| unsupportedField || toolCall.type !== "toolCall"
							|| typeof toolCall.id !== "string" || !TOOL_CALL_ID.test(toolCall.id)
							|| seenToolCallIds.has(toolCall.id) || typeof toolCall.name !== "string" || !TOOL_NAME.test(toolCall.name)
							|| !toolNames.has(toolCall.name) || !toolCall.arguments || typeof toolCall.arguments !== "object"
							|| Array.isArray(toolCall.arguments)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						let argumentsJson: string;
						try { argumentsJson = JSON.stringify(toolCall.arguments); } catch {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						const value = block.value || argumentsJson;
						let parsedArguments: unknown;
						try { parsedArguments = JSON.parse(value); } catch {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)
							|| JSON.stringify(parsedArguments) !== argumentsJson || Buffer.byteLength(value, "utf8") > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						if (!block.value) {
							block.value = value;
							block.bytes = Buffer.byteLength(value, "utf8");
							totalOutputBytes += block.bytes;
						}
						seenToolCallIds.add(toolCall.id);
						yield { type: "block_start", payload: { index, blockType: "tool_call", id: toolCall.id, name: toolCall.name } };
						yield { type: "tool_call_delta", payload: { index, delta: block.value } };
						yield { type: "block_end", payload: { index, value: block.value } };
						openBlocks.delete(index);
						continue;
					}
					if (type === "done") {
						if (openBlocks.size > 0) {
							terminalSeen = true;
							yield terminal("stream_truncated", FIXED_REASONS.truncatedBlock);
							return;
						}
						const usage = usageFrom(event.message?.usage);
						if (usage) yield { type: "usage", payload: usage };
						const semanticOutput = semanticOutputSeen || (event.message?.content?.some?.((part: any) =>
							part?.type === "text" && typeof part.text === "string" && part.text.length > 0,
						) ?? false);
						terminalSeen = true;
						if (event.reason === "toolUse" || toolCallSeen) {
							if (!toolCallSeen) yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							else yield terminal("succeeded_terminal", undefined, "tool_use");
						} else if (event.reason === "stop") {
							yield terminal(semanticOutput ? "succeeded_terminal" : "empty_response", undefined, "stop");
						} else if (event.reason === "length") {
							yield terminal("unknown_finish", undefined, "length");
						} else if (event.reason === "aborted") {
							yield terminal("cancelled_after_send");
						} else if (event.reason === "deferred") {
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
						} else if (event.reason === "error") {
							const classification = errorClassification(responseStatus, messageText(event.message), Boolean(options.signal?.aborted), headersSeen, nativeContentStarted || semanticOutput);
							yield terminal(classification.outcome, classification.reason);
						} else {
							yield terminal("unknown_finish");
						}
						return;
					}
					yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedStreamEvent);
					return;
				}
				if (!terminalSeen) {
					if (!headersSeen && responseStatus !== undefined) {
						headersSeen = true;
						yield { type: "headers", payload: headerPayload() };
					}
					terminalSeen = true;
					yield terminal(
						options.signal?.aborted
							? "cancelled_after_send"
							: headersSeen
								? "stream_truncated"
								: "transport_before_headers",
					);
				}
			} catch (error) {
				if (terminalSeen) return;
				terminalSeen = true;
				const classification = errorClassification(responseStatus, messageText(error), Boolean(options.signal?.aborted), headersSeen, nativeContentStarted);
				yield terminal(classification.outcome, classification.reason);
			}
			} finally {
				cleanupSession?.(snapshot.taskId, binding.provider);
			}
		},
	};

	return Object.freeze({ providerTransport: Object.freeze(providerTransport), routeResolver, routePreflight, inferenceProbe });
}

export function isControllerProviderPair(value: unknown): value is { providerTransport: { stream: Function }; routeResolver: Function; routePreflight: Function } {
	return Boolean(value && typeof value === "object" && !Array.isArray(value)
		&& typeof (value as any).providerTransport?.stream === "function"
		&& typeof (value as any).routeResolver === "function"
		&& typeof (value as any).routePreflight === "function");
}
