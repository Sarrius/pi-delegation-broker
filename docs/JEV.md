# Operational Jev engine in the Pi Delegation Broker

The installed extension has one new operational switch family: `/delegation-broker-jev status [7|30|90|365]|on|off|decisions-on|decisions-off|routing-on|routing-off`. **OFF is the baseline.** `on` enables both functions only after an interactive, separate disclosure/consent confirmation. `decisions-on` and `routing-on` enable one function after that same disclosure. `off` disables both immediately in the current process, aborts in-flight requests, and writes a disabled setting. The two narrower `*-off` commands disable only that function. Non-interactive enabling does nothing. If a write fails, OFF remains effective in this process but the persisted file must be inspected before restarting Pi. No automatic paid live canary is launched by installation.

The new owner-only `~/.pi/agent/delegation-broker/jev-engine.json` (schema version 1) controls this mode. Old `jev.json` and `jev-active.json` are **not** permission to start the engine. Legacy `shadow`, `routing-shadow`, and `active-on` command arguments do nothing in the product extension; `active-off` is a compatibility alias for `routing-off`. An absent, malformed or unconsented engine file fails closed. An API key alone is not consent. The key is obtained from `PI_JEV_API_KEY` in the *parent* environment; it is not stored in the engine file or passed to children. Do not put keys into task text or CLI arguments. After source changes, restart Pi to import the new ESM modules: `/reload` is not enough.

## Experimental Images / Box

`/delegation-broker-jev visual-on` separately approves image export and exposes
`delegate_visual({path, target})`; `visual-off` revokes it. Existing text approval
and ordinary `on` do not silently grant image consent. Master `off` disables all
features. An owner may stage `{ "schemaVersion": 1, "enabled": true,
"consentToSendImages": true }` in `jev-visual.json` beside an already approved engine
file: new runtimes use this overlay only when the engine file has no explicit visual
setting. This leaves already-running older strict config readers undisturbed.
Explicit engine visual settings take precedence; restart the owning Pi to load new
source modules. Staging consent alone cannot add a tool to an old running process.

The tool sends exactly one explicitly selected local image plus a target description
to TypeSafe, using pinned `jev-1.14.0` and `TypeSafe-Danger-Zone-Images: true`.
It does not capture screenshots, discover files, fetch URLs, click, or edit. PNG and
baseline JPEG are supported, at most 4 MiB, 280–1568 pixels per side. Animated PNG,
EXIF JPEG and other formats must be re-exported upright first. Structural local
validation is not a full image decoder; the API may still reject an invalid file.
There is no automatic resizing or orientation correction.

Every target gets both a Noul presence question and a Box question. A Box always
returns coordinates even for an absent target. The tool exposes usable normalized
coordinates only at presence >= 0.8 and box confidence >= 0.5; otherwise it returns
`not_detected` or `uncertain` without coordinates. These thresholds are operational,
not calibrated accuracy. Neither result grants tool authority or verifies completion.
Image contents may contain private information: select only images authorized for
external processing. No image bytes or target text are written to custom telemetry;
the normal Pi tool transcript still contains the caller's path/target arguments.

Visual calls share the advisor's session allowance, single-flight, cooldown and
revocation lifecycle. Text uses its existing model/timeout; visual requests have a
separate 10-second maximum timeout and a 6-MiB serialized-body bound. The response
stream remains bounded to 64 KB. Enabling never starts a paid probe automatically.
`advisor.requestsByPhase.visual` records requests; visual observations do not count
as applied action decisions or controller-verified quality.

Live synthetic probes on 2026-11-02: a real 400px PNG with a known red rectangle was
localized at left/right 0.24/0.76 and top/bottom 0.30/0.70 (expected 0.25/0.75 and
0.30/0.70). A second query for an absent blue circle returned presence 0.01 and no
usable box. These two calls prove bounded API compatibility, not accuracy rates.
A separate fresh-Pi test proves actual `delegate_visual` registration/tool dispatch
using isolated settings and a fake API; it is not a third live inference test.

Sources: https://docs.typesafe.ai/images.md,
https://docs.typesafe.ai/primitives/box.md, https://docs.typesafe.ai/primitives/noul.md.
The provider labels Images/Box experimental; the owner explicitly approved their use.

## What ON actually does

