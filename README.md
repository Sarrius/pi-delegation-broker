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
- SHA-256-hashed lease capabilities for owner-only Unix-socket IPC.
- Signed Ed25519 capability-registry verification before supervisor startup.
- Owner-only state directory, lock, socket, bounded shutdown and periodic TTL sweep.
- A controller-only resolver that checks the exact approved model before creating a child policy.
- Pre-handoff and post-session cleanup hooks for a compatible patched child launcher.
- Deterministic test fixtures for success, 429, expiry, cancellation and stale capability scenarios.

## What it deliberately does **not** provide

- A real provider proxy, streaming upstream API calls, credential vault or account discovery.
- Multi-host coordination, automatic stale-lock recovery, production daemon/service management or dashboard.
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

Do not install from npm until the repository release checklist is complete and the package name is confirmed available.

## Minimal API shape

```js
import {
  SingleHostBrokerSupervisor,
  BrokeredLaunchResolver,
  verifySignedRegistry,
} from "@sars267/pi-delegation-broker";
```

A supervisor requires a signed registry by default. Passing an unsigned fixture requires the explicit `allowUnsignedFixture: true` escape hatch, which exists only for deterministic tests.

The controller owns all of these values:

- signed registry and trusted public-key keyring;
- controller token;
- approved task contract and exact provider/model;
- child-agent root and explicit extension allowlist.

A child receives only a short-lived lease capability. Never pass a controller token, registry signing key, OAuth token, API key or complete account inventory to child environment, prompt, result or log.

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the intended boundary and [`RELEASE.md`](RELEASE.md) before publishing.

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
