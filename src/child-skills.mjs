/**
 * Reviewed skill identities for brokered children.
 *
 * Ambient discovery stays off (`--no-skills`). The controller may then pass explicit `--skill`
 * paths. A skill is guidance, never authorization: it cannot add a tool, widen a lease, or turn
 * an observe child into an effect child. Stored identities include a content digest so a mutated
 * file cannot silently ride on a previously reviewed path.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const MAX_SKILLS = 8;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_SKILL_PATH = 4096;

function fail(message) { throw new Error(`child skills: ${message}`); }

const DIGEST = /^[0-9a-f]{64}$/;

function requestedPath(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.path === "string") return entry.path;
  fail("skill path is required");
}

function attested(entry) {
  return Boolean(entry && typeof entry === "object"
    && typeof entry.path === "string"
    && DIGEST.test(entry.digest)
    && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_SKILL_BYTES);
}

/** Shape-only check for durable records. Does not read the filesystem. */
export function assertStoredSkills(skills) {
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS) fail(`skills must be an array of at most ${MAX_SKILLS}`);
  const seen = new Set();
  for (const entry of skills) {
    if (!attested(entry)) fail("skill identity must include path, sha256 digest and byte size");
    if (!isAbsolute(entry.path) || entry.path.length > MAX_SKILL_PATH || entry.path.includes("\0")) {
      fail("skill path must be an absolute filesystem path");
    }
    if (seen.has(entry.path)) fail(`skill ${JSON.stringify(entry.path)} is duplicated`);
    seen.add(entry.path);
  }
  return Object.freeze(skills.map((entry) => Object.freeze({
    path: entry.path, digest: entry.digest, bytes: entry.bytes,
  })));
}

/**
 * Resolve caller paths to canonical identities. When an entry already carries a digest, the
 * live file must still match it: a reviewed skill that changed on disk is refused, not trusted.
 */
export function reviewSkills(skills) {
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS) fail(`skills must be an array of at most ${MAX_SKILLS}`);
  const seen = new Set();
  const reviewed = [];
  for (const entry of skills) {
    const requested = requestedPath(entry);
    if (!isAbsolute(requested) || requested.length > MAX_SKILL_PATH || requested.includes("\0")) {
      fail("skill path must be an absolute filesystem path");
    }
    let canonical;
    try { canonical = realpathSync(requested); }
    catch (error) { fail(`skill ${JSON.stringify(requested)} is not readable`); }
    if (seen.has(canonical)) fail(`skill ${JSON.stringify(canonical)} is duplicated`);
    seen.add(canonical);
    let stat;
    try { stat = statSync(canonical); }
    catch { fail(`skill ${JSON.stringify(canonical)} is not readable`); }
    if (!stat.isFile()) fail(`skill ${JSON.stringify(canonical)} is not a regular file`);
    if (stat.size > MAX_SKILL_BYTES) fail(`skill ${JSON.stringify(canonical)} exceeds ${MAX_SKILL_BYTES} bytes`);
    const bytes = readFileSync(canonical);
    if (bytes.length !== stat.size) fail(`skill ${JSON.stringify(canonical)} changed while reading`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (attested(entry) && entry.digest !== digest) {
      fail(`skill ${JSON.stringify(canonical)} content does not match the attested digest`);
    }
    reviewed.push(Object.freeze({ path: canonical, digest, bytes: bytes.length }));
  }
  return reviewed.length ? Object.freeze(reviewed) : undefined;
}

/** Keep attested identities as data; review live paths. */
export function normalizeSkills(skills) {
  if (skills === undefined) return undefined;
  if (Array.isArray(skills) && skills.length > 0 && skills.every(attested)) return assertStoredSkills(skills);
  return reviewSkills(skills);
}
