# Task: Implement capability-aware model selection for brokered child delegation

## Context

Repository: `/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker`

This is a Pi delegation broker — a control plane that spawns isolated Pi child agents for subtasks. The broker owns leases, capacity, credentials, routing, and verification. Children receive only scoped capabilities and cannot select their own model, provider, account, or credentials.

## Problem

The broker has infrastructure for matching models to tasks but no selection logic. Currently `selectContract` is a stub that returns a hardcoded model. We need the broker to automatically select the cheapest sufficient model for each task based on capability requirements.

## Current architecture

### Registry (signed, Ed25519)
```js
// src/broker.mjs — fixtureRegistry()
profiles: {
  "reasoning-high/v1": { status: "approved", supports: ["text_generation", "code_reasoning", "repo_navigation", "large_context"] },
  "audit-low/v1":      { status: "approved", supports: ["text_generation"] },
}
resources: {
  "R1": { capacityGroup: "G-shared", profile: "reasoning-high/v1", confidence: "observed", enforcement: {...} },
  "R3": { capacityGroup: "G-cheap",   profile: "audit-low/v1",      confidence: "measured",  enforcement: {...} },
}
```

### Contract (what the parent submits)
```js
{
  taskId: "task-123",
  operationClass: "read_only",  // read_only | propose_patch | apply | external_write
  admissionClass: "work",       // control | verify | work
  capability: {
    minimumProfile: "reasoning-high/v1",
    required: ["code_reasoning", "repo_navigation"],
    downgradePolicy: "forbid",
  },
  doneWhen: ["tests pass", "no regressions"],
  promptDigest: "sha256 hex",
  latencyBudgetMs: 30000,
  budget: { enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
}
```

### Resolver (controller-side, decides which model the child gets)
```js
// src/trusted-launch-resolver.mjs
// selectContract is a controller-provided callback:
selectContract: (input) => ({
  expectedModel: { provider: "...", modelId: "..." },
  contract: { /* the full contract above */ },
})
```

### Broker matching (already works)
The broker's `#reserveCore` in `src/broker.mjs` already:
1. Validates the contract
2. Finds the requested profile in the registry
3. Searches resources that match the profile and capability requirements
4. Checks capacity, cooldown, breaker state
5. Returns a lease or denies

### Dynamic provider catalog
`src/dynamic-provider-watcher.mjs` reads Pi's `~/.pi/agent/models-store.json` + `auth.json` and builds a registry via `catalogToBrokerRegistry()` from `src/provider-catalog.mjs`. Each provider becomes a resource; each provider's strongest model becomes a profile.

`catalogToBrokerRegistry()` in `src/provider-catalog.mjs` already derives capabilities:
- All models get `text_generation`
- Reasoning-capable models get `code_reasoning`
- Image-capable models get `vision_input`
- Context >= 200K gets `large_context`

## What to implement

### 1. `src/model-selector.mjs` — capability-aware model selection

A controller-owned function that takes a task description and the current registry, and returns the cheapest sufficient contract:

```js
export function selectModelForTask({ taskDescription, registry, constraints }) {
  // 1. Parse task requirements from the description
  // 2. Find all approved profiles that satisfy the requirements
  // 3. Among matching profiles, pick the cheapest (fewest capabilities = weakest model)
  // 4. Build a contract with that profile as minimumProfile
  // 5. Return { expectedModel, contract }
}
```

Input:
- `taskDescription`: string — what the child needs to do (e.g. "read a file and summarize", "write a patch", "run tests")
- `registry`: the broker registry (profiles, resources, capacityGroups)
- `constraints`: optional overrides (operationClass, admissionClass, budget, latencyBudgetMs)

Logic:
- Simple tasks (read, summarize, list) → `text_generation` only → cheapest model
- Code tasks (edit, patch, refactor) → `text_generation` + `code_reasoning` → mid-tier model
- Large context tasks (analyze whole repo) → `large_context` → model with 200K+ context
- Effect-capable tasks (apply patch, external write) → all capabilities + hard budget → strongest model
- Never select a stronger model than necessary; never select a weaker model than required
- If multiple resources match, prefer: measured confidence > observed > assumed, then lowest cost

### 2. Integrate into `BrokeredChildRunner`

In `src/brokered-runner.mjs`, the `spawn` method currently receives a hardcoded `model` parameter. Change it so:
- If `model` is provided explicitly → use it (manual override)
- If `model` is not provided → call `selectModelForTask` with the task description and current registry
- The resolver's `selectContract` callback should use the selected model

### 3. Test

Add `test/model-selector.test.mjs` with cases:
- Simple read task → selects cheapest text_generation model
- Code task → selects model with code_reasoning
- No matching model → returns deny with reason
- Manual override → bypasses selection
- Multiple matches → picks cheapest/weakest
- Effect-capable task → requires all capabilities + hard budget

### Constraints

- The selector is controller-only, never child-visible
- It reads the registry, it does not modify it
- It must respect `downgradePolicy: "forbid"` — never pick a weaker profile than required
- It must prefer `measured` confidence over `observed` over `assumed` for hard-budget tasks
- It must not select a resource that is in cooldown or unknown state
- No live provider calls, no credentials, no external API
- All tests must pass with `npm run release:check`
- Pure `.mjs`, no TypeScript, no external dependencies

### Key files to read first

- `src/broker.mjs` — `fixtureRegistry()`, `#reserveCore()`, `#resourceMatchesContract()`, `#validateContract()`
- `src/provider-catalog.mjs` — `catalogToBrokerRegistry()`, `deriveModelSupports()`
- `src/trusted-launch-resolver.mjs` — `BrokeredLaunchResolver`, `selectContract` callback
- `src/brokered-runner.mjs` — `BrokeredChildRunner.spawn()`
- `src/dynamic-provider-watcher.mjs` — how the registry is built from Pi's config

### Verification

```sh
cd /Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker
npm run release:check
```

Must show 0 failures. Current baseline: 186 tests pass.