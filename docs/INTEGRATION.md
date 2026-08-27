# Pi launcher integration boundary

This package does not install itself into Pi and does not modify Pi configuration.

A compatible launcher must enforce all of the following before a brokered child starts:

1. Call a controller-owned trusted resolver before worktree, shim or subprocess creation.
2. Give the resolver only a prompt digest and resolved request facts, not raw prompt text.
3. Let the resolver reserve a lease, verify the exact provider/model, create an owner-only agent directory and return a policy.
4. Start the child with minimal inherited environment, isolated `PI_CODING_AGENT_DIR`, explicit extensions and model scope.
5. Pass only `PI_BROKER_SOCKET`, lease metadata and `PI_BROKER_CAPABILITY` to the child. Do **not** serialize an authorization policy into the environment: `BrokeredLaunchResolver` must bind the exact `EffectiveChildCapability` under the lease, and the extension must retrieve it through lease-scoped IPC.
6. Invoke parent-only hooks after child-session handoff, before-handoff failure and session-process closure.
7. Bind the selected contract's `promptDigest` to the launch request and include its `doneWhen`; mismatched frames are denied before lease reservation.
8. Poll/observe controller-only pending readiness and launch only the exact task/lease returned by `dispatchPending`; atomically `claimReadyTask` before spawn. A queued contract is not itself authority to spawn, and a child terminal result is never acceptance.
9. Load `extensions/pi-behavioral-enforcement.ts` as the final explicit broker extension after every shim, with discovery disabled (`--no-extensions`) and no later extension capable of mutating tool arguments. For an effect-capable launch, pass `launcherAttestationConfig` to `BrokeredLaunchResolver`: it contains one reviewed SHA-256 for each explicit extension and the final behavioral extension path. The resolver refuses an effect before reservation if it is absent; the source-only seam rehashes every extension immediately before spawn and refuses handoff unless the child startup report includes `broker_declare_action`. It calls central `declareBehavioralAction`/`authorizeBehavioralAction` from Pi's blocking `tool_call` hook and `observeBehavioralResult` only after completed `tool_result`; the controller derives its state digest and writes behavioral events separately from provider telemetry. A parent RPC event after execution is too late to block a mismatched effect. Revalidate action snapshot, lease, fence, budget and extension/launcher attestation after any awaited hook/approval and immediately before dispatch; an extension may tighten/ask but cannot force-allow over the controller. This remains a source-pinned reference seam rather than an accepted upstream launcher API. The resolver permits only the bounded `propose_patch` surface when the final behavioral extension is attested; `apply` and `external_write` remain unavailable to children. A host must treat the local seam as owner-authorized alpha operation, not as a production sandbox. `behavioralEnforcement` is a trusted-caller-only low-level seam: do not expose it through config/env/CLI.
10. Run the full pre-registered acceptance plan in an isolated controller verifier, then capture evidence into an owner-only retained `ControllerEvidenceStore` and validate it. `ControllerAcceptanceVerifier` is the reference for fixed command/test checks: its injected controller `runCheck` maps fixed IDs to read-only work, receives no child-selected command or expected output, runs checks serially, and rejects timeout/error/malformed/failing observations. `ControllerVerificationAuthority` then stores a receipt bound to the exact task/lease/fence; `ControllerQueuedTaskVerifier` is the controller-only close→verify→`finalizeVerifiedTask` workflow. Child-supplied `source: controller` text is not trusted without matching metadata and content. The alpha store has a single-writer precondition. Spot audit uses `captureObservation`/`compareSemantic` and passes recaptures to the validator; raw-byte recapture is not semantic comparison. Normalization is opt-in, and a criterion naming timestamp/PID/order/path conflicts with policy that strips that field.

