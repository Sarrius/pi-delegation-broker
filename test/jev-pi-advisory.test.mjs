import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerJevAdvisory, observeJevRoutingShadow, jevActiveEnabled, adviseJevActiveRoute } from "../src/jev-pi-advisory.mjs";
import {compactModelCriteria} from '../src/model-criteria.mjs';
import {visualFixture} from './fixtures/jev-visual-image.mjs';

const enabled = { mode: "advisory", consentToSendTaskText: true, timeoutMs: 100 };
const task = "Fix login without invalidating existing sessions.";
const requirements = ["Keep existing sessions working.", "Supply regression test evidence."];
function response(body) {
  return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 40, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(JSON.parse(body).questions).map((id) => [id, {
      type: "choice", choice: "potential_gap", confidence: 0.9,
      probabilities: { appears_covered: 0, potential_gap: 1, unclear: 0, not_applicable: 0 },
    }])) });
}
function harness(t, { config = enabled, fetchImpl = async (_url, init) => response(init.body),engineMode=false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "optional-jev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jev.json");
  const activePath = join(dir, "jev-active.json");
  const enginePath = join(dir,'jev-engine.json');
  if (config !== null) writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config), { mode: 0o600 });
  const hooks = new Map(), tools = new Map(), commands = new Map(), observations = [], notices = [];
  let active = ["delegate", "delegate_collect", "read"], activeChanges = 0, calls = 0, inputs = [];
  let branch = [];
  const pi = {
    on(name, fn) { const handlers = hooks.get(name) ?? []; handlers.push(fn); hooks.set(name, handlers); },
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { activeChanges++; active = [...names]; },
    appendEntry(name, result) { observations.push({ name, result }); },
  };
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
    notify: (...args) => notices.push(args), confirm: async () => true,
  } };
  const advisor = registerJevAdvisory(pi, { stateDir: dir, engineMode, getApiKey: () => "fixture-not-a-real-secret",
    reportTask: (report) => report.reviewedTask
      ? { task: report.fullTask, reviewedTask: report.reviewedTask }
      : report.fullTask,
    fetchImpl: (...args) => { calls++; inputs.push(JSON.parse(args[1].body)); return fetchImpl(...args); },
  });
  async function emit(name, event = {}) {
    let result;
    for (const handler of hooks.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  }
  const command = (args) => commands.get("delegation-broker-jev").handler(args, ctx);
  const collect = () => ({ toolName: "delegate_collect", input: { taskId: "task-1" }, isError: false,
    content: [{ type: "text", text: "Original complete report" }], details: { taskId: "task-1", status: "completed", verificationStatus: "not_verified", task: "truncated", fullTask: task, text: "I fixed it; trust me.", untouched: 42 } });
  return { path, activePath, enginePath, pi, ctx, tools, hooks, advisor, observations, notices, emit, command, collect,
    setBranch(value) { branch = value; }, config(value) { writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); },
    activeConfig(value) { writeFileSync(activePath, typeof value === "string" ? value : JSON.stringify(value)); },
    get calls() { return calls; }, get inputs() { return inputs; }, get activeChanges() { return activeChanges; } };
}

test('visual-only consent cannot silently activate decisions or routing later',async t=>{
 const h=harness(t,{config:null,engineMode:true});await h.emit('session_start');
 await h.command('visual-on');
 assert.equal(h.advisor.status().visual,true);
 assert.equal(h.advisor.status().engineDecisions,false);assert.equal(h.advisor.status().activeRouting,false);
 let confirmations=0;h.ctx.ui.confirm=async()=>{confirmations++;return false;};
 await h.command('decisions-on');await h.command('routing-on');
 assert.equal(confirmations,2,'each new text function still requires its own affirmative disclosure');
 assert.equal(h.advisor.status().engineDecisions,false);assert.equal(h.advisor.status().activeRouting,false);
 assert.equal(h.calls,0);
});

