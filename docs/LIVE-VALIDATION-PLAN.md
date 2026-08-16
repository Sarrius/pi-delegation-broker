# Owner-gated live validation plan

**Status:** pre-registered procedure only. This repository has made no live provider request and this document is not approval to make one.

## Preconditions

All conditions must be true before the controller constructs `createApprovedAnthropicProviderRoute` with a non-test credential:

1. A reviewed first-party trusted launcher API (or accepted upstream replacement for the local patch) proves final behavioral-hook attestation. Effect-capable contracts remain denied until then.
2. A signed registry identifies the one approved resource/profile/capacity group. The route table maps that same resource to one account/model/endpoint and opaque credential reference; its route-table fingerprint is recorded.
3. The API key is injected into `ControllerCredentialStore` by the owner process only. It must not appear in config, environment, Pi child config, prompt, logs, evidence, registry or CLI arguments.
4. The owner supplies a one-request `ControllerLiveProviderApproval` expiring within the pre-registered window. The controller records approval ID, route-table fingerprint and wall-clock bounds without recording a secret.
5. The task is non-effectful/read-only, bounded by a lease, controller budget, known prompt digest, fixed verifier plan and a named recovery owner/deadline.

## Adversarial gate sequence

Run one physical attempt per case; never re-run a case through another account/model automatically.

| Case | Required result | Automatic follow-up |
|---|---|---|
| credential ref miss while unrelated ambient secret exists | no dispatch; `credential_unavailable` | deny/escalate |
| aborted before dispatch | `cancelled_before_send`; no dispatch | controller may decide new attempt |
| transport loss after send | `cancelled_after_send` or ambiguous provider terminal | no retry; reconcile/escalate |
| provider 429 with Retry-After | one dispatch; `rate_limited`; exact capacity-group cooldown | no automatic failover |
| quota/auth terminal | one dispatch; exact resource becomes unknown | deny/pause |
| malformed/truncated SSE | no success terminal; controller evidence retains failure | no retry after send |
| valid simple read-only completion | one dispatch; independent fixed verifier accepts; task becomes completed | record verifier-bound routing observation |

For every case retain redacted controller evidence of route snapshot fingerprints, dispatch count, normalized terminal, broker ledger transition, and verifier result. Do not use child status or provider text as acceptance evidence.

## Paired Pi utility experiment

Only after the valid controller-owned arm above completes, pre-register a paired Pi experiment. Each pair uses the same read-only task, model/reasoning setting, fixed acceptance verifier, token/cost/latency budget and one physical attempt per arm:

- **A:** isolated Pi child through the approved controller route.
- **B:** baseline Pi configuration, with the same model/task and independently retained acceptance evidence.

Report accepted outcomes, dispatch count, wall time, usage/cost, terminal taxonomy and confidence intervals; do not claim a rate from one pair. A Claude Code arm is outside this plan and remains deferred until A is a valid executable live arm.
