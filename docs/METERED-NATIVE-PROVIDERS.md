# Metered native providers: integrating vendor pay-per-token APIs

Status: **proposal for review** (2026-09-11). Decision owner: user. First instance: DeepSeek.
Scope: `pi-delegation-broker` (admission policy, quality, currency) and `pi-multi-account`
(labels, priority, spend posture). No new credential machinery required.

## Implementation status

- **Increment 1 — done and verified (2026-09-11).** Provenance class `metered_native`
  (replaces the OpenAI-only `direct_api`; vendor map `FIRST_PARTY_DIRECT_APIS`), tier-guarded
  default admission (cheap/standard auto; frontier explicit), vendor-advertised freshness for
  metered routes, `metered_native` quality fallback. `MODEL_POLICY_VERSION` → v2.
  `npm run release:check` green (591 tests, 0 fail). Live-data check: `deepseek/deepseek-flash`
  eligible at cheap/standard, excluded at frontier; retired ids deprecated.
- **Increment 2 — done and verified (2026-09-11).** Alias-canonicalization probe
  (`probeServedModel`, OpenAI-format served `model` field) wired into the extension for
  `metered_native` providers only, bounded (cap 8) and on a 30-min cadence; alias facts are
  persisted in the currency cache (`servedModelsFromCache`). A live probe of `deepseek-v4-flash`
  returns served `deepseek-flash` → the requested id is demoted `deprecated` with no table.
  Live check: `deepseek-flash`/`deepseek-v4-pro` current and eligible; `deepseek-v4-flash`
  alias-demoted. 595 tests, 0 fail; `release:check` green.
- **Deferred (cosmetic).** `pi-multi-account` grouping/priority labels; metered cost status in
  `delegation-inventory` (currently `unavailable` for `native_metered`).

## Problem

Both extensions were designed subscription-first. Their routing language conflates two
different questions into one:

1. **Provenance** — who provided the model: the original vendor, a subscription bundle, or a
   reseller/aggregator.
2. **Billing** — how a call is paid for: a subscription quota (flat) or metered money
   (pay-per-token).

Because the policy encoded "native = subscription", a vendor's own direct API without a
subscription falls out of every native path. In `src/model-provenance-policy.mjs`,
`providerClassFor("deepseek")` returns `"unknown"`, so `evaluateRouteEligibility` rejects it
with `provider_not_subscription_native_default` + `route_not_native_subscription_pool`. In
`pi-multi-account` it lands in `unmanagedRotationMembers()` — "Other providers (no quota
tracking)" — a blind last resort beside aggregators.

The live evidence (2026-09-11 broker inventory):

```
deepseek/deepseek-flash   excluded: freshness_previous,
    provider_not_subscription_native_default, route_not_native_subscription_pool
deepseek/deepseek-v4-flash, -vision-exp   freshness_deprecated   (correct: retired ids)
```

So the model is already available and registered; only the admission policy keeps it out.

## Reframe: two orthogonal axes

| Provenance \ Billing | Subscription quota | Metered (pay-per-token) |
|---|---|---|
| **Vendor (native)** | anthropic, openai-codex, kimi-coding, qiniu | **DeepSeek** ← the empty cell |
| **Reseller** | cursor (mixed) | openrouter, ollama-cloud, opencode-go-api |

DeepSeek belongs in the empty cell — native *and* metered. It is neither a subscription
account nor "some other provider".

## Decision (option A, conservative spend guard)

- **Native routes are default-eligible**, whether subscription-backed or metered.
- **Aggregators remain explicit-only** (unchanged).
- **Metered native is conservatively gated by tier**: `cheap` and `standard` route
  automatically; `frontier` and `apex` require explicit admission
  (`explicitlyAllowed` / a `model-preferences.json` entry). Rationale: the cheap flash model
  is the whole point and costs cents; a metered frontier model is real money the user should
  opt into.

This makes "native from the original vendor" the default for both billing pools, which is the
rule the user stated, while keeping a spend safety valve that does not depend on the user
knowing which model id is cheap.

## New class

Introduce `providerClass: "metered_native"` (replacing the OpenAI-only `direct_api` special
case). Provenance gains a vendor map instead of a hardcoded comparison:

