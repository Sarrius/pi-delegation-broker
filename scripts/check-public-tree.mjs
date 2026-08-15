import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const publicRoots = ["src", "docs/INTEGRATION.md", "README.md", "SECURITY.md", "CHANGELOG.md", "LICENSE", "package.json"];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /CANARY_SECRET_[A-Za-z0-9_-]+/,
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
  }
}
console.log("public-tree check: pass");
