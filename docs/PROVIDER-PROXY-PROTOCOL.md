# Controller-owned provider proxy protocol

Status: implemented for the Pi-native provider boundary, with the older hand-built transports retained as text-only compatibility seams. `src/provider-protocol.mjs` implements envelope validation, stream grammar, terminal CAS, phase machine, and outcome taxonomy as deterministic protocol primitives. `src/ipc.mjs` accepts either its deterministic fake transport or an explicitly injected real `providerTransport + routeResolver` pair (never both), then feeds both through the same framed stream assembler and settlement boundary. `src/anthropic-messages-transport.mjs` and `src/openai-chat-completions-transport.mjs` remain text-only raw transport adapters; the companion `pi-multi-account/controller-provider.ts` supplies the native parent-owned route for all approved Pi providers, including tool replay. There is no environment/keychain fallback, account rotation, retry loop or automatic failover inside one attempt. Owner-authorized fresh-process Cursor evidence covers a credentialless child read and isolated patch/test flow; Anthropic subscription requests were rejected by the account's extra-usage policy.

## Authority boundary

The child owns model-facing consumption only. It never receives provider credentials, account inventory, registry contents, endpoint selection, retry policy, or failover authority. The controller owns:

- exact provider/account/model/reasoning/API route;
- credential resolution and provider transport;
- physical-attempt count;
- lease, fencing, deadline and budget enforcement;
- stream grammar and terminal commit;
- provider-health classification;
- retained evidence and settlement.

A child disconnect is cancellation, not proof that the provider did no work.

## One immutable attempt

Before any provider I/O the controller creates and retains an `AttemptRouteSnapshot`:

```json
{
  "schemaVersion": 1,
  "controllerEpoch": "uuid",
  "attemptId": "uuid",
  "streamId": "uuid",
  "taskId": "bounded id",
  "leaseId": "uuid",
  "fencingToken": 1,
  "registryFingerprint": "sha256 hex",
  "registryVersion": 1,
  "resourceId": "signed resource id",
  "capacityGroup": "signed capacity group",
  "accountAlias": "controller alias",
  "provider": "exact provider route",
  "model": "exact model id",
  "reasoningEffort": "exact effort or null",
  "apiDialect": "adapter-owned dialect",
  "endpointId": "non-secret signed endpoint identity",
  "adapterId": "implementation id and build hash",
  "credentialRefFingerprint": "non-secret fingerprint",
  "cacheRetention": "none | short | long; explicit controller route policy",
  "retryOwner": "broker",
  "sdkMaxRetries": 0,
  "deadlineAt": 0,
  "maxInputBytes": 0,
  "maxOutputBytes": 0,
  "maxOutputTokens": 0
}
```

All route facts and the credential are resolved from one generation. `ControllerCredentialStore` resolves one opaque credential reference to either an API key or a short-lived OAuth access token only when its snapshot fingerprint matches; `ControllerRouteTable` resolves one credential-free HTTPS endpoint or owner-approved loopback HTTP adapter only when every snapshot route fact matches. Configuration reload affects only later attempts. A named credential miss fails before send; the adapter may not fall through to ambient environment, keychain, another OAuth account, or provider-native discovery. For Anthropic subscription OAuth, the controller sends the access token as Bearer auth with the reviewed Claude Code identity headers; the Cursor OpenAI-compatible path sends Bearer auth to the owner-run loopback bridge; neither path forwards a refresh token. `ControllerLiveProviderApproval` is consumed before credential lookup/send and is bounded by route-table generation, expiry and request count. Cache retention is a route fact, not an ambient `PI_CACHE_RETENTION` setting: `none`, `short`, and `long` are frozen into the attempt snapshot so a concurrent setting change cannot alter its context-retention semantics.

The attempt handle is one-shot. Once admitted into controller middleware it cannot be dispatched again. Recovery creates a new `attemptId`; it never reuses a capability whose send status became ambiguous.

## Request ingress

