import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { JevAdvisor, normalizeJevConfig, makeJevReview, formatJevAdvice, jevTaskDigest } from "./jev-advisor.mjs";
import { registerJevVisualTool } from './jev-visual-tool.mjs';
import { makeJevRoutingShadow, describeJevRoutingShadow } from "./jev-routing-shadow.mjs";
import { makeJevActiveRouting, describeJevActiveRouting, jevActiveScopeAllowed } from "./jev-active-routing.mjs";
import { effectiveThinkingLevel } from "./model-thinking-policy.mjs";
import { parseResourceModel } from "./model-selector.mjs";
import { compactModelCriteria } from "./model-criteria.mjs";
import {makeJevDecision,describeJevDecision,JEV_DECISION_ID_PATTERN,JEV_DECISION_TOOL_PATTERN} from './jev-decision.mjs';
import {normalizeEngineSettings,engineNextState,jevConfigFromEngine} from './jev-engine-settings.mjs';
import {JevEngineMetrics} from './jev-engine-metrics.mjs';

export function readJevConfig(path) {
  let fd;
  try {
    // A corrupt/oversize file or FIFO must not stall or exhaust the parent process.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_384) return null;
    const bytes = Buffer.alloc(16_385);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > 16_384) return null;
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch (error) { return error?.code === "ENOENT" ? undefined : null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* optional */ } }
}

function writeConfig(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

// Separate owner file: old, already-imported Pi ESM modules see an unchanged jev.json and
// keep ordinary advisory working until the owner chooses a convenient full Pi restart.
const ACTIVE_DEFAULTS = Object.freeze({ activeRouting: false, consentToSendActiveRoutingState: false,
  activeProjectRoots: [], activeAutoThinkingMax: "off" });
function readActiveSettings(raw) {
  if (raw === undefined) return ACTIVE_DEFAULTS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1
    || Object.keys(raw).some((key) => !["schemaVersion", ...Object.keys(ACTIVE_DEFAULTS)].includes(key))
    || typeof raw.activeRouting !== "boolean" || typeof raw.consentToSendActiveRoutingState !== "boolean"
    || !Array.isArray(raw.activeProjectRoots) || raw.activeProjectRoots.length > 8
    || raw.activeProjectRoots.some((root) => typeof root !== "string" || !isAbsolute(root)
      || root.length > 2048 || /[\u0000-\u001f]/u.test(root))
    || !["off", "low"].includes(raw.activeAutoThinkingMax)) return ACTIVE_DEFAULTS;
  return { activeRouting: raw.activeRouting, consentToSendActiveRoutingState: raw.consentToSendActiveRoutingState,
    activeProjectRoots: [...raw.activeProjectRoots], activeAutoThinkingMax: raw.activeAutoThinkingMax };
}
function legacyJevConfig(config) {
  const keys = ["mode", "consentToSendTaskText", "handoff", "result", "routeShadow",
    "consentToSendRoutingState", "model", "timeoutMs", "maxRequestsPerSession"];
  return Object.fromEntries(keys.map((key) => [key, config[key]]));
}

function checklistFor(ctx, task) {
  const digest = jevTaskDigest(task);
  const entries = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.type === "message" ? entries[i].message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "delegate_review") continue;
    const binding = message.details?.jevChecklist;
    if (binding?.taskDigest === digest && makeJevReview({ phase: "handoff", task, requirements: binding.requirements })) {
      return { requirements: [...binding.requirements], source: "parent_declared_checklist" };
    }
  }
  // No inferred owner requirements: the complete brief is the sole checklist item.
  // If too large for one item, skip rather than silently truncate or sample it.
  if (task.length > 2000) return undefined;
  return { requirements: [task], source: "task_brief_only" };
}

