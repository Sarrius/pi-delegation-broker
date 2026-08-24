# @sars267/pi-delegation-broker

> **Alpha / research reference — a real provider request requires a separately authorized, pre-registered live experiment.**

A single-host Node.js reference implementation for capability-scoped Pi child delegation. It demonstrates a safe control path:

```text
trusted controller → signed registry → SQLite lease broker → scoped Unix-socket capability → isolated child policy
```

It fails closed without an explicitly injected provider transport. The controller may construct one exact Anthropic Messages route only from an in-memory `ControllerCredentialStore`, credential-free `ControllerRouteTable`, and bounded `ControllerLiveProviderApproval`; it has no OAuth integration, account rotation, automatic failover, ambient-auth fallback or retry loop. The route is separately tested with mocked HTTP only and has never been connected to a real account.

## Status

This package is publishable as an **`alpha` research artifact**, not a production broker. Its API, file schema and lifecycle hooks may change before `1.0.0`.

Validated locally on Node 26 with deterministic fake transport, mocked raw-Anthropic transport tests, and owner-gated live Pi-child checks against the currently available fleet. Live checks exercise dynamic failover and a restricted effect proposal, but do **not** make the packaged controller provider proxy production-ready. The fake transport is opt-in from `@sars267/pi-delegation-broker/testing` and must never be wired to a real model route.

## What it provides

- SQLite (`BEGIN IMMEDIATE` + WAL) lease reservation, TTL, fencing and shared capacity groups.
- Durable bounded task waiting with named recovery owner/deadline and supervisor wake-up after capacity changes.
- `control | verify | work` admission classes with clamped queue aging and protected dispatch-window representatives, preventing either old work or fresh control from disappearing behind backlog.
- Contract admission requires child-facing `doneWhen`, exact prompt-digest binding and a positive latency budget.
- A controller-owned behavioral monitor for typed action reconciliation and no-progress detection. The lease durably binds one effective capability; lease-scoped IPC retrieves it and centrally gates declaration, authorization and completed-tool observation. An effect-capable child receives only a restricted `propose_patch` tool, which applies a validated Git diff only to a disposable worktree; the controller re-applies and checks it in a separate scratch worktree before returning an unapplied patch. Attestation, worktree isolation and controller acceptance checks are mandatory.
- Registry-defined inventory confidence, pessimistic cooldown policy and one half-open probe per group. Recent credential-free provider listings persist across restart with a bounded TTL; an owner-only routing audit journal records route/failover/legacy transitions and observed token efficiency without prompts, credentials or price data.
- Capability-aware model selection over a provider set that changes while work runs. A catalog maps to one resource per `(provider, model)`, one capacity group per account and one profile per capability tier shared across providers. Before ranking, production extension routing applies hard provenance gates: automatic routes must be current and belong to a native first-party/mixed-subscription billing pool; Cursor's own Grok/Composer pool is distinct from its third-party catalog; OpenRouter/Ollama/opencode aggregators are default-deny and require an exact user tier allowlist. Previous/deprecated/unknown generations never enter autonomous routing, and an unavailable explicit pool denies rather than silently broadening to the catalog. Receipt-backed learning can reorder only the already eligible set.
- Parent-free durable workflow jobs. `delegate_workflow` submits atomically and returns a workflow id by default; `delegate_status`, `delegate_list`, `delegate_collect` and `delegate_cancel` operate on the durable lifecycle. Read-only workflows recover after controller restart, cancellation is idempotent, dependency reports are passed only through explicit `inputs`, and submission acknowledgement, no-progress watchdog, absolute attempt ceiling and whole-workflow deadline are separate controls.
- Automatic parent wake after a top-level background task/workflow settles. The controller emits a typed hidden custom `followUp` with `triggerTurn: true` (never `sendUserMessage`), so an idle parent resumes, collects the durable report and continues the owner task. Pi currently converts custom messages to provider-visible user role; the always-on `delegate_collect` system guideline therefore frames the marker as controller state, and the wake contains only bounded task IDs/statuses—never child text or owner-like instructions. Wake dispatch uses a persistent create-once pre-send claim plus a monotonic read marker, coalesces bursts and deduplicates per live session. Claim pathnames are never automatically released, stale-reaped or pruned: any host/crash ambiguity falls back to the next genuine owner turn rather than spending twice, collected state cannot be resurrected by stale JSON, definitely unclaimed pending wakes remain restart-recoverable, and legacy inboxes do not replay.
- Persistent content-addressed, redacted controller evidence with command/file/test/URL semantic recapture comparators and explicit retention/pruning; self-reported evidence cannot satisfy acceptance. `ControllerAcceptanceVerifier` runs a fixed controller-owned command/test plan serially; `ControllerVerificationAuthority` retains a receipt bound to exact task/lease/fence, and `ControllerQueuedTaskVerifier` alone connects close→verify→terminal finalization.
- SHA-256-hashed lease capabilities for owner-only Unix-socket IPC.
- Signed Ed25519 capability-registry verification before supervisor startup.
- Framed streaming IPC: children send bounded closed-schema context via `providerStream`; a native Pi `broker-proxy` provider can use that lease-scoped IPC route with **no upstream provider credential or child `auth.json`**. It is opt-in and accepts only text, tool-free context until a controller protocol can faithfully replay tool results; `captureProviderContext` admits only text system/user/assistant messages and uniquely named JSON-schema tools, then takes one `captureLosslessJson` snapshot before route/credential resolution. The controller creates an immutable `AttemptRouteSnapshot`, streams `ProviderStreamAssembler`-validated frames, and settles through `AttemptSettlement` with an `ArtifactPipeline` terminal durability barrier. A `streamProviderIpc` client reads NDJSON frames until the validated terminal. The legacy digest-only `providerAttempt` remains for backward compatibility. IPC requires either the deterministic fake transport or an explicitly injected `providerTransport + routeResolver` pair, never both; neither credentials nor a live route are packaged.
- An independently tested low-level `AnthropicMessagesTransport` and controller-only route gate: exact injected endpoint/credential resolution, one raw HTTPS dispatch, retry disabled by construction, explicit cache-retention snapshot policy, bounded strict SSE normalization, no environment/keychain/OAuth fallback, one route-table generation and an expiring request approval. This is not live-provider evidence.
- Unified capability compiler: `createEffectiveChildCapability` + `compileEffectiveChildCapability` generate prompt-visible rules and executable authorization from one immutable source. `BrokeredLaunchResolver` compiles and durably binds the capability to its lease before exposing the lease-scoped IPC token; a child can retrieve only that bound record. `BehavioralRunMonitor` runs centrally behind IPC (tool-not-allowed and behavioral-enforcement-unavailable terminal denials).
- Owner-only state directory, lock, socket, bounded shutdown and periodic TTL sweep.
- A controller-only resolver that checks the exact approved model before creating a child policy.
- Pre-handoff and post-session cleanup hooks for a compatible patched child launcher.
- Deterministic test fixtures for success, 429, expiry, cancellation and stale capability scenarios.