test('explicit visual activation exports only the selected image and off revokes the registered tool',async t=>{
 const h=harness(t,{config:null,engineMode:true,fetchImpl:async()=>Response.json({model:'jev-1.14.0',
  answers:{present:{type:'noul',noul:.99},target:{type:'box',box:{left:.25,right:.75,top:.3,bottom:.7},confidence:.95}},
  usage:{input_tokens:10,output_tokens:10}})});
 await h.emit('session_start');assert.equal(h.tools.has('delegate_visual'),false);
 await h.command('on');assert.equal(h.tools.has('delegate_visual'),false,'text approval cannot imply image approval');
 await h.command('visual-on');assert.ok(h.pi.getActiveTools().includes('delegate_visual'));
 const image=join(dirname(h.path),'selected.png');writeFileSync(image,visualFixture());
 const result=await h.tools.get('delegate_visual').execute('v',{path:image,target:'the red rectangle'},undefined,undefined,h.ctx);
 assert.equal(result.details.observation.status,'located');assert.equal(h.calls,1);
 assert.equal(h.inputs[0].model,'jev-1.14.0');assert.equal(Object.keys(h.inputs[0].assets).length,1);
 assert.ok(!JSON.stringify(h.inputs).includes(image));assert.ok(!JSON.stringify(h.observations).includes('data_base64'));
 await h.command('visual-off');assert.ok(!h.pi.getActiveTools().includes('delegate_visual'));
 await assert.rejects(h.tools.get('delegate_visual').execute('v',{path:image,target:'red'},undefined,undefined,h.ctx),/disabled/);
 assert.equal(h.calls,1);
});

for (const [name, config] of [["absent", null], ["off", {}], ["no consent", { mode: "advisory" }], ["broken JSON", "{bad"]]) {
  test(`${name}: zero network, no extra model tool, no changed result or baseline active tools`, async (t) => {
    const h = harness(t, { config });
    await h.emit("session_start");
    await h.emit("before_agent_start");
    assert.equal(h.tools.has("delegate_review"), false);
    assert.equal(h.hooks.has("tool_call"), false, "optional observer cannot block preflight");
    const original = h.collect(), before = structuredClone(original);
    assert.equal(await h.emit("tool_result", original), undefined);
    assert.deepEqual(original, before);
    assert.equal(h.calls, 0);
    assert.equal(h.activeChanges, 0);
    await h.emit("session_shutdown");
  });
}

test('operational ON sends a typed agent decision and exposes separate consent; OFF restores baseline',async(t)=>{
 const h=harness(t,{engineMode:true,config:{...enabled,maxRequestsPerSession:9999,timeoutMs:9500},fetchImpl:async(_url,init)=>{
   const q=JSON.parse(init.body).questions.next_action;
   assert.ok(q);return Response.json({model:'jev-1.13.0',usage:{input_tokens:20,output_tokens:2},answers:{next_action:{type:'choice',
     choice:'inspect',confidence:0.8,probabilities:{inspect:0.8,ignore:0.1,undecided:0.1}}}});
 }});
 assert.equal(h.tools.has('delegate_review'),false,'legacy advisor is not engine approval');
 assert.equal(h.tools.has('delegate_decide'),false);
 assert.equal(h.advisor.status().mode,'off');
 assert.equal(h.calls,0);
 await h.command('status 90');
 const status=JSON.parse(h.notices.at(-1)[0]);assert.equal(status.metrics.windowDays,90);
 assert.equal(status.metrics.controllerHistoryCoverage,'not_loaded');
 h.ctx.hasUI=false;await h.command('on');assert.equal(h.calls,0);
 assert.equal(h.tools.has('delegate_decide'),false,'headless command cannot consent');
 h.ctx.hasUI=true;await h.command('on');
 const engine=JSON.parse(readFileSync(h.enginePath,'utf8'));
 assert.equal(engine.decisions,true);assert.equal(engine.routing,true);assert.equal(engine.scope,'all_cwds');
 assert.equal(h.tools.has('delegate_decide'),true);
 assert.equal(h.advisor.status().maxRequestsPerSession,50,'old cost allowance is not promoted');
 assert.equal(h.advisor.status().timeoutMs,1500,'old latency ceiling is not promoted');
 const output=await h.tools.get('delegate_decide').execute('decision-1',{
   question:'Should I inspect this source?',context:'Need to understand the code before editing.',
   options:[{id:'inspect',meaning:'Read the file.',actionTool:'read'},{id:'ignore',meaning:'Skip the file.'}]},undefined,undefined,h.ctx);
 assert.match(output.content[0].text,/Jev chose inspect/);
 assert.equal(h.calls,1);
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.answered,1);
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.applied,0,'mere display is not observed application');
 await h.emit('tool_result',{toolName:'read',isError:false});
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.applied,1);
 await h.command('routing-off');
 assert.equal(h.advisor.status().activeRouting,false);
 assert.equal(h.pi.getActiveTools().includes('delegate_decide'),true,'decisions remain active');
 await h.command('decisions-off');assert.equal(h.advisor.status().mode,'off');
 assert.equal(h.pi.getActiveTools().includes('delegate_decide'),false);
 await h.command('routing-on');assert.equal(h.advisor.status().activeRouting,true);
 assert.equal(h.pi.getActiveTools().includes('delegate_decide'),false,'routing-only never enables decisions');
 await h.command('off');assert.equal(h.advisor.status().mode,'off');
 assert.equal(h.calls,1);
 assert.equal(JSON.parse(readFileSync(h.path,'utf8')).mode,'advisory','legacy consent remains separate, not promoted');
});

