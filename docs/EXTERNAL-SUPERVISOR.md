# External supervisor boundary

**Status:** required before unattended, overnight, or reboot-recovery operation. This package does not install or impersonate a host service manager.

`SingleHostBrokerSupervisor` owns the broker lock, Unix socket, TTL sweep and bounded shutdown while its controller process is alive. It is not a crash supervisor: `tmux`, `caffeinate`, a Pi session, or a shell background process cannot guarantee restart after a crash, logout, reboot, or stale process.

## Required host-owned contract

The deployment owner must run the controller/parent process under `launchd`, `systemd`, or an equivalent reviewed service manager with:

- automatic restart after non-zero exit and reboot;
- bounded restart backoff/throttling so a broken attestation cannot hot-loop;
- an owner-only working/state directory and log destination;
- no provider credential, signing key, or approval receipt in the service unit or child environment;
- a stop path that allows the controller to execute bounded cleanup, followed by service-manager termination;
- a health signal that distinguishes `running`, `degraded` (no authorized provider), `attestation_failed`, and `stopped`;
- explicit notification/escalation when recovery leaves a task or lease ambiguous;
- a clean restart of the Pi process after source changes, because Node module reload does not re-import cached `src/*.mjs` modules.

The service manager must not be granted authority to choose a provider route, rewrite a registry, refresh a credential, or approve an effect. It only starts, stops and reports the controller process.

## Attestation recovery

A stale launcher digest is a deliberate fail-closed condition. Recovery is:

1. stop new delegation and let the active controller drain or reconcile;
2. stop the parent/controller process through the service manager;
3. review the exact extension source and update the trusted digest manifest through the approved release process;
4. start a fresh parent/controller process so it rehashes every extension immediately before spawn;
5. run deterministic checks and the bounded read-only canary before re-enabling work.

Never make the launcher accept the digest it just observed, disable attestation, or retry indefinitely. The failed delegation report

`Launcher attestation extension 0 digest does not match its pinned trusted digest`

must remain an operator-visible `attestation_failed` state until a reviewed restart fixes the pin.

## Readiness boundary

A one-shot read-only canary may use the controller proxy once the live-validation plan is approved. Overnight operation additionally requires a tested service-manager configuration, restart/reconciliation evidence, and an owner who can respond to a failed or ambiguous controller state. No current repository check proves those host-level properties; they are deployment acceptance criteria, not `npm test` claims.
