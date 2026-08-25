import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!Array.isArray(packageJson.files) || packageJson.files.some((path) => typeof path !== "string" || !path)) {
  throw new Error("package.json files allowlist is missing or malformed");
}
const publicRoots = [...new Set([...packageJson.files, "package.json"])];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /CANARY_SECRET_[A-Za-z0-9_-]+/,
];
const personalPatterns = [
  /@gmail\.com/i,
  new RegExp(["vitalij", "simko"].join(""), "i"),
  new RegExp(["jrnl", "drive"].join(""), "i"),
  /\/Users\/(?!example|runner|shared)[A-Za-z]/,
];

function files(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => files(join(path, entry.name)));
}

for (const relative of publicRoots) {
  const path = join(root, relative);
  for (const file of files(path)) {
    const text = readFileSync(file, "utf8");
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Potential secret marker found in publishable file: ${file}`);
    }
    if (personalPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Personal identifier found in publishable file: ${file}`);
    }
  }
}
console.log("public-tree check: pass");
