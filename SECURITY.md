# Security policy

## Supported versions

Only the latest prerelease is supported while this project remains `0.x`.

## Reporting a vulnerability

Do **not** open a public issue with any of the following:

- provider/API/OAuth credentials or refresh tokens;
- `auth.json`, SQLite database, broker socket, lease capability or controller token;
- account identifiers, raw prompts, provider responses or signed private keys.

Use the repository's private GitHub Security Advisory reporting flow. If that flow is unavailable, open a minimal public issue requesting a private contact channel and include no sensitive material.

## Scope warning

This is an alpha reference implementation. It intentionally has no real provider transport or credential storage. Do not treat its test-only fake transport, local Unix socket, lock file or signed-registry test keys as a production security boundary.
