import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const skip = /\.(png|jpe?g|gif|webp|woff2?|sqlite|lock)$/i;
const allowedUsers = new Set(["example", "runner", "shared"]);
const allowedHome = new Set(["u", "runner"]);
const machineUser = ["vitalij", "simko"].join("");
const accountNick = ["jrnl", "drive"].join("");
const mailLocal = ["vitalii", ".shymko"].join("");
const patterns = [
  { id: "personal-mailbox", re: /@[A-Za-z0-9.-]*\b(gmail|icloud|me|outlook|hotmail|yahoo)\.com\b/gi },
  { id: "machine-username", re: new RegExp(machineUser, "gi") },
  { id: "personal-local-part", re: new RegExp(mailLocal.replace(".", "\\."), "gi") },
  { id: "account-nick", re: new RegExp(accountNick, "gi") },
];

const hits = [];
for (const rel of tracked) {
  if (skip.test(rel)) continue;
  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch {
    continue;
  }
  for (const { id, re } of patterns) {
    if (re.test(text)) hits.push(`${rel}: ${id}`);
  }
  for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
    if (!allowedUsers.has(match[1].toLowerCase())) hits.push(`${rel}: absolute-macos-home (${match[1]})`);
  }
  for (const match of text.matchAll(/\/home\/([A-Za-z0-9._-]+)/g)) {
    if (!allowedHome.has(match[1].toLowerCase())) hits.push(`${rel}: absolute-linux-home (${match[1]})`);
  }
}

if (hits.length) {
  throw new Error(
    `Refusing personal identifiers in tracked files:\n  ${[...new Set(hits)].join("\n  ")}\nUse example.com fixtures and relative or $HOME paths.`,
  );
}
console.log(`tracked-privacy check: pass (${tracked.length} files)`);
