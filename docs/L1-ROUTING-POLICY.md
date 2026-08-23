# L1 routing policy: when the parent delegates, and to whom

> **Superseded operationally on 2026-08-23.** The historical decision below explains why
> delegation guidance lives in tool text, but its model-pool and synchronous-workflow claims
> no longer describe the implementation. Current behavior is:
>
> - `delegate_workflow` is parent-free by default and returns a durable job id;
> - status/list/collect/cancel form the lifecycle API;
> - automatic routing is current-only and subscription-native;
> - Cursor Grok/Composer is its native billing pool; Cursor third-party models are explicit-only;
> - aggregators are explicit user allowlists; an unavailable pool denies rather than broad auto;
> - provider/account health and receipt-backed learning rank only inside the hard eligible set.
>
> Canonical design and evidence: `~/.pi/research/delegation-doctrine/async-native-routing-research/REPORT.md`.

Status: **historical rationale; implementation claims below are preserved for provenance.**
The tool-description policy is already on `delegate` / `delegate_workflow`. Execution-layer
fixes from this document landed. Live proof 2026-08-20:

- `one(frontier)` canary `delegate-mt15ffdl-1` reached completed on `cursor/cursor-grok-4.6-high`
  without killing the parent session.
- `team` canary `workflow-mt166q44-1` ran two frontier nodes in parallel. Cursor took one slot;
  the teammate failed over (zai rate-limit → two ChatGPT Codex accounts that cannot run
  `gpt-5.6-sol` → `openai-codex-account-4`) and returned `# Changelog`.
- The Cursor node then lied: it declared `mcp_pi_read`, burned the 30s capability snapshot,
  got `unauthorized` because heartbeat extended only the lease row, settled with empty text,
  and the runner recorded `completed`. That is fixed in the working tree (needs Pi restart).

## Problem

The broker already provides an execution plane: leases, scoped credentials, isolated
children, capability classes, controller-owned verification, and a `delegate` /
`delegate_workflow` tool pair. What it does not provide — and what was observed missing in
practice — is a **routing policy** on the parent (L1) agent: a per-task decision between

- `self` — do the work in this session;
- `one(tier)` — delegate one self-contained subtask to a child at cheap / standard /
  frontier quality;
- `team` — decompose into independent branches via `delegate_workflow`.

Observed symptom (2026-08-19): over a full working day the L1 agent never called
`delegate`, although the broker was enabled (`enabled.json`, live socket, 482 resources in
the signed registry). The day's tasks were parent-harness edits — correctly not
self-contained — so the agent followed the existing policy faithfully and the broker stayed
idle. The instrument existed; the policy did not tell the agent to reach for it.

## Facts this design is based on

Code-level, verified in the working tree (not inferred):

1. `src/model-selector.mjs` is implemented (not a stub): capability classes, downward
   substitution forbidden, upward substitution mandatory, learned affinity ranking,
   controller-only and side-effect free.
2. `src/model-preferences.mjs` `taskModelTier()` derives cheap/standard/frontier from the
   task description automatically; explicit tier overrides win.
3. `src/model-quality-catalog.mjs` holds a researched frontier/standard/cheap table for all
   live providers (kimi, glm, minimax, deepseek, gpt, claude, grok, across
   ollama/opencode/openrouter).
4. `preferences.json` `tiers.standard` / `tiers.cheap` are **user-curated overrides**, not
   inventory. Empty arrays mean "controller auto mode", not "no such class exists".
5. The `delegate` tool's `description`/`promptSnippet` in `extensions/pi-delegation-broker.ts`
   already carries a when/when-not policy — but it covers self-containment only, not
   cardinality (self vs one vs team) and not tier choice.
6. `delegate_workflow` (durable DAG) exists: a "team" of children is already buildable.
7. Live state gaps: `grok-4.6` is pinned `via: openrouter` while the live fleet is Cursor;
   two test tasks from 2026-08-18 ended `no compatible broker capacity` /
   `task_state_awaiting_result` against an exhausted fleet and escalated by deadline as
   designed — artifacts of capacity, not design defects.
