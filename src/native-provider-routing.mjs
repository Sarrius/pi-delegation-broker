const CATALOG_ONLY_NATIVE_PROVIDER =
  /^(?:cursor(?:-account-\d+)?|anthropic-account-\d+|openai-codex-account-\d+)$/;

/**
 * Native subscription aliases backed by a parent-owned loopback proxy do not
 * accept controller-held upstream credentials at a generic `/models` URL.
 * Their model catalog is observed from the parent, while routePreflight stays
 * the exact credential/runtime gate before lease admission.
 */
export function isCatalogOnlyNativeProvider(provider) {
  return typeof provider === "string" && CATALOG_ONLY_NATIVE_PROVIDER.test(provider);
}