```js
const FIRST_PARTY_DIRECT_API = Object.freeze({
  deepseek: "deepseek",
  openai: "openai",
  // add a vendor only where it sells direct pay-per-token tokens
});
```

`deriveModelProvenance()` then computes, for `metered_native`:
- `nativeToRoute = modelDeveloper === FIRST_PARTY_DIRECT_API[baseProvider]`
- `billingPool = "metered_native"`

`MODEL_POLICY_VERSION` bumps to `subscription-and-metered-native-current-only/v2`. Note: this
re-keys `modelPolicyGeneration(preferences)`, so signed-registry/discovery caches and learned
affinities keyed on the old generation are invalidated — expected, but must be released
deliberately.

## Concrete changes

### 1. `src/model-provenance-policy.mjs`
- Add `FIRST_PARTY_DIRECT_API`; `providerClassFor()` returns `metered_native` for its bases.
- `evaluateRouteEligibility()`: admit `first_party_subscription`, `mixed_subscription` **and**
  `metered_native`. For `metered_native`, require `nativeToRoute === true` and
  `requestedTier ∈ {cheap, standard}` unless `explicitlyAllowed`.
- New reason codes: `route_not_vendor_native_metered`, `metered_tier_requires_explicit_admission`.
- Keep freshness as a hard gate (`current` only).

### 2. `src/model-quality-catalog.mjs`
- **Implemented dynamically, no per-model table.** A `metered_native` provider returns
  `standard` for every model it advertises, so "all of this vendor's models" work without a
  hardcoded list. Promotion to `frontier`/`apex` still requires a researched rule; a metered
  model is never auto-promoted. (The vendor-advertised freshness rule is what makes a
  generation-1 model like `deepseek-flash` current.)

### 3. Currency / freshness — dynamic-first (`src/provider-probe.mjs`)

The current module derives `generation` primarily from the model id's version number and uses
the live listing only to *demote* (`assignGenerations`: `unversioned ranks below versioned`).
That inverts authority and misranks DeepSeek, whose newest id `deepseek-flash` is unversioned
while its retired predecessors carry `v4` — so the current flagship is marked `previous`
(`freshness_previous`) and blocked by the hard `freshness === "current"` gate.

Live-first ordering (replaces version-first):

1. **The vendor's own `/models` is the authoritative current lineup for a `metered_native`
   provider.** What the vendor still sells is current. Advertised, and not an alias of another
   id ⇒ `generation 0`.
2. **Alias canonicalization (new probe).** On the OpenAI-format `/chat/completions`, the
   response `model` field names the model that actually served the request. `requested ≠
   served` ⇒ the requested id is a retired alias of `served`, not an independent model.
   Verified 2026-09-11: `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-chat`,
   `deepseek-reasoner` → served `deepseek-flash`. The Anthropic-format
   `/anthropic/v1/messages` echoes the *requested* id, so this probe must use the OpenAI format.
3. **`created` timestamps** where the vendor supplies them (DeepSeek does not; most do).
4. **`system_fingerprint`** — per-build drift detector (flash `aeb56401…`, v4-pro `a307abda…`,
   stable across calls).
5. **id-version heuristic — fallback only**, when no live signal can decide. Aggregators keep
   it (they accumulate stale ids by design); it is nowhere the primary authority.

Consequences:
- `deepseek-flash` → `current` (generation 0), because the vendor advertises it.
- `deepseek-v4-flash`, `-vision-exp` → legacy: unlisted and/or resolving to another id.
- **Self-healing**: when the vendor starts routing `deepseek-v4-pro` to V4.1 Flash (announced
  2026-09-14), the canonicalization probe observes `v4-pro` served as `deepseek-flash` and
  demotes it — no code change, no table to maintain.
- No curated table. The lineup comes from live data only.

Cost telemetry: `GET /user/balance` returns a live money balance
(`{"total_balance":"8.96","currency":"USD"}`, verified 2026-09-11), so a metered route can be
shown as real spend instead of `subscription_no_request_price`.

### 4. `pi-multi-account` (`index.ts`)
- Replace the conflated `unmanagedRotationMembers()` grouping with three named groups:
  **subscription accounts**, **metered native providers**, **aggregators/other**. DeepSeek
  moves from the third to the second.
