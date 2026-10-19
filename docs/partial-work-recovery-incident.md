# Partial work recovery incident — 2026-09-10

Owner requirement: every terminal outcome must make all captured work recoverable. Failure, cancellation and timeout are not permission to discard artifacts. Partial/unverified work must never be promoted to accepted completion.

## Reproduced evidence

Task `delegate-mtv6mu6r-67cecb24b15d5a91-6` reached deadline; collect returned only `task deadline expired`. Its retained child JSONL contains 88 entries: session/model/thinking/user setup, 10 assistant messages and 74 tool results. Assistant messages contain tool calls, with a final aborted empty message; there is no completed prose answer to recover. The journal nevertheless is real partial work and must be discoverable through collection.

`extensions/pi-delegation-broker.ts` currently:
- `preserveArtifact` ignores every result whose status is not completed.
- `persistDelegationReport` stores text only for completed results.
- `settleTaskWithoutChildResult` emits a synthetic failure without retained-session references.
- `delegate_feedback` requires a history route; deadline settlement above can skip route persistence altogether. Thus observed feedback rejection is not yet evidence of broken session identity across failover.

## Acceptance before returning to Dialer

1. Recoverable owner-bound attempt artifacts/transcript references for success/failure/timeout/cancellation, including no-final-answer runs and prior failover attempts.
2. Capture partial public output during execution so process termination cannot erase already received output; separate raw retained evidence from bounded collection preview. Preserve credential redaction and exclude hidden reasoning from preview.
3. Terminal state reflects controller cancellation/deadline even if useful child work exists; no false acceptance, no automatic resume from unverified artifacts.
4. Feedback accepts authorized settled jobs even if route telemetry is missing, without widening cross-session authority or training verified quality from parent opinion.
5. Runtime tests: partial text + tool result then abort/crash/deadline, completed-then-cancel race, no-result dispatch failure, restart collection, inaccessible/symlink/malformed evidence, cross-owner denial. Existing reports can expose retained evidence without rewriting historical outcome.
6. Full check/test/release gates, fresh-process forced interruption canary and evidence recovery of the actual incident. Do not claim current running extension adopted on-disk edits without proving it.

Implemented WIP: failed results retain bounded text; timeout/cancel persist route/result before settling as failed; owner-bound collection discovers retained JSONL pointers including historical incident journals; feedback permits an owner-bound terminal job when telemetry is missing. Public streaming text has an attempt-unique fsynced journal registered at child RPC launch, excluding reasoning and arbitrary event metadata. Fresh Node process SIGKILL test proves persistence without message_end. Full release check passes 587 tests (579 pass, 8 skipped), package/install checks pass. Follow-up verification: fresh-process extension probes now prove recovered cancellation → automatic wake → collect with raw journal pointers and failed status, direct foreign-report denial without marking it read, and failed/deadline-job feedback without any broker runtime startup. The feedback test first failed because the handler unnecessarily tried starting a Unix-socket broker; it now uses only the durable history store. A separate runner test proves a throwing isolated child retains its patch before worktree cleanup and never mutates the source repo. All retry attempt directories are discoverable. Capturing patches fails closed by retaining the original worktree. Cancellation/deadline removes any completed verification marker from the failed terminal result.

Final release check: 588 tests, 580 pass, 8 skipped, package and clean fresh Pi activation pass. Actual incident recovery returns the existing 377833-byte session journal; no prose answer existed. Evidence logs: `/tmp/broker-final-recovery.log`, `/tmp/broker-recovery-e2e.log`. Deterministic forced-interruption tests do not establish real-provider reliability statistics. Existing running Pi processes still hold old modules: `/reload` or a new Pi process is required for their tool definitions to adopt these changes; no unsafe self-restart was attempted. Source package install/activation is verified in a fresh process.

Existing unrelated dirty provider/runner/IPC work is preserved. Parent performs tightly coupled harness repair directly; no child is asked to repair its own controller.
