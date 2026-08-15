import assert from "node:assert/strict";
import test from "node:test";
import { captureLosslessJson } from "../src/lossless-json.mjs";

test("lossless capture detaches, freezes, sorts keys, and preserves __proto__ as data", () => {
  const shared = { value: 1 };
  const source = Object.create(null);
  source.z = shared;
  source.__proto__ = { safe: true };
  source.a = shared;

  const captured = captureLosslessJson(source);
  shared.value = 2;

  assert.equal(captured.canonical, '{"__proto__":{"safe":true},"a":{"value":1},"z":{"value":1}}');
  assert.equal(Object.getPrototypeOf(captured.value), Object.prototype);
  assert.equal(Object.hasOwn(captured.value, "__proto__"), true);
  assert.deepEqual(captured.value.__proto__, { safe: true });
  assert.deepEqual(captured.value.a, { value: 1 });
  assert.deepEqual(captured.value.z, { value: 1 });
  assert.equal(Object.isFrozen(captured.value), true);
  assert.equal(Object.isFrozen(captured.value.a), true);
});

test("lossless capture enforces configured depth, node, and byte bounds", () => {
  assert.throws(
    () => captureLosslessJson({ a: { b: { c: true } } }, { maxDepth: 2 }),
    /depth limit/,
  );
  assert.throws(
    () => captureLosslessJson([1, 2, 3], { maxNodes: 3 }),
    /node limit/,
  );
  assert.throws(
    () => captureLosslessJson("x".repeat(20), { maxBytes: 10 }),
    /byte limit/,
  );
});

test("lossless capture rejects hidden and symbol-owned data", () => {
  const hidden = Object.defineProperty({}, "secret", { value: "x" });
  const symbol = { [Symbol("secret")]: "x" };
  assert.throws(() => captureLosslessJson(hidden), /non-enumerable/);
  assert.throws(() => captureLosslessJson(symbol), /symbol properties/);
});
