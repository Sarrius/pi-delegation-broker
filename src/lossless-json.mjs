const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 50_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function limits(options) {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) throw new Error("lossless JSON maxDepth must be an integer between 1 and 1000");
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000_000) throw new Error("lossless JSON maxNodes must be an integer between 1 and 1000000");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error("lossless JSON maxBytes must be an integer between 1 and 67108864");
  return { maxDepth, maxNodes, maxBytes };
}

function plainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("lossless JSON accessors are not allowed");
  return descriptor.value;
}

function assign(destination, value) {
  if (destination.kind === "root") destination.box.value = value;
  else if (destination.kind === "array") destination.target[destination.index] = value;
  else {
    Object.defineProperty(destination.target, destination.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function freezeDeep(value) {
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    Object.freeze(current);
    for (const key of Object.keys(current)) pending.push(current[key]);
  }
  return value;
}

function canonicalizeSnapshot(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeSnapshot).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeSnapshot(value[key])}`).join(",")}}`;
}

/**
 * Capture one bounded, detached, deeply frozen value that survives JSON
 * round-trip without semantic loss. Accessors and exotic containers are
 * rejected rather than invoked. The returned canonical string is derived from
 * the detached snapshot and is therefore safe to hash or sign.
 */
export function captureLosslessJson(input, options) {
  const { maxDepth, maxNodes, maxBytes } = limits(options);
  const root = { value: undefined };
  const ancestors = new Set();
  const tasks = [{ kind: "visit", value: input, depth: 0, destination: { kind: "root", box: root } }];
  let nodes = 0;
  let observedBytes = 0;

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task.kind === "leave") {
      ancestors.delete(task.value);
      continue;
    }
    const { value, depth, destination } = task;
    nodes += 1;
    if (nodes > maxNodes) throw new Error("lossless JSON node limit exceeded");
    if (depth > maxDepth) throw new Error("lossless JSON depth limit exceeded");

    if (value === null || typeof value === "boolean") {
      observedBytes += 5;
      assign(destination, value);
      continue;
    }
    if (typeof value === "string") {
      observedBytes += Buffer.byteLength(value);
      if (observedBytes > maxBytes) throw new Error("lossless JSON byte limit exceeded");
      assign(destination, value);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("lossless JSON numbers must be finite and not negative zero");
      observedBytes += 24;
      assign(destination, value);
      continue;
    }
    if (!value || typeof value !== "object") throw new Error("lossless JSON contains an unsupported value");
    if (ancestors.has(value)) throw new Error("lossless JSON cycles are not allowed");

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("lossless JSON arrays must use Array.prototype");
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string")) throw new Error("lossless JSON symbol properties are not allowed");
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) throw new Error("lossless JSON arrays must be dense and undecorated");
      const target = [];
      assign(destination, target);
      ancestors.add(value);
      tasks.push({ kind: "leave", value });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(value, index)) throw new Error("lossless JSON arrays must be dense and undecorated");
        tasks.push({
          kind: "visit",
          value: dataProperty(value, String(index)),
          depth: depth + 1,
          destination: { kind: "array", target, index },
        });
      }
      continue;
    }

    if (!plainObject(value)) throw new Error("lossless JSON objects must be plain or null-prototype records");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error("lossless JSON symbol properties are not allowed");
    for (const key of keys) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) throw new Error("lossless JSON non-enumerable properties are not allowed");
      observedBytes += Buffer.byteLength(key);
      if (observedBytes > maxBytes) throw new Error("lossless JSON byte limit exceeded");
    }
    const target = {};
    assign(destination, target);
    ancestors.add(value);
    tasks.push({ kind: "leave", value });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      tasks.push({
        kind: "visit",
        value: dataProperty(value, key),
        depth: depth + 1,
        destination: { kind: "object", target, key },
      });
    }
  }

  const canonical = canonicalizeSnapshot(root.value);
  const bytes = Buffer.byteLength(canonical);
  if (bytes > maxBytes) throw new Error("lossless JSON byte limit exceeded");
  return Object.freeze({ value: freezeDeep(root.value), canonical, bytes, nodes });
}
