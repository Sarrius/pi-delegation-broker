import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temp = mkdtempSync(join(tmpdir(), "pi-broker-install-check-"));
try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", temp], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) throw new Error("npm pack did not produce one tarball");
  writeFileSync(join(temp, "package.json"), '{"private":true}\n', { mode: 0o600 });
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, filename)], {
    cwd: temp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const installed = join(temp, "node_modules", "@sars267", "pi-delegation-broker");
  if (lstatSync(installed).isSymbolicLink()) {
    throw new Error(`clean install unexpectedly linked the package to ${readlinkSync(installed)}`);
  }
  for (const dependency of [join(temp, "node_modules", "typebox"), join(temp, "node_modules", "@earendil-works", "pi-ai")]) {
    if (!existsSync(dependency)) throw new Error(`declared runtime dependency was not installed: ${dependency}`);
  }
  const home = join(temp, "home");
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ packages: [installed], quietStartup: true })}\n`, { mode: 0o600 });
  writeFileSync(join(agent, "auth.json"), "{}\n", { mode: 0o600 });
  const localPi = join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const piBin = process.env.PI_BIN || (existsSync(localPi) ? localPi : "pi");
  const result = spawnSync(piBin, ["--mode", "rpc", "--offline", "--no-context-files", "--no-skills"], {
    cwd: temp,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent },
    input: `${JSON.stringify({ id: "installed-package", type: "get_state" })}\n`,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`installed Pi extension activation failed (${result.status})`);
  const events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const response = events.find((event) => event.type === "response" && event.id === "installed-package");
  if (!response?.success || events.some((event) => event.type === "extension_error")) {
    throw new Error("installed Pi extension did not activate cleanly");
  }
  console.log("installed-package check: pass (clean tarball install + Pi activation, no symlinks)");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