test('operational OFF revokes in process even when persisting the new owner file fails',async t=>{
 const h=harness(t,{engineMode:true});
 await h.command('on');assert.equal(h.advisor.status().activeRouting,true);
 rmSync(h.enginePath);mkdirSync(h.enginePath);
 await h.command('off');assert.equal(h.advisor.status().mode,'off');
 assert.equal(h.pi.getActiveTools().includes('delegate_decide'),false);
 assert.match(h.notices.at(-1)[0],/saving|saved|disk/i);
 await h.command('status');const view=JSON.parse(h.notices.at(-1)[0]);
 assert.equal(view.effectiveInThisProcess.forcedOff,true);
 assert.equal(view.engine.reason,'invalid_config');
});

test('operational route sends the SAME published model/effort evidence visible to the parent, with no account IDs',async t=>{
 const h=harness(t,{engineMode:true,fetchImpl:async(_url,init)=>{
   const request=JSON.parse(init.body);const q=request.questions;
   return Response.json({model:'jev-1.13.0',usage:{input_tokens:51,output_tokens:3},answers:Object.fromEntries(
     Object.entries(q).map(([id,item])=>{const selected=id==='model'?'model_0':'no_recommendation';
       return [id,{type:'choice',choice:selected,confidence:0.7,
         probabilities:Object.fromEntries(Object.keys(item.criteria).map(option=>[option,option===selected?1:0]))}];}))});
 }});
 await h.command('routing-on');
 const snapshot={cwd:dirname(h.path),task:'Read and diagnose this module without writing files.',taskId:'local-only-task-id',
   taskClass:'diagnosis',resourceIds:['cursor-account-2/composer-2.5','openai-codex-account-8/gpt-6-sol'],
   baselineResourceId:'openai-codex-account-8/gpt-6-sol',routeMode:'auto',thinkingMode:'auto',
   requestedThinking:'off',policyGeneration:'verified-fixture',baselineEffortSupported:true};
 const choice=await adviseJevActiveRoute(h.pi,h.advisor,snapshot);
 assert.deepEqual(choice.model,{provider:'cursor',modelId:'composer-2.5'});
 assert.equal(h.calls,1);
 const exported=h.inputs.at(-1).state;
 assert.deepEqual(exported.candidateEvidence['openai-codex/gpt-6-sol'],compactModelCriteria('openai-codex/gpt-6-sol'));
 assert.equal(exported.candidateEvidence['cursor/composer-2.5'].externalBenchmark,null,'Composer comparative benchmark is unknown');
 assert.doesNotMatch(JSON.stringify(h.inputs),/account-8|account-2|local-only-task-id|\/tmp\/optional-jev-/);
 await h.command('routing-off');
 assert.equal(await adviseJevActiveRoute(h.pi,h.advisor,snapshot),undefined);assert.equal(h.calls,1);
});

