# Owner-gated live validation plan

**Status:** pre-registered procedure with owner-authorized canary evidence. The Anthropic subscription arm was rejected by Anthropic's extra-usage policy; the Cursor subscription arm completed successfully through the controller proxy. A separate fresh-process native Cursor tool canary completed a credentialless read and isolated patch/test flow. This document is not standing approval for future requests.

## Preconditions

All conditions must be true before the controller constructs any approved provider route with a non-test credential:

1. A reviewed first-party trusted launcher API (or accepted upstream replacement for the local patch) proves final behavioral-hook attestation. Effect-capable contracts remain denied until then.
2. A signed registry identifies the one approved resource/profile/capacity group. The route table maps that same resource to one account/model/endpoint and opaque credential reference; its route-table fingerprint is recorded.
3. The exact provider credential is injected into `ControllerCredentialStore` by the owner process only: either an API key or the current OAuth access token. It must not appear in config, environment, Pi child config, prompt, logs, evidence, registry or CLI arguments; OAuth refresh tokens are never forwarded.
4. The owner supplies a one-request `ControllerLiveProviderApproval` expiring within the pre-registered window. The controller records approval ID, route-table fingerprint and wall-clock bounds without recording a secret.
5. The standing live task is non-effectful/read-only, bounded by a lease, controller budget, known prompt digest, fixed verifier plan and a named recovery owner/deadline. Effect-capable canaries are a separate owner-authorized experiment and require the source-pinned behavioral launch gate plus isolated worktree verification.

The credentialless Pi-child canary harnesses are `test/live-controller-proxy-child.test.mjs` (Anthropic Messages) and `test/live-cursor-controller-proxy-child.test.mjs` (Cursor's OpenAI-compatible loopback bridge). The tool-capable native experiment must load `pi-multi-account` in the fresh parent and inject its `controllerProvider` pair; the older hand-built OpenAI/Anthropic adapters remain text-only. Both remain skipped unless the owner explicitly sets `LIVE_PROVIDER_TEST=1`, `LIVE_PROXY_CANARY_APPROVED=1`, and `LIVE_CONTROLLER_CREDENTIAL_FILE` to an existing owner-only file. The file may contain a raw API key, a single credential JSON object (`{"type":"oauth","access":"..."}` or `{"type":"api_key","key":"..."}`), or the owner-only Pi `auth.json`; for the latter, `LIVE_CONTROLLER_CREDENTIAL_PROVIDER` selects the exact provider. Only the selected access/key value is injected into the in-memory `ControllerCredentialStore`; it is never passed to the child, route config, CLI arguments, or evidence. Anthropic OAuth requests use Bearer auth plus Claude Code identity headers, including `oauth-2025-04-20`; Cursor OAuth is sent as Bearer auth to the owner-run loopback bridge; refresh tokens are ignored. `LIVE_ANTHROPIC_MODEL`/`LIVE_CURSOR_MODEL` select the model, while `LIVE_ANTHROPIC_ENDPOINT`/`LIVE_CURSOR_ENDPOINT` select the exact endpoint. The Cursor endpoint must be an owner-run loopback adapter. These harnesses remain prohibited until preconditions 1–5 are independently approved for each new run.

## Completed native tool-capable evidence

An owner-authorized fresh parent process loaded `pi-multi-account`, injected its native `controllerProvider` pair, and ran the broker against a temporary Git project on the exact registered Cursor route `cursor/claude-4-sonnet`. A credentialless child completed a local `read` turn. A second effect-capable child used only the attested `propose_patch` tool in a disposable worktree; the controller independently applied the returned patch and its fixed `npm-test` check passed. The native child tool set included only the requested/local tools plus controller gate tools, the result was `NATIVE_PATCH_TOOL_OK`, and the broker ended with zero leases. This is bounded path evidence, not standing approval: the parent-run Cursor bridge must remain available, legacy direct-auth paths remain disallowed for live coding, and unattended supervision is outside this plan.

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

Only after the valid controller-owned arm above completes, pre-register a paired Pi experiment. Each pair uses the same read-only task, model/reasoning setting, fixed acceptance verifier, input/output-token and latency budget, and one physical attempt per arm:

- **A:** isolated Pi child through the approved controller route.
- **B:** baseline Pi configuration, with the same model/task and independently retained acceptance evidence.

Report accepted outcomes, dispatch count, wall time, token usage, terminal taxonomy and confidence intervals; do not claim a rate from one pair. A Claude Code arm is outside this plan and remains deferred until A is a valid executable live arm.
