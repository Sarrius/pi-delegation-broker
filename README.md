# @sars267/pi-delegation-broker

> **Alpha / research reference — a real provider request requires a separately authorized, pre-registered live experiment.**

A single-host Node.js reference implementation for capability-scoped Pi child delegation. It demonstrates a safe control path:

```text
trusted controller → signed registry → SQLite lease broker → scoped Unix-socket capability → isolated child policy
```

The Pi extension owns its native provider adapter and uses Agent Pi's model registry, provider runtime and authentication APIs directly. It keeps credentials in the parent while children receive a scoped IPC route. No other extension is required to initialize this path. The low-level library additionally supports explicitly injected transports; a missing transport fails closed.

## Status

This package is publishable as an **`alpha` research artifact**, not a production broker. Its API, file schema and lifecycle hooks may change before `1.0.0`.

Validated locally on Node 26 with deterministic transports, native-provider tests, and owner-authorized fresh-process Cursor canaries. The native canary completed a credentialless child read and isolated `propose_patch`/controller `npm-test` flow on `cursor/claude-4-sonnet`; the child had no `auth.json` and the broker had no leaked lease. These bounded checks are evidence for the path, not unattended or general production approval. The fake transport is opt-in from `@sars267/pi-delegation-broker/testing` and must never be wired to a real model route.

## Core principle: use available resources, recover automatically

Use currently available, suitable, authorized resources; continue with eligible alternatives or the ordinary baseline when one disappears; automatically reconsider it when it recovers. This applies to the **whole broker**, not only optional Jev. Temporary failure must not become permanent exclusion, nor may recovery override owner off/consent, quality, permissions or task bounds. See the [resource availability contract and regression matrix](docs/RESOURCE-AVAILABILITY.md).

## Delegation decisions and evidence

New delegations declare the child's result and the parent's independent work in `work`. Small tasks stay local; default workflow concurrency is two and planned children default to three physical route attempts. **Connected is not ready:** before the first owner task, each offered route must pass an isolated synthetic child that reads a random challenge, returns its exact contents and round-trips a durable report. `delegate_inventory` and the automatic parent roster expose only qualified ready rows; failed, busy, excluded and unchecked routes are separate diagnostics. Ordinary Enter builds that roster synchronously from unexpired cached evidence without waiting for startup, catalog refresh or inference; an empty cache is not an availability verdict. After the user message is visible, a deferred single-flight background pass refreshes the catalog and prepares eligible routes (at most one pass per 30 seconds, 180-second deadline, cancelled on shutdown). This preserves automatic preparation without putting it on Enter's critical path; there is no idle inference polling. Foreground `agent_settled` is not global child idleness: it preserves controller-owned qualification children both during startup and execution. Orphan RPCs are reaped only when owner jobs and controller work are idle; shutdown drains owned runners before the orphan backstop. Explicit inventory/plan and actual launch still qualify on demand and retain separate fresh admission checks. `delegate_plan` qualifies compatible routes without submitting the owner's task. Stable conformance expires after ten minutes or a route/credential/runtime change; short availability expires after sixty seconds, and every actual launch rechecks it before leasing. Checks consume configured subscription quota or metered-provider credits but never use the owner's brief as a probe. `verifyLive:false` is a cached/no-spend view, not a launch bypass. Qualification proves neither future quota nor task quality. See [readiness and recovery](docs/RESOURCE-AVAILABILITY.md). `delegate_feedback` remains **attributed feedback, not a quality verdict**.

