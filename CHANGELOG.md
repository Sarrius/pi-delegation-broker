# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/) after `1.0.0`.

## Unreleased

- Added a low-level, unconfigured `AnthropicMessagesTransport` as the first real-provider transport primitive and wired it through the same controller IPC frame/settlement boundary as the fake transport. It resolves only controller-injected exact endpoint and credential handles; has no environment/keychain/OAuth fallback; makes exactly one raw HTTPS dispatch without retries or redirects; freezes cache retention (`none | short | long`) in `AttemptRouteSnapshot`; and converts bounded strict Anthropic SSE into closed controller events. IPC accepts the real transport only with its paired route resolver, never alongside fake transport. It is mock-tested only, has no credential configuration, and has made no live provider call.
- Integrated the capability compiler into the launch resolver: `BrokeredLaunchResolver` now creates an `EffectiveChildCapability` from the contract and lease, compiles it into `promptRules` (child-visible) and `authorizationPolicy` (controller-enforced), and includes both in the returned policy. A `deriveAllowedTools` helper maps operation classes to default tool sets.
- Added unified capability compiler: `createEffectiveChildCapability` validates and deep-freezes one immutable child-facing capability (operation class, allowed tools, doneWhen, budget, behavioral enforcement); `compileEffectiveChildCapability` generates prompt-visible rules and executable authorization from that single source. `BehavioralRunMonitor` now optionally accepts an authorization policy that denies tools outside the allowed set (terminal `tool_not_allowed`) and effect-capable operations without a wired blocking monitor (terminal `behavioral_enforcement_unavailable`).
- Added `RoutingBoard`: dynamic, continuously updated scoreboard tracking machine-verifiable outcomes per (resource, capability) pair. Uses Wilson score confidence intervals for routing scores (small samples don't outrank large), exploration bonuses for under-observed resources, drift detection via rolling-window divergence, consecutive-failure exclusion, recency decay, and export/import for persistence. The one-provider degenerate case reduces to monitoring. Only machine-verifiable evidence kinds (test_pass, schema_valid, compile_clean, type_check, acceptance_criteria) feed routing — model-graded scores are rejected.
- Added `provider-catalog.mjs`: converts a Pi modelRegistry snapshot (populated by pi-multi-account or other extensions) into a broker registry. Each provider becomes a resource in its own capacity group; each provider's strongest model becomes a profile with derived capability supports. The broker consumes a plain catalog snapshot — it does not know about multi-account as a package.
- Added transactional registry reload: `reloadRegistry` validates the candidate, denies reload while active leases or pending tasks exist, atomically deletes and re-inserts the registry in a single transaction with SQLite rollback on failure.
- Added `ArtifactPipeline` with bounded pending queue, byte cap, ordered drain, terminal durability barrier, and re-attemptable failure. The streaming path calls `pipeline.barrier()` before `settlement.markPersisted()`; if the barrier fails, the crash-repair class stays `terminal_unpersisted` instead of treating the attempt as durably settled.
- Wired framed streaming into the IPC layer: children can now send bounded typed context (systemPrompt, messages, tools, options) via the new `providerStream` method, which validates context through `captureLosslessJson`, creates an immutable `AttemptRouteSnapshot`, streams frames back through `ProviderStreamAssembler`-validated grammar, and settles through `AttemptSettlement`. The legacy digest-only `providerAttempt` remains for backward compatibility. A `streamProviderIpc` client reads NDJSON frames until the validated terminal. Real transport wiring requires the separately described exact-route, mock-tested transport path; credentials are never included.
- Implemented deterministic provider proxy protocol machinery: immutable `AttemptRouteSnapshot` with one-time route/credential fingerprinting, versioned framed envelope validation, strict stream grammar (block lifecycle, tool-call identity pinning, cumulative usage monotonicity), exactly-once terminal CAS, attempt phase machine with crash-repair classification, and closed terminal/outcome vocabulary with provenance and retry-eligibility properties. No transport, credential, or IPC wiring is included; live use remains prohibited.
- Added the versioned controller-owned real-provider proxy design gate, including strict stream grammar, immutable route/account binding, terminal/outcome taxonomy, cancellation, backpressure and adversarial acceptance tests; implementation remains absent and live use remains prohibited.
- Behavioral action/result hashing now uses one bounded detached lossless-JSON snapshot; lossy numbers, sparse/decorated arrays, cycles, accessors and exotic containers fail closed instead of colliding or changing after declaration.
- Added exact ready-task claim, pre-handoff requeue, `awaiting_result` crash reconciliation and terminal parent-result finalization.
- Added clamped queue aging, protected control/verifier dispatch-window representatives and per-class p95/max wait metrics so neither strict priority nor an aged backlog hides a class.
- Effect-capable contracts now fail closed with `behavioral_enforcement_unavailable` until a trusted launch path asserts a wired blocking monitor; the enforcement capability is carried on admitted leases.
- Added command/file/test/URL semantic recapture projections and validator integration instead of byte-exact spot audit; volatile normalization is opt-in and conflicts fail closed when acceptance names the stripped field.
- Backward clock steps now fail closed against the durable ledger time floor rather than extending capabilities.
- Added contract `doneWhen`, prompt-digest binding and positive latency-budget admission checks.
- Added deterministic behavioral monitoring for no-progress, typed action mismatch, declared-change reconciliation and completion claims.
- Replaced digest-only evidence indexing with redacted content-addressed retention, restart verification, corruption detection and explicit pruning.
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