The child sends canonical context, not only a digest. The native vocabulary is deliberately narrow: a `systemPrompt` string, text `user` messages, text/tool-call `assistant` messages, matching `toolResult` messages, and uniquely named tools with `name`, `description`, and JSON `inputSchema`. Provider options, provider response IDs, replay/cache handles, unknown fields, non-text modalities, malformed arguments and duplicate tool names fail before route/credential resolution; they are not silently transformed or dropped. The controller:

1. parses a size-bounded request frame;
2. validates the closed schema through `captureProviderContext` and semantic block vocabulary;
3. creates one detached lossless-JSON snapshot with depth/node/byte limits;
4. verifies contract/prompt/tool digests against the lease;
5. retains or references the exact snapshot according to evidence policy;
6. hashes and dispatches that same frozen value.

Unknown content blocks, unsupported modalities, duplicate tool ids, malformed tool arguments, unmatched tool results, non-finite/negative-zero numbers, sparse/decorated arrays, cycles, accessors and exotic objects fail before provider I/O. No malformed argument is replaced with `{}` and no unsupported block is silently dropped.

## Wire envelope

Every controller-to-child frame has:

```json
{
  "protocolVersion": 1,
  "controllerEpoch": "uuid",
  "attemptId": "uuid",
  "streamId": "uuid",
  "leaseId": "uuid",
  "fencingToken": 1,
  "seq": 0,
  "type": "attempt_accepted",
  "payload": {}
}
```

`seq` starts at zero and increases by one. Every identity field must exactly match the connection's admitted attempt. A controller restart creates a new epoch and cannot continue an old stream. Unknown required frame types are fatal. Optional telemetry extensions may be ignored only when explicitly marked ignorable and unable to alter stream interpretation.

## Stream grammar

Allowed required frame types:

- `attempt_accepted` — controller admission receipt; not provider send or completion;
- `provider_send_started` — transport invocation began;
- `block_start` — opens one non-negative index as `text`, `reasoning`, or `tool_call`;
- `text_delta`, `reasoning_delta`, `tool_call_delta` — address an open matching block;
- `block_end` — closes exactly one matching block with the canonical completed value;
- `usage` — one cumulative validated provider accounting snapshot;
- `terminal` — exactly one terminal outcome and the final frame.

Rules:

- no duplicate/retyped block index;
- no delta before start or after end;
- tool-call id/name cannot change after first non-empty value;
- tool-call arguments must close as one valid JSON object and match the assembled deltas;
- normal success cannot leave an open block;
- usage cannot decrease and cannot contain negative/non-finite values;
- no frame follows `terminal`;
- EOF without `terminal` is never success;
- a second terminal is fatal even if identical;
- partial tool calls are never executable;
- output is tentative until the terminal is validated and durably persisted.

The child may render tentative text, but it must not append an accepted assistant message or execute a local tool until the controller has validated the provider tool-call turn and emitted its terminal. The resulting tool result is replayed through a new controller provider turn; the controller never executes the tool or receives its function implementation.

## Attempt phases

```text
prepared
  -> admitted
  -> provider_send_started
  -> headers_seen | provider_rejected
  -> streaming_tentative
  -> terminal_validated
  -> terminal_persisted
  -> result_reconciled
```

Crash repair distinguishes:

- `not_started`: no durable send-start marker;
- `outcome_unknown`: send started but no authoritative terminal;
- `terminal_unpersisted`: terminal observed but durable settlement failed;
- `terminal_persisted`: authoritative result exists;
- `reconciled`: parent task state consumed that result.

Only `not_started`, read-only/idempotent operations, or provider-specific idempotency evidence may be automatic retry candidates. `outcome_unknown` requires reconciliation or owner escalation.

## Terminal outcomes

The controller owns this closed vocabulary:

- `succeeded_terminal`;
- `rejected_before_send`;
- `transport_before_headers`;
- `empty_response`;
- `stream_truncated`;
- `malformed_provider_frame`;
- `unknown_finish`;
- `rate_limited`;
- `quota_fatal`;
- `auth_fatal`;
- `context_window_exceeded`;
- `cancelled_before_send`;
- `cancelled_after_send`;
- `deadline_exceeded_before_send`;
- `deadline_exceeded_after_send`;
- `budget_exceeded`;
- `controller_failure`.

