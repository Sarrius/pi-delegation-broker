import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOPOLOGIES = new Set(["specialist", "sectioning", "ensemble", "reviewer", "adjudication", "integrator"]);
const JOIN_KINDS = new Set(["sectioning", "ensemble", "reviewer"]);
const MATERIAL_DIFFERENCE_REASONS = new Set([
  "provider_diversity",
  "adversarial_method",
  "separate_evidence_source",
  "reviewer_independence",
  "different_scope",
]);
const JOIN_POLICIES = new Map([
  ["sectioning", new Set(["all_accepted"])],
  ["ensemble", new Set(["majority", "all_accepted", "adjudicated"])],
  ["reviewer", new Set(["reviewer_accepts"])],
]);
const DEFAULT_BUDGETS = Object.freeze({
  maxNodes: 1_000,
  maxAppends: 100,
  maxParallel: 64,
  maxRedundant: 0,
  maxAttempts: 1_000,
});

function fail(message) { throw new Error(`team admission: ${message}`); }

function bounded(value, label, max = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) {
    fail(`${label} must be a bounded single-line string`);
  }
  return value.trim();
}

function optionalBounded(value, label, max = 4096) {
  if (value === undefined || value === null || value === "") return undefined;
  return bounded(value, label, max);
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function fingerprintInput(value, label) {
  if (value === undefined || value === null) return digest({ [label]: [] });
  if (typeof value === "string" && SHA256.test(value)) return value;
  if (!Array.isArray(value) && typeof value !== "string" && (typeof value !== "object" || value === null)) {
    fail(`${label} fingerprint input is invalid`);
  }
  return digest({ [label]: value });
}

function normalizePurpose(value) {
  const purpose = value ?? "specialist";
  if (typeof purpose !== "string" || !TOPOLOGIES.has(purpose)) fail("topology purpose is invalid");
  return purpose;
}

export function normalizeTaskAdmission(node, index = 0) {
  if (!node || typeof node !== "object" || Array.isArray(node)) fail(`node ${index} is invalid`);
  const raw = node.admission && typeof node.admission === "object" ? node.admission : {};
  const objective = bounded(raw.objective ?? node.objective ?? node.task, `node ${index} objective`, 256 * 1024);
  const scope = optionalBounded(raw.scope ?? node.scope, `node ${index} scope`, 16 * 1024) ?? "";
  const inputValue = raw.inputFingerprint ?? node.inputFingerprint ?? node.inputs ?? [];
  const artifactValue = raw.artifactFingerprint ?? node.artifactFingerprint ?? [];
  const inputFingerprint = fingerprintInput(inputValue, "inputs");
  const artifactFingerprint = fingerprintInput(artifactValue, "artifact");
  const purpose = normalizePurpose(raw.purpose ?? node.topologyPurpose ?? node.purpose);
  const materialDifference = raw.materialDifference ?? node.materialDifference;
  if (materialDifference !== undefined && !MATERIAL_DIFFERENCE_REASONS.has(materialDifference)) {
    fail("material difference reason is invalid");
  }
  const identity = { objective, scope, inputFingerprint, artifactFingerprint };
  return Object.freeze({
    schemaVersion: 1,
    objective,
    scope,
    inputFingerprint,
    artifactFingerprint,
    purpose,
    objectiveFingerprint: digest(identity),
    fingerprint: digest({ ...identity, purpose, materialDifference: materialDifference ?? null }),
    ...(materialDifference ? { materialDifference } : {}),
  });
}

export function normalizeTeamBudgets(value = {}, { concurrency = 4 } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("budgets must be an object");
  const maxParallel = integer(value.maxParallel ?? concurrency, "maxParallel", 1, 64);
  const budgets = {
    maxNodes: integer(value.maxNodes ?? DEFAULT_BUDGETS.maxNodes, "maxNodes", 1, 1000),
    maxAppends: integer(value.maxAppends ?? DEFAULT_BUDGETS.maxAppends, "maxAppends", 0, 1000),
    maxParallel,
    maxRedundant: integer(value.maxRedundant ?? DEFAULT_BUDGETS.maxRedundant, "maxRedundant", 0, 1000),
    maxAttempts: integer(value.maxAttempts ?? Math.min(DEFAULT_BUDGETS.maxAttempts, value.maxNodes ?? DEFAULT_BUDGETS.maxNodes), "maxAttempts", 1, 100_000),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: integer(value.maxOutputTokens, "maxOutputTokens", 1, 2_000_000_000) }),
  };
  if (budgets.maxParallel > concurrency) fail("maxParallel cannot exceed workflow concurrency");
  return Object.freeze(budgets);
}

