const ACTIVE_JOB_STATES = new Set(["submitted", "queued", "running", "cancellation_requested"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);
const ATTEMPT_WAITING = new Set(["selecting", "waiting_capacity", "dispatching"]);
const ATTEMPT_RUNNING = new Set(["running", "verifying"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeText(value, fallback, max = 160) {
  if (typeof value !== "string") return fallback;
  // Fleet strings cross a terminal trust boundary. Remove C0/C1, ESC/OSC inputs and bidi
  // controls before whitespace normalization; no child/provider metadata may steer the TUI.
  const line = value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ").trim();
  return line ? line.slice(0, max) : fallback;
}

function safeId(value, fallback = "unknown") {
  return safeText(value, fallback, 200).replace(/[^A-Za-z0-9._:/-]/g, "_");
}

function usageOf(value) {
  const usage = isRecord(value) ? value : {};
  return Object.freeze({
    input: finiteNonNegative(usage.input),
    output: finiteNonNegative(usage.output),
    cacheRead: finiteNonNegative(usage.cacheRead),
    cacheWrite: finiteNonNegative(usage.cacheWrite),
    turns: finiteNonNegative(usage.turns),
  });
}

function rowFromJob(job) {
  const id = safeId(job.jobId);
  const recoveredWithoutAttempt = job.status === "queued" && Number.isSafeInteger(job.recoveryCount) && job.recoveryCount > 0;
  return {
    id,
    rootId: id,
    parentId: null,
    kind: job.kind === "workflow" ? "workflow" : "task",
    label: job.kind === "workflow" ? `workflow:${id}` : id,
    state: recoveredWithoutAttempt ? "reconciling" : safeText(job.status, "unknown", 40),
    durableState: safeText(job.status, "unknown", 40),
    ...(recoveredWithoutAttempt ? { liveness: "lost", recoveryCount: job.recoveryCount } : {}),
    persistence: "durable_job",
    submittedAt: finiteNonNegative(job.submittedAt),
    startedAt: optionalFiniteNonNegative(job.startedAt),
    completedAt: optionalFiniteNonNegative(job.completedAt),
    updatedAt: finiteNonNegative(job.updatedAt),
    tier: typeof job.tier === "string" ? safeText(job.tier, undefined, 40) : undefined,
    attempt: undefined,
    usage: usageOf(undefined),
  };
}

function rowsFromJobs(jobs, { maxJobs, maxRows, maxNodesPerWorkflow }) {
  const rows = [];
  for (const candidate of (Array.isArray(jobs) ? jobs : []).slice(0, maxJobs)) {
    if (rows.length >= maxRows) break;
    if (!isRecord(candidate) || typeof candidate.jobId !== "string") continue;
    const root = rowFromJob(candidate);
    rows.push(root);
    if (candidate.kind !== "workflow" || !Array.isArray(candidate.nodes)) continue;
    for (const node of candidate.nodes.slice(0, maxNodesPerWorkflow)) {
      if (rows.length >= maxRows) break;
      if (!isRecord(node) || typeof node.id !== "string") continue;
      const id = `${root.id}/${safeId(node.id)}`;
      rows.push({
        id,
        rootId: root.id,
        parentId: root.id,
        kind: "workflow_node",
        label: safeId(node.id),
        rootTerminal: TERMINAL_STATES.has(root.state),
        rootState: root.state,
        state: safeText(node.state, "pending", 40),
        durableState: safeText(node.state, "pending", 40),
        persistence: "durable_job",
        submittedAt: root.submittedAt,
        startedAt: optionalFiniteNonNegative(node.startedAt),
        completedAt: optionalFiniteNonNegative(node.completedAt),
        updatedAt: root.updatedAt,
        tier: typeof node.tier === "string" ? safeText(node.tier, undefined, 40) : undefined,
        dependencies: Array.isArray(node.dependsOn) ? node.dependsOn.map((item) => safeId(item)).slice(0, 64) : [],
        attempt: undefined,
        usage: usageOf(undefined),
      });
    }
  }
  return rows;
}

function derivedAttemptState(attempt) {
  if (attempt.attempt > 1 && ATTEMPT_RUNNING.has(attempt.state)) return "retrying";
  return attempt.state;
}

function overlayAttempt(row, attempt, now, noProgressTimeoutMs) {
  // Only observed positive progress counts. Falling back to startedAt would turn a child that
  // has produced nothing but lifecycle chatter into a healthy-looking row while the runner
  // watchdog is separately counting it down; silence must read as unknown, not as alive.
  const lastProgressAt = optionalFiniteNonNegative(attempt.lastProgressAt);
  const progressAgeMs = lastProgressAt === undefined ? undefined : Math.max(0, now - lastProgressAt);
  const active = ATTEMPT_RUNNING.has(attempt.state);
  const liveness = active
    ? (progressAgeMs === undefined ? "unknown" : progressAgeMs > noProgressTimeoutMs ? "stalled" : "alive")
    : ATTEMPT_WAITING.has(attempt.state) ? "waiting" : undefined;
  const provider = safeText(attempt.provider, undefined, 100);
  const modelId = safeText(attempt.modelId, undefined, 160);
  const resourceId = safeText(attempt.resourceId, undefined, 240);
  return {
    ...(row ?? {
      id: safeId(attempt.logicalId ?? attempt.attemptId),
      rootId: safeId(attempt.rootId ?? attempt.logicalId ?? attempt.attemptId),
      parentId: attempt.workflowId ? safeId(attempt.workflowId) : null,
      kind: safeText(attempt.kind, "attempt", 40),
      label: safeId(attempt.nodeId ?? attempt.logicalId ?? attempt.attemptId),
      durableState: undefined,
      persistence: "volatile_attempt",
      submittedAt: finiteNonNegative(attempt.startedAt),
      updatedAt: finiteNonNegative(attempt.lastProgressAt, attempt.startedAt),
      tier: undefined,
    }),
    state: derivedAttemptState(attempt),
    persistence: row ? "durable_job+volatile_attempt" : "volatile_attempt",
    attemptId: safeId(attempt.attemptId),
    attempt: Number.isSafeInteger(attempt.attempt) ? attempt.attempt : 1,
    role: safeText(attempt.role, "worker", 80),
    resourceId,
    provider,
    modelId,
    route: resourceId ?? (provider && modelId ? `${provider}/${modelId}` : undefined),
    requestedThinking: safeText(attempt.requestedThinking, undefined, 40),
    effectiveThinking: safeText(attempt.effectiveThinking, undefined, 40),
    startedAt: optionalFiniteNonNegative(attempt.startedAt) ?? row?.startedAt,
    lastProgressAt,
    lastEventType: safeText(attempt.lastEventType, undefined, 80),
    progressAgeMs,
    liveness,
    waitUntil: optionalFiniteNonNegative(attempt.waitUntil),
    usage: usageOf(attempt.usage),
  };
}

function countRows(rows) {
  const counts = { running: 0, retrying: 0, waiting: 0, stalled: 0, blocked: 0, failed: 0, completed: 0 };
  for (const row of rows) {
    if (row.kind === "workflow" || row.rootTerminal) continue;
    if (row.liveness === "stalled") counts.stalled += 1;
    if (row.state === "retrying") counts.retrying += 1;
    else if (ATTEMPT_RUNNING.has(row.state) || row.state === "running") counts.running += 1;
    else if (ATTEMPT_WAITING.has(row.state) || ["submitted", "queued", "pending", "reconciling", "dispatching"].includes(row.state)) counts.waiting += 1;
    else if (row.state === "blocked" || row.state === "cancellation_requested") counts.blocked += 1;
    else if (["failed", "cancelled", "expired"].includes(row.state)) counts.failed += 1;
    else if (row.state === "completed") counts.completed += 1;
  }
  return Object.freeze(counts);
}

function sortRows(rows) {
  const rank = (row) => row.liveness === "stalled" ? 0
    : row.state === "retrying" ? 1
      : ATTEMPT_RUNNING.has(row.state) || row.state === "running" ? 2
        : ATTEMPT_WAITING.has(row.state) || ["submitted", "queued", "pending", "reconciling", "dispatching"].includes(row.state) ? 3
          : row.state === "blocked" || row.state === "cancellation_requested" ? 4
            : TERMINAL_STATES.has(row.state) ? 6 : 5;
  return [...rows].sort((left, right) => rank(left) - rank(right)
    || finiteNonNegative(right.startedAt, right.updatedAt) - finiteNonNegative(left.startedAt, left.updatedAt)
    || left.id.localeCompare(right.id));
}

export function buildFleetProjection({
  jobs = [], reports = [], attempts = [], now = Date.now(), noProgressTimeoutMs = 180_000,
  maxJobs = 256, maxReports = 256, maxRows = 1_000, maxNodesPerWorkflow = 256, inputTruncated = false,
} = {}) {
  if (!Number.isFinite(now)) throw new Error("fleet projection now must be finite");
  if (!Number.isFinite(noProgressTimeoutMs) || noProgressTimeoutMs < 1_000) {
    throw new Error("fleet noProgressTimeoutMs must be at least 1000");
  }
  for (const [name, value, ceiling] of [
    ["maxJobs", maxJobs, 1_000], ["maxReports", maxReports, 1_000],
    ["maxRows", maxRows, 10_000], ["maxNodesPerWorkflow", maxNodesPerWorkflow, 1_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`fleet ${name} is invalid`);
  }
  const baseRows = rowsFromJobs(jobs, { maxJobs, maxRows, maxNodesPerWorkflow });
  const byId = new Map(baseRows.map((row) => [row.id, row]));
  for (const report of (Array.isArray(reports) ? reports : []).slice(0, maxReports)) {
    if (!isRecord(report) || typeof report.taskId !== "string") continue;
    const id = safeId(report.logicalId ?? report.taskId);
    const existingRow = byId.get(id);
    // A terminal report beside a non-terminal durable job is a recovery record, not proof that
    // the current attempt owns this route. Startup reconciliation settles the job first.
    if (existingRow && !TERMINAL_STATES.has(existingRow.durableState)) continue;
    const row = existingRow ?? {
      id,
      rootId: id.includes("/") ? id.slice(0, id.indexOf("/")) : id,
      parentId: id.includes("/") ? id.slice(0, id.indexOf("/")) : null,
      kind: "report",
      label: id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id,
      state: safeText(report.status, "failed", 40),
      durableState: safeText(report.status, "failed", 40),
      persistence: "durable_report",
      submittedAt: optionalFiniteNonNegative(report.startedAt) ?? optionalFiniteNonNegative(report.completedAt) ?? 0,
      startedAt: optionalFiniteNonNegative(report.startedAt),
      completedAt: optionalFiniteNonNegative(report.completedAt),
      updatedAt: optionalFiniteNonNegative(report.completedAt) ?? 0,
      usage: usageOf(undefined),
    };
    const provider = safeText(report.provider, undefined, 100);
    const modelId = safeText(report.modelId, undefined, 160);
    const resourceId = safeText(report.resourceId, undefined, 240);
    byId.set(id, {
      ...row,
      resourceId,
      provider,
      modelId,
      route: resourceId ?? (provider && modelId ? `${provider}/${modelId}` : safeText(report.route, undefined, 240)),
      effectiveThinking: safeText(report.effectiveThinking, undefined, 40),
      requestedThinking: safeText(report.requestedThinking, undefined, 40),
      role: safeText(report.role, undefined, 80),
      usage: usageOf(report.usage),
      verification: safeText(report.verificationStatus, undefined, 80),
      persistence: byId.has(id) ? "durable_job+durable_report" : "durable_report",
    });
  }
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!isRecord(attempt) || typeof attempt.attemptId !== "string") continue;
    const logicalId = safeId(attempt.logicalId ?? attempt.attemptId);
    const current = byId.get(logicalId);
    byId.set(logicalId, overlayAttempt(current, { ...attempt, logicalId }, now, noProgressTimeoutMs));
  }
  for (const [id, row] of byId) {
    if (row.kind !== "workflow" && row.state === "running" && row.attemptId === undefined) {
      byId.set(id, { ...row, state: "dispatching", liveness: "unknown" });
    }
  }
  const rows = sortRows([...byId.values()]);
  const truncated = inputTruncated === true
    || (Array.isArray(jobs) && jobs.length > maxJobs)
    || (Array.isArray(reports) && reports.length > maxReports)
    || rows.length > maxRows;
  const boundedRows = rows.slice(0, maxRows);
  return Object.freeze({
    now, noProgressTimeoutMs, truncated,
    rows: Object.freeze(boundedRows.map((row) => Object.freeze(row))), counts: countRows(boundedRows),
  });
}

function compactNumber(value) {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function duration(ms) {
  const seconds = Math.max(0, Math.floor(finiteNonNegative(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function codePointWidth(character) {
  if (/\p{Mark}/u.test(character)) return 0;
  const point = character.codePointAt(0);
  if (point === undefined) return 0;
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1faff) || (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

export function terminalWidth(text) {
  let width = 0;
  for (const character of String(text)) width += codePointWidth(character);
  return width;
}

function clip(text, width) {
  if (terminalWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? "…" : "";
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = codePointWidth(character);
    if (used + size > width - 1) break;
    result += character;
    used += size;
  }
  return `${result}…`;
}

function stateGlyph(row) {
  if (row.liveness === "stalled") return "!";
  if (row.state === "retrying") return "↻";
  if ((ATTEMPT_RUNNING.has(row.state) || row.state === "running") && row.liveness === "unknown") return "?";
  if (ATTEMPT_RUNNING.has(row.state) || row.state === "running") return "▶";
  if (ATTEMPT_WAITING.has(row.state) || ["queued", "pending", "submitted", "reconciling", "dispatching"].includes(row.state)) return "◷";
  if (row.state === "completed") return "✓";
  if (["failed", "cancelled", "expired"].includes(row.state)) return "×";
  return "·";
}

function activeRow(row) {
  return !row.rootTerminal && !TERMINAL_STATES.has(row.state) && row.kind !== "workflow";
}

export function fleetSummary(fleet) {
  const counts = fleet?.counts ?? {};
  const pieces = [];
  for (const [name, value] of [["running", counts.running], ["retry", counts.retrying], ["waiting", counts.waiting], ["stalled", counts.stalled], ["blocked", counts.blocked]]) {
    if (value) pieces.push(`${value} ${name}`);
  }
  const active = Array.isArray(fleet?.rows) ? fleet.rows.filter(activeRow) : [];
  const input = active.reduce((sum, row) => sum + finiteNonNegative(row.usage?.input), 0);
  const output = active.reduce((sum, row) => sum + finiteNonNegative(row.usage?.output), 0);
  return `Delegation ${pieces.length ? pieces.join(" · ") : "idle"}${active.length ? ` · ↑${compactNumber(input)} ↓${compactNumber(output)}` : ""}${fleet?.truncated ? " · bounded" : ""}`;
}

export function formatFleetWidget(fleet, { maxRows = 5, width = 120 } = {}) {
  const safeRows = Math.max(0, Math.min(20, Number.isSafeInteger(maxRows) ? maxRows : 5));
  // Pi's component contract is absolute: a rendered line may never exceed the width the TUI
  // passed. A narrow terminal loses columns of detail, it does not get an overflowing widget.
  // A fractional width is still a real budget: floor it rather than falling back to a default
  // that is far wider than the pane the TUI actually offered.
  const requested = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 120;
  const safeWidth = Math.min(400, requested);
  if (safeWidth < 1) return Object.freeze([]);
  const active = (fleet?.rows ?? []).filter(activeRow).slice(0, safeRows);
  if (active.length === 0) return Object.freeze([]);
  const lines = [clip(fleetSummary(fleet), safeWidth)];
  for (const row of active) {
    const elapsed = row.startedAt === undefined ? "—" : duration(fleet.now - row.startedAt);
    const progress = row.progressAgeMs === undefined ? "obs:—" : `${row.liveness === "stalled" ? "stale" : "obs"}:${duration(row.progressAgeMs)}`;
    const route = row.route ?? "route:pending";
    // Show both sides only when they disagree: an effort the provider changed is news.
    const effort = row.effectiveThinking && row.requestedThinking && row.effectiveThinking !== row.requestedThinking
      ? `${row.requestedThinking}→${row.effectiveThinking}` : row.effectiveThinking ?? row.requestedThinking ?? "—";
    const attempt = row.attempt ? `a${row.attempt}` : "a—";
    const label = clip(row.label, 24);
    lines.push(clip(`${stateGlyph(row)} ${label} · ${row.role ?? "worker"} · ${route} · ${effort} · ${elapsed} · ${progress} · ${attempt}`, safeWidth));
  }
  const hidden = (fleet?.rows ?? []).filter(activeRow).length - active.length;
  if (hidden > 0 && lines.length < safeRows + 2) lines.push(clip(`… ${hidden} more active delegation item(s)`, safeWidth));
  return Object.freeze(lines);
}

export function formatFleetDetails(fleet, { selector = "active", selectorMode, maxRows = 100, maxBytes = 32 * 1024 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number.isSafeInteger(maxRows) ? maxRows : 100));
  const safeBytes = Math.max(512, Math.min(256 * 1024, Number.isSafeInteger(maxBytes) ? maxBytes : 32 * 1024));
  let rows = [...(fleet?.rows ?? [])];
  const mode = selectorMode ?? (selector === "active" || !selector ? "active" : selector === "all" ? "all" : "id");
  if (mode === "active") rows = rows.filter(activeRow);
  else if (mode === "id") rows = rows.filter((row) => row.id === selector || row.rootId === selector || row.attemptId === selector);
  rows = rows.slice(0, safeLimit);
  const lines = [fleetSummary(fleet)];
  for (const row of rows) {
    const route = row.route ?? "pending";
    const timing = row.startedAt === undefined ? "elapsed=—" : `elapsed=${duration(fleet.now - row.startedAt)}`;
    const progress = row.progressAgeMs === undefined ? "progress=—" : `progressAge=${duration(row.progressAgeMs)}`;
    const usage = `tokens=in:${compactNumber(row.usage?.input)} out:${compactNumber(row.usage?.output)} cache:${compactNumber(row.usage?.cacheRead)}`;
    lines.push(`${row.id} state=${row.state} durable=${row.durableState ?? "—"} persistence=${row.persistence} liveness=${row.liveness ?? "—"}`);
    lines.push(`  route=${route} effort=${row.effectiveThinking ?? "—"} requested=${row.requestedThinking ?? "—"} attempt=${row.attempt ?? "—"} ${timing} ${progress} ${usage}`);
    if (row.dependencies?.length) lines.push(`  dependsOn=${row.dependencies.join(",")}`);
  }
  if (rows.length === 0) lines.push(mode === "active" ? "No active delegation work." : `No delegation item matched ${safeId(selector)}.`);
  let text = lines.join("\n");
  if (Buffer.byteLength(text) > safeBytes) {
    text = Buffer.from(text).subarray(0, Math.max(0, safeBytes - 3)).toString("utf8").replace(/\uFFFD$/u, "") + "…";
  }
  return text;
}