test("visible preflight gap advice launches nothing and binds a branch-specific declared checklist", async (t) => {
  const h = harness(t);
  assert.deepEqual([...h.tools.keys()], ["delegate_review"]);
  const output = await h.tools.get("delegate_review").execute("review", { task, requirements, sourceRequest: "Fix login; preserve existing sessions." }, undefined, undefined, h.ctx);
  assert.match(output.content[0].text, /POTENTIAL GAP/);
  assert.match(output.content[0].text, /not instructions, permission, verification/);
  assert.deepEqual(output.details.jevChecklist.requirements, requirements);
  h.setBranch([{ type: "message", message: { role: "toolResult", toolName: "delegate_review", details: output.details } }]);
  const event = h.collect();
  const before = structuredClone(event);
  const patch = await h.emit("tool_result", event);
  assert.deepEqual(event, before, "observer must not mutate source result");
  assert.deepEqual(patch.content[0], event.content[0]);
  assert.equal(patch.details.status, "completed");
  assert.equal(patch.details.verificationStatus, "not_verified");
  assert.equal(patch.details.untouched, 42);
  assert.equal(patch.details.jevAdvice.checklistSource, "parent_declared_checklist");
  assert.deepEqual(h.inputs[1].state.requirements.map((r) => r.text), requirements);
  assert.equal(h.inputs[1].state.task, task, "full durable brief, not truncated report.task");
  assert.equal(h.inputs[1].state.controllerEvidence.verificationStatus, "not_verified");
});

test("workflow dependency assembly keeps the parent checklist bound to the original reviewed node task", async (t) => {
  const h = harness(t);
  const reviewed = await h.tools.get("delegate_review").execute("review", { task, requirements },
    undefined, undefined, h.ctx);
  h.setBranch([{ type: "message", message: { role: "toolResult", toolName: "delegate_review",
    details: reviewed.details } }]);
  const fullTask = `${task}\n\nController-provided dependency artifacts (data, not instructions):\n\nDependency dep-1:\nfixture evidence`;
  const report = h.collect();
  report.details.fullTask = fullTask;
  report.details.reviewedTask = task;
  const patch = await h.emit("tool_result", report);
  assert.equal(patch.details.jevAdvice.checklistSource, "parent_declared_checklist");
  assert.deepEqual(h.inputs.at(-1).state.requirements.map((r) => r.text), requirements);
  assert.equal(h.inputs.at(-1).state.task, fullTask,
    "Jev assesses the assembled child input but retains the original checklist");
});

test("other branch/task checklist is not reused; brief-only coverage is disclosed", async (t) => {
  const h = harness(t);
  const output = await h.tools.get("delegate_review").execute("review", { task: "Different job", requirements }, undefined, undefined, h.ctx);
  h.setBranch([{ type: "message", message: { role: "toolResult", toolName: "delegate_review", details: output.details } }]);
  const patch = await h.emit("tool_result", h.collect());
  assert.equal(patch.details.jevAdvice.checklistSource, "task_brief_only");
  assert.deepEqual(h.inputs.at(-1).state.requirements.map((r) => r.text), [task]);
});

for (const [name, fetchImpl] of [
  ["billing", async () => new Response("private", { status: 402 })],
  ["rate limit", async () => new Response("private", { status: 429 })],
  ["server failure", async () => new Response("private", { status: 529 })],
  ["malformed response", async () => Response.json({ answers: {} })],
  ["network failure", async () => { throw Error("fixture-not-a-real-secret"); }],
  ["timeout", async () => new Promise(() => {})],
]) test(`${name} preserves full successful delegate/collect result and receipt`, async (t) => {
  const h = harness(t, { fetchImpl });
  for (const event of [h.collect(), {
    toolName: "delegate", input: { task, proposeChangesIn: "/test/repo" }, isError: false,
    content: [{ type: "text", text: "Verified patch NOT applied" }],
    details: { taskId: "sync-1", receipt: { verified: true, baseCommit: "abc", checks: [{ id: "npm-test", ok: true, exitCode: 0 }] }, patch: "patch content", applied: false },
  }]) {
    const before = structuredClone(event);
    assert.equal(await h.emit("tool_result", event), undefined);
    assert.deepEqual(event, before);
  }
  assert.equal(h.calls, 1, "failure is not retried by a following tool result");
  assert.equal(h.tools.has("delegate"), false, "no replacement of baseline delegation tool");
  assert.doesNotMatch(JSON.stringify(h.observations), /fixture-not-a-real-secret|private/);
});

test("shadow makes observations but leaves result identical and does not show judgments in draft response", async (t) => {
  const h = harness(t, { config: { ...enabled, mode: "shadow" } });
  const output = await h.tools.get("delegate_review").execute("review", { task, requirements }, undefined, undefined, h.ctx);
  assert.doesNotMatch(JSON.stringify(output), /potential_gap|POTENTIAL GAP/);
  assert.equal(await h.emit("tool_result", h.collect()), undefined);
  assert.equal(h.observations.length, 2);
  assert.equal(h.observations[1].result.mode, "shadow");
});

