# Antigravity subscription routes

Install pi-multi-account 1.27.0+ on a compatible Pi host and use `/login google-antigravity`; complete browser authorization and return to Pi. No manual OAuth application configuration is required. The Multi Account adapter carries a source-reviewed shared installed-client identity, distinct from private user credentials. Never include private application secrets, account tokens, project identifiers or local diagnostic journals in this repository. Account credentials stay in the parent Pi process.

This change admits account-discovered Antigravity Google/Anthropic/OpenAI models as included subscription routes. Serving host and model developer remain separate facts: Google hosting Claude does not make Claude a Google-developed model. Existing current-generation, quality, account capacity and launch gates still apply. The provider disables credit opt-in and does not use an API-key fallback; this is not a guarantee of server billing or Google's approval of third-party access.

Antigravity has no generic OpenAI `/models` endpoint: model discovery comes from its parent-owned native provider. Gemini Argon, Pro, Flash and Flash-Lite are independent current-generation families.

A model quota failure cools that resource, not every model on the account. Account concurrency remains shared. A successful catalog observation does not clear a dispatch-scoped failure; actual leased recovery is required. Credential failures can still affect the account.

Legacy account-wide quota cooldowns are migrated only when matching durable quota events identify their resources and no probe lease owns the group. Exhaustion evidence is preserved on those resources. Missing/inconsistent evidence never permits a blanket health reset.

This focused integration does not include unrelated local readiness, Jev, metered-provider or workflow changes. Catalog eligibility is not proof of successful inference, available quota or universal model compatibility. Retain the normal controller qualification and admission checks in the installed controller version.
