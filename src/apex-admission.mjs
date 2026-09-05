/** Controller-local admission. Caller JSON can never mint an admission. */
import { createHash } from "node:crypto";
import { qualityForModel } from "./model-quality-catalog.mjs";
import { inferModelDeveloper } from "./model-provenance-policy.mjs";

const admissions = new WeakMap();
const digest = (text) => createHash("sha256").update(text).digest("hex");
const SEMANTIC = new Map([
  ["semantic_rejection", "verification_rejected"],
  ["semantic_failure", "fatal"],
  ["no_progress", "no_progress"],
  ["capability_gap", "context_exhausted"],
]);
const TTL = 5 * 60_000;

function identityFromResource(id) {
  if (typeof id !== "string" || !id.includes("/")) throw new Error("semantic failure evidence requires a model identity");
  const slash = id.indexOf("/");
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function brand(value, privateState) {
  const admission = Object.freeze(value);
  admissions.set(admission, privateState);
  return admission;
}

export function createOwnerModelAdmission(identity) {
  if (qualityForModel(identity) !== "apex") throw new Error("owner admission requires an exact apex identity");
  const exact = { provider: identity.provider, modelId: identity.modelId };
  return brand({ kind: "owner_primary", ...exact }, { kind: "owner_primary", identity: exact });
}

export function apexAdmissionKind(admission) {
  const state = admissions.get(admission);
  if (!state || (state.expiresAt !== undefined && state.now() >= state.expiresAt)) return undefined;
  return state.kind;
}

export function apexAdmissionAllows(admission, identity, task) {
  const kind = apexAdmissionKind(admission);
  if (!kind || qualityForModel(identity) !== "apex") return false;
  const state = admissions.get(admission);
  if (kind === "owner_primary") return identity.provider === state.identity.provider && identity.modelId === state.identity.modelId;
  return task === undefined || digest(task) === state.taskDigest;
}

/** Only controller-owned report/job readers belong here; never pass model-supplied reports. */
export function authorizeApexRescue({ task, reportIds, loadReport, loadJob, ownerSessionId, now = Date.now } = {}) {
  if (typeof task !== "string" || task.length === 0 || typeof ownerSessionId !== "string" || !ownerSessionId
    || typeof loadReport !== "function" || typeof loadJob !== "function" || typeof now !== "function"
    || !Array.isArray(reportIds) || reportIds.length !== 2 || new Set(reportIds).size !== 2) {
    throw new Error("rescue requires two materially distinct frontier models with owner session evidence");
  }
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("rescue clock is invalid");
  const taskDigest = digest(task);
  const identities = [];
  const snapshots = [];
  for (const id of reportIds) {
    const report = loadReport(id);
    const job = loadJob(id);
    if (job?.jobId !== id || job.ownerSessionId !== ownerSessionId) throw new Error("rescue owner session does not match");
    if (!report || report.taskId !== id || report.status !== "failed" || report.taskDigest !== taskDigest || digest(report.task ?? "") !== taskDigest) {
      throw new Error("rescue task digest does not match verified report");
    }
    if (!Number.isSafeInteger(report.startedAt) || !Number.isSafeInteger(report.completedAt)
      || report.startedAt > report.completedAt || report.completedAt > at || at - report.completedAt > 30 * 60_000) {
      throw new Error("semantic failure evidence is stale or has invalid timestamps");
    }
    const steps = report.routeSteps;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 32) throw new Error("semantic failure evidence requires route steps");
    const models = steps.map((step) => identityFromResource(step.resourceId));
    if (models.some((model) => qualityForModel(model) === "apex")) throw new Error("rescue evidence already used an apex model");
    const last = steps.at(-1);
    const model = models.at(-1);
    if (!SEMANTIC.has(report.failureClass) || last.outcome !== SEMANTIC.get(report.failureClass)
      || qualityForModel(model) !== "frontier"
      || steps.some((step) => ![...SEMANTIC.values()].includes(step.outcome))) {
      throw new Error("rescue requires semantic failure evidence, not transport or quota failures");
    }
    identities.push(model);
    snapshots.push({ id, taskDigest, failureClass: report.failureClass, steps, completedAt: report.completedAt });
  }
  const failedDevelopers = [...new Set(identities.map((model) => inferModelDeveloper(model.modelId)))];
  if (failedDevelopers.length !== 2 || failedDevelopers.includes("unknown")) throw new Error("rescue requires two materially distinct frontier models");
  return brand({
    kind: "rescue", taskDigest, ownerSessionId,
    reportIds: Object.freeze([...reportIds]), failedDevelopers: Object.freeze(failedDevelopers),
    evidenceDigest: digest(JSON.stringify(snapshots)), maxAttempts: 2, expiresAt: at + TTL,
  }, { kind: "rescue", taskDigest, now, expiresAt: at + TTL });
}