- **Decisions:** enables `delegate_decide`. For an explicit parent question, context and two to eight bounded parent-supplied actions, Jev returns exactly one action ID or `undecided`. The tool tells the agent to use that next action or identify a specific override. A selected `actionTool` can be correlated with a subsequent *successful tool result*; exposing a choice is not counted as execution. This tool cannot read the agent's unexpressed thoughts, perform actions, confer tool permission or verify task completion. An unavailable or undecided Jev leaves the ordinary parent plan unchanged.
- **Routing:** for a complete *read-only* `auto` route/effort launch with fresh controller-vetted same-quality candidates, Jev sees the bounded task and current candidate model identities **plus the same versioned research cards and aggregate controller-verified local outcomes available to the parent**. A valid model choice can constrain real pre-lease selection; an explicitly attested low auto-effort suggestion can apply only to the baseline model. This is not preview inference; `delegate_plan` makes no Jev call. The controller reselects, preflights, checks policy/capacity/consent and issues the lease. A cancellation, config revocation, changed candidate set, unsupported effort, busy route, invalid response or abstention uses the baseline, not a different authority. Effectful tasks, explicit model or effort, incomplete briefs and omitted role/skill/dependency framing are outside this mode. Existing children are not interrupted.

Both operations send the parent-supplied text **without automatic redaction** to `api.typesafe.ai` from the applicable parent working directory when explicitly approved for global scope (`all_cwds`). Routing exports eligible public model cards and aggregate controller-verified local outcome counts (model/cohort/effort, no task IDs), task class and policy metadata, not provider account slots, credentials, local cwd, journals, arbitrary files or full chat. Decisions export only the specified question/context/options. The local controller still enforces its permission, quality, privacy, request allowance, quota-aware selection, leases and independent verification. Jev `confidence` is not the probability a task is correct. Vendor positioning is a claim; third-party index scores are not Pi child success probabilities. Benchmark provider-level `none` is **not** Pi `off`; Pi `minimal` may map to `low` in Codex, and exact transport support is checked by preflight. No new metered OpenAI API route is enabled by Jev.

The parent can request `delegate_model_evidence` without Jev or inference. It returns *source-attributed, versioned* manufacturer claims, externally measured index-by-effort where available, verified local outcomes grouped by model/cohort/effort, explicit unknowns and current catalog eligibility. Numbered subscription accounts share a model card but remain distinct capacity routes. Cards older than 90 days retain archive provenance but their public suitability and benchmarks cease to drive Jev until refreshed. Unknown models do not inherit a similar name's measurements. Public source research and methodology live in the owner's `research/jev-engine-delivery-20260925/` artifacts; the npm package contains only the curated `src/model-criteria-v1.json`. Even verified narrow local results are not a cross-model comparative proof.

## Decision input contract

`delegate_decide` uses lowercase `snake_case` identifiers for `purpose` and option
IDs (1–40 characters, starting with a letter); IDs must be unique and `undecided`
is reserved. `actionTool` is the bare registered tool name, such as `read`, not
`functions.read`. Question, context and meanings must contain non-whitespace text.
The advertised schema exposes these lexical constraints. Invalid direct calls throw
a bounded explanation before any external request; they never silently lose action
accounting or echo the supplied context.

## Accounting and limitations

`status` (optionally `status 7`, `status 90` or `status 365`; 30 days by default) shows effective advisor availability, request/response counts by function, valid-response token usage, reported latency, choice/abstention/application/skip counts, OFF baseline handoffs and outcome joins where controller history is loaded. `jev-engine-events.jsonl` is owner-only append-only metadata: no raw task, child report, provider response, key or business rows. `routing-history.sqlite` provides separately authenticated controller acceptance/rejection and parent feedback; invalidated quality observations are excluded. If that ledger is not loaded, those status counts are **unknown**, not zero. A reported provider-response success, a handed child, a Jev answer, a parent-usefulness label, a signed controller receipt and verified completion of the original owner request are different facts. An answered decision with no observed action is not an applied decision. OFF does not call Jev; decisions the parent never asks about cannot be counted as opportunities. Missing or late outcomes must not be counted as failures or successes. Status windows of 7/30/90/365 days and a truncated-file warning do not purport to retain all history. Token counts cover valid Jev responses only: an HTTP failure may still have incurred charges, and no actual monetary spend is available. The per-session request allowance is a safety limit, **not** a billing ceiling.

Controller-verified results collected over time may inform the existing model affinity separately from these public priors; the prior/feedback split is deliberate. Read-only fixture tests and a short public route probe establish plumbing, not future quota or a causal quality/cost benefit. Independent comparative task sets with authentic receipts, balanced work and measured expenses are necessary before claiming improvement. Legacy advisory/shadow helpers remain importable for isolated tests, but the product no longer treats old advisory flags as operational consent.

## Verification

Run `npm run release:check` in the broker repository; it includes the full tests, privacy/public-tree gates, package manifest and clean installed-tarball activation. Focused regressions: `node --test test/jev-engine-settings.test.mjs test/jev-decision.test.mjs test/jev-engine-metrics.test.mjs test/model-criteria.test.mjs test/jev-active-routing.test.mjs test/jev-active-resolver.test.mjs test/jev-pi-advisory.test.mjs test/jev-native-host.test.mjs`. Fresh-Pi tests use fake local Jev/child transports and separate ephemeral consent files, never the owner's key or paid API. Do not label those tests live Jev quality evidence.