8. No utility benchmark exists: no recorded run of a real task reaching
   `TaskTerminal(completed, source=controller_verifier)` from routine use (only the E2E
   acceptance test from the build phase).

## Decision

**Policy lives in the tool description; execution stays in the broker; liveness is proven
by a canary — in that order, and nothing else yet.**

The L1 routing decision is a judgement call about user intent and conversation context.
Only the model holds that context, so the policy must sit where the model is guaranteed to
read it on every turn: the `delegate` tool's own `description` / `promptSnippet`. Skills are
recall-based (the model must remember to load them); a tool description is presence-based
(it is always in the tool list). Today that channel worked exactly as designed — it simply
had no cardinality content.

The broker deliberately does **not** gain a scheduler or a `plan_work` module:

- "Does this subtask need the conversation's context?" is unanswerable by deterministic
  code; pushing it into the broker would create a second, worse channel for the same
  decision (harness coupling).
- The README states a complete controller scheduler is out of scope for the reference
  implementation. The routing decision is the parent session's scheduler.

### The policy content to add to the tool description

A compact routing table the model applies before writing code itself:

| Route | When |
|---|---|
| `self` | Needs this conversation's context, edits the parent harness (multi-account, broker src), or requires judging the user's intent |
| `one(cheap)` | Self-contained: read/summarize/grep/draft; no code reasoning needed |
| `one(standard)` | Self-contained code reasoning at non-frontier difficulty |
| `one(frontier)` | Self-contained, hard, or effect-capable (`proposeChangesIn`) |
| `team` | 2+ independent branches → `delegate_workflow` |

Plus one forcing question: *"Before doing work myself — is this self-contained? If yes,
delegate; if no, be able to say why."* Self remains a valid, first-class route; the table
exists so it is a decision, not a default.

### Execution-layer fixes (broker side, no new architecture)

1. `preferences.json`: add `grok-4.6` `via: cursor` (and `cursor-account-*`) — the live
   fleet is not covered by the current pin.
2. Canary: one read-only `delegate` run driven to `TaskTerminal(completed)` or a concrete
   denial reason. On denial, diagnose via the broker SQLite event journal per
   `diagnose-live-brokered-routing`.
3. Workflow canary: one `delegate_workflow` with two independent read-only nodes.

### Explicitly out of scope (now)

- A `plan_work` tool/module, task auto-classification inside the broker, a new skill,
  changes to `model-selector.mjs`, any multi-account work, enforcement hooks.
- Enforcement (a pre-turn hook demanding a routing decision) is justified **only** if the
  text policy measurably fails: if after this change a week of sessions shows no
  `delegate` calls on self-contained tasks, revisit with that evidence.

## Why not the alternatives

- **New skill (`l1-orchestrate`)**: skills load on recall; the failure mode is precisely
  that the model never recalls. Tool description is always present.
- **Broker-side `plan_work`**: mixes the decision layer into the execution layer and asks
  deterministic code to judge conversation context it cannot see.
- **Fill `standard`/`cheap` user tiers**: they are overrides with auto fallback, not
  inventory; filling them adds pinning where the quality catalog already ranks correctly.
  User tiers stay user-owned.

## Verification

1. Canary run reaches `TaskTerminal(completed, source=controller_verifier)`; zero live
   leases after; affinity journal records the accepted route.
2. `delegate_workflow` canary completes both nodes.
3. Tool text change: schema intact, `promptSnippet` within length limits, broker tests
   (`npm test`, `npm run release:check`) green.
4. Behavioural evidence (the actual acceptance criterion): on the next self-contained
   subtask, the L1 agent delegates it and names the chosen route and tier in one line.
   Absence of that line is the failure signal for the "out of scope" enforcement step.

## Risk

Prompt-level policy is advice, not enforcement: the model may still not delegate. That is
accepted deliberately — the alternative (building enforcement before proving text
insufficient) is the "another safety layer without liveness" anti-pattern. The mitigation
is the recorded verification criterion above: if the line doesn't appear, that is the
evidence that justifies enforcement, and not before.
