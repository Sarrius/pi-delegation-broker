# Pi launcher integration boundary

This package does not install itself into Pi and does not modify Pi configuration.

A compatible launcher must enforce all of the following before a brokered child starts:

1. Call a controller-owned trusted resolver before worktree, shim or subprocess creation.
2. Give the resolver only a prompt digest and resolved request facts, not raw prompt text.
3. Let the resolver reserve a lease, verify the exact provider/model, create an owner-only agent directory and return a policy.
4. Start the child with minimal inherited environment, isolated `PI_CODING_AGENT_DIR`, explicit extensions and model scope.
5. Pass only `PI_BROKER_SOCKET`, lease metadata and `PI_BROKER_CAPABILITY` to the child. Do **not** serialize an authorization policy into the environment: `BrokeredLaunchResolver` must bind the exact `EffectiveChildCapability` under the lease, and the extension must retrieve it through lease-scoped IPC.
6. Invoke parent-only hooks after child-session handoff, before-handoff failure and session-process closure.
7. Bind the selected contract's `promptDigest` to the launch request and include its `doneWhen`; mismatched frames are denied before lease reservation.
8. Poll/observe controller-only pending readiness and launch only the exact task/lease returned by `dispatchPending`; atomically `claimReadyTask` before spawn and reconcile the terminal child result. A queued contract is not itself authority to spawn.
9. Load `extensions/pi-behavioral-enforcement.ts` as the final explicit broker extension after every shim, with discovery disabled (`--no-extensions`) and no later extension capable of mutating tool arguments. For an effect-capable launch, pass `launcherAttestationConfig` to `BrokeredLaunchResolver`: it contains one reviewed SHA-256 for each explicit extension and the final behavioral extension path. The resolver refuses an effect before reservation if it is absent; the source-only seam rehashes every extension immediately before spawn and refuses handoff unless the child startup report includes `broker_declare_action`. It calls central `declareBehavioralAction`/`authorizeBehavioralAction` from Pi's blocking `tool_call` hook and `observeBehavioralResult` only after completed `tool_result`; the controller derives its state digest and writes behavioral events separately from provider telemetry. A parent RPC event after execution is too late to block a mismatched effect. Revalidate action snapshot, lease, fence, budget and extension/launcher attestation after any awaited hook/approval and immediately before dispatch; an extension may tighten/ask but cannot force-allow over the controller. This remains an unaccepted reference seam: until it is reviewed and the final controller gate is verified, the broker default denies `propose_patch`, `apply`, and `external_write`. `behavioralEnforcement` is a trusted-caller-only low-level seam: do not expose it through config/env/CLI.
10. Capture acceptance evidence through controller-owned tools into an owner-only retained `ControllerEvidenceStore` and validate it; child-supplied `source: controller` text is not trusted without matching metadata and content. The alpha store has a single-writer precondition. Spot audit uses `captureObservation`/`compareSemantic` and passes recaptures to the validator; raw-byte recapture is not semantic comparison. Normalization is opt-in, and a criterion naming timestamp/PID/order/path conflicts with policy that strips that field.

The [source-repository-only reference patch](https://github.com/Sarrius/pi-delegation-broker/blob/main/patches/pi-subagent-workflow-trusted-launcher-seam.patch) demonstrates such a seam against `pi-subagent-workflow` commit `0c28ce87bc45f4c3d66e0100b58ae13cf345978c`, including pinned extension rehash/order and startup-tool attestation. It is an unaccepted local patch and is not part of the npm tarball. Applying it, accepting it upstream, or replacing it with an equivalent stable API remains a human release decision.

`pi-multi-account` must be absent from brokered children until it has a reviewed brokered report-only mode. A brokered child must not invoke `pi.setModel()` or auto-continue on its own.

## Failure semantics

- Before handoff: controller release cleans up the lease/agent directory. If controller IPC fails, the resolver retains an explicitly pending record for later reconciliation.
- After handoff: child provider shutdown releases its lease and moves a claimed queued task to `awaiting_result`; parent completion cleanup is idempotent and finalizes it. A lost parent result escalates at the task deadline.
- Capacity unavailable: `submit` queues only when the contract names a recovery owner and future deadline. Release/expiry/cooldown transitions make timed work eligible; the supervisor scheduler moves admitted entries to `ready`, while the controller remains responsible for child launch.
- Wait deadline reached: the task becomes `escalated`; it never remains an ownerless, unbounded `paused_capacity` row.
- Provider transport missing: `BrokerIpcServer` returns `provider_transport_unavailable`; it never falls back to fake success.
- A real provider proxy must classify and reconcile any ambiguous external effect. The fake transport only proves pre-effect cancellation.