The [source-repository-only reference patch](https://github.com/Sarrius/pi-delegation-broker/blob/main/patches/pi-subagent-workflow-trusted-launcher-seam.patch) demonstrates such a seam against `pi-subagent-workflow` commit `0c28ce87bc45f4c3d66e0100b58ae13cf345978c`, including pinned extension rehash/order and startup-tool attestation. It is an unaccepted local patch and is not part of the npm tarball. Applying it, accepting it upstream, or replacing it with an equivalent stable API remains a human release decision.

### Account aliases and fresh Pi processes

`pi-multi-account` must be absent from brokered children until it has a reviewed brokered report-only mode. Its `*-account-N` names are **controller inventory identities**, not standalone providers a fresh `pi --no-extensions` process can resolve. The launcher therefore has a binding canonicalization rule:

1. The broker keeps the leased alias (for example `anthropic-account-2`) in the resource id, lease, health/cooldown accounting and audit trail.
2. In the legacy compatibility path, `writeScopedChildAuth` reads precisely that alias credential but writes it as its base id (`anthropic`) into the child-only `auth.json`, catalog and endpoint config. This remains model-readable and is not permitted for live validation.
3. In the approved proxy path, no child credential file is written: the controller route resolver binds the alias to its in-memory credential reference and the child launches `--provider broker-proxy` with only a non-secret model id.
4. `resolveChildLaunchModel` in the legacy path launches `--provider anthropic --model claude-opus-5`. Since that agent directory contains exactly one credential, the canonical id cannot accidentally select the parent's base account or any other alias.

Do not pass `*-account-N/model` to a fresh isolated Pi child and do not solve this by loading the parent's entire multi-account extension: either choice breaks the scoped-credential boundary. Regression coverage lives in `test/scoped-child-auth.test.mjs` and `test/child-launcher.test.mjs`.

### Proxy-backed OAuth (Cursor)

pi-multi-account provisions Cursor into `models.json` as `http://127.0.0.1:<port>/v1`. A bare `--no-extensions` child cannot run Cursor's OAuth handler. The approved native controller path resolves the exact Cursor model and OAuth credential in the parent, invokes Pi's native provider with retries disabled and forces SSE through the owner-run local Cursor bridge. Approved tool schemas and tool-call/result replay remain inside this credentialless boundary. The older `createApprovedOpenAIProviderRoute` path is retained for explicit text-only compatibility tests. The child receives only `broker-proxy` and never gets `auth.json`. The loopback endpoint is accepted only for this explicitly configured adapter; arbitrary HTTP remains rejected. The legacy `writeScopedChildAuth` path still materializes Cursor as `type: api_key` for compatibility and is not live-validation-ready. Regression coverage: `test/scoped-child-auth.test.mjs`, `test/child-rpc.test.mjs`, `test/openai-chat-completions-transport.test.mjs` and `test/live-cursor-controller-proxy-child.test.mjs`.

Hermes is a distinct integration: its review subprocess intentionally runs against the parent agent directory, but it too uses `--no-extensions`. If Hermes follows the active chat model and that model is an account alias, configure its **single trusted provider extension** explicitly:

```json
{
  "reviewTransport": "direct",
  "childExtensionPaths": [
    "/absolute/path/to/.pi/agent/git/github.com/Sarrius/pi-multi-account/index.ts"
  ]
}
```

Use an absolute path — Hermes normalizes with `resolve()` and does not expand a literal `~`. This lets the subprocess resolve the active alias and lets the multi-account extension perform its normal account-level failover. Do not set `llmModelOverride` to a stale route merely to conceal alias failures. A brokered child must not invoke `pi.setModel()` or auto-continue on its own. `ControllerAccountInventory` can consume a controller-injected registry snapshot only as `observed` inventory; it contains no credential and still requires signed-registry policy before admission.

### Reloading during development

`/reload` re-runs extension activation, but it does **not** re-import `src/*.mjs`: Node caches ES modules by URL for the lifetime of the process, so a reloaded extension keeps calling the already-loaded broker code. Editing anything under `src/` therefore requires a full Pi restart, not a reload.

This matters because the failure is silent — the extension activates, the broker starts, and stale routing or health logic keeps running as if the fix were live. Do not conclude from a reloaded session that a `src/` change had no effect. Confirm which code is actually running by observing a field only the new code can emit; for example `RegistryReloaded` carries `healthCarried` only after the health-preserving reload landed. An audit event is evidence, an assumption is not.

### Credentialless controller-provider proxy

For a controller that has explicitly injected an approved `providerTransport + routePreflight + routeResolver` pair, `BrokeredLaunchResolver` can be constructed with `controllerProxy: { providerId: "broker-proxy" }` and **without** `provisionChildAuth`. Before reserving a lease, the resolver refreshes the owner-side provider snapshot and asks `routePreflight` to validate each exact candidate's current model registration, native runtime, credential availability and API dialect. Unready candidates are quarantined and excluded without starting a child or spending a physical attempt. It then launches the leased resource's model through `extensions/controller-provider-proxy.ts`; the child gets only `PI_BROKER_SOCKET`, its lease-scoped capability and a non-secret model id. There is no child `auth.json`, upstream endpoint credential, OAuth token or parent agent directory.

The proxy calls child-authorized `providerStream` over the owner-only Unix socket. The native boundary accepts bounded text, approved JSON-schema tools, assistant tool calls and matching tool results. It rejects images, provider options, reasoning replay, unknown fields and unapproved tool names before dispatch; executable functions and provider credentials never cross the boundary. The controller remains responsible for immutable route snapshots, one physical dispatch, provider health classification and all retry/failover decisions. The parent Pi extension enters the credentialless proxy path when the owner host injects `ctx.controllerProvider = { providerTransport, routePreflight, routeResolver }` before startup; the three callbacks are owner-side only and the preflight result contains only bounded readiness facts. Otherwise it retains the explicitly documented text-only/scoped-auth compatibility paths, which are not live-validation-ready for coding work.

`test/tool-capable-proxy-child.test.mjs` is a deterministic E2E: a real Pi child runs the native `broker-proxy` provider against `ScriptedFakeProvider`; it asserts a local tool call/result round-trip and no child `auth.json`. The owner-authorized fresh-process Cursor canary additionally exercises a real native child read and isolated patch/test flow. A real provider route still requires the owner-gated process in [the provider route protocol](PROVIDER-PROXY-PROTOCOL.md), never ambient authentication.

## Controller provider route gate

`ControllerCredentialStore` keeps one exact API key or short-lived OAuth access token only in controller memory. `ControllerRouteTable` is an owner-only, credential-free JSON configuration that maps one signed resource to exactly one account/model/endpoint/opaque credential reference. `createApprovedAnthropicProviderRoute` and `createApprovedOpenAIProviderRoute` require a matching `ControllerLiveProviderApproval` with a bounded expiry/request count before they can dispatch. They expose no account rotation, default route, ambient auth, SDK retry or failover. Anthropic subscription OAuth is sent as Bearer auth with the Claude Code identity headers; the Cursor path sends Bearer auth to an owner-run loopback OpenAI-compatible bridge; refresh tokens are never forwarded. A real call still requires a separately authorized/pre-registered live experiment; mocked adversarial tests do not establish a live capability.

`ControllerVerifiedRoutingBoard` may reorder only the broker's current signed candidate IDs. It updates from receipt-bound controller acceptance/rejection after terminal finalization; it cannot add a resource, bypass capability/budget/breaker checks, or treat child/provider self-report as routing evidence.

## Failure semantics

- Before handoff: controller release cleans up the lease/agent directory. If controller IPC fails, the resolver retains an explicitly pending record for later reconciliation.
- After handoff: child provider shutdown/session close releases its lease and moves a claimed queued task to `awaiting_result`; parent cleanup cannot complete it. Only controller `finalizeVerifiedTask` with an independent verifier receipt can make it `completed` or `failed`; absent reconciliation escalates at the registered deadline.
- Capacity unavailable: `submit` queues only when the contract names a recovery owner and future deadline. Release/expiry/cooldown transitions make timed work eligible; the supervisor scheduler moves admitted entries to `ready`, while the controller remains responsible for child launch.
- Wait deadline reached: the task becomes `escalated`; it never remains an ownerless, unbounded `paused_capacity` row.
- Provider transport missing: `BrokerIpcServer` returns `provider_transport_unavailable`; it never falls back to fake success.
- A real provider proxy must classify and reconcile any ambiguous external effect. The fake transport only proves pre-effect cancellation.
