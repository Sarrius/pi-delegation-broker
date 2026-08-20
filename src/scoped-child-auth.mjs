/**
 * Scoped child authentication.
 *
 * A brokered child must authenticate as exactly the account the broker leased — no more.
 * The naive alternative (pointing the child at the parent's own agent directory) hands the
 * child every credential the parent holds: fifteen accounts where the lease covers one. This
 * module writes a minimal per-child configuration instead:
 *
 * - `auth.json`        — the ONE credential for the leased provider. Native Pi OAuth
 *   (Anthropic, Codex, …) is copied verbatim. Extension-backed OAuth that Pi only understands
 *   through a parent-side provider (Cursor: a localhost OpenAI-compatible proxy) is written as
 *   `type: api_key` whose key is that account's access token: a `--no-extensions` child cannot
 *   run Cursor's OAuth handler, and copying `type: oauth` made Pi throw "No API key found for
 *   cursor" — which used to crash the parent interactive session via unhandledRejection.
 *   For a `*-account-N` lease the entry is stored under the canonical base provider id: a fresh
 *   Pi process cannot resolve an alias unless its multi-account UI extension is also loaded,
 *   while the isolated directory guarantees that base id still means exactly this one leased
 *   account.
 * - `models-store.json` — that provider's model catalog under the same canonical id.
 * - `models.json`      — the provider's endpoint config (api/baseUrl), when the parent has
 *   one, scoped to the same canonical provider.
 *
 * Everything here runs controller-side, inside the launch resolver's provisioning hook. The
 * files land in the child's owner-only agent directory (0o700 dir, 0o600 files) and are
 * removed with it when the lease ends. A child never sees the parent's agent directory, never
 * sees another account's credential, and cannot re-login: it runs with extension discovery
 * disabled, so no account-management extension is present.
 *
 * Fail-closed: no credential entry for the leased provider means the child cannot possibly
 * honour its lease, so provisioning throws and the resolver denies the launch.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACCOUNT_SUFFIX = /-account-\d+$/;

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOwnerOnly(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** The base provider a multi-account id inherits its catalog from. */
export function baseProviderFor(provider) {
  return provider.replace(ACCOUNT_SUFFIX, "");
}

function isLoopbackProxyUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") && url.port !== "";
  } catch {
    return false;
  }
}

/**
 * Isolated children do not load provider extensions. Native Pi OAuth still works from a
 * copied `type: oauth` entry. Cursor (and any similar proxy-backed slot) is provisioned as a
 * localhost OpenAI-compatible endpoint whose Authorization header IS the access token — that
 * is how pi-multi-account's shared proxy identifies the leased account.
 */
function credentialForIsolatedChild(base, credential, providerConfig) {
  const proxyBacked = base === "cursor" || isLoopbackProxyUrl(providerConfig?.baseUrl);
  if (!proxyBacked || credential.type !== "oauth") return credential;
  if (typeof credential.access !== "string" || !credential.access) {
    throw new Error(`proxy-backed provider ${base} has no access token to materialize as API key`);
  }
  return { type: "api_key", key: credential.access };
}

/**
 * Write a single-provider auth/model configuration into a provisioned child agent dir.
 *
 * @param {object} input
 * @param {string} input.agentDir — owner-only dir from provisionBrokeredAgentDir.
 * @param {string} input.provider — the leased provider/account id.
 * @param {string} input.parentAgentDir — the controller's own Pi agent dir to read from.
 * @returns {{ provider: string, credentialType: string, modelCount: number, modelsSource: string }}
 */
export function writeScopedChildAuth({ agentDir, provider, parentAgentDir } = {}) {
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) throw new Error("Scoped child auth requires an absolute agentDir");
  if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) throw new Error("Scoped child auth requires a valid provider id");
  if (typeof parentAgentDir !== "string" || !isAbsolute(parentAgentDir)) throw new Error("Scoped child auth requires an absolute parentAgentDir");
  const resolvedAgentDir = resolve(agentDir);
  if (!existsSync(resolvedAgentDir) || !statSync(resolvedAgentDir).isDirectory()) {
    throw new Error(`Scoped child auth agent dir does not exist: ${resolvedAgentDir}`);
  }

  // 1. Credential: exactly the leased provider's entry, shaped so a `--no-extensions` Pi can
  //    actually use it. Missing means the child cannot authenticate as the leased account at
  //    all — deny rather than launch broken.
  const auth = readJson(join(parentAgentDir, "auth.json"));
  const credential = auth[provider];
  if (!credential || typeof credential !== "object" || typeof credential.type !== "string") {
    throw new Error(`no credential for leased provider: ${provider}`);
  }
  // `pi-multi-account` aliases exist in the parent interactive process, but isolated children
  // deliberately run `--no-extensions`; Pi then has no provider definition for
  // `anthropic-account-2` et al. A one-credential agent dir makes the canonical name safe:
  // `anthropic` here can only authenticate as this leased account, never the parent's base one.
  const base = baseProviderFor(provider);
  const store = readJson(join(parentAgentDir, "models-store.json"));
  const modelsConfig = readJson(join(parentAgentDir, "models.json"));
  const providerConfig = modelsConfig.providers?.[provider] ?? modelsConfig.providers?.[base];
  const childCredential = credentialForIsolatedChild(base, credential, providerConfig);
  writeOwnerOnly(join(resolvedAgentDir, "auth.json"), { [base]: childCredential });

  // 2. Model catalog: the provider's own entry, else the base provider's (multi-account
  //    inheritance), else whatever the endpoint config already lists. Model entries are
  //    self-describing (api + baseUrl), so a provider the child's Pi has never heard of is
  //    still fully defined by this file alone.
  let models;
  let modelsSource;
  if (Array.isArray(store[provider]?.models) && store[provider].models.length > 0) {
    models = store[provider].models;
    modelsSource = "direct";
  } else if (base !== provider && Array.isArray(store[base]?.models) && store[base].models.length > 0) {
    models = store[base].models;
    modelsSource = "base";
  } else if (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0) {
    models = providerConfig.models;
    modelsSource = "config";
  } else {
    models = [];
    modelsSource = "none";
  }
  const scopedModels = models
    .filter((model) => model && typeof model === "object" && typeof model.id === "string")
    .map((model) => ({
      ...model,
      provider: base,
      ...(providerConfig?.api && !model.api ? { api: providerConfig.api } : {}),
      ...(providerConfig?.baseUrl && !model.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
    }));
  if (scopedModels.length > 0) {
    writeOwnerOnly(join(resolvedAgentDir, "models-store.json"), { [base]: { models: scopedModels } });
  }

  // 3. Endpoint config: also canonicalized, matching auth/catalog and the launch --provider.
  const scopedConfig = providerConfig
    ? { ...providerConfig, models: scopedModels.length > 0 ? scopedModels : providerConfig.models }
    : (scopedModels.length > 0 && scopedModels[0].api && scopedModels[0].baseUrl)
      ? { api: scopedModels[0].api, baseUrl: scopedModels[0].baseUrl }
      : undefined;
  if (scopedConfig) {
    writeOwnerOnly(join(resolvedAgentDir, "models.json"), { providers: { [base]: scopedConfig } });
  }

  return Object.freeze({
    // `provider` is the controller/audit identity; `runtimeProvider` only appears when a
    // fresh Pi must use a different canonical id to represent that exact scoped credential.
    provider,
    ...(base === provider ? {} : { runtimeProvider: base }),
    credentialType: childCredential.type,
    modelCount: scopedModels.length,
    modelsSource,
  });
}