export function normalizeTeamJoin(join, index = 0) {
  if (!join || typeof join !== "object" || Array.isArray(join)) fail(`join ${index} is invalid`);
  const id = join.id;
  if (typeof id !== "string" || !ID.test(id)) fail(`join ${index} id is invalid`);
  const kind = join.kind;
  if (!JOIN_KINDS.has(kind)) fail(`join ${id} kind is invalid`);
  const members = join.members ?? join.producers;
  if (!Array.isArray(members) || members.length < 1 || members.length > 1000
    || members.some((member) => typeof member !== "string" || !ID.test(member))
    || new Set(members).size !== members.length) {
    fail(`join ${id} members are invalid`);
  }
  const reviewerId = join.reviewerId ?? join.reviewer;
  if (kind === "reviewer" && (typeof reviewerId !== "string" || !ID.test(reviewerId) || members.includes(reviewerId))) {
    fail(`join ${id} reviewer is invalid`);
  }
  const policy = join.policy ?? (kind === "sectioning" ? "all_accepted" : kind === "ensemble" ? "majority" : "reviewer_accepts");
  if (!JOIN_POLICIES.get(kind).has(policy)) fail(`join ${id} policy is invalid for ${kind}`);
  if (kind === "ensemble" && policy === "majority" && members.length < 2) fail(`join ${id} ensemble needs at least two members`);
  if (policy === "adjudicated" && (typeof join.adjudicatorId !== "string" || !ID.test(join.adjudicatorId))) {
    fail(`join ${id} adjudicatorId is required`);
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    kind,
    members: Object.freeze([...members]),
    ...(reviewerId ? { reviewerId } : {}),
    ...(join.adjudicatorId ? { adjudicatorId: join.adjudicatorId } : {}),
    policy,
  });
}

export function normalizeTeamMetadata({ jobId, rootId, dynamic = false, acceptingAppends = dynamic, budgets, joins = [], concurrency = 4 } = {}) {
  if (typeof jobId !== "string" || !ID.test(jobId)) fail("jobId is invalid");
  const normalizedJoins = joins.map((join, index) => normalizeTeamJoin(join, index));
  if (new Set(normalizedJoins.map((join) => join.id)).size !== normalizedJoins.length) fail("join ids must be unique");
  return {
    schemaVersion: 1,
    rootId: rootId ?? jobId,
    topology: dynamic ? "dynamic_flat" : "static_flat",
    dynamic: Boolean(dynamic),
    acceptingAppends: Boolean(acceptingAppends),
    sealed: !Boolean(acceptingAppends),
    revision: 0,
    appendCount: 0,
    proposals: [],
    usage: { admittedMembers: 0, startedAttempts: 0, outputTokens: 0 },
    budgets: normalizeTeamBudgets(budgets, { concurrency }),
    joins: normalizedJoins,
  };
}

