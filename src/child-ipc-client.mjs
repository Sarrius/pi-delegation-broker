import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const METHODS = new Set(["requestChild", "cancelChild"]);

export function requestChildIpc(method, params, { signal, timeoutMs = 15_000 } = {}) {
  if (!METHODS.has(method)) return Promise.reject(new Error("child IPC method is not allowed"));
  const socketPath = process.env.PI_BROKER_SOCKET;
  const authorization = process.env.PI_BROKER_CAPABILITY;
  if (!socketPath || !authorization) return Promise.reject(new Error("child broker capability is unavailable"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("child broker request timed out")), timeoutMs);
    timer.unref?.();
    const abort = () => finish(new Error("child broker request cancelled"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params: params ?? {}, authorization })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(new Error("child broker response too large"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line);
        if (!response || response.id !== id) return finish(new Error("child broker response id mismatch"));
        if (response.ok !== true) return finish(new Error(typeof response.error === "string" ? response.error.slice(0, 2000) : "child broker request denied"));
        return finish(undefined, response.result);
      } catch { return finish(new Error("child broker response was invalid")); }
    });
    socket.on("error", () => finish(new Error("child broker IPC unavailable")));
    socket.on("close", () => { if (!settled) finish(new Error("child broker IPC closed")); });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