A terminal carries only bounded controller-owned facts: provider request id, validated HTTP status, positive bounded `Retry-After`, usage, finish reason, and retained evidence refs where applicable. Third-party SDK codes/objects are not trusted directly.

`empty_response` means a provider terminal proved zero semantic output and no accepted message; it may be retryable by policy. `stream_truncated`, cancellation/deadline after send, and terminal persistence uncertainty are ambiguous and never blind-retried.

## Failure provenance and health

Only provider-owned response/transport evidence may update cooldown, breaker, quota, or account health. The following remain controller-local and must not mark a resource unhealthy:

- context conversion or schema failure;
- child disconnect/IPC backpressure;
- evidence/spill persistence failure;
- policy/behavior denial;
- verifier failure;
- projection/consumer/rendering failure.

`Retry-After` is accepted only from the provider response, parsed to a positive bounded delay. Quota exhaustion is distinct from transient 429. Auth fatal marks the exact resource unknown/unavailable without exposing the credential.

## Cancellation and clocks

The controller fuses child cancellation, lease expiry, absolute deadline, shutdown, and adapter cancellation. Wrappers may tighten but never detach these signals.

Track `bodyInvoked`, `requestSent`, `headersSeen`, and `terminalSeen`. Cancellation before send and after send are different outcomes. Stop emitting child frames promptly, then drain/close started provider work to quiescence. Exactly one controller terminal CAS wins; a teardown error cannot create a second outcome.

Two clocks are mandatory:

- idle/no-activity watchdog;
- immutable absolute lease/deadline/latency budget.

Provider keepalive comments may pulse idle time but never extend the absolute deadline, lease TTL, token cap, or controller cancellation.

## Backpressure and evidence

Bound independently:

- request frame bytes;
- total context bytes/nodes/depth;
- individual provider frame bytes;
- total tentative output bytes;
- open block count and tool-argument bytes;
- socket pending-write bytes;
- pending artifact/ledger side work;
- output tokens.

Keep four forms separate: canonical provider value, bounded child/model projection, redacted ledger projection, and retained full artifact. Framing/locator bytes count inside caps. Required evidence work reaches quiescence before `terminal_persisted`; under a hard cap, spill/projection failure fails closed rather than returning the oversized original.

## Failover and replay metadata

Canonical messages and source provenance survive a compatible replacement attempt. Provider/adapter-private response ids, cache handles, signatures, encrypted reasoning, and replay state are stripped unless the signed registry declares the exact adapter generations compatible. Equivalent model capability does not imply replay-state portability.

SDK retries are pinned to zero and verified at the physical transport mock. Pi, provider SDK, broker, and multi-account may not independently retry the same attempt.

## Required adversarial tests before live use

1. exact route/account/reasoning binding and route-substitution refusal;
2. named credential miss with an unrelated ambient credential present;
3. one physical SDK/HTTP dispatch per attempt;
4. context digest mismatch and post-validation caller mutation;
5. oversized/deep/sparse/exotic context;
6. unknown/unsupported block and modality;
7. malformed, duplicate-id, renamed, truncated, and oversized tool call;
8. EOF without terminal, duplicate terminal, frame after terminal, open block at success;
9. stale controller epoch/stream/lease/fencing frame;
10. child disconnect before send and after send;
11. lease expiry during credential resolution, middleware, headers, and stream;
12. idle timeout versus keepalive under a shorter absolute deadline;
13. output/token crossing before and at terminal;
14. bounded slow consumer and bounded slow artifact store;
15. evidence failure after provider success without false provider-health mutation;
16. 429 with valid/invalid/past/oversized `Retry-After`;
17. quota fatal, auth fatal, context overflow, malformed provider error body;
18. provider-private replay state stripped on replacement route;
19. crash at every durable phase with `not_started` versus `outcome_unknown` repair;
20. no accepted assistant message or tool execution from tentative/partial output.