function redundancyCount(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const admission = node.admission;
    if (!admission || admission.purpose !== "ensemble") continue;
    groups.set(admission.objectiveFingerprint, (groups.get(admission.objectiveFingerprint) ?? 0) + 1);
  }
  return [...groups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

export function teamProposalDigest(nodes, joins = []) {
  return digest({
    nodes: nodes.map((node) => ({
      id: node.id,
      task: node.task,
      dependsOn: [...(node.dependsOn ?? [])].sort(),
      inputs: [...(node.inputs ?? [])].sort(),
      admission: node.admission ?? normalizeTaskAdmission(node),
    })),
    joins,
  });
}

export function admitTeamNodes(existingNodes, incomingNodes, { budgets, appendCount = 0, concurrency = 4 } = {}) {
  if (!Array.isArray(existingNodes) || !Array.isArray(incomingNodes)) fail("team nodes must be arrays");
  const normalizedBudgets = normalizeTeamBudgets(budgets, { concurrency });
  integer(appendCount, "appendCount", 0, normalizedBudgets.maxAppends);
  const existing = existingNodes.map((node, index) => ({ node, admission: node.admission ?? normalizeTaskAdmission(node, index) }));
  const ids = new Set(existingNodes.map((node) => node.id));
  const byFingerprint = new Map(existing.map(({ node, admission }) => [admission.fingerprint, node.id]));
  const byObjective = new Map();
  for (const { admission } of existing) {
    const list = byObjective.get(admission.objectiveFingerprint) ?? [];
    list.push(admission);
    byObjective.set(admission.objectiveFingerprint, list);
  }
  const added = [];
  const reused = [];
  const normalized = [];
  for (let index = 0; index < incomingNodes.length; index += 1) {
    const raw = incomingNodes[index];
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !ID.test(raw.id)) fail(`node ${index} id is invalid`);
    if (ids.has(raw.id) || normalized.some((node) => node.id === raw.id)) fail(`node id ${raw.id} already exists`);
    const admission = normalizeTaskAdmission(raw, index);
    const exact = byFingerprint.get(admission.fingerprint);
    if (exact) {
      reused.push({ requestedId: raw.id, existingId: exact, fingerprint: admission.fingerprint });
      continue;
    }
    const sameObjective = byObjective.get(admission.objectiveFingerprint) ?? [];
    if (sameObjective.length > 0 && !admission.materialDifference) {
      fail(`node ${raw.id} is materially duplicate of an existing objective; declare materialDifference`);
    }
    const node = { ...raw, admission };
    ids.add(node.id);
    normalized.push(node);
    added.push(node);
    byFingerprint.set(admission.fingerprint, node.id);
    byObjective.set(admission.objectiveFingerprint, [...sameObjective, admission]);
  }
  if (existingNodes.length + added.length > normalizedBudgets.maxNodes) fail("root maxNodes budget exceeded");
  if (added.length > 0 && appendCount >= normalizedBudgets.maxAppends) fail("root maxAppends budget exceeded");
  const all = [...existingNodes, ...added];
  const redundant = redundancyCount(all);
  if (redundant > normalizedBudgets.maxRedundant) fail("root redundancy budget exceeded");
  return Object.freeze({
    added: Object.freeze(added.map((node) => structuredClone(node))),
    reused: Object.freeze(reused.map((entry) => Object.freeze({ ...entry }))),
    redundancyUsed: redundant,
    budgets: normalizedBudgets,
  });
}

function nodeDisposition(node) {
  if (!node || !["completed", "failed", "blocked"].includes(node.state)) return "pending";
  if (node.state !== "completed") return "rejected";
  const result = node.result ?? {};
  const status = result.semanticStatus ?? result.acceptanceStatus ?? result.verificationStatus
    ?? result.verification?.outcome?.status ?? result.artifact?.status;
  if (status === "accepted" || status === "semantically_accepted" || status === "completed") return "accepted";
  return "produced";
}

export function evaluateTeamJoin(join, nodes) {
  const normalized = normalizeTeamJoin(join);
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]));
  const ids = [...normalized.members, ...(normalized.reviewerId ? [normalized.reviewerId] : []), ...(normalized.adjudicatorId ? [normalized.adjudicatorId] : [])];
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "blocked", reason: "unknown_members", missing });
  const members = normalized.members.map((id) => ({ id, disposition: nodeDisposition(byId.get(id)) }));
  const rejected = members.filter((entry) => entry.disposition === "rejected");
  if (rejected.length) return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "rejected", rejected: rejected.map((entry) => entry.id) });
  const pending = members.filter((entry) => entry.disposition === "pending" || entry.disposition === "produced");
  if (normalized.kind === "reviewer") {
    const reviewer = nodeDisposition(byId.get(normalized.reviewerId));
    if (reviewer === "rejected") return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "rejected", rejected: [normalized.reviewerId] });
    if (pending.length || reviewer === "pending" || reviewer === "produced") return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "pending" });
    return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "accepted", acceptedArtifacts: normalized.members, reviewerId: normalized.reviewerId });
  }
  if (normalized.policy === "majority") {
    const accepted = members.filter((entry) => entry.disposition === "accepted");
    const needed = Math.floor(members.length / 2) + 1;
    if (accepted.length >= needed) return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "accepted", selectedNodeId: accepted[0].id, acceptedArtifacts: accepted.map((entry) => entry.id) });
    if (pending.length) return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "pending", accepted: accepted.length, needed });
    return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "rejected", accepted: accepted.length, needed });
  }
  if (pending.length) return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "pending" });
  return Object.freeze({ id: normalized.id, kind: normalized.kind, policy: normalized.policy, status: "accepted", acceptedArtifacts: normalized.members });
}

