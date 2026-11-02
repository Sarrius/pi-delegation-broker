# Resource availability is reversible

This is a **system-wide Delegation Broker principle**, not a Jev-specific exception:

> Use the currently available, suitable and authorized resources. When one becomes unavailable, continue with eligible alternatives or the ordinary baseline. When it recovers, automatically reconsider it without requiring the owner to reset a failure flag.

Availability is an observation with a recovery path, not permanent policy. “Enabled by the owner” and “currently reachable/usable” are separate states. A billing outage must not silently become an owner-level `off` setting.

## Required behavior

- **Qualify before the first owner task.** The parent receives only a qualified ready roster. Cold routes run an isolated synthetic child through the real controller proxy, tools, lease and report store. A random challenge absent from the prompt must be read with the actual `read` tool and returned exactly; transcript evidence and report read-back are required. A text-only ping cannot establish conformance. `delegate_inventory` sweeps all eligible configured routes by default; a caller limit/provider filter leaves other routes unverified, never ready. Checks consume configured native subscription quota or metered-provider credits, never the owner task brief.
- **Recheck every real admission.** The central launch resolver gates single tasks, workflow nodes and effect proposals before owner work. Stable conformance is incarnation-local, bound to exact route/model/API/auth/effort and valid for ten minutes. Availability evidence lasts sixty seconds; actual launch forces another bounded native availability check (or a full canary when conformance is absent). Health, capability/quality policy and atomic capacity reservation remain mandatory. `verifyLive:false` only disables explicit preview/inventory spending; it cannot disable launch qualification.
- **Scope failures to their evidence.** A bad request must not disable unrelated inputs. A model-specific refusal must not condemn an unrelated account or independent pool. Shared credential/endpoint failures may affect the corresponding group.
- **Continue useful work.** Try compatible alternatives within the existing physical-attempt and time bounds. Missing optional advice means the ordinary workflow continues, not that workers stop or verification disappears.
- A truncated provider stream may use an alternate route only when the resolved controller authorization explicitly says `observe` and `effectCapable: false`. Caller prose is insufficient. Existing attempt, budget and cancellation gates remain; ambiguous effects and unknown authority are not replayed.
- **Recover automatically.** Every temporary exclusion has a finite retry condition. When it becomes due, permit a bounded probe on demand; successful real use restores eligibility. Repeated metadata failures cannot slide the probe deadline forever.
- **Do not confuse discovery with execution.** A working model-list endpoint does not prove that inference quota has returned. Preserve that distinction across registry refresh/reload. Conversely, a broken listing endpoint must not prevent a due inference probe forever.
- **Keep useful evidence.** Do not overwrite a real `Retry-After` with a longer default merely because another layer reports the same failure without the header. Retain verified/cached results whose input/version/consent binding remains valid.
- **Make recovery visible.** Report why a resource is unavailable, its next eligible retry where known, and whether recovery is only probe-eligible rather than proven healthy.

## Cost, lifecycle and evidence boundaries

Cold qualification adds up to two provider turns and one isolated child per eligible exact route/effort. Checks run at bounded concurrency two; same-route/effort requests with the same freshness contract share one check. A fresh admission cannot join a cache-eligible inventory request. Last-waiter cancellation and shutdown cancel underlying checks. A check has a 120-second safety deadline. The input critical path and `before_agent_start` only project cached, expiry-aware evidence; they never await controller startup, catalog refresh or qualification/inference. After visible user `message_start`, a deferred background pass refreshes provider state and prepares eligible routes. It is single-flight, rate-limited to one pass per 30 seconds, has a 180-second deadline and is cancelled with its incarnation on shutdown. An empty prompt cache is not an availability verdict: explicit `delegate_inventory`/`delegate_plan` and actual launch perform the required checks on demand. Unknown/timed-out routes remain outside the ready roster. No background periodic inference loop is installed. Stable conformance is reused only while its binding is unchanged; a configured adapter without a binding fingerprint must repeat the full canary.

The synthetic canary proves the observe-mode child/tool/report path, not arbitrary image/effect behavior, sufficient quota for a long job, or correctness of a future answer. Those contracts still need their own capability, authorization and acceptance checks. Availability may change immediately after a successful check; bounded recovery remains necessary. These checks are technical readiness evidence, never routing-quality training or acceptance of the owner's work.

A missing terminal report is reported as a collection artifact failure, not indefinitely as “not ready yet.” Background reports retain the controller's `accepted`/`rejected` verification status and receipt rather than using execution `completed` as if it meant verification. Queuing a parent wake is not acknowledgement; a failed queued delivery remains eligible for the genuine-owner fallback.

## Shared controller state and isolated diagnostics

