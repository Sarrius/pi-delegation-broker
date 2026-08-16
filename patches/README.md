# Trusted-launcher seam patch

- Target: `mzenko/pi-subagent-workflow` commit `0c28ce87bc45f4c3d66e0100b58ae13cf345978c`.
- File: `pi-subagent-workflow-trusted-launcher-seam.patch`.
- SHA-256: `aa35716325ee3bad305028fd0f16988e7f6785732277c88e9f58112a0eeffe7f`.
- Revalidation on 2026-08-16: `git apply --check`, `npm run check`, and `npm run build` passed against that exact clean commit/spike.

## Review contract

The patch adds a narrow controller-owned resolver seam before worktree/shim/process creation, source-order/final-hook attestation, a minimal brokered child environment, and parent-only lifecycle callbacks. It must preserve legacy launch behavior when brokered mode is not explicitly required. Reviewers must verify that no policy field can alter the resolved model, prompt, cwd, tools, credentials, controller token, or retry/failover owner; that callbacks never cross into child env/argv/shim; and that an effect-capable child cannot start without a verified final behavioral hook.

This patch is an **unaccepted local proposal**, not a first-party API. It is intentionally excluded from the npm tarball. Upstream acceptance, an equivalent versioned first-party seam, native upstream test coverage, and final controller-gate review remain required before effects or a live provider account are enabled. Do not auto-apply it to a global Pi installation.