- Surface in `/multi-account status`:
  `Metered native providers (pay per token): deepseek` — distinct from
  `Other providers (no quota tracking)`.
- Placement via existing `providerPriority`/`providerOrder`: metered native defaults **after
  subscription accounts, before aggregators**; user-overridable so cheap work can be sent to
  DeepSeek to preserve subscription quota.
- One spend switch, not a model allowlist: `meteredNativeSpend: "cheap_standard" | "off" | "all"`,
  default `cheap_standard` (mirrors the broker guard).
- No new family/slot machinery: the unit is `(provider, model)`, not `(provider, account)`.
  DeepSeek has no quota bucket, no OAuth, no usage endpoint; forcing `deepseek-account-N` would
  present a fake "account".

### 5. Delegation broker surface
- `delegate`/`delegate_workflow` tool description and the inventory already carry per-resource
  `cost`; mark metered-native routes distinctly (tier + money) so the parent can see a route
  costs money rather than quota headroom.
- Where the provider exposes it, read live spend (`GET /user/balance` for DeepSeek) so the
  money figure is observed, not modeled.
- `docs/INTEGRATION.md` and the L1 policy note: "native = vendor's own API; subscription and
  metered direct APIs are both native; aggregators are explicit-only".

## Child usability (already satisfied)

`src/scoped-child-auth.mjs` `credentialForIsolatedChild()` returns an `api_key` credential
verbatim for non-proxy-backed providers. DeepSeek is `type: api_key`, base `deepseek`, not
loopback-backed, so an isolated child receives `{type:"api_key", key:"sk-…"}` plus the scoped
`models-store.json`/`models.json` — it can call `api.deepseek.com` directly. No proxy route is
needed (unlike Cursor/Kimi OAuth slots). This must still be proven live, not assumed.

## Verification

1. `release:check` passes (`tsc --noEmit`, `node --test`).
2. Unit: `providerClassFor("deepseek-account-2")` style ids and base `deepseek` → `metered_native`;
   eligibility admits `deepseek-flash` at `standard`, denies at `frontier`, admits at `frontier`
   when `explicitlyAllowed`.
3. Inventory: `deepseek/deepseek-flash` state becomes `available` (or cooling only on a real
   429), no longer `provider_not_subscription_native_default`.
4. Currency: `deepseek-flash` freshness `current`; retired ids `deprecated`; an injected
   canonicalization probe (`deepseek-v4-flash` → served `deepseek-flash`) demotes the alias
   without any curated table.
5. Live bounded canary: one `delegate` at `standard` under option A actually reaches
   `deepseek/deepseek-flash` through an isolated child and returns a report; verify the child
   `auth.json` held only the deepseek key.
6. Negative: an aggregator deepseek route (ollama `deepseek-v4-flash:cloud`) stays excluded
   without an explicit allowlist.

## Risks

- **Silent spend.** Mitigated by the tier guard (frontier/apex explicit) and by surfacing cost;
  not eliminated. The user's default posture is deliberate.
- **Policy-version bump** invalidates generation-keyed caches/affinity — release intentionally.
- **Quality claim.** Tiering `deepseek-flash` as `standard` is a conservative research decision;
  promoting it to `frontier` needs evidence, not vendor marketing.
- **Advertised-set trust.** Treating the vendor's `/models` as the current lineup assumes the
  vendor does not accumulate dead ids (OpenAI historically does). Scoped to `metered_native`
  and backed by alias canonicalization, this is correct for DeepSeek today; if a first-party
  direct API later advertises stale ids, the alias probe plus version fallback still demote
  them, and the scope is one class rather than global.
- **Probe cost.** Alias canonicalization issues a 1-token request per candidate id that is not
  advertised; bounded to non-advertised candidates only.
- **Vendor id churn** is handled by the live signals above, not by a table:
  `deepseek-v4-flash`/`-vision-exp` are demoted by listing/alias, and `deepseek-v4-pro` is
  demoted automatically once the vendor reroutes it (2026-09-14). `system_fingerprint`
  (flash `aeb56401…`, v4-pro `a307abda…`) remains the build-drift detector.
