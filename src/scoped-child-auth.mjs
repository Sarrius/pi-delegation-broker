/**
 * Scoped child authentication.
 *
 * A brokered child must authenticate as exactly the account the broker leased — no more.
 * The naive alternative (pointing the child at the parent's own agent directory) hands the
 * child every credential the parent holds: fifteen accounts where the lease covers one. This
 * module writes a minimal per-child configuration instead:
 *
 * - `auth.json`        — the ONE credential entry for the leased provider, copied verbatim.
 * - `models-store.json` — that provider's model catalog. Multi-account providers
 *   (`openai-codex-account-2`, ...) have no catalog of their own: their models live under the
 *   base provider, so they are inherited with the provider field rewritten to the account.
 * - `models.json`      — the provider's endpoint config (api/baseUrl), when the parent has
 *   one, scoped to the single provider.
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

  // 1. Credential: exactly the leased provider's entry, verbatim. Missing means the child
  //    cannot authenticate as the leased account at all — deny rather than launch broken.
  const auth = readJson(join(parentAgentDir, "auth.json"));
  const credential = auth[provider];
  if (!credential || typeof credential !== "object" || typeof credential.type !== "string") {
    throw new Error(`no credential for leased provider: ${provider}`);
  }
  writeOwnerOnly(join(resolvedAgentDir, "auth.json"), { [provider]: credential });

  // 2. Model catalog: the provider's own entry, else the base provider's (multi-account
  //    inheritance), else whatever the endpoint config already lists. Model entries are
  //    self-describing (api + baseUrl), so a provider the child's Pi has never heard of is
  //    still fully defined by this file alone.
  const store = readJson(join(parentAgentDir, "models-store.json"));
  const base = baseProviderFor(provider);
  const modelsConfig = readJson(join(parentAgentDir, "models.json"));
  const providerConfig = modelsConfig.providers?.[provider] ?? modelsConfig.providers?.[base];
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
      provider,
      ...(providerConfig?.api && !model.api ? { api: providerConfig.api } : {}),
      ...(providerConfig?.baseUrl && !model.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
    }));
  if (scopedModels.length > 0) {
    writeOwnerOnly(join(resolvedAgentDir, "models-store.json"), { [provider]: { models: scopedModels } });
  }

  // 3. Endpoint config: scoped to the one provider. For a multi-account id the child's Pi
  //    has no built-in definition, so give it a complete self-contained entry when we can.
  const scopedConfig = providerConfig
    ? { ...providerConfig, models: scopedModels.length > 0 ? scopedModels : providerConfig.models }
    : (scopedModels.length > 0 && scopedModels[0].api && scopedModels[0].baseUrl)
      ? { api: scopedModels[0].api, baseUrl: scopedModels[0].baseUrl }
      : undefined;
  if (scopedConfig) {
    writeOwnerOnly(join(resolvedAgentDir, "models.json"), { providers: { [provider]: scopedConfig } });
  }

  return Object.freeze({
    provider,
    credentialType: credential.type,
    modelCount: scopedModels.length,
    modelsSource,
  });
}
