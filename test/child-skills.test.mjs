import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeContract, resolveContract } from "../src/child-contract.mjs";
import {
  assertStoredSkills, MAX_SKILL_BYTES, MAX_SKILLS, normalizeSkills, reviewSkills,
} from "../src/child-skills.mjs";
import { disposeBrokeredChildProcesses, spawnBrokeredChild } from "../src/child-launcher.mjs";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function fixture(root, name, body) {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

test("reviewSkills canonicalizes, hashes and caps; relative paths fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  try {
    const path = fixture(root, "guide.md", "# Reviewer\nCheck the diff.\n");
    const [skill] = reviewSkills([path]);
    assert.equal(skill.path, realpathSync(path));
    assert.equal(skill.digest, sha256(readFileSync(path)));
    assert.equal(skill.bytes, readFileSync(path).length);

    assert.throws(() => reviewSkills(["guide.md"]), /absolute filesystem path/);
    assert.throws(
      () => reviewSkills(Array.from({ length: MAX_SKILLS + 1 }, (_, i) => fixture(root, `s${i}.md`, "x"))),
      /at most/,
    );
    assert.throws(() => reviewSkills([fixture(root, "huge.md", "x".repeat(MAX_SKILL_BYTES + 1))]), /exceeds/);
    assert.throws(() => reviewSkills([path, path]), /duplicated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an attested digest that no longer matches the file is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-mutate-"));
  try {
    const path = fixture(root, "guide.md", "original");
    const [skill] = reviewSkills([path]);
    writeFileSync(path, "mutated");
    assert.throws(() => reviewSkills([skill]), /does not match the attested digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stored skill identities are shape-checked without reading the file", () => {
  const attested = [{ path: "/tmp/guide.md", digest: "a".repeat(64), bytes: 12 }];
  assert.deepEqual(assertStoredSkills(attested), attested);
  assert.throws(() => assertStoredSkills([{ path: "/tmp/guide.md", digest: "nope", bytes: 1 }]), /digest/);
  assert.throws(() => assertStoredSkills(["/tmp/guide.md"]), /path, sha256 digest and byte size/);
});

test("a contract skill is guidance: it never becomes a tool grant", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-contract-"));
  try {
    const path = fixture(root, "reviewer.md", "Review patches. Do not merge.");
    const contract = normalizeContract({ thinking: "low", route: "auto", skills: [path] });
    assert.equal(contract.skills.length, 1);
    assert.equal(contract.skills[0].path, realpathSync(path));
    assert.equal("tools" in contract, false);
    const resolved = resolveContract(contract, {});
    assert.equal(resolved.skills[0].digest, contract.skills[0].digest);
    assert.deepEqual(normalizeSkills(contract.skills), contract.skills);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child argv keeps --no-skills and then lists only reviewed --skill paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "skills-launch-"));
  let argv;
  const signals = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const exitListeners = [];
  const rpc = {
    exited,
    onEvent() {},
    onExit(listener) { exitListeners.push(listener); },
    async request(message) {
      if (message.type === "get_state") {
        return { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" };
      }
      throw new Error("unexpected request");
    },
    send() {},
    stderrTail() { return ""; },
    kill(signal) {
      signals.push(signal);
      const event = { code: null, signal };
      for (const listener of exitListeners) listener(event);
      resolveExit(event);
    },
  };
  try {
    const path = fixture(root, "guide.md", "Be precise.");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const skill = reviewSkills([path])[0];
    const spawned = await spawnBrokeredChild({
      spec: {
        model: "zai/glm-5.3", thinkingLevel: "off", appendSystemPrompt: "",
        skills: [skill],
      },
      parentCwd: root,
      sessionsDir: join(root, "sessions"),
      childPiEntry: process.execPath,
      launchPolicy: { offline: false },
      spawnRpc(command, options) {
        argv = command;
        const shim = JSON.parse(readFileSync(options.env.PI_SUBAGENT_SHIM_SPEC, "utf8"));
        writeFileSync(shim.toolReportPath, JSON.stringify({ activeTools: [] }));
        return rpc;
      },
    });
    assert.ok(spawned.session);
    assert.ok(argv.includes("--no-skills"), "ambient discovery stays disabled");
    const flag = argv.indexOf("--skill");
    assert.ok(flag >= 0, "reviewed skill is passed explicitly");
    assert.equal(argv[flag + 1], skill.path);
    assert.ok(argv.indexOf("--no-skills") < flag, "explicit --skill comes after the ambient disable");
    assert.equal(argv.filter((arg) => arg === "--skill").length, 1);
    await disposeBrokeredChildProcesses();
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    await disposeBrokeredChildProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn re-hashes attested skills and refuses a mutated file", async () => {
  const root = mkdtempSync(join(tmpdir(), "skills-spawn-mutate-"));
  try {
    const path = fixture(root, "guide.md", "original");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const skill = reviewSkills([path])[0];
    writeFileSync(path, "mutated");
    await assert.rejects(
      () => spawnBrokeredChild({
        spec: { model: "zai/glm-5.3", thinkingLevel: "off", appendSystemPrompt: "", skills: [skill] },
        parentCwd: root,
        sessionsDir: join(root, "sessions"),
        childPiEntry: process.execPath,
        launchPolicy: { offline: false },
        spawnRpc() { throw new Error("must not spawn after a digest mismatch"); },
      }),
      /does not match the attested digest/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewed skills without isolated discovery never reach argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "skills-no-isolate-"));
  try {
    const path = fixture(root, "guide.md", "Be precise.");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const skill = reviewSkills([path])[0];
    await assert.rejects(
      () => spawnBrokeredChild({
        spec: { model: "zai/glm-5.3", thinkingLevel: "off", appendSystemPrompt: "", skills: [skill] },
        parentCwd: root,
        sessionsDir: join(root, "sessions"),
        childPiEntry: process.execPath,
        spawnRpc() { throw new Error("must not spawn without isolated discovery"); },
      }),
      /isolated discovery/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