// Called only after a real child session opens, never from delegate_plan. Separate, default-off
// consent controls this new payload family. The result is telemetry, not a route or effort.
export async function observeJevRoutingShadow(pi, advisor, snapshot) {
  try {
    const status = advisor?.status();
    if (!status?.routeShadow || !status.routingConsent || status.mode === "off") {
      return { status: "skipped", reason: "feature_disabled", authority: "none" };
    }
    const model = parseResourceModel(snapshot?.leasedResourceId);
    const request = makeJevRoutingShadow({
      ...snapshot,
      effectiveThinking: effectiveThinkingLevel(model, snapshot?.appliedThinking ?? snapshot?.requestedThinking),
    });
    if (!request) return { status: "skipped", reason: "invalid_input", authority: "none" };
    const result = await advisor.evaluate(request);
    const hypothesis = describeJevRoutingShadow(result, request);
    if (hypothesis) {
      // Append a bounded metadata-only projection. No task, report, credential or account ID.
      try { pi.appendEntry?.("delegation-jev-routing-shadow-v1", {
        ...hypothesis,
        // Controller-owned local correlation only; these identifiers are not sent to Jev.
        ...(typeof snapshot.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(snapshot.taskId)
          ? { taskId: snapshot.taskId } : {}),
        ...(typeof snapshot.leaseId === "string" && /^[0-9a-f-]{36}$/i.test(snapshot.leaseId)
          ? { leaseId: snapshot.leaseId } : {}),
        model: result.model, version: result.version, digest: result.digest,
        evaluatedAt: result.evaluatedAt, elapsedMs: result.elapsedMs, usage: result.usage,
      }); } catch { /* telemetry must not affect delegated work */ }
    }
    return hypothesis ?? { status: "skipped", reason: result.reason ?? "unavailable", authority: "none" };
  } catch { return { status: "skipped", reason: "internal_error", authority: "none" }; }
}

export function jevActiveEnabled(advisor, cwd) {
  try { return jevActiveScopeAllowed(normalizeJevConfig(advisor?.getConfig?.()), cwd); }
  catch { return false; }
}

/** Launch-only: optional advice before a lease. No request on preview, outside the scoped cwd,
 * or without separate active consent. The resolver still checks every answer against fresh
 * controller admission and route preflight; this helper never grants a model or effort. */
export async function adviseJevActiveRoute(pi, advisor, snapshot, signal) {
  try {
    if (!jevActiveEnabled(advisor, snapshot?.cwd) || signal?.aborted) return undefined;
    const config = normalizeJevConfig(advisor.getConfig());
    const facts = Object.create(null);
    for (const resourceId of snapshot?.resourceIds ?? []) {
      const card=compactModelCriteria(resourceId,{history:snapshot.history});
      if(card)facts[card.identity]=card;
    }
    const request = makeJevActiveRouting({ ...snapshot, candidateEvidence:facts, autoEffortCeiling: config.activeAutoThinkingMax });
    if (!request) return undefined;
    const note=(value)=>{try{advisor.engineMetrics?.record({functionName:'routing',
      taskId:snapshot.taskId,taskDigest:jevTaskDigest(snapshot.task),...value});}catch{/* metrics cannot affect routing */}};
    note({state:'opportunity',reason:'eligible_prelease'});
    const result = await advisor.evaluate({ ...request, localScopeCwd: snapshot.cwd }, { signal });
    if (signal?.aborted || !jevActiveEnabled(advisor, snapshot.cwd)){
      note({state:'skipped',reason:'revoked_after_evaluation'});return undefined;
    }
    const advice = describeJevActiveRouting(result, request);
    if(result.status==='evaluated'&&!result.cached)note({state:'invoked',latencyMs:result.elapsedMs,
      inputTokens:result.usage?.inputTokens,outputTokens:result.usage?.outputTokens,
      answer:advice?.modelAnswer??'invalid_response'});
    if(!advice?.model&&!advice?.thinking)note({state:'skipped',reason:result.reason??'no_recommendation'});
    else note({state:'answered',answer:advice?.modelAnswer??advice?.effortAnswer??'unknown'});
    try { pi.appendEntry?.("delegation-jev-routing-active-eval-v1", {
      status: result.status, reason: result.reason ?? null,
      candidateSetDigest: request.state.candidateSetDigest,
      modelAnswer: advice?.modelAnswer ?? null, effortAnswer: advice?.effortAnswer ?? null,
      modelVersion: result.model ?? null, digest: result.digest ?? null,
      elapsedMs: result.elapsedMs ?? null, usage: result.usage ?? null,
    }); } catch { /* an optional trace cannot fail a child */ }
    return advice;
  } catch { return undefined; }
}

