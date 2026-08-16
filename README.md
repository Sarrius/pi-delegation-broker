# @sars267/pi-delegation-broker

> **Alpha / research reference — a real provider request requires a separately authorized, pre-registered live experiment.**

A single-host Node.js reference implementation for capability-scoped Pi child delegation. It demonstrates a safe control path:

```text
trusted controller → signed registry → SQLite lease broker → scoped Unix-socket capability → isolated child policy
```

It fails closed without an explicitly injected provider transport. The controller may construct one exact Anthropic Messages route only from an in-memory `ControllerCredentialStore`, credential-free `ControllerRouteTable`, and bounded `ControllerLiveProviderApproval`; it has no OAuth integration, account rotation, automatic failover, ambient-auth fallback or retry loop. The route is separately tested with mocked HTTP only and has never been connected to a real account.

## Status

This package is publishable as an **`alpha` research artifact**, not a production broker. Its API, file schema and lifecycle hooks may change before `1.0.0`.

Validated locally on Node 26 with deterministic fake transport plus mocked raw-Anthropic-transport tests only. No real provider call has been made. The fake transport is opt-in from `@sars267/pi-delegation-broker/testing` and must never be wired to a real model route.

## What it provides

- SQLite (`BEGIN IMMEDIATE` + WAL) lease reservation, TTL, fencing and shared capacity groups.
- Durable bounded task waiting with named recovery owner/deadline and supervisor wake-up after capacity changes.
- `control | verify | work` admission classes with clamped queue aging and protected dispatch-window representatives, preventing either old work or fresh control from disappearing behind backlog.
- Contract admission requires child-facing `doneWhen`, exact prompt-digest binding and a positive latency budget.
- A controller-owned behavioral monitor for typed action reconciliation and no-progress detection. The lease now durably binds one effective capability; lease-scoped IPC retrieves it and centrally gates declaration, authorization and completed-tool observation. A source-auditable Pi extension implements the required `tool_call`/`tool_result` client side, but effect-capable contracts remain denied until a reviewed launcher proves its isolated, final-hook attestation.
- Registry-defined inventory confidence, pessimistic cooldown policy and one half-open probe per group.
- Capability-aware model selection over a provider set that changes while work runs. A catalog maps to one resource per `(provider, model)`, one capacity group per account (a rate limit cools every model of that account) and one profile per capability tier shared across providers — so a contract pins a *class*, and any live provider in that class can serve it. `selectModelForTask` takes the weakest sufficient class, escalates to a stronger one when the cheap tier has nothing alive rather than denying, and never substitutes downward. `updateRegistry` applies newly authenticated accounts immediately and drains withdrawn ones instead of deleting them under a live lease; `BrokeredChildRunner.run` classifies a provider rate limit or outage as a routing fact, reports it, and finishes the task on another account.
- Persistent content-addressed, redacted controller evidence with command/file/test/URL semantic recapture comparators and explicit retention/pruning; self-reported evidence cannot satisfy acceptance. `ControllerAcceptanceVerifier` runs a fixed controller-owned command/test plan serially; `ControllerVerificationAuthority` retains a receipt bound to exact task/lease/fence, and `ControllerQueuedTaskVerifier` alone connects close→verify→terminal finalization.
- SHA-256-hashed lease capabilities for owner-only Unix-socket IPC.
- Signed Ed25519 capability-registry verification before supervisor startup.
- Framed streaming IPC: children send bounded closed-schema context via `providerStream`; `captureProviderContext` admits only text system/user/assistant messages and uniquely named JSON-schema tools, then takes one `captureLosslessJson` snapshot before route/credential resolution. The controller creates an immutable `AttemptRouteSnapshot`, streams `ProviderStreamAssembler`-validated frames, and settles through `AttemptSettlement` with an `ArtifactPipeline` terminal durability barrier. A `streamProviderIpc` client reads NDJSON frames until the validated terminal. The legacy digest-only `providerAttempt` remains for backward compatibility. IPC requires either the deterministic fake transport or an explicitly injected `providerTransport + routeResolver` pair, never both; neither credentials nor a live route are packaged.
- An independently tested low-level `AnthropicMessagesTransport` and controller-only route gate: exact injected endpoint/credential resolution, one raw HTTPS dispatch, retry disabled by construction, explicit cache-retention snapshot policy, bounded strict SSE normalization, no environment/keychain/OAuth fallback, one route-table generation and an expiring request approval. This is not live-provider evidence.
- Unified capability compiler: `createEffectiveChildCapability` + `compileEffectiveChildCapability` generate prompt-visible rules and executable authorization from one immutable source. `BrokeredLaunchResolver` compiles and durably binds the capability to its lease before exposing the lease-scoped IPC token; a child can retrieve only that bound record. `BehavioralRunMonitor` runs centrally behind IPC (tool-not-allowed and behavioral-enforcement-unavailable terminal denials).
- Owner-only state directory, lock, socket, bounded shutdown and periodic TTL sweep.
- A controller-only resolver that checks the exact approved model before creating a child policy.
- Pre-handoff and post-session cleanup hooks for a compatible patched child launcher.
- Deterministic test fixtures for success, 429, expiry, cancellation and stale capability scenarios.

## What it deliberately does **not** provide

- OAuth/keychain integration, durable secret vault/rotation, account switching, automatic provider failover, or an unattended live-provider approval path.
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

`ControllerEvidenceStore` requires an absolute owner-only `root` and exactly one writer process; its startup orphan sweep is not a multi-writer protocol. Text artifacts are redacted before hashing/retention, while binary artifacts require `artifactIsRedacted: true`. `captureObservation`/`compareSemantic` support command, file-range, test-outcome and URL-body recapture, and `validateResultEvidence` applies any supplied `semanticRecaptures`. `ControllerAcceptanceVerifier` accepts no worker-provided check selection or command: its controller-owned `runCheck` closure maps a fixed 1–20 command/test plan to a read-only verifier environment; it serializes checks, captures each retained descriptor, and treats runner error, timeout, malformed observation or non-zero/failing outcome as rejected acceptance. `ControllerVerificationAuthority` retains an immutable receipt with the task/lease/fence binding; broker finalization refuses a structurally valid but unattested receipt. `ControllerQueuedTaskVerifier` may run this workflow after a queued child closes. Volatile-field normalization is opt-in and fails with `policy_conflict` when an acceptance criterion names a stripped field. `BehavioralRunMonitor` detaches bounded lossless action/result snapshots. The broker persists the controller-selected capability under the lease, derives the state digest itself, and records behavioral events separately from provider telemetry. `extensions/pi-behavioral-enforcement.ts` retrieves that capability using only the lease-scoped IPC token, requires a one-action declaration, calls central authorization from Pi's blocking `tool_call`, and observes completed `tool_result` projections. The source-only launcher seam now accepts a controller-pinned extension attestation: every explicit extension's reviewed SHA-256, the behavioral extension last, a pre-spawn rehash, and a required active-tool startup report. `BrokeredLaunchResolver` requires that configuration before it will reserve an effect-capable child. This is still an unaccepted reference seam, not launch authority: `propose_patch`, `apply`, and `external_write` remain unavailable until it is reviewed/accepted and the final controller gate is verified. The low-level `behavioralEnforcement` constructor seam is trusted-caller-only and must never be populated from environment or configuration.

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
