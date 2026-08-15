# Contributing

## Local checks

```sh
npm ci
npm run release:check
```

Use Node 26+. Tests must stay hermetic: no provider account, credential, network call or user-owned Pi configuration.

## Safety rules

- Never add credentials, account identifiers, raw prompts or real provider responses to tests, fixtures, docs or logs.
- Do not make fake transport the default behavior of a public runtime path.
- Preserve fail-closed behavior for missing transport, invalid lease, invalid registry, stale capability and controller IPC failure.
- Keep child capabilities scoped; never add a controller token or signing private key to a child policy.
- Changes to the upstream launcher patch must include a regenerated patch, `git apply --check`, TypeScript check/build and a non-live integration result.

## Pull requests

Describe the invariant being changed, the relevant tests, and any compatibility or migration impact. Production provider support requires a separate design/review because it changes the credential and external-effect trust boundary.
