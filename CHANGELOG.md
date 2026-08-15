# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/) after `1.0.0`.

## 0.1.0-alpha.1 - 2026-08-15

OIDC provenance validation release. No runtime changes from `0.1.0-alpha.0`.

- Publishes through the configured GitHub Actions trusted publisher.

## 0.1.0-alpha.0 - 2026-08-15

Initial public research release.

- Single-host SQLite lease broker with fencing, TTL, shared capacity and redacted ledger.
- Owner-only Unix-socket IPC with controller and child-scoped authority.
- Signed Ed25519 registry verification and supervisor lifecycle reference.
- Controller-only brokered launch resolver and deterministic fake transport.
- No real provider proxy, credential storage, account discovery or multi-host coordination.
