import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChildRpc } from "./child-rpc.mjs";

const TOOL_REPORT_TIMEOUT_MS = 60_000;
const TOOL_REPORT_POLL_MS = 100;
const SHIM_SPEC_ENV = "PI_SUBAGENT_SHIM_SPEC";
const RECURSION_GUARD_TOOLS = ["subagent", "workflow"];
const ANSWER_REQUIRED_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const PROMPT_ACK_TIMEOUT_MS = 60_000;
const DISPOSE_KILL_GRACE_MS = 2_000;
const IMMEDIATE_COMPLETION_POLL_MS = 60;
const IMMEDIATE_COMPLETION_MAX_POLLS = 40;

function resolveChildPiEntry() {
  const invoked = process.argv[1];
  if (invoked) {
    try {
      const real = realpathSync(invoked);
      if (/[\\/]cli\.js$/.test(real)) return real;
    } catch { /* fall through */ }
  }
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    const index = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    return join(dirname(index), "cli.js");
  } catch {
    throw new Error("Cannot find pi-coding-agent entry: install @earendil-works/pi-coding-agent or set childPiEntry explicitly");
  }
}

function buildChildArgs(config) {
  for (const name of [...(config.tools ?? []), ...(config.excludeTools ?? [])]) {
    if (name.includes(",")) throw new Error(`Tool name ${JSON.stringify(name)} contains a comma`);
  }
  const excludeTools = [...new Set([...(config.excludeTools ?? []), ...RECURSION_GUARD_TOOLS])];
  const args = [
    "--mode", "rpc",
    ...(config.offline ? ["--offline"] : []),
    ...(config.isolatedDiscovery ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"] : []),
    ...(config.scopedModel ? ["--models", config.scopedModel] : []),
    "--provider", config.provider,
    "--model", config.modelId,
    "--thinking", config.thinkingLevel,
    "--session-dir", config.sessionDir,
    "--append-system-prompt", config.appendSystemPrompt,
    "--exclude-tools", excludeTools.join(","),
  ];
  if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
  if (config.forkSessionFile) args.push("--fork", config.forkSessionFile);
  if (config.shimPath) args.push("--extension", config.shimPath);
  for (const extensionPath of config.trustedExtensionPaths ?? []) args.push("--extension", extensionPath);
  return args;
}

function validateFile(path, label) {
  let isFile;
  try {
    isFile = statSync(path).isFile();
    accessSync(path, constants.R_OK);
  } catch (error) {
    throw new Error(`${label} ${JSON.stringify(path)} is not readable: ${error.message}`);
  }
  if (!isFile) throw new Error(`${label} ${JSON.stringify(path)} is not a regular file`);
}

async function awaitToolReport(rpc, path) {
  const deadline = Date.now() + TOOL_REPORT_TIMEOUT_MS;
  let exited = false;
  rpc.onExit(() => { exited = true; });
  for (;;) {
    let raw;
    try { raw = readFileSync(path, "utf8"); } catch { /* not yet */ }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.activeTools)) return { activeTools: parsed.activeTools.filter((n) => typeof n === "string") };
      } catch { /* corrupt, keep waiting */ }
    }
    if (exited) throw new Error(`Child pi process exited before reporting tools. Stderr: ${rpc.stderrTail() || "(empty)"}`);
    if (Date.now() > deadline) throw new Error(`Child did not report tools within ${TOOL_REPORT_TIMEOUT_MS / 1000}s. Stderr: ${rpc.stderrTail() || "(empty)"}`);
    await new Promise((resolve) => { const t = setTimeout(resolve, TOOL_REPORT_POLL_MS); t.unref?.(); });
  }
}

const KNOWN_ASSISTANT_UPDATE_TYPES = new Set([
  "start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error",
]);

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

class RpcChildSession {
  #rpc;
  #listeners = new Set();
  #latestAssistant;
  #usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  #sessionFile;
  #turn;
  #exitError;
  #disposal;
  #lifecycleEventsEnabled = false;

