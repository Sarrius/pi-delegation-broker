import assert from "node:assert/strict";
import test from "node:test";

import { resolveChildLaunchModel } from "../src/child-launcher.mjs";

test("account aliases remain controller identities but launch through a canonical Pi provider", () => {
  assert.deepEqual(resolveChildLaunchModel("anthropic-account-2/claude-opus-5"), {
    leasedProvider: "anthropic-account-2", provider: "anthropic", modelId: "claude-opus-5",
  });
  assert.deepEqual(resolveChildLaunchModel("openai-codex-account-6/gpt-5.6-terra"), {
    leasedProvider: "openai-codex-account-6", provider: "openai-codex", modelId: "gpt-5.6-terra",
  });
  assert.deepEqual(resolveChildLaunchModel("zai/glm-5.3"), {
    leasedProvider: "zai", provider: "zai", modelId: "glm-5.3",
  });
});

test("malformed child model identities fail before a process can launch", () => {
  for (const value of ["", "anthropic", "/claude-opus-5", "anthropic/"]) {
    assert.throws(() => resolveChildLaunchModel(value), /Model must be/);
  }
});