test("queued jobs, failed tools, aggregate summaries and unowned reports trigger no result inference", async (t) => {
  const h = harness(t);
  for (const event of [
    { toolName: "delegate", input: { task }, details: { taskId: "task-1", background: true, status: "submitted" } },
    { ...h.collect(), isError: true },
    { ...h.collect(), details: { ...h.collect().details, status: "failed" } },
    { ...h.collect(), details: { ...h.collect().details, fullTask: undefined } },
    { ...h.collect(), input: {} },
    { toolName: "delegate_workflow", details: { status: "completed" } },
  ]) assert.equal(await h.emit("tool_result", event), undefined);
  assert.equal(h.calls, 0);
});

test("active-on needs scoped consent, sends no local cwd/account alias and active-off revokes new launches",async(t)=>{
  const h=harness(t,{config:enabled,fetchImpl:async(_url,init)=>{
    const questions=JSON.parse(init.body).questions;
    return Response.json({model:"jev-1.13.0",usage:{input_tokens:20,output_tokens:2},answers:Object.fromEntries(Object.entries(questions).map(([id,q])=>{
      const choice=id==="model"?"model_0":"low";
      return [id,{type:"choice",choice,confidence:0.8,probabilities:Object.fromEntries(Object.keys(q.criteria).map(key=>[key,key===choice?1:0]))}];
    }))});
  }});
  const cwd=dirname(h.path);
  await h.command("active-on");
  assert.equal(h.advisor.status().activeRouting,false,"an owner must configure allowed project roots first");
  const original=readFileSync(h.path,"utf8");
  h.activeConfig({schemaVersion:1,activeRouting:false,consentToSendActiveRoutingState:false,
    activeProjectRoots:[cwd],activeAutoThinkingMax:"low"});
  assert.equal(jevActiveEnabled(h.advisor,cwd),false);
  await h.command("active-on");
  assert.equal(readFileSync(h.path,"utf8"),original,"an older running Pi must not be disabled by new keys");
  assert.equal(jevActiveEnabled(h.advisor,cwd),true);
  const snapshot={cwd,task:"Read one module; no file changes.",taskClass:"diagnosis",
    resourceIds:["openai-codex-account-8/gpt-5.6-sol","cursor-account-2/composer-2.5"],
    baselineResourceId:"openai-codex-account-8/gpt-5.6-sol",routeMode:"auto",thinkingMode:"auto",
    requestedThinking:"off",policyGeneration:"fixture-gen",baselineEffortSupported:true};
  const advice=await adviseJevActiveRoute(h.pi,h.advisor,snapshot);
  assert.equal(advice.model.provider,"openai-codex");
  assert.equal(advice.thinking,"low");
  assert.equal(h.calls,1);
  assert.equal(JSON.stringify(h.inputs).includes(cwd),false);
  assert.equal(JSON.stringify(h.inputs).includes("account-8"),false);
  assert.ok(h.observations.some(item=>item.name==="delegation-jev-routing-active-eval-v1"));
  await h.command("active-off");
  assert.equal(readFileSync(h.path,"utf8"),original);
  assert.equal(jevActiveEnabled(h.advisor,cwd),false);
  assert.equal(await adviseJevActiveRoute(h.pi,h.advisor,snapshot),undefined);
  assert.equal(h.calls,1);
});

test("a broken new active file cannot disable the legacy handoff advisor",async(t)=>{
  const h=harness(t);
  h.activeConfig('{not-json');
  await h.emit('before_agent_start');
  assert.equal(h.advisor.status().reason,'ready');
  assert.equal(h.tools.has('delegate_review'),true);
  assert.equal(jevActiveEnabled(h.advisor,dirname(h.path)),false);
  const review=await h.tools.get('delegate_review').execute('review',{task,requirements},undefined,undefined,h.ctx);
  assert.match(review.content[0].text,/POTENTIAL GAP/);
  assert.equal(h.calls,1);
});

