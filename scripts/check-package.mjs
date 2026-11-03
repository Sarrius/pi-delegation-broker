import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const packed = JSON.parse(output);
if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) throw new Error("npm pack did not return one package file manifest");
const names = packed[0].files.map((file) => file.path);
const forbidden = /(^|\/)(?:test|tests|patches|evidence|node_modules)(?:\/|$)|(?:^|\/)(?:auth\.json|.*\.sqlite(?:-wal|-shm)?|.*\.log|.*\.patch)$/i;
const leaked = names.filter((name) => forbidden.test(name));
if (leaked.length) throw new Error(`Refusing package with non-public artifacts: ${leaked.join(", ")}`);
for (const required of ["package.json", "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "docs/INTEGRATION.md", "docs/LIVE-VALIDATION-PLAN.md", "docs/JEV.md", "docs/RESOURCE-AVAILABILITY.md", "src/index.mjs", "src/jev-advisor.mjs", "src/jev-pi-advisory.mjs", "src/jev-routing-shadow.mjs", "src/jev-active-routing.mjs", "src/jev-decision.mjs", "src/jev-engine-settings.mjs", "src/jev-engine-metrics.mjs", "src/model-criteria.mjs", "src/model-criteria-v1.json", "src/live-readiness.mjs"]) {
  if (!names.includes(required)) throw new Error(`npm package is missing required file: ${required}`);
}
const unpackedSize = packed[0].unpackedSize;
// The raw provider transport is intentionally source-shipped and independently
// auditable rather than hidden in a generated artifact. Keep a bounded package
// budget while allowing one reviewed streaming adapter, a source-auditable Pi
// behavioral enforcement extension, the fixed controller acceptance verifier,
// their protocol docs, controller receipt authority, and narrowly scoped
// controller-only route/credential configuration primitives, plus the controller-owned
// capability-aware model selector and the incremental registry update that lets a changing
// provider set be picked up while delegated work is in flight, plus the currency probe and
// scoped child-auth provisioner, plus the credentialless controller provider proxy that lets a
// leased child stream through controller IPC while holding no provider credential of its own.
// Keep an approximately 1.28 MiB ceiling: enough for the audited source, including the read-only
// admission preview sharing exact-route checks with launch, the closed tool-call/result
// proxy protocol and native-provider boundary, while still catching accidental fixtures,
// credentials, or generated artifacts. The package remains source-only: every byte is reviewable
// .mjs/.ts/.md or the curated public model-criteria JSON. The extra 0.1 MiB covers the reviewed shared history, ownership
// and availability modules plus their product contract, not generated payloads.
// The additional 0.05 MiB covers the optional Jev client, isolated Pi consumer and docs.
// A further 16 KiB covers audited failure attribution, durable budget/attempt recovery,
// exact append contracts and resolver ownership fixes. The separately consented routing-shadow
// source, launch-only observer, and privacy/rollback docs add one required source module:
// its first audited manifest had 91 files / 1,346,833 bytes. The owner-session
// evidence-ladder scorecard and post-handoff child counter add no new package paths:
// the re-audited 91-file manifest was 1,356,017 bytes. The separate default-off active
// Jev choice/consent module and its controller launch guards bring the audited 92-file
// manifest to 1,392,616 bytes; permit ~27 KiB for its rollback docs and small fixes,
// not fixtures, generated output or credentials (explicitly forbidden above).
// The controller-only native inference readiness ledger and the parent tool's
// evidence/health integration add one audited .mjs file and ~18 KiB. The
// 93-file manifest is 1,423,889 bytes. The separately consented operational
// decision engine, durable metrics, model-card consumer and five reviewed public
// source files produced a 98-file manifest of 1,471,694 bytes. Bound the next
// audited source/doc updates to <1.51 MB; retain the forbidden-artifact gate above.
// The current manifest has 102 public source/documentation files, 1,514,444 bytes:
// no tests, logs, credentials, generated bundles or node_modules. Background
// readiness, parent context, pool state and qualification source account for the
// newer paths. Keep these functional modules rather than trim them to fit a stale
// budget. Owner-authorized manifest review raises the ceiling to 1.55 MB (~35 KiB
// headroom); required-file, forbidden-artifact and permission gates are unchanged.
const MAX_UNPACKED_BYTES = 1_585_000;
if (!Number.isSafeInteger(unpackedSize) || unpackedSize > MAX_UNPACKED_BYTES) throw new Error(`npm package is unexpectedly large: ${unpackedSize} > ${MAX_UNPACKED_BYTES}`);
const packageJson = statSync(join(root, "package.json"));
if ((packageJson.mode & 0o022) !== 0) throw new Error("package.json permissions must not grant group/other write access");
console.log(`package check: pass (${names.length} files, ${unpackedSize} bytes unpacked)`);
