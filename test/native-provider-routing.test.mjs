import assert from "node:assert/strict";
import test from "node:test";
import { isCatalogOnlyNativeProvider } from "../src/native-provider-routing.mjs";

test("parent-proxy native aliases use catalog-only currency observations", () => {
  for (const provider of [
    "cursor",
    "cursor-account-2",
    "anthropic-account-2",
    "openai-codex-account-2",
    "openai-codex-account-7",
  ]) {
    assert.equal(isCatalogOnlyNativeProvider(provider), true, provider);
  }
});

test("base native providers and unrelated providers remain generic-probe eligible", () => {
  for (const provider of ["anthropic", "openai-codex", "openrouter", "cursor-account-x", ""]) {
    assert.equal(isCatalogOnlyNativeProvider(provider), false, provider);
  }
});