test("shadow controls keep the separate active file intact, global off stops both",async(t)=>{
  const h=harness(t),cwd=dirname(h.path);
  h.activeConfig({schemaVersion:1,activeRouting:true,consentToSendActiveRoutingState:true,
    activeProjectRoots:[cwd],activeAutoThinkingMax:'low'});
  assert.equal(jevActiveEnabled(h.advisor,cwd),true);
  await h.command('routing-off');
  assert.equal(jevActiveEnabled(h.advisor,cwd),true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(h.path,'utf8')),'activeRouting'),false);
  await h.command('off');
  assert.equal(jevActiveEnabled(h.advisor,cwd),false);
  assert.equal(JSON.parse(readFileSync(h.activePath,'utf8')).activeRouting,false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(h.path,'utf8')),'activeRouting'),false);
});

test("routing shadow has distinct consent, runs after an admitted-route snapshot and never changes original advice", async (t) => {
  const shadowResponse = (_url, init) => {
    const parsed = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => [id, {
      type: "choice", choice: "no_recommendation", confidence: 0.8,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "no_recommendation" ? 1 : 0])),
    }]));
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 15, output_tokens: 4 }, answers });
  };
  const h = harness(t, { fetchImpl: shadowResponse });
  const snapshot = { task: "PRIVATE REVIEW BRIEF", taskClass: "review",
    taskId: "fixture-job", leaseId: "123e4567-e89b-12d3-a456-426614174000",
    resourceIds: ["slot-account-2/model-a", "slot-account-3/model-b"],
    baselineResourceId: "slot-account-2/model-a", leasedResourceId: "slot-account-2/model-a",
    routeMode: "auto", thinkingMode: "auto", requestedThinking: "off", policyGeneration: "fixture-v1" };
  assert.equal((await observeJevRoutingShadow(h.pi, h.advisor, snapshot)).reason, "feature_disabled");
  assert.equal(h.calls, 0, "the existing handoff/result consent is not routing consent");
  h.ctx.ui.confirm = async () => false;
  await h.command("routing-shadow");
  assert.equal(h.advisor.status().routeShadow, false);
  assert.equal(h.calls, 0);
  h.ctx.ui.confirm = async () => true;
  await h.command("routing-shadow");
  assert.equal(h.advisor.status().routeShadow, true);
  assert.equal(h.advisor.status().routingConsent, true);
  const result = await observeJevRoutingShadow(h.pi, h.advisor, snapshot);
  assert.equal(result.authority, "none");
  assert.equal(result.modelHypothesis, "no_recommendation");
  assert.equal(result.effortHypothesis, "no_recommendation");
  assert.equal(h.calls, 1);
  assert.equal(h.observations.at(-1).name, "delegation-jev-routing-shadow-v1");
  assert.equal(h.observations.at(-1).result.taskId, "fixture-job");
  assert.equal(h.observations.at(-1).result.leaseId, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(Object.hasOwn(h.inputs.at(-1).state, "taskId"), false, "local correlation IDs must not be exported");
  assert.equal(Object.hasOwn(h.inputs.at(-1).state, "leaseId"), false);
  assert.doesNotMatch(JSON.stringify(h.observations), /PRIVATE REVIEW BRIEF|slot-account|fixture-not-a-real-secret/);
  assert.deepEqual(h.pi.getActiveTools().filter((name) => name !== "delegate_review"), ["delegate", "delegate_collect", "read"]);
  await observeJevRoutingShadow(h.pi, h.advisor, { ...snapshot, appliedThinking: "low" });
  assert.equal(h.inputs.at(-1).state.requestedThinking, "off", "caller intent remains distinct");
  assert.equal(h.inputs.at(-1).state.effectiveThinking, "low", "shadow sees the effort actually applied by active choice");
  await h.command("routing-off");
  assert.equal(h.advisor.status().routeShadow, false);
  assert.equal((await observeJevRoutingShadow(h.pi, h.advisor, snapshot)).reason, "feature_disabled");
  assert.equal(h.calls, 2);
  assert.equal(h.pi.getActiveTools().includes("delegate_review"), true, "routing-off must not disable original advice");
});

test("routing-off survives a disk write failure in this process, even if the old enabled file is restored", async (t) => {
  const config = { ...enabled, routeShadow: true, consentToSendRoutingState: true };
  const h = harness(t, { config });
  rmSync(h.path);
  mkdirSync(h.path);
  await h.command("routing-off");
  assert.match(JSON.stringify(h.notices), /routing shadow is off in this process.*saving failed/);
  rmSync(h.path, { recursive: true });
  h.config(config);
  await h.emit("before_agent_start");
  assert.equal(h.advisor.status().routeShadow, false);
  assert.equal(h.advisor.status().routingConsent, false);
  assert.equal(h.calls, 0);
  assert.equal(h.pi.getActiveTools().includes("delegate_review"), true);
});

