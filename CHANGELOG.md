# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/) after `1.0.0`.

## Unreleased

- Added durable task waiting with explicit recovery owner/deadline and supervisor dispatch.
- Added `control | verify | work` admission reserves to prevent work fan-out from starving merger/verifier capacity.
- Added confidence-labelled schema-v2 inventory enforcement, registry-defined cooldowns and a one-probe half-open breaker.
- Registry/persisted-policy mismatches now fail closed instead of silently retaining stale capacity or admission rules.
- Added controller-rooted evidence validation; self-reported evidence cannot satisfy acceptance.
- Queue size is hard-bounded; high-risk contracts must declare all three hard budget dimensions and positive caps.
- A success from an older in-flight lease cannot close a breaker opened by a concurrent 429.
- Expanded deterministic liveness, priority, cooldown and evidence tests.

## 0.1.0-alpha.1 - 2026-08-15

OIDC provenance validation release. No runtime changes from `0.1.0-alpha.0`.

- Published through the verified GitHub Actions trusted publisher with provenance.

## 0.1.0-alpha.0 - 2026-08-15

Initial public research release.

- Single-host SQLite lease broker with fencing, TTL, shared capacity and redacted ledger.
- Owner-only Unix-socket IPC with controller and child-scoped authority.
- Signed Ed25519 registry verification and supervisor lifecycle reference.
- Controller-only brokered launch resolver and deterministic fake transport.
- No real provider proxy, credential storage, account discovery or multi-host coordination.
