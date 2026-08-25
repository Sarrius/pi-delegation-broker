import assert from "node:assert/strict";
import test from "node:test";

import { assertStoredContract, normalizeContract, renderRoleFraming, resolveContract } from "../src/child-contract.mjs";

const PARENT = { model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "high" };

test("effort is an axis of its own and defaults to the controller level", () => {
  assert.equal(resolveContract(normalizeContract({}), PARENT).requestedThinking, "off");
  assert.equal(resolveContract(normalizeContract({ thinking: "auto" }), PARENT).requestedThinking, "off");
  // Tier must not drag effort with it: a cheap child may still be asked to think hard.
  const cheapButThoughtful = resolveContract(normalizeContract({ thinking: "high" }), PARENT);
  assert.equal(cheapButThoughtful.requestedThinking, "high");
  assert.equal(cheapButThoughtful.thinkingMode, "high");
});

test("inherit copies the live parent effort and never invents one", () => {
  assert.equal(resolveContract(normalizeContract({ thinking: "inherit" }), PARENT).requestedThinking, "high");
  assert.equal(resolveContract(normalizeContract({ thinking: "inherit" }), {}).requestedThinking, "off");
  assert.equal(
    resolveContract(normalizeContract({ thinking: "inherit" }), { thinkingLevel: "nonsense" }).requestedThinking,
    "off",
  );
});

test("inherit_model asks for the parent's exact identity and fails closed without one", () => {
  const inherited = resolveContract(normalizeContract({ route: "inherit_model" }), PARENT);
  assert.deepEqual(inherited.model, { provider: "anthropic", modelId: "claude-opus-5" });
  assert.throws(
    () => resolveContract(normalizeContract({ route: "inherit_model" }), {}),
    /inherit_model needs this session's model identity/,
  );
});

test("peer rejects instead of guessing quality equivalence", () => {
  assert.throws(
    () => resolveContract(normalizeContract({ route: "peer" }), PARENT),
    /no calibrated quality-equivalence/,
  );
});

test("an invalid axis is refused at submission, not silently defaulted", () => {
  assert.throws(() => normalizeContract({ thinking: "hard" }), /thinking mode is invalid/);
  assert.throws(() => normalizeContract({ route: "cheapest" }), /route mode is invalid/);
  assert.throws(() => normalizeContract({ role: { name: "" } }), /role name is required/);
  assert.throws(() => normalizeContract({ role: "planner" }), /role must be an object/);
  assert.throws(() => normalizeContract({ role: { name: "x", schemaVersion: 2 } }), /schemaVersion must equal 1/);
  assert.throws(
    () => normalizeContract({ role: { name: "x", deliverables: Array.from({ length: 11 }, () => "d") } }),
    /deliverables exceeds 10 entries/,
  );
});

test("a role is framing and says so; it never claims authority", () => {
  const contract = normalizeContract({
    role: {
      name: "project manager",
      mission: "Sequence the work and name the dependencies.",
      deliverables: ["An ordered plan"],
      boundaries: ["Do not decide product priority"],
    },
  });
  const framing = renderRoleFraming(contract.role);
  assert.match(framing, /BEGIN ROLE FRAMING/);
  assert.match(framing, /END ROLE FRAMING/);
  assert.match(framing, /\| Role: project manager/);
  assert.match(framing, /\| Mission: Sequence the work/);
  assert.match(framing, /\| - An ordered plan/);
  assert.match(framing, /\| - Do not decide product priority/);
  assert.match(framing, /not a capability grant/);
  assert.match(framing, /quoted with '\|'/);
});

test("role text cannot forge prompt structure or smuggle control characters", () => {
  const contract = normalizeContract({
    role: { name: "auditor\u0000\u001b[31m", mission: "line one\nline two\r\nline three\u0007" },
  });
  assert.equal(contract.role.name, "auditor [31m");
  assert.doesNotMatch(contract.role.name, /[\u0000\u001b\u0007]/);
  // A mission may span lines, but carriage returns and other controls are normalized away.
  assert.equal(contract.role.mission, "line one\nline two\nline three");

  // Separators and invisible characters that could make text render unlike what it says.
  const sneaky = normalizeContract({
    role: {
      name: "admin\u202Eresu\u200b",
      mission: "first\u2028second\u2029third\u0085fourth\ufeff",
      deliverables: ["a\u2060b"],
    },
  });
  assert.doesNotMatch(sneaky.role.name, /[\u202e\u200b]/u);
  assert.doesNotMatch(sneaky.role.mission, /[\u2028\u2029\u0085\ufeff]/u);
  assert.doesNotMatch(sneaky.role.deliverables[0], /\u2060/u);
  // Real line structure survives sanitization; forged separators become ordinary lines.
  assert.equal(sneaky.role.mission, "first\nsecond\nthird\nfourth");
  const framing = renderRoleFraming(contract.role);
  assert.doesNotMatch(framing, /[\u0000\u001b\u0007]/);
});

test("oversized role text is bounded rather than rejected outright", () => {
  const contract = normalizeContract({
    role: { name: "n".repeat(500), mission: "m".repeat(5000), boundaries: ["b".repeat(1000)] },
  });
  assert.equal(contract.role.name.length, 80);
  assert.equal(contract.role.mission.length, 2000);
  assert.equal(contract.role.boundaries[0].length, 300);
});

test("no role means no framing and no fleet role override", () => {
  assert.equal(renderRoleFraming(undefined), undefined);
  assert.equal(resolveContract(normalizeContract({}), PARENT).role, undefined);
});

test("resolve always re-normalizes so a tampered thinking field cannot ride through", () => {
  assert.throws(
    () => resolveContract({ thinking: "turbo", route: "auto" }, PARENT),
    /thinking mode is invalid/,
  );
  assert.throws(
    () => resolveContract({ thinking: "high", route: "magic" }, PARENT),
    /route mode is invalid/,
  );
  const dirty = resolveContract({
    thinking: "high",
    route: "auto",
    role: { name: "reviewer\u0007", mission: "keep secrets\u001b[0m" },
  }, PARENT);
  assert.equal(dirty.role.name, "reviewer");
  assert.doesNotMatch(dirty.role.mission, /[\u001b\u0007]/);
});

test("a stored contract must name both axes; a partial object is not auto", () => {
  assert.equal(assertStoredContract(undefined), undefined);
  assert.throws(() => assertStoredContract({ route: "auto" }), /must include thinking and route/);
  assert.throws(() => assertStoredContract({ thinking: "high" }), /must include thinking and route/);
  assert.throws(() => assertStoredContract({ thinking: "turbo", route: "auto" }), /thinking mode is invalid/);
  const stored = assertStoredContract({ thinking: "low", route: "inherit_model", role: { name: "reviewer" } });
  assert.equal(stored.thinking, "low");
  assert.equal(stored.route, "inherit_model");
  assert.equal(stored.role.schemaVersion, 1);
});