export function evaluateTeamJoins(joins, nodes) {
  return Object.freeze((joins ?? []).map((join) => evaluateTeamJoin(join, nodes)));
}

export function validateTeamState(team, nodes = []) {
  if (!team || typeof team !== "object" || team.schemaVersion !== 1) fail("team state is invalid");
  if (typeof team.rootId !== "string" || !ID.test(team.rootId)) fail("team rootId is invalid");
  if (typeof team.dynamic !== "boolean" || typeof team.acceptingAppends !== "boolean" || typeof team.sealed !== "boolean") fail("team dynamic flags are invalid");
  integer(team.revision, "team revision", 0, 1_000_000);
  integer(team.appendCount, "team appendCount", 0, 1000);
  if (!Array.isArray(team.proposals) || team.proposals.length > 1000) fail("team proposals are invalid");
  const proposalIds = new Set();
  for (const proposal of team.proposals) {
    if (!proposal || typeof proposal.proposalId !== "string" || !ID.test(proposal.proposalId)
      || typeof proposal.digest !== "string" || !SHA256.test(proposal.digest)
      || !["recorded", "admitted", "rejected", "conflicted"].includes(proposal.status)
      || !Array.isArray(proposal.memberIds) || proposal.memberIds.some((id) => typeof id !== "string" || !ID.test(id))
      || !Number.isSafeInteger(proposal.recordedAt) || (proposal.decidedAt !== undefined && !Number.isSafeInteger(proposal.decidedAt))) fail("team proposal is invalid");
    if (proposalIds.has(proposal.proposalId)) fail("team proposal ids are not unique");
    proposalIds.add(proposal.proposalId);
  }
  if (!team.usage || !Number.isSafeInteger(team.usage.admittedMembers) || !Number.isSafeInteger(team.usage.startedAttempts) || !Number.isSafeInteger(team.usage.outputTokens)) fail("team usage is invalid");
  const budgets = normalizeTeamBudgets(team.budgets, { concurrency: team.budgets?.maxParallel ?? 4 });
  if (!Array.isArray(team.joins)) fail("team joins are invalid");
  const joins = team.joins.map((join, index) => normalizeTeamJoin(join, index));
  if (new Set(joins.map((join) => join.id)).size !== joins.length) fail("team join ids are not unique");
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node?.admission || typeof node.admission.fingerprint !== "string") fail(`node ${node?.id ?? index} admission is missing`);
    const normalized = normalizeTaskAdmission(node, index);
    if (normalized.fingerprint !== node.admission.fingerprint || normalized.objectiveFingerprint !== node.admission.objectiveFingerprint) {
      fail(`node ${node.id ?? index} admission fingerprint is invalid`);
    }
  }
  for (const join of joins) {
    const refs = [...join.members, ...(join.reviewerId ? [join.reviewerId] : []), ...(join.adjudicatorId ? [join.adjudicatorId] : [])];
    if (refs.some((id) => !nodeIds.has(id))) fail(`team join ${join.id} references an unknown node`);
  }
  if (nodes.length > budgets.maxNodes) fail("team maxNodes budget is exceeded");
  if (team.usage.admittedMembers !== nodes.length) fail("team admitted member usage is invalid");
  if (team.usage.startedAttempts > budgets.maxAttempts) fail("team attempt budget is exceeded");
  if (budgets.maxOutputTokens !== undefined && team.usage.outputTokens > budgets.maxOutputTokens) fail("team output budget is exceeded");
  if (redundancyCount(nodes) > budgets.maxRedundant) fail("team redundancy budget is exceeded");
  return Object.freeze({ ...team, budgets, joins });
}
