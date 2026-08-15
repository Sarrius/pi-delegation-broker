# Publication readiness record

**Candidate:** `@sars267/pi-delegation-broker@0.1.0-alpha.1`

**Local Git commit:** see `git log -1 --oneline` (recorded after final local release preparation)

**Publication state:** public GitHub repository and prereleases created; `@sars267/pi-delegation-broker@0.1.0-alpha.0` and the OIDC-attested `0.1.0-alpha.1` are published on npm. No real provider request was made.

## Passed local evidence

- `npm run release:check` passed on Node `v26.7.0` / npm `11.19.0`.
  - 26 hermetic core tests passed.
  - Syntax and publishable-file secret-marker checks passed.
  - `npm pack --dry-run` allowlist check passed.
- Tarball manifest: 15 files, 74,276 bytes unpacked. It contains only public source, public docs, license and npm metadata; it excludes tests, patch, logs, SQLite artifacts, sockets and local configuration.
- A clean temporary consumer installed the generated tarball and imported `.` and `./testing`; fake transport is absent from the root export.
- `git diff --check`, staged diff check and Git object integrity check passed.
- The launcher seam patch applies with `git apply --check` to `pi-subagent-workflow` commit `0c28ce87bc45f4c3d66e0100b58ae13cf345978c`. Current unreleased patch SHA-256: `6928c0ad2b6fe115cc7f6111f490d8d716bdfe31a72dd4d277a6f871f3addf31` (adds terminal child-result reconciliation).
- Non-live upstream integration scenarios (success, 429, expiry, stale capability and cancellation) passed using only `ScriptedFakeProvider`.
- GitHub Actions CI passed on Ubuntu and macOS for the pushed `main` commit. `main` requires both CI checks, linear history and resolved conversations; force-push and branch deletion are disabled.
- Private vulnerability reporting, Dependabot configuration and a reviewer-protected `npm-publish` GitHub Environment are enabled.
- npm registry consumer installation/import passed for the published tarball (15 public files; integrity `sha512-Mi8bAtYmpnuAVwZ4P7K+6D5qoY5qifaUBpR903+DGCYnsN8hhwWGQrY3Sbg1kc/jNPinKm5lPuk58XhYjx0eDw==`).
- GitHub publish workflow dry-run and the OIDC-attested `0.1.0-alpha.1` upload both passed. Trusted-publisher record `85654e64-5b40-43f2-b52e-d3ddc5ec2746` restricts publishing to `Sarrius/pi-delegation-broker`, `publish.yml`, `npm-publish`, and package creation.

## Required human/remote actions before first public release

1. Keep using the protected GitHub OIDC workflow; do not add an npm token to GitHub secrets. Start every future release with its dry-run.
2. Resolve npm's first-release `latest` dist-tag mapping through the package account’s required 2FA/permission flow before publishing a non-alpha version. `next` maps to `0.1.0-alpha.1`; `latest` still maps to `0.1.0-alpha.0`.
3. Do not claim production readiness or connect real accounts/credentials until the provider-proxy, signing-key lifecycle, controller reconciliation and read-only capacity-inventory gates are complete.
