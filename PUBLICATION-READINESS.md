# Publication readiness record

**Candidate:** `@sars267/pi-delegation-broker@0.1.0-alpha.0`

**Local Git commit:** see `git log -1 --oneline` (recorded after final local release preparation)

**Publication state:** public GitHub repository created and `main` pushed; no npm package has been uploaded and no real provider request was made.

## Passed local evidence

- `npm run release:check` passed on Node `v26.7.0` / npm `11.19.0`.
  - 26 hermetic core tests passed.
  - Syntax and publishable-file secret-marker checks passed.
  - `npm pack --dry-run` allowlist check passed.
- Tarball manifest: 15 files, 74,276 bytes unpacked. It contains only public source, public docs, license and npm metadata; it excludes tests, patch, logs, SQLite artifacts, sockets and local configuration.
- A clean temporary consumer installed the generated tarball and imported `.` and `./testing`; fake transport is absent from the root export.
- `git diff --check`, staged diff check and Git object integrity check passed.
- The launcher seam patch applies with `git apply --check` to `pi-subagent-workflow` commit `0c28ce87bc45f4c3d66e0100b58ae13cf345978c`. Patch SHA-256: `0dffa9bd90f8abee2c870e6479044e68ce6b01118ddea900d04fa00084eddc8a`.
- Non-live upstream integration scenarios (success, 429, expiry, stale capability and cancellation) passed using only `ScriptedFakeProvider`.
- GitHub Actions CI passed on Ubuntu and macOS for the pushed `main` commit. `main` requires both CI checks, linear history and resolved conversations; force-push and branch deletion are disabled.
- Private vulnerability reporting, Dependabot configuration and a reviewer-protected `npm-publish` GitHub Environment are enabled.

## Required human/remote actions before first public release

1. Configure npm trusted publishing for `@sars267/pi-delegation-broker` and exactly `.github/workflows/publish.yml`. Do not add an npm token to GitHub secrets.
2. Re-run the checklist in [`RELEASE.md`](RELEASE.md), create `v0.1.0-alpha.0`, and use the manually dispatched workflow with the `next` tag.
3. Verify the npm provenance attestation and the published tarball manifest before creating GitHub release notes.
4. Do not claim production readiness or connect real accounts/credentials until the provider-proxy, signing-key lifecycle, controller reconciliation and read-only capacity-inventory gates are complete.
