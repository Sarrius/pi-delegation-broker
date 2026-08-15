# @sars267/pi-delegation-broker

> **Alpha / research reference — do not connect it to a real provider account or credential.**

A single-host Node.js reference implementation for capability-scoped Pi child delegation. It demonstrates a safe control path:

```text
trusted controller → signed registry → SQLite lease broker → scoped Unix-socket capability → isolated child policy
```

It is designed to fail closed when a provider transport is not explicitly supplied. The package ships **no** HTTP client, OAuth integration, credential store, account rotation, real model proxy, or automatic provider failover.

## Status

This package is publishable as an **`alpha` research artifact**, not a production broker. Its API, file schema and lifecycle hooks may change before `1.0.0`.

Validated locally on Node 26 with deterministic fake transport only. The fake transport is opt-in from `@sars267/pi-delegation-broker/testing` and must never be wired to a real model route.

## What it provides

- SQLite (`BEGIN IMMEDIATE` + WAL) lease reservation, TTL, fencing and shared capacity groups.
- Durable bounded task waiting with named recovery owner/deadline and supervisor wake-up after capacity changes.
- `control | verify | work` admission classes with clamped queue aging and protected dispatch-window representatives, preventing either old work or fresh control from disappearing behind backlog.
- Contract admission requires child-facing `doneWhen`, exact prompt-digest binding and a positive latency budget.
- A deterministic behavioral monitor for typed action reconciliation, no-progress detection and evidence-bound completion claims. Effect-capable contracts fail closed until a trusted launch path asserts the still-unwired blocking monitor.
- Registry-defined inventory confidence, pessimistic cooldown policy and one half-open probe per group.
- Persistent content-addressed, redacted controller evidence with command/file/test/URL semantic recapture comparators and explicit retention/pruning; self-reported evidence cannot satisfy acceptance.
- SHA-256-hashed lease capabilities for owner-only Unix-socket IPC.
- Signed Ed25519 capability-registry verification before supervisor startup.
- Framed streaming IPC: children send bounded typed context via `providerStream`; the controller validates it through `captureLosslessJson`, creates an immutable `AttemptRouteSnapshot`, streams `ProviderStreamAssembler`-validated frames, and settles through `AttemptSettlement`. A `streamProviderIpc` client reads NDJSON frames until the validated terminal. The legacy digest-only `providerAttempt` remains for backward compatibility. No real transport or credential is included.
- Owner-only state directory, lock, socket, bounded shutdown and periodic TTL sweep.
- A controller-only resolver that checks the exact approved model before creating a child policy.
- Pre-handoff and post-session cleanup hooks for a compatible patched child launcher.
- Deterministic test fixtures for success, 429, expiry, cancellation and stale capability scenarios.

## What it deliberately does **not** provide

- A real provider proxy, streaming upstream API calls, credential vault or account discovery.
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
  validateResultEvidence,
  verifySignedRegistry,
} from "@sars267/pi-delegation-broker";
```

`ControllerEvidenceStore` requires an absolute owner-only `root` and exactly one writer process; its startup orphan sweep is not a multi-writer protocol. Text artifacts are redacted before hashing/retention, while binary artifacts require `artifactIsRedacted: true`. `captureObservation`/`compareSemantic` support command, file-range, test-outcome and URL-body recapture, and `validateResultEvidence` applies any supplied `semanticRecaptures`. Volatile-field normalization is opt-in and fails with `policy_conflict` when an acceptance criterion names a stripped field. `BehavioralRunMonitor` is deterministic reference state: it detaches one bounded lossless-JSON snapshot before hashing action arguments/results, rejecting values JSON would erase or normalize, and a Pi integration must call action authorization from a blocking pre-tool hook and result observation only after tool completion. The shipped supervisor does not assert that integration, so `propose_patch`, `apply`, and `external_write` admission returns `behavioral_enforcement_unavailable`. The low-level `behavioralEnforcement` constructor seam is trusted-caller-only and must never be populated from environment or configuration; live use requires launcher/extension attestation.

A supervisor requires signed registry schema v2 by default. Registry capacity groups must declare admission reserves, inventory confidence, default cooldown and probe interval; resources must declare their own inventory confidence. These fields are fail-closed because inferred capacity must not masquerade as measured capacity. If a durable database contains different policy values or removed/extra registry IDs, startup refuses an implicit transition and requires an audited migration/new state directory. Passing an unsigned fixture requires the explicit `allowUnsignedFixture: true` escape hatch, which exists only for deterministic tests.

The controller owns all of these values:

- signed registry and trusted public-key keyring;
- controller token;
- approved task contract and exact provider/model;
- child-agent root and explicit extension allowlist.

A child receives only a short-lived lease capability. Never pass a controller token, registry signing key, OAuth token, API key or complete account inventory to child environment, prompt, result or log.

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the launcher boundary, [`docs/PROVIDER-PROXY-PROTOCOL.md`](docs/PROVIDER-PROXY-PROTOCOL.md) for the unimplemented fail-closed provider protocol, and [`RELEASE.md`](RELEASE.md) before publishing.

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
