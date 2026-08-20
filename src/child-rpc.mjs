import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const STDERR_TAIL_MAX = 4_096;
const RPC_MAX_FRAME_CHARS = 8 * 1024 * 1024;
const RPC_FRAME_TYPE_PREFIX_CHARS = 256;
const MAX_DISCARDED_FRAME_CHARS = 512 * 1024 * 1024;
const SETTLE_AFTER_EXIT_MS = 250;

function observeRejection(promise) {
  promise.catch(() => undefined);
  return promise;
}

export class RpcChannelClosedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RpcChannelClosedError";
  }
}

export class RpcFrameTooLargeError extends RpcChannelClosedError {
  constructor(message) {
    super(message);
    this.name = "RpcFrameTooLargeError";
  }
}

export function spawnChildRpc(command, options) {
  const [binary, ...args] = command;
  if (!binary) throw new Error("Child RPC spawn requires a non-empty command");
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const pending = new Map();
  const eventListeners = new Set();
  const exitListeners = new Set();
  let exitInfo;
  let channelDone = false;
  let stderr = "";
  let requestId = 0;
  let stdoutBuffer = "";
  let discardedFrameChars;
  let discardedFrameType;
  let totalDiscardedFrameChars = 0;
  let channelFailure;
  const stdoutDecoder = new StringDecoder("utf8");

  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  let settleGrace;

  function killProcessGroup(signal) {
    try {
      if (child.pid === undefined) throw new Error("child pid unavailable");
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });

  child.stdout.on("data", (chunk) => {
    if (channelFailure !== undefined) return;
    try {
      drainStdoutLines(stdoutDecoder.write(chunk));
    } catch (error) {
      failChannel({ code: null, signal: null }, `Child RPC stdout handler failed: ${error.message}`);
    }
  });

  function drainStdoutLines(decoded = "", endOfStream = false) {
    if (channelFailure !== undefined) return;
    let offset = 0;
    while (offset < decoded.length) {
      if (discardedFrameChars !== undefined) {
        const newline = decoded.indexOf("\n", offset);
        const end = newline === -1 ? decoded.length : newline;
        if (discardFrameCharacters(end - offset)) return;
        if (newline === -1) break;
        offset = newline + 1;
        discardedFrameChars = undefined;
        discardedFrameType = undefined;
        continue;
      }
      const newline = decoded.indexOf("\n", offset);
      const end = newline === -1 ? decoded.length : newline;
      const segmentLength = end - offset;
      if (stdoutBuffer.length + segmentLength > RPC_MAX_FRAME_CHARS) {
        const characters = stdoutBuffer.length + segmentLength;
        const prefix = stdoutBuffer.length >= RPC_FRAME_TYPE_PREFIX_CHARS
          ? stdoutBuffer.slice(0, RPC_FRAME_TYPE_PREFIX_CHARS)
          : stdoutBuffer + decoded.slice(offset, offset + RPC_FRAME_TYPE_PREFIX_CHARS - stdoutBuffer.length);
        const frameType = /"type":"([^"\\]*)"/.exec(prefix)?.[1];
        stdoutBuffer = "";
        if (frameType === undefined || prefix.includes('"type":"response"')) {
          failOversizedFrame(characters);
          return;
        }
        discardedFrameChars = 0;
        discardedFrameType = frameType;
        if (discardFrameCharacters(characters)) return;
        if (newline === -1) break;
        offset = newline + 1;
        continue;
      }
      stdoutBuffer += decoded.slice(offset, end);
      if (newline === -1) break;
      const line = stdoutBuffer.trim();
      stdoutBuffer = "";
      if (line.length > 0) {
        let message;
        try { message = JSON.parse(line); } catch { message = undefined; }
        if (message) handleMessage(message);
        if (channelFailure !== undefined) return;
      }
      offset = newline + 1;
    }
    if (endOfStream && discardedFrameChars !== undefined) {
      discardedFrameChars = undefined;
      discardedFrameType = undefined;
    }
  }

  function discardFrameCharacters(characters) {
    if (discardedFrameChars === undefined) return false;
    discardedFrameChars += characters;
    totalDiscardedFrameChars += characters;
    if (totalDiscardedFrameChars <= MAX_DISCARDED_FRAME_CHARS) return false;
    failChannel({ code: null, signal: null }, `Child RPC oversized-frame discard total exceeded ${MAX_DISCARDED_FRAME_CHARS} characters`);
    return true;
  }

  function failOversizedFrame(characters) {
    failChannel({ code: null, signal: null }, `Child RPC frame exceeded ${RPC_MAX_FRAME_CHARS}-character cap (${characters} observed)`);
  }

  function handleMessage(message) {
    if (channelFailure !== undefined) return;
    if (message.type === "response" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) return;
      if (message.command !== request.command || typeof message.success !== "boolean") {
        failChannel({ code: null, signal: null }, `Malformed RPC response for ${request.command}`);
        return;
      }
      pending.delete(message.id);
      if (request.timer) clearTimeout(request.timer);
      if (message.success) {
        request.onResponse?.(message.data);
        request.resolve(message.data);
      } else {
        request.reject(new Error(typeof message.error === "string" ? message.error : `RPC ${request.command} failed`));
      }
      return;
    }
    if (typeof message.type === "string") {
      for (const listener of eventListeners) {
        try { listener(message); } catch { eventListeners.delete(listener); }
      }
    }
  }

  function closeRequestPlane(failure) {
    if (channelFailure !== undefined) return;
    channelFailure = failure;
    stdoutBuffer = "";
    discardedFrameChars = undefined;
    discardedFrameType = undefined;
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
  }

  function settleChannel(result, reason) {
    if (settleGrace) { clearTimeout(settleGrace); settleGrace = undefined; }
    if (channelDone) return;
    channelDone = true;
    exitInfo ??= result;
    closeRequestPlane(channelFailure ?? new RpcChannelClosedError(
      `${reason ? reason + ". " : ""}Child channel closed (code ${exitInfo.code ?? "null"}, signal ${exitInfo.signal ?? "null"}). Stderr: ${stderr || "(empty)"}`,
    ));
    resolveExited(exitInfo);
    for (const listener of exitListeners) {
      try { listener(exitInfo); } catch { /* ignore */ }
    }
    exitListeners.clear();
  }

  function failChannel(result, reason, failure) {
    closeRequestPlane(failure ?? new RpcChannelClosedError(reason));
    stderr = (stderr + `\n${reason}`).slice(-STDERR_TAIL_MAX);
    const processGone = exitInfo !== undefined || child.exitCode !== null || child.signalCode !== null;
    if (!processGone) killProcessGroup("SIGKILL");
    if (child.pid === undefined) settleChannel(result, reason);
  }

  child.on("exit", (code, signal) => {
    exitInfo ??= { code, signal };
    if (!channelDone && !settleGrace) {
      settleGrace = setTimeout(() => settleChannel(exitInfo ?? { code, signal }), SETTLE_AFTER_EXIT_MS);
      settleGrace.unref?.();
    }
  });
  child.on("close", (code, signal) => {
    try {
      drainStdoutLines(stdoutDecoder.end(), true);
    } catch (error) {
      failChannel({ code: null, signal: null }, `Child RPC stdout close handler failed: ${error.message}`);
    }
    settleChannel(exitInfo ?? { code, signal });
  });
  child.on("error", (error) => failChannel({ code: null, signal: null }, `child spawn error: ${error.message}`));
  child.stdin.on("error", (error) => failChannel({ code: null, signal: null }, `child stdin error: ${error.message}`));

  return Object.freeze({
    request(command, requestOptions = {}) {
      if (channelFailure !== undefined) return observeRejection(Promise.reject(channelFailure));
      const id = `req-${++requestId}`;
      const promise = new Promise((resolve, reject) => {
        const entry = { command: command.type, resolve, reject, onResponse: requestOptions.onResponse };
        if (requestOptions.timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(new Error(`Child RPC ${command.type} timed out after ${requestOptions.timeoutMs}ms`));
          }, requestOptions.timeoutMs);
          entry.timer.unref?.();
        }
        pending.set(id, entry);
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (!error) return;
          failChannel({ code: null, signal: null }, `Child RPC request write failed: ${error.message}`);
        });
      });
      // stdout can reject this from the I/O callback before the caller attaches `await`.
      // Node then converts unhandledRejection into uncaughtException and Pi's interactive
      // session exits (“No API key found for cursor”). A sink here does not swallow the
      // rejection for an actual awaiter — both handlers fire.
      return observeRejection(promise);
    },
    send(message) {
      if (channelFailure !== undefined) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        failChannel({ code: null, signal: null }, `Child RPC send write failed: ${error.message}`);
      });
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit(listener) {
      if (channelDone && exitInfo) { listener(exitInfo); return () => {}; }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    kill(signal = "SIGKILL") {
      if (!channelDone && child.exitCode === null && child.signalCode === null && child.pid !== undefined) killProcessGroup(signal);
    },
    exited,
    stderrTail: () => stderr,
  });
}