test("routing consent does not silently reactivate after global Jev off/on", async (t) => {
  const h = harness(t);
  await h.command("routing-shadow");
  assert.equal(h.advisor.status().routeShadow, true);
  await h.command("off");
  assert.equal(h.advisor.status().routeShadow, false);
  await h.command("on");
  assert.equal(h.advisor.status().routeShadow, false);
  assert.equal(h.advisor.status().routingConsent, false);
});

test("on requires explicit consent, off deactivates only advisory tool, missing key is not a blocker", async (t) => {
  const h = harness(t, { config: null });
  h.ctx.ui.confirm = async () => false;
  await h.command("on");
  assert.equal(h.tools.has("delegate_review"), false);
  h.ctx.ui.confirm = async () => true;
  await h.command("on");
  assert.equal(h.pi.getActiveTools().includes("delegate_review"), true);
  assert.deepEqual(h.pi.getActiveTools().filter((x) => x !== "delegate_review"), ["delegate", "delegate_collect", "read"]);
  await h.command("off");
  assert.deepEqual(h.pi.getActiveTools(), ["delegate", "delegate_collect", "read"]);
  assert.equal(await h.emit("tool_result", h.collect()), undefined);
  assert.equal(h.calls, 0);
  await h.command("status");
  assert.doesNotMatch(JSON.stringify(h.notices), /fixture-not-a-real-secret/);
});

for (const lifecycle of ["session_shutdown", "session_tree", "session_start"]) test(`${lifecycle} invalidates a pending observer without affecting original result`, async (t) => {
  let resolveResponse, body;
  const h = harness(t, { config: { ...enabled, timeoutMs: 1000 }, fetchImpl: (_url, init) => { body = init.body; return new Promise((resolve) => { resolveResponse = resolve; }); } });
  const event = h.collect(), before = structuredClone(event);
  const pending = h.emit("tool_result", event);
  await h.emit(lifecycle);
  resolveResponse(response(body));
  assert.equal(await pending, undefined);
  assert.deepEqual(event, before);
});

test("broken telemetry, context and runtime config never alter baseline results", async (t) => {
  const h = harness(t);
  h.pi.appendEntry = () => { throw Error("disk error"); };
  assert.ok(await h.emit("tool_result", h.collect()), "telemetry failure does not hide useful valid advice");
  h.ctx.sessionManager.getBranch = () => { throw Error("session unavailable"); };
  assert.equal(await h.emit("tool_result", h.collect()), undefined);
  h.config("broken");
  await h.emit("before_agent_start");
  assert.equal(await h.emit("tool_result", h.collect()), undefined);
  assert.deepEqual(h.pi.getActiveTools(), ["delegate", "delegate_collect", "read"]);
});

test("off works in memory even when persistence fails; restoring an enabled file cannot resurrect it", async (t) => {
  const h = harness(t);
  rmSync(h.path);
  mkdirSync(h.path); // atomic rename of a file over a directory must fail
  await h.command("off");
  assert.match(JSON.stringify(h.notices), /off in this process.*saving the setting failed/);
  rmSync(h.path, { recursive: true });
  h.config(enabled);
  await h.emit("before_agent_start");
  assert.equal(h.advisor.status().mode, "off");
  assert.equal(await h.emit("tool_result", h.collect()), undefined);
  assert.equal(h.calls, 0);
  await h.command("on");
  assert.equal(h.advisor.status().reason, "ready");
});

test("off during a result request discards the late response and keeps original result", async (t) => {
  let resolveResponse, body;
  const h = harness(t, { config: { ...enabled, timeoutMs: 1000 }, fetchImpl: (_url, init) => { body = init.body; return new Promise((resolve) => { resolveResponse = resolve; }); } });
  const original = h.collect();
  const pending = h.emit("tool_result", original);
  await h.command("off");
  resolveResponse(response(body));
  assert.equal(await pending, undefined);
  assert.deepEqual(original.content, [{ type: "text", text: "Original complete report" }]);
  assert.equal(h.advisor.status().mode, "off");
});
