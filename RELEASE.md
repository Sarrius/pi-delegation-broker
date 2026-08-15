# Release procedure

This document prepares a public prerelease. It does **not** authorize a live provider test or production deployment.

## One-time maintainer setup

1. Confirm the npm package name is available. If it is not, update `name`, repository URLs, README install command and this file together.
2. Ensure the GitHub repository `Sarrius/pi-delegation-broker` is **public**, has private vulnerability reporting, and protects `main`.
3. Push only this repository; do not push the parent research directory.
4. In npm, configure trusted publishing for this exact GitHub repository and the `.github/workflows/publish.yml` workflow. Do not place an npm automation token in GitHub secrets.
5. Ensure the protected GitHub Environment named `npm-publish` has required reviewer(s).
6. Create the npm `next` dist-tag through the first prerelease. Promote to `latest` only after production readiness is separately reviewed.

## Before every release

```sh
npm ci
npm run release:check
git diff --check
git diff --cached --check
git status --short
```

All must pass, and the working tree must be clean. Review the `npm pack --dry-run` manifest printed by `npm run pack:check`; it must not contain tests, patches, logs, SQLite files, sockets, credentials or local config.

Verify the version has the intended prerelease/channel semantics:

```sh
node -p "require('./package.json').version"
```

For this alpha, use `0.1.0-alpha.N` and dist-tag `next`. Never manually run `npm publish` from a credential-bearing workstation.

## Publish

1. Create and push an annotated version tag only after checks pass, for example:
   ```sh
   git tag -a v0.1.0-alpha.0 -m "v0.1.0-alpha.0"
   git push origin main --follow-tags
   ```
2. Use **Actions → Publish npm package → Run workflow**. Supply the tag already present in `package.json` (`next` for alpha) and keep `dry_run=false`.
3. Approve the protected `npm-publish` environment in GitHub.
4. Verify on npm that the version, provenance attestation, repository link and file list match the reviewed release.
5. Create GitHub release notes from `CHANGELOG.md` after the npm publish succeeds.

## Stop conditions

Stop rather than publish when any of these is true:

- The public npm name/repository owner differs from `package.json`.
- The package manifest contains an unexpected file.
- A secret, account identifier, private key, raw prompt, provider response, SQLite database or socket is discovered.
- CI differs from the reviewed commit or trusted-publishing provenance is unavailable.
- The release would be represented as a production broker, provider proxy or endorsed Pi integration.

## Rollback

Do not unpublish a widely downloaded package. Deprecate the bad version, publish a fixed prerelease under `next`, revoke compromised credentials outside this repository, and disclose the issue through GitHub Security Advisories as appropriate.