  constructor(rpc) {
    this.#rpc = rpc;
    rpc.onEvent((event) => {
      if (!this.#lifecycleEventsEnabled) return;
      this.#handleEvent(event);
    });
    rpc.onExit((exit) => {
      this.#exitError = new Error(`Child exited (code ${exit.code ?? "null"}, signal ${exit.signal ?? "null"}). Stderr: ${rpc.stderrTail() || "(empty)"}`);
      this.#turn?.fail?.(this.#exitError);
    });
  }

  static async start(rpc) {
    const session = new RpcChildSession(rpc);
    const state = await rpc.request({ type: "get_state" }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
    if (!isRecord(state) || typeof state.isStreaming !== "boolean" || typeof state.isCompacting !== "boolean"
      || typeof state.pendingMessageCount !== "number" || state.pendingMessageCount < 0) {
      throw new Error("Child RPC startup state was malformed");
    }
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) throw new Error("Child RPC startup state was not idle");
    if (session.#exitError) throw session.#exitError;
    session.#sessionFile = state.sessionFile;
    session.#lifecycleEventsEnabled = true;
    return session;
  }

  get sessionFile() { return this.#sessionFile; }
  get latestAssistantMessage() { return this.#latestAssistant; }
  get usage() { return { ...this.#usage }; }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(text) {
    if (this.#exitError) throw this.#exitError;
    if (this.#turn) throw new Error("Child already has a prompt running");
    const turn = { done: false, completion: null, acknowledged: false, runStarted: false };
    turn.completion = new Promise((resolve, reject) => { turn.resolve = resolve; turn.reject = reject; });
    turn.fail = (error) => { if (turn.done) return; turn.done = true; turn.reject(error); };
    turn.acknowledge = () => { turn.acknowledged = true; };
    turn.observeAcceptance = () => { turn.runStarted = true; };
    turn.observeSettlement = () => {
      if (turn.done || !turn.runStarted) return;
      turn.done = true; turn.resolve();
    };
    turn.observeImmediateCompletion = () => { if (turn.done) return; turn.done = true; turn.resolve(); };
    this.#turn = turn;
    try {
      await this.#rpc.request({ type: "prompt", message: text }, { timeoutMs: PROMPT_ACK_TIMEOUT_MS });
      turn.acknowledge();
      if (!turn.done) void this.#confirmImmediateCompletion(turn);
      await turn.completion;
    } catch (error) {
      turn.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (this.#turn === turn) this.#turn = undefined;
    }
  }

  async steer(text) {
    await this.#rpc.request({ type: "steer", message: text }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  }

  async abort() {
    if (this.#exitError) return;
    await this.#rpc.request({ type: "abort" }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  }

  clearLatestAssistant() { this.#latestAssistant = undefined; }

  async dispose() {
    if (this.#disposal) return this.#disposal;
    this.#disposal = Promise.resolve().then(async () => {
      this.#rpc.kill("SIGTERM");
      const escalate = setTimeout(() => this.#rpc.kill("SIGKILL"), DISPOSE_KILL_GRACE_MS);
      escalate.unref?.();
      try { await this.#rpc.exited; } finally { clearTimeout(escalate); }
    });
    return this.#disposal;
  }

  async #confirmImmediateCompletion(turn) {
    let idle = 0;
    for (let poll = 0; poll < IMMEDIATE_COMPLETION_MAX_POLLS; poll++) {
      await new Promise((resolve) => { const t = setTimeout(resolve, IMMEDIATE_COMPLETION_POLL_MS); t.unref?.(); });
      if (turn.done || turn.runStarted) return;
      let state;
      try {
        state = await this.#rpc.request({ type: "get_state" }, {
          timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
          onResponse: (candidate) => { if (isRecord(candidate) && candidate.isStreaming) turn.observeAcceptance(); },
        });
      } catch (error) {
        if (!turn.runStarted && !turn.done) turn.fail(new Error(`State read failed: ${error.message}`));
        return;
      }
      if (turn.done || turn.runStarted) return;
      if (state.isStreaming) { turn.observeAcceptance(); return; }
      if (state.isCompacting) { idle = 0; poll -= 1; continue; }
      if (state.pendingMessageCount > 0) { idle = 0; continue; }
      idle += 1;
      if (idle >= 2) { turn.observeImmediateCompletion(); return; }
    }
    turn.fail(new Error(`Child neither started an agent run nor settled within ${IMMEDIATE_COMPLETION_MAX_POLLS} polls`));
  }

  #handleEvent(event) {
    if (typeof event.type !== "string") return;
    if (event.type === "agent_start") { this.#turn?.observeAcceptance(); }
    if (event.type === "agent_settled") { this.#turn?.observeSettlement(); }
    if (event.type === "turn_end" || event.type === "message_start" || event.type === "message_end") {
      if (isRecord(event.message) && event.message.role === "assistant") {
        this.#latestAssistant = event.message;
        if (event.type === "message_end") {
          const u = isRecord(event.message.usage) ? event.message.usage : {};
          const c = isRecord(u.cost) ? u.cost : {};
          if (typeof u.input === "number") this.#usage.input += u.input;
          if (typeof u.output === "number") this.#usage.output += u.output;
          if (typeof u.cacheRead === "number") this.#usage.cacheRead += u.cacheRead;
          if (typeof u.cacheWrite === "number") this.#usage.cacheWrite += u.cacheWrite;
          if (typeof c.total === "number") this.#usage.cost += c.total;
          this.#usage.turns += 1;
        }
      }
    }
    for (const listener of this.#listeners) {
      try { listener(event); } catch { this.#listeners.delete(listener); }
    }
  }
}

/**
 * Spawn one isolated Pi child process with broker-gated launch policy.
 * Returns { session, resolved } or throws before any child side-effect if
 * validation fails. The broker resolver decides allow/deny before this call.
 */
export async function spawnBrokeredChild({ spec, parentCwd, sessionsDir, childPiEntry, shimPath, launchPolicy, forkSessionFile, spawnRpc = spawnChildRpc }) {
  const cwd = spec.cwd ?? parentCwd;
  let isDir;
  try { isDir = statSync(cwd).isDirectory(); accessSync(cwd, constants.X_OK); }
  catch (error) { throw new Error(`Child cwd ${JSON.stringify(cwd)} is not usable: ${error.message}`); }
  if (!isDir) throw new Error(`Child cwd ${JSON.stringify(cwd)} is not a directory`);

  const entry = childPiEntry ?? resolveChildPiEntry();
  validateFile(entry, "Child pi CLI entry");
  if (shimPath) validateFile(shimPath, "Child shim");
  if (forkSessionFile) validateFile(forkSessionFile, "Fork session file");

  const model = spec.model ?? "broker-fake/lease-fake";
  const slash = model.indexOf("/");
  if (slash < 1) throw new Error(`Model must be "provider/model-id", got ${JSON.stringify(model)}`);
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);

  const args = buildChildArgs({
    provider, modelId,
    thinkingLevel: spec.thinkingLevel ?? "off",
    tools: spec.tools,
    excludeTools: spec.excludeTools,
    sessionDir: sessionsDir,
    forkSessionFile,
    appendSystemPrompt: spec.appendSystemPrompt ?? "",
    shimPath,
    ...(launchPolicy ? {
      trustedExtensionPaths: launchPolicy.extensionPaths,
      isolatedDiscovery: true,
      scopedModel: `${provider}/${modelId}`,
      offline: launchPolicy.offline ?? false,
    } : {}),
  });

  const shimDir = join(dirname(sessionsDir), "shim");
  mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  const stem = join(shimDir, randomUUID());
  const toolReportPath = `${stem}.tools.json`;
  const specPath = `${stem}.spec.json`;
  writeFileSync(specPath, JSON.stringify({ schema: spec.schema, toolReportPath }), { mode: 0o600 });

  const env = launchPolicy?.environment
    ? { ...isolatedEnv(launchPolicy, specPath) }
    : { ...process.env, [SHIM_SPEC_ENV]: specPath };

  let rpc;
  try {
    rpc = spawnRpc([process.execPath, entry, ...args], { cwd, env });
  } catch (error) {
    rmSync(specPath, { force: true });
    rmSync(toolReportPath, { force: true });
    throw error;
  }

  void rpc.exited.then(() => {
    rmSync(specPath, { force: true });
    rmSync(toolReportPath, { force: true });
  }).catch(() => undefined);

  try {
    rpc.onEvent((event) => {
      if (event.type !== "extension_ui_request" || typeof event.id !== "string") return;
      if (ANSWER_REQUIRED_UI_METHODS.has(event.method)) rpc.send({ type: "extension_ui_response", id: event.id, cancelled: true });
    });

    const report = await awaitToolReport(rpc, toolReportPath);
    const guardBreach = report.activeTools.filter((name) => RECURSION_GUARD_TOOLS.includes(name));
    if (guardBreach.length > 0) throw new Error(`Recursion guard: child exposes ${guardBreach.join(", ")}`);

    const requiredTools = launchPolicy?.requiredActiveTools ?? [];
    const missing = requiredTools.filter((name) => !report.activeTools.includes(name));
    if (missing.length > 0) throw new Error(`Required active tools missing: ${missing.join(", ")}. Active: ${report.activeTools.join(", ") || "none"}`);

    const session = await RpcChildSession.start(rpc);
    return Object.freeze({
      session,
      resolved: Object.freeze({
        provider, modelId,
        thinkingLevel: spec.thinkingLevel ?? "off",
        tools: Object.freeze(report.activeTools),
        cwd,
        label: spec.label ?? "brokered-child",
      }),
    });
  } catch (error) {
    rpc.kill("SIGKILL");
    await rpc.exited;
    throw error;
  }
}

const SAFE_INHERITED_ENVIRONMENT = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
];

const ALLOWED_POLICY_ENVIRONMENT = new Set([
  "PI_BROKER_SOCKET", "PI_BROKER_LEASE_ID", "PI_BROKER_FENCING_TOKEN", "PI_BROKER_CAPABILITY",
]);

function isolatedEnv(policy, shimSpecPath) {
  const env = {};
  for (const key of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (policy.agentDir) env.PI_CODING_AGENT_DIR = policy.agentDir;
  for (const [key, value] of Object.entries(policy.environment ?? {})) {
    if (!ALLOWED_POLICY_ENVIRONMENT.has(key)) throw new Error(`Policy cannot set env ${key}`);
    env[key] = value;
  }
  env[SHIM_SPEC_ENV] = shimSpecPath;
  return env;
}