`delegate_inventory(history=true)` and `/delegation-broker history` include an owner-session execution scorecard by provider/model, task class, tier, selector preference source and **requested versus effective reasoning effort**: completion/failure, controller-recorded verification, observed token/latency coverage, child handoffs, route hops and parent-usefulness counts. Child handoffs are not paid inference requests; route hops can include pre-dispatch denials. The separate `performance` section counts only controller-checked acceptance outcomes and alone can train model affinity. New quality observations also label the child's **effective** reasoning level; older records label it `unknown`. The current `routing-v3` learner still cohorts by **requested** effort, so this is descriptive evidence, not an automatic effort optimizer or a causal comparison. Missing verification, unknown actual subscription spending and limited samples remain visibly unknown; no score is proof that the original parent task or product succeeded. Agent-visible rows are bounded and other sessions' task IDs are not shown. Quality, availability, evidence count and consumption remain separate; an unobserved model is not presumed worse than a verified failure. See the [product contract](docs/INTEGRATION.md#delegation-product-contract-2026-09-05) for ownership, cancellation, storage, fairness and measurement limits.

## What it provides

- SQLite (`BEGIN IMMEDIATE` + WAL) lease reservation, TTL, fencing and shared capacity groups.
- Durable bounded task waiting with named recovery owner/deadline and supervisor wake-up after capacity changes.
- `control | verify | work` admission classes with clamped queue aging and protected dispatch-window representatives, preventing either old work or fresh control from disappearing behind backlog.
- Contract admission requires child-facing `doneWhen`, exact prompt-digest binding and a positive latency budget. New ordinary read-only work has **no implicit cumulative input or output stop**: the controller records usage, asks for at most 16k tokens per provider response (a best-effort provider hint), and enforces attempt/no-progress/deadline limits instead of failing an audit at an invented 16k total. A caller-declared output cap is still hard, across provider streams and failover; effect-capable work keeps a hard safety cap. Read-only input is metered and reconciled to actual provider usage; an explicit cumulative input cap remains binding, but the broker no longer invents a 1M total-input ceiling for ordinary work. Effect-capable input keeps its byte-safe hard safety cap. Workflow roots gate physical attempts and pass a declared remaining output budget into each node, serializing output-budgeted teams to preserve that cap. Independent persisted input/output policy markers preserve historical job limits after restart or idempotent replay (including the old 1M input cap and, for pre-output-v2 jobs, the hard 16k output cap). Only newly submitted jobs receive the corresponding uncapped metered defaults.
- Workflow mutations are bound to the originating parent session, and team joins accept only controller-verifier-bound node receipts. Integration requires authority receipts bound to the exact patch digest and target head; protected repairs require signed, expiry-bound owner approval. The extension exposes controller-only repair lifecycle tools, but repair execution stays fail-closed until an owner-injected verification/canary/reconciliation adapter exists.
- A controller-owned behavioral monitor for typed action reconciliation and no-progress detection. The lease durably binds one effective capability; lease-scoped IPC retrieves it and centrally gates declaration, authorization and completed-tool observation. An effect-capable child receives only a restricted `propose_patch` tool, which applies a validated Git diff only to a disposable worktree; the controller re-applies and checks it in a separate scratch worktree before returning an unapplied patch. Attestation, worktree isolation and controller acceptance checks are mandatory.
- Registry-defined inventory confidence, pessimistic cooldown policy and one half-open probe per group. The dynamic controller rechecks credential expiry and provider listings periodically, supports OAuth subscriptions in controller preflight, applies account additions/withdrawals while work is active, and represents an empty authorized fleet explicitly. Recent credential-free provider listings persist across restart with a bounded TTL; an owner-only routing audit journal records route/failover/legacy transitions and observed token efficiency without prompts, credentials or price data.
- Capability-aware model selection over a provider set that changes while work runs. A catalog maps to one resource per `(provider, model)`, one capacity group per account and one profile per capability tier shared across providers. Before ranking, production extension routing applies hard provenance gates: automatic routes must be current and belong to a native first-party/mixed-subscription billing pool; Cursor's own Grok/Composer pool is distinct from its third-party catalog; OpenRouter/Ollama/opencode aggregators are default-deny and require an exact user tier allowlist. Previous/deprecated/unknown generations never enter autonomous routing, and an unavailable explicit pool denies rather than silently broadening to the catalog. Receipt-backed learning can reorder only the already eligible set.
- Parent-free durable workflow jobs. `delegate_workflow` submits atomically and returns a workflow id by default; `delegate_status`, `delegate_list`, `delegate_collect` and `delegate_cancel` operate on the durable lifecycle. Read-only workflows recover after controller restart, cancellation is idempotent, dependency reports are passed only through explicit `inputs`, and submission acknowledgement, no-progress watchdog, absolute attempt ceiling and whole-workflow deadline are separate controls.
- Automatic parent wake after a top-level background task/workflow settles. The controller emits a typed hidden custom `followUp` with `triggerTurn: true` (never `sendUserMessage`) only when the full active parent interval and pending owner queue are safe, so a busy parent is never prompted recursively; an idle parent resumes, collects the durable report and continues the owner task. `agent_settled` remains the fast path. A single unreferenced 250ms local readiness retry, armed only while definitely unclaimed reports are pending, also covers standalone parent compaction (success, failure or abort) without requiring another owner message. It checks host readiness only—no provider calls, inference, lease changes or child restarts. Pi currently converts custom messages to provider-visible user role; the always-on `delegate_collect` system guideline therefore frames the marker as controller state, and the wake contains only bounded task IDs/statuses—never child text or owner-like instructions. Terminal `completed` means execution settled, not controller quality acceptance: the parent must collect the report and inspect explicit `verificationStatus` and evidence. Failed/incomplete review work is never redeemed by lifecycle completion, and an accepted child check still does not establish the larger owner task succeeded. Wake dispatch uses persistent create-once pre-send claim, sent and read markers, coalesces bursts and deduplicates per live session. Claim pathnames are never automatically released, stale-reaped or pruned: any host/crash ambiguity falls back to the next genuine owner turn rather than spending twice, collected state cannot be resurrected by stale JSON, definitely unclaimed pending wakes remain restart-recoverable, and legacy inboxes do not replay.
- A controller-driven terminal fleet view. A compact below-editor widget and footer status show active task/node state, actual safe account/provider/model, effective thinking, retry attempt, elapsed time, last progress age and token/cache usage. `/delegation-broker fleet [active|all|id]` drills into durable job/report versus volatile attempt state. Recovery is labeled `lost/reconciling`; silence is never inferred healthy. The view is bounded and never includes credentials, prompts or child report prose.
- Independent child contract axes. `tier` sets the quality floor, `thinking` sets reasoning effort (`auto`, `inherit` from the live parent session, or an explicit `off…max` level that is never silently lowered), and `route` chooses identity: `auto` lets the selector decide, `inherit_model` asks for the parent's exact current model when a genuine peer is needed, and `peer` fails closed while no calibrated quality-equivalence exists rather than guessing. An optional schema-versioned `role` (name, mission, deliverables, boundaries) is quoted inside delimiters and placed before lease rules, so the lease remains the last authoritative voice: it shapes how a child works and never grants a tool, permission or effect capability. Recovered node contracts are re-validated and fail closed on invalid axes. Reviewed `skills` are explicit absolute paths with content digests: ambient discovery stays off, `--skill` is the only injection, and a skill never grants tools. `inherit_model` narrows the candidate set through the selector's `requireModelIdentity` filter, applied beside the currency, provenance, quality-floor and health gates rather than instead of them, so naming a model can only ever reduce what is eligible; an inadmissible identity denies. Requested and effective effort are both persisted, and the fleet shows `requested→effective` whenever a provider changed it.
- Slice 3 recovery: controller/tool defects are captured as bounded immutable records with provenance; a child may publish partial structured work through lease-scoped `broker_checkpoint`, but only controller-accepted, conflict-free checkpoints are offered to a replacement attempt. Checkpoints are partial data, never completion or authority. Durable parent-session bindings retain active roots and the Pi compaction cursor. Each model request reconstructs a bounded owner-scoped assignment/current-inbox snapshot, including continuations inside the same run after compaction. The snapshot is transient, prefixed before genuine owner messages, and contains no child report prose; it neither grows stored history nor revives an already-woken historical inbox.
- Persistent content-addressed, redacted controller evidence with command/file/test/URL semantic recapture comparators and explicit retention/pruning; self-reported evidence cannot satisfy acceptance. `ControllerAcceptanceVerifier` runs a fixed controller-owned command/test plan serially; `ControllerVerificationAuthority` retains a receipt bound to exact task/lease/fence, and `ControllerQueuedTaskVerifier` alone connects close→verify→terminal finalization. For read-only exact-answer checks it receives bounded final child text only as untrusted comparison data; missing/wrong text is rejected, and the controller evidence records a digest rather than the answer. A controller-proven bad historical **receipt-backed read-only** quality observation can be retained with an append-only `quality_invalidation` event and excluded from affinity/quality summaries; neither parent feedback nor a compensating made-up success repairs it. A verified child answer is not itself proof that the parent's larger task succeeded.
- SHA-256-hashed lease capabilities for owner-only Unix-socket IPC.
- Signed Ed25519 capability-registry verification before supervisor startup.
- Framed streaming IPC: children send bounded closed-schema context via `providerStream`; a native Pi `broker-proxy` provider can use that lease-scoped IPC route with **no upstream provider credential or child `auth.json`**. The native controller boundary replays approved JSON-schema tools, assistant tool calls, and bounded canonical text/image user or tool-result blocks; executable functions, provider options, remote image URLs, unknown media and reasoning blocks never cross it. Vision input is advertised to the child only for a `vision_input` contract, and the exact native model is checked again before dispatch. `captureProviderContext` validates one closed conversation and takes one `captureLosslessJson` snapshot before route/credential resolution. The controller creates an immutable `AttemptRouteSnapshot`, streams `ProviderStreamAssembler`-validated frames, and settles through `AttemptSettlement` with an `ArtifactPipeline` terminal durability barrier. A `streamProviderIpc` client reads NDJSON frames until the validated terminal. The legacy digest-only `providerAttempt` remains for backward compatibility. IPC requires either the deterministic fake transport or an explicitly injected `providerTransport + routePreflight + routeResolver` pair, never both; neither credentials nor a live route are packaged. The older hand-built OpenAI/Anthropic transport seams remain text-only; use the Pi-native pair for tool-capable work.
- Independently tested low-level `AnthropicMessagesTransport` and `OpenAIChatCompletionsTransport` controller-only route gates: exact injected endpoint/credential resolution (API key or current subscription OAuth access token), one raw dispatch, retry disabled by construction, bounded strict SSE normalization, no environment/keychain/alternate-account fallback, one route-table generation and an expiring request approval. The OpenAI-compatible path permits loopback HTTP only for an owner-run adapter such as the Cursor subscription bridge. This is not live-provider evidence.
- Unified capability compiler: `createEffectiveChildCapability` + `compileEffectiveChildCapability` generate prompt-visible rules and executable authorization from one immutable source. `BrokeredLaunchResolver` compiles and durably binds the capability to its lease before exposing the lease-scoped IPC token; a child can retrieve only that bound record. `BehavioralRunMonitor` runs centrally behind IPC (tool-not-allowed and behavioral-enforcement-unavailable terminal denials).
- Owner-only state directory, bounded shutdown and periodic TTL sweep. Concurrent parent Pi processes share one transactional SQLite capacity ledger, but each controller incarnation owns a namespaced lock/socket/token and private evidence journals; one Pi reload or shutdown cannot replace another controller's IPC route.
- A controller-only resolver that checks the exact approved model before creating a child policy.
- Pre-handoff and post-session cleanup hooks for a compatible patched child launcher.
- Deterministic test fixtures for success, 429, expiry, cancellation and stale capability scenarios.

## Jev decision and routing engine (separate opt-in)

The new operational switch `/delegation-broker-jev on` requires explicit interactive consent for **both** bounded agent next-step decisions (`delegate_decide`) and read-only pre-lease model/auto-effort choice; `off` restores the controller baseline. `decisions-on/off`, `routing-on/off` and `status` control/show individual functions and accounting. Old advisory/shadow settings do **not** activate this engine, nor does the mere presence of `PI_JEV_API_KEY`. No automatic paid API call occurs on installation. Vendor/model-effort research cards and separately checked local outcomes are available without Jev through `delegate_model_evidence`; Jev uses those same cards when consented. Jev cannot grant permissions, lease a route or verify the result. Its outage/abstention retains baseline; status distinguishes a decision merely shown to the parent from an actually observed action. See [consent, evidence, metrics, limits and verification](docs/JEV.md). Fixture tests prove wiring, not live quality gains.

## Optional companion

[`pi-multi-account`](https://github.com/Sarrius/pi-multi-account) adds interactive account discovery, rotation and recovery to Agent Pi. Both extensions work independently; neither imports, initializes, or requires the other. Installed together, they use the same public Pi provider/model catalog, while keeping their own task and retry responsibilities. The broker can use any provider correctly registered in Pi, regardless of how it was registered.

## Help improve reliability

A reproducible [issue](https://github.com/Sarrius/pi-delegation-broker/issues), focused PR, regression test or clearer documentation can help everyone. Share Pi/extension versions and expected versus actual behavior, with credentials and private task data removed. Different real workflows reveal failures one maintainer cannot anticipate alone.

## What it deliberately does **not** provide

- A durable secret vault/rotation, unattended live-provider approval, or provider failover outside the broker's explicit leased Pi-child path. The library has a controller-owned proxy child path, but enabling it against a real provider still requires an explicit approved route/credential injection.
- Multi-host coordination, automatic stale-lock recovery, production daemon/service management or dashboard. See [`docs/EXTERNAL-SUPERVISOR.md`](docs/EXTERNAL-SUPERVISOR.md) for the required host-owned crash/reboot boundary; `tmux` and `caffeinate` are not substitutes.
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
/delegation-broker fleet
/delegation-broker fleet all
/delegation-broker fleet <id>
/delegation-broker fleet id all   # disambiguate a job literally named "all"
/delegation-broker models
/delegation-broker models openrouter
/delegation-broker tier frontier list
/delegation-broker tier standard add glm-5.3 zai opencode-go-api
/delegation-broker tier standard remove glm-5.3 zai
```

`fleet` is the human control-plane projection; it distinguishes durable job/report state from volatile live-attempt progress and preserves the actual terminal route after completion. The live widget and footer read a bounded in-memory projection (maximum 256 durable jobs/reports and 1,000 rows) and never scan the store on their refresh timer; `fleet all` pays one bounded durable rescan, and `fleet id <id>` loads one exact durable task/report for drill-down. Whenever the view is not complete the summary ends with `· bounded`. `models` reports catalog/live broker health and credential-free provenance (`providerClass/billingPool/modelDeveloper`). Empty tier lists mean strict automatic subscription-native/current-only selection. Adding an exact model/provider entry is an explicit allowlist and is how an aggregator route is enabled. An unavailable explicit tier denies; it never falls back to the whole catalog. Delegation results show the policy fingerprint, tier, decision source, actual leased account, billing pool, freshness and failover trail. `delegate` also accepts `proposeChangesIn` plus fixed controller acceptance checks (`git-diff-check`, `npm-check`, `npm-test`, `npm-release-check`, or bounded `file-equals`) for the restricted, unapplied patch workflow. For read-only work, only the fixed `answer-equals` check can verify an **exact final answer against a trustworthy pre-frozen expected value** (≤4096 UTF-8 bytes, never sent to the child); ambient file/tests do not verify a child's reply and are refused before submission. Without an applicable answer check, completion is unverified and cannot train routing. Executable `argv` and caller-supplied claims are not accepted.

Read-only `delegate` and `delegate_workflow` are asynchronous by default:

```text
delegate({ task, tier?, idempotencyKey?, deadlineMs? }) -> task id
delegate_workflow({ nodes, concurrency?, idempotencyKey?, deadlineMs? }) -> workflow id
delegate_status({ id })
delegate_list({ states? })
delegate_collect({ taskId: id })
delegate_cancel({ id, reason? })
```

Set `wait: true` only for compatibility with a short synchronous caller. The workflow deadline remains controller safety; it does not make the parent wait. Independent workflow nodes run concurrently up to the workflow and controller limits. Each provider/account group admits four work leases plus one protected control lease by default, so fallback to one healthy subscription does not silently serialize a four-worker team; a real account-level throttle still cools that entire group. For workflows, `delegate_status` overlays volatile runner state on durable scheduler state: `running` is shown only for an executing/verifying attempt, while route selection and capacity admission remain explicit as `selecting` / `waiting_capacity` with `route:pending`.

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

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the launcher boundary, [`docs/PROVIDER-PROXY-PROTOCOL.md`](docs/PROVIDER-PROXY-PROTOCOL.md) for the fail-closed provider protocol, [`docs/LIVE-VALIDATION-PLAN.md`](docs/LIVE-VALIDATION-PLAN.md) for the owner-gated live procedure, and [`RELEASE.md`](RELEASE.md) before publishing.

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