## Works with `pi-multi-account`

`pi-delegation-broker` is designed to work well alongside [`pi-multi-account`](https://github.com/Sarrius/pi-multi-account): it discovers dynamically added account aliases, models each alias as a separate broker capacity group, and cools the whole account when one of its models is throttled or its balance is exhausted. Thus an interactive Pi failover and a brokered-child failover both adapt to the same changing fleet instead of pinning a provider.

The integration deliberately preserves the credential boundary:

- The **parent** Pi session may load `pi-multi-account` and expose aliases such as `anthropic-account-2` or `openai-codex-account-6`.
- The controller keeps that alias in lease, health, cooldown and audit data, so it knows exactly which account was spent.
- A brokered child runs with `--no-extensions`; it never loads the parent's multi-account UI/rotation extension and never receives the parent `auth.json`.
- Its isolated agent directory contains only the credential leased for that attempt. The launcher maps `*-account-N` to the canonical Pi provider (`anthropic`, `openai-codex`, …) solely inside that one-credential directory, because a fresh extension-isolated Pi process cannot resolve alias providers itself.

This means multi-account capacity and failover remain controller-owned while a child cannot select an account, invoke `pi.setModel()`, or access another credential. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md#account-aliases-and-fresh-pi-processes) for the exact invariant and Hermes subprocess configuration.

## What it deliberately does **not** provide

- A durable secret vault/rotation, unattended live-provider approval, or provider failover outside the broker's explicit leased Pi-child path. The library has a controller-owned proxy child path, but enabling it against a real provider still requires an explicit approved route/credential injection.
- Multi-host coordination, automatic stale-lock recovery, production daemon/service management or dashboard.
- A complete controller scheduler that turns every ready queued lease into a child launch. The reference exposes durable readiness; integration remains controller-owned.
- Signing-key storage, rotation, revocation or registry distribution.
- A stable upstream Pi launcher API. The [integration patch](https://github.com/Sarrius/pi-delegation-broker/tree/main/patches) is source-repository-only and is **not** installed by this package.
- A sandbox. Worktrees and a minimal environment are not operating-system isolation.

## Requirements

- Node.js **26 or later**. The package uses the built-in `node:sqlite` API.
- macOS/Linux Unix-domain sockets for the supervisor IPC path.
- For Pi child integration: a separately reviewed/accepted launcher seam. Do not patch global Pi files automatically.

## Install

The first public prerelease should use the `next` npm tag:

```sh
npm install @sars267/pi-delegation-broker@next
```

The published prerelease is a research artifact only; installing it does not authorize connection to any real provider/account.

## Pi extension controls

The parent extension exposes controller-owned policy controls; they edit only `~/.pi/agent/delegation-broker/preferences.json` through schema validation, never a child prompt:

```text
/delegation-broker status
/delegation-broker models
/delegation-broker models openrouter
/delegation-broker tier frontier list
/delegation-broker tier standard add glm-5.3 zai opencode-go-api
/delegation-broker tier standard remove glm-5.3 zai
```

`models` reports catalog/live broker health and credential-free provenance (`providerClass/billingPool/modelDeveloper`). Empty tier lists mean strict automatic subscription-native/current-only selection. Adding an exact model/provider entry is an explicit allowlist and is how an aggregator route is enabled. An unavailable explicit tier denies; it never falls back to the whole catalog. Delegation results show the policy fingerprint, tier, decision source, actual leased account, billing pool, freshness and failover trail. `delegate` also accepts `proposeChangesIn` plus controller acceptance checks for the restricted, unapplied patch workflow.

Read-only `delegate` and `delegate_workflow` are asynchronous by default:

```text
delegate({ task, tier?, idempotencyKey?, deadlineMs? }) -> task id
delegate_workflow({ nodes, concurrency?, idempotencyKey?, deadlineMs? }) -> workflow id
delegate_status({ id })
delegate_list({ states? })
delegate_collect({ taskId: id })
delegate_cancel({ id, reason? })
```

Set `wait: true` only for compatibility with a short synchronous caller. The workflow deadline remains controller safety; it does not make the parent wait.

## Minimal API shape

```js
import {
  SingleHostBrokerSupervisor,
  BrokeredLaunchResolver,
  BehavioralRunMonitor,
  ControllerEvidenceStore,
  ControllerAcceptanceVerifier,
  validateResultEvidence,
  verifySignedRegistry,
} from "@sars267/pi-delegation-broker";
```

`ControllerEvidenceStore` requires an absolute owner-only `root` and exactly one writer process; its startup orphan sweep is not a multi-writer protocol. Text artifacts are redacted before hashing/retention, while binary artifacts require `artifactIsRedacted: true`. `captureObservation`/`compareSemantic` support command, file-range, test-outcome and URL-body recapture, and `validateResultEvidence` applies any supplied `semanticRecaptures`. `ControllerAcceptanceVerifier` accepts no worker-provided check selection or command: its controller-owned `runCheck` closure maps a fixed 1–20 command/test plan to a read-only verifier environment; it serializes checks, captures each retained descriptor, and treats runner error, timeout, malformed observation or non-zero/failing outcome as rejected acceptance. `ControllerVerificationAuthority` retains an immutable receipt with the task/lease/fence binding; broker finalization refuses a structurally valid but unattested receipt. Volatile-field normalization is opt-in and fails with `policy_conflict` when an acceptance criterion names a stripped field. `BehavioralRunMonitor` detaches bounded lossless action/result snapshots. The broker persists the controller-selected capability under the lease, derives the state digest itself, and records behavioral events separately from provider telemetry. `extensions/pi-behavioral-enforcement.ts` retrieves that capability using only the lease-scoped IPC token, requires a one-action declaration, calls central authorization from Pi's blocking `tool_call`, and observes completed `tool_result` projections. `BrokeredLaunchResolver` requires controller-pinned extension attestation before effect-capable reservation. The implemented effect surface is intentionally only `propose_patch`: it can alter a disposable worktree, and the controller independently applies/checks the resulting patch without modifying the caller's tree. The low-level `behavioralEnforcement` constructor seam is trusted-caller-only and must never be populated from environment or configuration.

A supervisor requires signed registry schema v2 by default. Registry capacity groups must declare admission reserves, inventory confidence, default cooldown and probe interval; resources must declare their own inventory confidence. These fields are fail-closed because inferred capacity must not masquerade as measured capacity. If a durable database contains different policy values or removed/extra registry IDs, startup refuses an implicit transition and requires an audited migration/new state directory. Passing an unsigned fixture requires the explicit `allowUnsignedFixture: true` escape hatch, which exists only for deterministic tests.

The controller owns all of these values:

- signed registry and trusted public-key keyring;
- controller token;
- approved task contract and exact provider/model;
- child-agent root and explicit extension allowlist.

A child receives only a short-lived lease capability. Never pass a controller token, registry signing key, OAuth token, API key or complete account inventory to child environment, prompt, result or log.

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the launcher boundary, [`docs/PROVIDER-PROXY-PROTOCOL.md`](docs/PROVIDER-PROXY-PROTOCOL.md) for the partially implemented fail-closed provider protocol, [`docs/LIVE-VALIDATION-PLAN.md`](docs/LIVE-VALIDATION-PLAN.md) for the owner-gated live procedure, and [`RELEASE.md`](RELEASE.md) before publishing.

## Verification

```sh
npm ci
npm run release:check
```

This runs syntax checks, deterministic tests and an `npm pack --dry-run` manifest/secret guard. It does **not** run live provider tests.

## Security

Please read [`SECURITY.md`](SECURITY.md). Do not open public issues containing tokens, account identifiers, database copies or provider responses.

## License

[MIT](LICENSE)