Namespaced dynamic supervisors share capacity/health but merge local registry additions without withdrawing resources absent from their own local view. One Pi process can have fewer registered providers than another; its empty/narrow catalog is not global withdrawal authority. Selection remains constrained to each controller's current local catalog and exact allowed-resource list. Authoritative single-controller brokers retain normal withdrawal/drain behavior. Shared historical rows are not a ready roster and do not bypass current authorization.

For fresh-process diagnostics, set `PI_DELEGATION_BROKER_STATE_DIR` to an absolute owner-only temporary directory. This isolates registry/leases/jobs/reports from active sessions while using parent-owned provider authentication. Diagnostic capacity accounting is separate from the production fleet, so keep live checks deliberately small; it is not proof of production concurrent quota headroom. Never narrow a diagnostic registry against the user's production DB, restart an unrelated session or treat a fresh-process result as proof an already-running process has loaded new code.

## Boundaries that availability never overrides

Explicit owner off, missing export consent, credential scope, model/quality requirements, pinned routes, capability permissions, accepted verification rules and declared budgets are not temporary outages. Recovery must not bypass them, lower the required quality or silently use an unapproved paid service. Missing credentials cannot be fabricated.

A recovered resource is a candidate for remaining/new authorized work. This does **not** revive cancelled/expired/terminal jobs, repeat ambiguous external effects, guarantee a preferred route will be chosen, or justify unbounded retries. If no suitable route is available within the task's bounds, report the limitation honestly; the parent can continue independent work or choose a new plan.

## Stops and restarts are not free retries

Generic aborts and typed behavioral/heartbeat failures are not provider-health evidence. A no-progress guard remains terminal for that run; changing accounts must not replay its stop decision.

Controller allowances intersect with explicit/legacy child ceilings. Gracefully paused workflows charge returned output before saving state; observed overshoot remains recorded. A bounded root with unavailable usage cannot dispatch more work. Capped standalone tasks and legacy-capped nodes interrupted after admission fail rather than replenish their allowance. Cold recovery also refuses in-flight capped work whose remaining usage is unknown. This is deliberately conservative, not a claim that zero tokens were used.

New metered tasks retain physical-attempt counts across restart; old interrupted tasks without that accounting cannot silently obtain a fresh attempt budget. New workflow initialization writes both policy markers; old durable jobs keep their original limits.

## Current mechanisms and executable checks

| Path | Recovery mechanism | Regression evidence |
|---|---|---|
| Automatic preparation outside Enter | Visible-message-triggered deferred single-flight preparation, rate limit/deadline/shutdown fencing; no idle inference polling | `test/background-readiness.test.mjs`, `test/live-readiness-parent.test.mjs` |
| First-use tool readiness and every-launch gate | Cold isolated canary, exact binding/expiry, short fresh availability, fail-closed qualified roster | `test/route-qualification.test.mjs`, `test/readiness-regressions.test.mjs`, fresh-host inventory/resolver tests |
| Multiple Pi controller catalogs | Namespaced merge preserves peer resources and observed health | `a second controller narrow catalog…` regression |
| Native OpenAI-compatible tool events | Legal empty initial argument chunks are no-ops within an open tool block; orphan/malformed events remain rejected | `test/pi-native-provider.test.ts` |
| Native account quota/auth/endpoint failure | Persisted group/resource health, bounded delay, one leased half-open probe; real success clears health | `test/broker.test.mjs`, `test/trusted-launch-resolver.test.mjs` |
| Repeated catalog failure | Initial quarantine remains bounded; repeated catalog observations cannot renew an already-unknown route's deadline | `repeated catalog outages…` tests include alternate-group work, automatic probe, successful reuse |
| Provider Retry-After | Controller IPC retains it; duplicate headerless reports retain the existing cooldown rather than imposing the default again | `test/ipc-stream.test.mjs`, `duplicate rate-limit reports…` in broker tests |
| Normalized provider quota/context failure | Closed proxy error vocabulary reaches runner classification; quota tries an eligible alternate, context requests a suitable larger-context route | `test/brokered-runner-failover.test.mjs` |
| Replenishable credits without reset hint | Account-scoped unknown state uses the registry's half-open probe interval, not an invented multi-hour reset forecast | Runner quota tests + broker unknown-route recovery tests |
| Catalog/auth changes and pool resets | Refresh exact provider state before launch; periodic catalog observation; expired/stale optional pool-pressure evidence no longer excludes routes | Existing provider watcher, selector, pool-state and resolver tests |
| Optional Jev | Baseline immediately; bounded demand-driven exponential backoff; usable exact-input cache; success resets failure history | `test/jev-advisor.test.mjs`, six fresh-Pi scenarios in `test/jev-native-host.test.mjs`; details in [JEV.md](JEV.md) |

These checks establish deterministic recovery and integration behavior, not fleet-wide live provider reliability or improved owner-task success rates. Tests use isolated/scripted providers; they do not spend live Jev quota. Changes must preserve unrelated working-tree work and must not implicitly restart the user's active Pi process.
