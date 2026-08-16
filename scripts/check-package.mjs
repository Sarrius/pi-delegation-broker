import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const packed = JSON.parse(output);
if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) throw new Error("npm pack did not return one package file manifest");
const names = packed[0].files.map((file) => file.path);
const forbidden = /(^|\/)(?:test|tests|patches|evidence|node_modules)(?:\/|$)|(?:^|\/)(?:auth\.json|.*\.sqlite(?:-wal|-shm)?|.*\.log|.*\.patch)$/i;
const leaked = names.filter((name) => forbidden.test(name));
if (leaked.length) throw new Error(`Refusing package with non-public artifacts: ${leaked.join(", ")}`);
for (const required of ["package.json", "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "docs/INTEGRATION.md", "docs/LIVE-VALIDATION-PLAN.md", "src/index.mjs"]) {
  if (!names.includes(required)) throw new Error(`npm package is missing required file: ${required}`);
}
const unpackedSize = packed[0].unpackedSize;
// The raw provider transport is intentionally source-shipped and independently
// auditable rather than hidden in a generated artifact. Keep a bounded package
// budget while allowing one reviewed streaming adapter, a source-auditable Pi
// behavioral enforcement extension, the fixed controller acceptance verifier,
// their protocol docs, controller receipt authority, and narrowly scoped
// controller-only route/credential configuration primitives.
if (!Number.isSafeInteger(unpackedSize) || unpackedSize > 384 * 1024) throw new Error(`npm package is unexpectedly large: ${unpackedSize}`);
const packageJson = statSync(join(root, "package.json"));
if ((packageJson.mode & 0o022) !== 0) throw new Error("package.json permissions must not grant group/other write access");
console.log(`package check: pass (${names.length} files, ${unpackedSize} bytes unpacked)`);