function safeEvidence(details) {
  // Whitelist controller fields. Never copy raw journals, routes, errors or arbitrary details.
  const receipt = details?.receipt;
  return {
    verificationStatus: typeof details?.verificationStatus === "string" ? details.verificationStatus : "not_supplied",
    ...(receipt ? { scratchTree: {
      verified: receipt.verified === true,
      baseCommit: typeof receipt.baseCommit === "string" ? receipt.baseCommit : undefined,
      checks: Array.isArray(receipt.checks) ? receipt.checks.map((check) => ({
        id: check.id, ok: check.ok === true, exitCode: check.exitCode,
      })) : [],
    } } : {}),
  };
}

/** Optional Pi consumer. No tool_call gate; no access to launch, cancellation or acceptance. */
export function registerJevAdvisory(pi, { stateDir, reportTask = () => undefined, fetchImpl, getApiKey,
  engineMode = false } = {}) {
  const path = join(stateDir, "jev.json");
  const activePath = join(stateDir, "jev-active.json");
  const enginePath = join(stateDir,'jev-engine.json');
  const metrics=engineMode?new JevEngineMetrics(join(stateDir,'jev-engine-events.jsonl')):undefined;
  let forcedOff = false;
  let forcedRoutingOff = false;
  let forcedActiveOff = false;
  let forcedDecisionsOff = false;
  let forcedVisualOff = false;
  const currentConfig = () => {
    if (forcedOff) return { mode: "off" };
    if(engineMode){
      // Legacy consent and even its request allowance are NOT inherited by the new engine.
      const engine=readJevConfig(enginePath);
      // Separate activation overlay lets future runtimes enable images without making an
      // already-running older engine reject new keys in its strict settings file.
      const visual=readJevConfig(join(stateDir,'jev-visual.json'));
      const overlay=visual?.schemaVersion===1&&visual.enabled===true&&visual.consentToSendImages===true;
      const effective=engine&&typeof engine==='object'&&engine.visual===undefined&&overlay
        &&normalizeEngineSettings(engine).reason==='ready'
        ? {...engine,visual:true,consentToSendImages:true} : engine;
      const derived=jevConfigFromEngine(effective);
      return {...derived,...(forcedActiveOff?{activeRouting:false,consentToSendActiveRoutingState:false}:{}),
        ...(forcedDecisionsOff?{engineDecisions:false}:{}),
        ...(forcedVisualOff?{visual:false,consentToSendImages:false}:{})};
    }
    const stored = readJevConfig(path);
    if (!stored || typeof stored !== "object") return stored;
    return {
      ...stored, ...readActiveSettings(readJevConfig(activePath)),
      ...(forcedRoutingOff ? { routeShadow: false, consentToSendRoutingState: false } : {}),
      ...(forcedActiveOff ? { activeRouting: false, consentToSendActiveRoutingState: false } : {}),
    };
  };
  const advisor = new JevAdvisor({ config: currentConfig, ...(fetchImpl ? { fetchImpl } : {}), ...(getApiKey ? { getApiKey } : {}) });
  if(metrics)advisor.engineMetrics=metrics;
  let decisionToolRegistered=false;
  let pendingActions=[];
  let registered = false;
  let lastObservation;
  let generation = 0;
  const syncVisual=registerJevVisualTool(pi,{advisor,getConfig:currentConfig,getGeneration:()=>generation});

  const observe = (result, ctx) => {
    // No raw state or secrets in telemetry. Custom entries are not sent to the model.
    lastObservation = result;
    if (!result.cached) {
      try { pi.appendEntry?.("delegation-jev-observation-v1", result); } catch { /* telemetry cannot fail a task */ }
    }
  };

  const syncTool = () => {
    syncVisual();
    const config = normalizeJevConfig(currentConfig());
    const expose = !config.reason && config.handoff;
    if (expose && !registered) {
      pi.registerTool({
        name: "delegate_review", label: "Optional delegation brief review",
        description: "Optional Jev check of a proposed child brief against a parent-declared requirements checklist. Does not launch, approve, reject or reserve a child. Use before delegate when enabled; a skipped review means continue ordinary checks. Requirements are not authenticated owner intent; include all applicable constraints yourself.",
        promptSnippet: "Optionally check a child brief for missing requirements before delegating",
        promptGuidelines: [
          "When delegate_review is available, use it before delegation where a missed requirement would cause meaningful rework. Include the owner's applicable requirements faithfully; this tool cannot discover constraints you omit from both the checklist and source quote.",
          "delegate_review is advisory only. If skipped, continue the normal delegation process without retrying it or weakening checks. Neither its scores nor later Jev result advice authorize actions, prove tests passed or establish acceptance.",
        ],
        parameters: Type.Object({
          task: Type.String({ minLength: 1, maxLength: 262144, description: "Exact proposed child task; this binds the checklist to later results." }),
          requirements: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 24, description: "Applicable requirements and constraints copied faithfully by the parent. Caller-declared, not authenticated owner intent." }),
          sourceRequest: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "Optional verbatim source request to spot constraints omitted from the checklist. Caller-supplied quotation, not an authorization receipt." })),
        }),
        async execute(_id, params, signal, _update, ctx) {
          try {
            const binding = { taskDigest: jevTaskDigest(params.task), requirements: [...params.requirements] };
            const request = makeJevReview({ ...params, phase: "handoff" });
            const currentGeneration = generation;
            const result = await advisor.evaluate(request, { signal });
            if (currentGeneration !== generation) return { content: [{ type: "text", text: "Optional Jev review skipped (session changed). Continue ordinary checks." }] };
            observe(result, ctx);
            const advice = formatJevAdvice(result, params.requirements);
            return {
              content: [{ type: "text", text: advice || (result.status === "evaluated"
                ? "Optional Jev shadow review recorded without applying its judgments. Continue ordinary checks."
                : `Optional Jev review skipped (${result.reason}). Continue ordinary checks; delegation is not blocked.`) }],
              details: { jevChecklist: binding, jev: result.mode === "shadow" ? { status: result.status, mode: "shadow", authority: "none" } : result },
            };
          } catch {
            return { content: [{ type: "text", text: "Optional Jev review unavailable. Continue ordinary checks; delegation is not blocked." }] };
          }
        },
      });
      registered = true;
    }
    // No active-tools changes at all when never enabled. Preserve other extensions' tools.
    if (registered && pi.getActiveTools && pi.setActiveTools) {
      const active = pi.getActiveTools();
      if (expose && !active.includes("delegate_review")) pi.setActiveTools([...active, "delegate_review"]);
      else if (!expose && active.includes("delegate_review")) pi.setActiveTools(active.filter((name) => name !== "delegate_review"));
    }
    if(engineMode){
      const decide=config.mode==='advisory'&&config.engineDecisions===true&&!config.reason;
      if(decide&&!decisionToolRegistered){
        pi.registerTool({name:'delegate_decide',label:'Jev next-step decision',
          description:'Ask Jev to choose ONE parent-supplied next action for an explicit question. Enabled decision mode applies a typed semantic choice for the next agent step, not a freeform review. Only the caller can execute actions; Jev cannot grant permissions, verify work or invent options. Undecided/outage retains the ordinary parent plan.',
          promptSnippet:'For consequential ambiguous choices, ask Jev to select a bounded next action; execute it only after your safety checks.',
          promptGuidelines:[
            'When a delegated brief is materially ambiguous, use delegate_decide to choose a concrete next action such as revise_brief versus submit; supply all applicable context and an actionTool when the chosen step has a corresponding tool. Revise with your own reasoning; Jev does not rewrite or approve it.',
            'After a result with unresolved or contradictory controller evidence, use delegate_decide with evidence follow-up options before calling the work complete. A Jev choice is not a receipt; verify the original owner request independently.',
            'If Jev abstains or is unavailable, use the normal parent reasoning path, not an invented Jev conclusion. When you override a chosen action, state the specific safety or evidence reason.'
          ],
          parameters:Type.Object({question:Type.String({minLength:1,maxLength:2000,pattern:'\\S'}),context:Type.String({minLength:1,maxLength:12000,pattern:'\\S'}),
            purpose:Type.Optional(Type.String({minLength:1,maxLength:40,pattern:JEV_DECISION_ID_PATTERN,description:'Lowercase snake_case identifier, e.g. qualification_fix_order; no hyphens.'})),
            options:Type.Array(Type.Object({id:Type.String({minLength:1,maxLength:40,pattern:JEV_DECISION_ID_PATTERN,description:'Unique lowercase snake_case identifier; undecided is reserved.'}),meaning:Type.String({minLength:1,maxLength:500,pattern:'\\S'}),
              actionTool:Type.Optional(Type.String({minLength:1,maxLength:80,pattern:JEV_DECISION_TOOL_PATTERN,description:'Exact bare registered tool name, e.g. read (not functions.read), for observed application only; never grants a tool permission.'}))}),{minItems:2,maxItems:8})}),
          async execute(_id,params,signal,_update,ctx){
            const request=makeJevDecision(params);
            if(!request)throw new Error('Invalid decision input: use lowercase snake_case purpose/option ids, unique option ids other than undecided, nonblank question/context/meanings and a bare actionTool such as read (not functions.read). No external request made.');
            const record=(entry)=>{try{metrics.record({functionName:'decision',taskDigest:jevTaskDigest(params.question),...entry});}catch{/* metrics cannot grant authority */}};
            record({state:'opportunity',reason:request.state.purpose});
            const epoch=generation;
            let result;
            try{result=await advisor.evaluate({...request,localScopeCwd:ctx?.cwd??process.cwd()},{signal});}
            catch{result={status:'skipped',reason:'internal_error'};}
            const stale=epoch!==generation||!normalizeJevConfig(currentConfig()).engineDecisions;
            const action=stale?undefined:describeJevDecision(result,request);
            if(result.status==='evaluated'&&!result.cached)record({state:'invoked',answer:action?.selected??'invalid_response',
              latencyMs:result.elapsedMs,inputTokens:result.usage?.inputTokens,outputTokens:result.usage?.outputTokens});
            if(action?.selected&&action.selected!=='undecided'){
              record({state:'answered',answer:action.selected,reason:'exposed_to_parent'});
              const chosen=params.options.find(option=>option.id===action.selected);
              if(typeof chosen?.actionTool==='string'&&new RegExp(JEV_DECISION_TOOL_PATTERN).test(chosen.actionTool)){
                pendingActions=[...pendingActions.slice(-15),{generation,toolName:chosen.actionTool,
                  taskDigest:jevTaskDigest(params.question),answer:action.selected,issuedAt:Date.now()}];
              }
            }else record({state:'skipped',reason:stale?'revoked':result.reason??'undecided'});
            return {content:[{type:'text',text:action
              ? `Jev chose ${action.selected}: ${action.nextStep} Parent must still enforce all permissions and verify outcomes.`
              : `Jev decision unavailable (${stale?'revoked':result.reason??'invalid_response'}). Keep the ordinary parent plan.`}],
              details:{decision:action??{selected:'undecided',authority:'none',qualityEvidence:false},
                application:'choice_exposed_to_parent; subsequent action not independently observed'}};
          },
        });
        decisionToolRegistered=true;
      }
      if(decisionToolRegistered&&pi.getActiveTools&&pi.setActiveTools){
        const active=pi.getActiveTools();
        if(decide&&!active.includes('delegate_decide'))pi.setActiveTools([...active,'delegate_decide']);
        else if(!decide&&active.includes('delegate_decide'))pi.setActiveTools(active.filter(name=>name!=='delegate_decide'));
      }
    }
    advisor.refresh();
  };

  const executeEngineCommand=async(action,ctx)=>{
    const statusWindow=/^status(?: (7|30|90|365))?$/.exec(action);
    if(statusWindow){
      const days=Number(statusWindow[1]??30);
      ctx.ui?.notify?.(JSON.stringify({engine:normalizeEngineSettings(readJevConfig(enginePath)),
        effectiveInThisProcess:{forcedOff,forcedRoutingOff:forcedActiveOff,forcedDecisionsOff,
          decisions:normalizeJevConfig(currentConfig()).engineDecisions,
          routing:normalizeJevConfig(currentConfig()).activeRouting},
        advisor:advisor.status(),metrics:metrics.summary({days,routingHistory:advisor.engineHistory?.()}),
        configPath:enginePath,legacyConfigPath:path,legacyActivePath:activePath},null,2),'info');return;
    }
    if(['shadow','routing-shadow','active-on'].includes(action)){
      ctx.ui?.notify?.('Legacy shadow/active-on is not operational Jev approval. Use /delegation-broker-jev on or routing-on with explicit consent. Nothing changed.','warning');return;
    }
    if(action==='active-off')action='routing-off';
    if(!['on','off','decisions-on','decisions-off','routing-on','routing-off','visual-on','visual-off'].includes(action)){
      ctx.ui?.notify?.('Usage: /delegation-broker-jev status [7|30|90|365]|on|off|decisions-on|decisions-off|routing-on|routing-off|visual-on|visual-off','warning');return;
    }
    const enabling=['on','decisions-on','routing-on','visual-on'].includes(action);
    if(action==='visual-on'&&(!ctx.hasUI||!await ctx.ui.confirm('Enable experimental Jev Images / Box?',
      'Allow explicitly selected local images and target descriptions from all working directories to be sent to TypeSafe. Images/Box are experimental; calls may be billed. No automatic screenshot capture or UI action. Presence and box observations are not verification. Approve image export?')))return;
    if(enabling&&action!=='visual-on'&&(!ctx.hasUI||!await ctx.ui.confirm('Enable operational Jev '+action+'?',
      'Explicit separate approval: from ALL current and future parent working directories, send complete parent-supplied delegation briefs or explicitly entered decision questions/context/choices, plus source-attributed public model research cards AND aggregated controller-verified local outcome counts by model/cohort/effort (no task IDs), candidate model identities and effort metadata, to api.typesafe.ai. Text is not automatically redacted. Provider may bill requests; per-session request count is NOT a monetary cap. Routing may really change an eligible read-only child model or auto effort before lease; decisions return a concrete next action to the agent. Broker admission, fresh preflight, consent recheck and independent verification remain mandatory. OFF restores baseline. Approve this new scope and its possible cost?')))return;
    try{
      if(action==='off'){forcedOff=true;forcedActiveOff=true;forcedDecisionsOff=true;advisor.close();generation++;syncTool();}
      if(action==='routing-off'){forcedActiveOff=true;advisor.close();generation++;syncTool();}
      if(action==='decisions-off'){forcedDecisionsOff=true;advisor.close();generation++;syncTool();}
      if(action==='visual-off'){forcedVisualOff=true;advisor.close();generation++;syncTool();}
      let previous=readJevConfig(enginePath);
      if(forcedOff)previous=engineNextState(previous,'off');
      else if(previous&&typeof previous==='object')previous={...previous,
        ...(forcedActiveOff?{routing:false}:{}),...(forcedDecisionsOff?{decisions:false}:{}),
        ...(forcedVisualOff?{visual:false,consentToSendImages:false}:{})};
      const next=engineNextState(previous,action);
      mkdirSync(stateDir,{recursive:true,mode:0o700});writeConfig(enginePath,next);
      forcedOff=forcedActiveOff=forcedDecisionsOff=forcedVisualOff=false;
      generation++;syncTool();
      ctx.ui?.notify?.(`Jev engine: decisions ${next.decisions?'ON':'OFF'}, routing ${next.routing?'ON':'OFF'}, visual ${next.visual?'ON':'OFF'}. ${advisor.status().reason}. Current Pi restart is required if source modules changed since launch.`, 'info');
    }catch{
      ctx.ui?.notify?.('Engine setting could not be saved. Disabling remains effective in THIS process only; inspect jev-engine.json before restarting Pi. No consent was inferred from old settings.','warning');
    }
  };

  pi.registerCommand("delegation-broker-jev", {
    description: engineMode
      ? 'Operational Jev: status [7|30|90|365] | on | off | decisions-on | decisions-off | routing-on | routing-off | visual-on | visual-off. Explicit new consent is required before exporting parent text/images or influencing read-only routes.'
      : "Legacy optional Jev advice: status | off | shadow | on | routing-shadow | routing-off | active-on | active-off.",
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase() || "status";
      if(engineMode)return executeEngineCommand(action,ctx);
      try {
        if (action === "status") {
          ctx.ui?.notify?.(JSON.stringify({ ...advisor.status(), lastObservation, configPath: path, activeConfigPath: activePath }, null, 2), "info");
          return;
        }
        if (!["off", "shadow", "on", "routing-shadow", "routing-off", "active-on", "active-off"].includes(action)) {
          ctx.ui?.notify?.("Usage: /delegation-broker-jev status|off|shadow|on|routing-shadow|routing-off|active-on|active-off", "warning");
          return;
        }
        if (action === "routing-shadow") {
          const existing = normalizeJevConfig(readJevConfig(path));
          if (existing.reason) {
            ctx.ui?.notify?.("Enable ordinary Jev with /delegation-broker-jev on or shadow first. Routing remains off.", "warning");
            return;
          }
          if (!ctx.hasUI || !await ctx.ui.confirm("Enable Jev routing shadow only?",
            "Across projects, send an actual delegated read-only task brief (including supplied workflow dependency excerpts), task class, approved model identities, current and leased model identity, effort mode/level and policy generation to api.typesafe.ai? No credentials, full chat, automatic file reads, candidate account slot IDs or child journals (the parent-supplied task text itself is not redacted). This can incur charges; a process-local request allowance is not a billing cap. Only after a child opens, never for delegate_plan. Jev cannot change model, effort, lease or result; errors leave normal work unchanged.")) return;
          const { reason: _reason, ...previous } = existing;
          mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          writeConfig(path, legacyJevConfig({ ...previous, routeShadow: true, consentToSendRoutingState: true }));
          forcedRoutingOff = false;
          generation++;
          syncTool();
          ctx.ui?.notify?.("Jev routing shadow enabled. No child routing or thinking behavior changed.", "info");
          return;
        }
        if (action === "routing-off") {
          forcedRoutingOff = true;
          generation++;
          advisor.close();
          const { reason: _reason, ...previous } = normalizeJevConfig(readJevConfig(path));
          mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          writeConfig(path, legacyJevConfig({ ...previous, routeShadow: false, consentToSendRoutingState: false }));
          syncTool();
          ctx.ui?.notify?.("Jev routing shadow off. Other optional advice is unchanged.", "info");
          return;
        }
        if (action === "active-on") {
          const existing = normalizeJevConfig(currentConfig());
          if (existing.reason || existing.mode !== "advisory" || existing.activeProjectRoots.length === 0) {
            ctx.ui?.notify?.("Active Jev requires ordinary advisory mode and owner-provisioned activeProjectRoots in jev-active.json. No routing changed.", "warning");
            return;
          }
          if (!ctx.hasUI || !await ctx.ui.confirm("Enable scoped active Jev routing?",
            `Only read-only delegation launched FROM the configured project roots (${existing.activeProjectRoots.join(", ")}) may send its COMPLETE task brief, task class, controller-eligible model identities and reasoning metadata to api.typesafe.ai BEFORE leasing. Jev may prefer a same-quality model or request auto thinking no higher than ${existing.activeAutoThinkingMax}; explicit model/effort, effects, previews and other directories are excluded. Task text is not automatically redacted. There may be API charges, extra latency and quality regressions; unavailable/abstaining advice retains baseline. Off is immediate for new launches.`)) return;
          mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          writeConfig(activePath, { schemaVersion: 1, ...readActiveSettings(readJevConfig(activePath)),
            activeRouting: true, consentToSendActiveRoutingState: true });
          forcedActiveOff = false;
          generation++;
          syncTool();
          ctx.ui?.notify?.("Scoped read-only active Jev enabled for new launches. No running child changed.", "info");
          return;
        }
        if (action === "active-off") {
          forcedActiveOff = true;
          generation++;
          advisor.close();
          mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          writeConfig(activePath, { schemaVersion: 1, ...readActiveSettings(readJevConfig(activePath)),
            activeRouting: false, consentToSendActiveRoutingState: false });
          syncTool();
          ctx.ui?.notify?.("Active Jev off for this process and new sessions; ordinary advice/shadow unchanged.", "info");
          return;
        }
        if (action === "off") {
          // An owner can always stop this process's observer, even if disk writes fail.
          forcedOff = true;
          forcedRoutingOff = true;
          forcedActiveOff = true;
          generation++;
          advisor.close();
          syncTool();
        } else if (!ctx.hasUI || !await ctx.ui.confirm("Enable optional Jev?",
          "Send selected delegation briefs, parent-provided requirements/source quotes, collected report text or patch, and verification summaries to api.typesafe.ai using PI_JEV_API_KEY? No full chat, automatic file reads or child journals. This is a global broker setting for this user, across projects. This may incur API charges. Errors fall back to ordinary work. Shadow also sends data and costs tokens.")) return;
        const { reason: _reason, ...previous } = normalizeJevConfig(readJevConfig(path));
        const value = { ...previous, mode: action === "on" ? "advisory" : action, consentToSendTaskText: action !== "off",
          ...(action === "off" ? { routeShadow: false, consentToSendRoutingState: false,
            activeRouting: false, consentToSendActiveRoutingState: false } : {}) };
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeConfig(path, legacyJevConfig(value));
        if (action === "off") writeConfig(activePath, { schemaVersion: 1,
          ...readActiveSettings(readJevConfig(activePath)), activeRouting: false,
          consentToSendActiveRoutingState: false });
        forcedOff = action === "off";
        generation++;
        syncTool();
        ctx.ui?.notify?.(`Jev ${value.mode}. ${advisor.status().reason ?? "ready"}. Normal delegation/verification remains unchanged.`, "info");
      } catch {
        ctx.ui?.notify?.(forcedOff
          ? "Jev is off in this process, but saving the setting failed. Disable it in jev.json before restarting Pi. Normal delegation is unchanged."
          : forcedRoutingOff && action === "routing-off"
            ? "Jev routing shadow is off in this process, but saving failed. Disable routeShadow in jev.json before restarting Pi. Normal delegation is unchanged."
            : forcedActiveOff && action === "active-off"
              ? "Active Jev is off in this process, but saving failed. Set activeRouting:false in jev-active.json before restarting Pi."
              : "Could not update optional Jev configuration. No delegation settings changed; inspect /delegation-broker-jev status.", "warning");
      }
    },
  });

  if(engineMode)pi.on('tool_result',(event)=>{
    if(event.toolName==='delegate_decide')return;
    const matching=pendingActions.filter(entry=>entry.generation===generation&&entry.toolName===event.toolName
      && Date.now()-entry.issuedAt<300000);
    pendingActions=pendingActions.filter(entry=>!matching.includes(entry)&&entry.generation===generation
      &&Date.now()-entry.issuedAt<300000);
    for(const entry of matching)try{metrics.record({functionName:'decision',state:event.isError?'skipped':'applied',
      reason:event.isError?'selected_tool_failed':'selected_tool_returned_not_task_verified',
      taskDigest:entry.taskDigest,answer:entry.answer});}catch{/* no authority */}
  });
  pi.on("session_start", () => { generation++;pendingActions=[]; advisor.resetSession(); lastObservation = undefined; try { syncTool(); } catch { /* optional */ } });
  pi.on("session_shutdown", () => { generation++; advisor.close(); });
  pi.on("session_tree", () => { generation++; advisor.close(); });
  pi.on("before_agent_start", () => { try { syncTool(); } catch { /* optional */ } });
  pi.on("tool_result", async (event, ctx) => {
    try {
      const config = normalizeJevConfig(currentConfig());
      if (config.reason || !config.result || event.isError) return;
      if (!["delegate", "delegate_collect"].includes(event.toolName)) return;
      const details = event.details;
      let task, reviewedTask, report;
      if (event.toolName === "delegate_collect") {
        if (!event.input?.taskId || details?.status !== "completed" || typeof details.text !== "string") return;
        // The host resolves the full durable task; report.task may be truncated.
        // Workflow inputs include controller-assembled dependency artifacts. Their
        // original node brief is the exact text the parent passed to delegate_review.
        const resolved = reportTask(details, ctx);
        task = typeof resolved === "string" ? resolved : resolved?.task;
        reviewedTask = typeof resolved?.reviewedTask === "string" ? resolved.reviewedTask : task;
        report = details.text;
      } else {
        // Async submission is not a result. Failure/status-only responses are not artifacts.
        if (details?.background || !details?.taskId || (!details.note && !details.receipt)) return;
        if (details.receipt && details.receipt.verified !== true) return;
        task = event.input?.task;
        report = typeof details.patch === "string" ? details.patch : (event.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      }
      if (typeof task !== "string" || typeof report !== "string") return;
      const checklist = checklistFor(ctx, reviewedTask ?? task);
      if (!checklist) return;
      const request = makeJevReview({ phase: "result", task, requirements: checklist.requirements, report, controllerEvidence: safeEvidence(details) });
      if (!request) return;
      const currentGeneration = generation;
      const result = await advisor.evaluate(request, { signal: ctx?.signal });
      if (currentGeneration !== generation) return;
      observe({ ...result, checklistSource: checklist.source }, ctx);
      const advice = formatJevAdvice(result, checklist.requirements);
      if (!advice) return; // failure/off/shadow preserves the exact original tool result
      return {
        content: [...event.content, { type: "text", text: `${advice}\nChecklist source: ${checklist.source}. Original result and controller verification above remain authoritative.` }],
        details: { ...details, jevAdvice: { ...result, checklistSource: checklist.source } },
      };
    } catch { /* a broken observer must never break or overwrite delegate/collect */ }
  });
  try { syncTool(); } catch { /* no optional configuration can prevent extension activation */ }
  return advisor;
}
