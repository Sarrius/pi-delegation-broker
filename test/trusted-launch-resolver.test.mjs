import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";
import { createControllerAcceptancePlan } from "../src/acceptance-plan.mjs";
import { ControllerAcceptanceVerifier } from "../src/acceptance-verifier.mjs";
import { createSelectContract } from "../src/model-selector.mjs";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { ControllerQueuedTaskVerifier, ControllerVerificationAuthority } from "../src/verification-authority.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };
const CONTROLLER_TOKEN = "r".repeat(48);
const EXTENSION_PATH = new URL("./isolated-fake-provider.ts", import.meta.url).pathname;
const BEHAVIORAL_EXTENSION_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;

function signedSupervisor(root, registry = fixtureRegistry(), verificationReceiptVerifier, sweepIntervalMs = 100) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = { registryVersion: "resolver-v1", issuedAt: now - 1_000, expiresAt: now + 60_000, ...registry };
  const unsigned = { schemaVersion: 2, keyId: "resolver-key", registry: payload };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "resolver-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs,
    ...(verificationReceiptVerifier === undefined ? {} : { verificationReceiptVerifier }),
  });
}

function request(childId) {
  return {
    childId,
    promptDigest: "a".repeat(64),
    requestedCwd: tmpdir(),
    isolation: "none",
    schemaRequested: false,
    model: { ...MODEL, thinkingLevel: "off" },
  };
}

function resolverFor(supervisor, root, selectContract, launcherAttestationConfig, extensionPaths = [EXTENSION_PATH], queuedTaskVerifier, routePreflight, refreshProviderState) {
  return new BrokeredLaunchResolver({
    socketPath: supervisor.socketPath,
    controllerToken: supervisor.controllerToken,
    agentRoot: join(root, "child-agents"),
    extensionPaths,
    offline: true,
    selectContract,
    ...(launcherAttestationConfig === undefined ? {} : { launcherAttestationConfig }),
    ...(queuedTaskVerifier === undefined ? {} : { queuedTaskVerifier }),
    ...(routePreflight === undefined ? {} : { routePreflight }),
    ...(refreshProviderState === undefined ? {} : { refreshProviderState }),
  });
}

function gate() { let open; const promise=new Promise(resolve=>{open=resolve;}); return {promise,open}; }

test('cold qualification is enforced before the first real lease and cannot be bypassed by caller data',async()=>{
 const root=mkdtempSync(join(tmpdir(),'br-qualified-')),supervisor=signedSupervisor(root);let checks=0,ready=false;
 try {
  await supervisor.start();
  const resolver=new BrokeredLaunchResolver({socketPath:supervisor.socketPath,controllerToken:supervisor.controllerToken,
   agentRoot:join(root,'children'),extensionPaths:[EXTENSION_PATH],offline:true,
   selectContract:input=>input.capabilityRequest?.excludeResources?.includes('R1')?{action:'deny',reason:'no qualified routes'}:
     {expectedModel:MODEL,contract:fixtureContract({capability:{...fixtureContract().capability,allowedResources:['R1']}})},
   routePreflight:async()=>({status:'ready'}),qualifyRoute:async input=>{
    checks++;assert.equal(input.fresh,true);assert.equal(supervisor.auditSnapshot().leases.length,0);
    return {status:ready?'verified':'failed'};
   },
  });
  const preview=await resolver.preview(request('preview'));assert.equal(preview.status,'compatible_quota_unknown');assert.equal(checks,0);
  assert.equal((await resolver.resolve({...request('cold'),capabilityRequest:{qualified:true,skipReadiness:true}})).action,'deny');
  assert.equal(supervisor.auditSnapshot().leases.length,0);assert.equal(checks,1);
  ready=true;const allowed=await resolver.resolve(request('warm'));assert.equal(allowed.action,'allow');assert.equal(checks,2);
  await allowed.policy.onBeforeChildAbandoned();
 } finally {await supervisor.stop();rmSync(root,{recursive:true,force:true});}
});

test("duplicate child IDs are excluded during selection/provisioning and stale callbacks cannot release a replacement", {timeout:5000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'br-id-race-')), supervisor=signedSupervisor(root);
  const selecting=gate(), selectGate=gate(), provisioning=gate(), provisionGate=gate();
  let count=0, first, resolver;
  try {
    await supervisor.start();
    resolver=new BrokeredLaunchResolver({socketPath:supervisor.socketPath,controllerToken:supervisor.controllerToken,
      agentRoot:join(root,'child-agents'),extensionPaths:[EXTENSION_PATH],offline:true,
      selectContract:async input=>{const number=++count;if(number===1){selecting.open();await selectGate.promise;}
        return {expectedModel:MODEL,contract:fixtureContract({taskId:`task-${input.childId}-${number}`})};},
      provisionChildAuth:async ({contract})=>{if(contract.taskId.endsWith('-1')){provisioning.open();await provisionGate.promise;}},
    });
    const denied={action:'deny',reason:'duplicate child admission'};
    const leases=()=>supervisor.auditSnapshot().leases.map(x=>x.leaseId);
    first=resolver.resolve(request('same_id'));await selecting.promise;
    assert.deepEqual(await resolver.resolve(request('same_id')),denied);assert.equal(count,1);assert.deepEqual(leases(),[]);
    selectGate.open();await provisioning.promise;
    assert.deepEqual(await resolver.resolve(request('same_id')),denied);assert.equal(count,1);assert.equal(leases().length,1);
    provisionGate.open();const owner=await first;assert.equal(owner.action,'allow');
    const oldLease=owner.policy.environment.PI_BROKER_LEASE_ID;
    assert.deepEqual(leases(),[oldLease]);await owner.policy.onBeforeChildAbandoned();assert.deepEqual(leases(),[]);
    const replacement=await resolver.resolve(request('same_id'));assert.equal(replacement.action,'allow');
    const newLease=replacement.policy.environment.PI_BROKER_LEASE_ID;assert.notEqual(newLease,oldLease);
    await owner.policy.onChildSessionOpened();await owner.policy.onBeforeChildAbandoned();await owner.policy.onChildSessionClosed({status:'completed'});
    assert.deepEqual(leases(),[newLease]);assert.equal(resolver.admissions()[0].phase,'pending_handoff');
    assert.equal(existsSync(replacement.policy.agentDir),true);
    await replacement.policy.onBeforeChildAbandoned();assert.deepEqual(leases(),[]);
  } finally {selectGate.open();provisionGate.open();await first?.catch(()=>{});await resolver?.releaseUnhanded('same_id').catch(()=>{});await supervisor.stop();rmSync(root,{recursive:true,force:true});}
});

for(const fault of ['deny','selector','provision']) test(`child ID is reusable after ${fault} failure`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'br-id-failure-')),supervisor=signedSupervisor(root);let calls=0;
 try{
  await supervisor.start();
  const resolver=new BrokeredLaunchResolver({socketPath:supervisor.socketPath,controllerToken:supervisor.controllerToken,
   agentRoot:join(root,'children'),extensionPaths:[EXTENSION_PATH],offline:true,
   selectContract:()=>{calls++;if(calls===1&&fault==='deny')return {action:'deny',reason:'fixture'};
    if(calls===1&&fault==='selector')throw new Error('selector fixture');return {expectedModel:MODEL,contract:fixtureContract()};},
   provisionChildAuth:()=>{if(calls===1&&fault==='provision')throw new Error('provision fixture');},
  });
  if(fault==='deny')assert.equal((await resolver.resolve(request('retry'))).action,'deny');
  else await assert.rejects(resolver.resolve(request('retry')),/fixture/);
  assert.deepEqual(resolver.admissions(),[]);assert.equal(supervisor.auditSnapshot().leases.length,0);
  const retry=await resolver.resolve(request('retry'));assert.equal(retry.action,'allow');
  await retry.policy.onBeforeChildAbandoned();assert.equal(supervisor.auditSnapshot().leases.length,0);
 }finally{await supervisor.stop();rmSync(root,{recursive:true,force:true});}
});

test("route preview checks the exact controller path without allocating a lease or child", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-preview-"));
  const supervisor = signedSupervisor(root);
  let refreshed = 0, checked = 0, routeAvailable = true;
  try {
    await supervisor.start();
    const selectContract = (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    });
    const ready = resolverFor(supervisor, root, selectContract, undefined, [EXTENSION_PATH], undefined,
      async ({ resourceId }) => { checked++; assert.equal(resourceId, `${MODEL.provider}/${MODEL.modelId}`); return { status: routeAvailable ? "ready" : "unavailable", reason: "endpoint offline" }; },
      async () => { refreshed++; });
    const compatible = await ready.preview(request("preview-ready"));
    assert.equal(compatible.status, "compatible_quota_unknown");
    assert.deepEqual(compatible.resourceIds, [`${MODEL.provider}/${MODEL.modelId}`]);
    assert.equal(compatible.budgetSufficiency, "unknown");
    assert.equal(compatible.reserved, false);
    assert.equal(refreshed, 1);
    assert.equal(checked, 1);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(ready.admissions().length, 0);
    assert.equal(existsSync(join(root, "child-agents", "preview-ready")), false);
    routeAvailable = false;
    const changedRoute = await ready.resolve(request("preview-ready"));
    assert.equal(changedRoute.action, "deny", "preview is not authorization; launch rechecks the route");
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(join(root, "child-agents", "preview-ready")), false);

    const dead = resolverFor(supervisor, root, selectContract, undefined, [EXTENSION_PATH], undefined,
      async () => ({ status: "unavailable", reason: "endpoint offline" }));
    const unavailable = await dead.preview(request("preview-dead"));
    assert.equal(unavailable.status, "unavailable_now");
    assert.equal(unavailable.reserved, false);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(dead.admissions().length, 0);
    assert.equal(existsSync(join(root, "child-agents", "preview-dead")), false);

    const withoutExactRoute = resolverFor(supervisor, root, selectContract);
    assert.equal((await withoutExactRoute.preview(request("preview-legacy"))).status, "indeterminate",
      "a catalog-only route cannot be reported ready");
    const preflightError = resolverFor(supervisor, root, selectContract, undefined, [EXTENSION_PATH], undefined,
      async () => { throw new Error("controller route resolution failed"); });
    assert.equal((await preflightError.preview(request("preview-error"))).status, "indeterminate");
    const invalidModel = { ...request("preview-unfit"), model: { provider: "wrong", modelId: "model" } };
    assert.equal((await ready.preview(invalidModel)).status, "known_unfit");
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing observer runs only after a real child handoff, never preview or pre-handoff failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-route-shadow-"));
  const supervisor = signedSupervisor(root);
  const resourceId = "R1";
  const observations = [];
  try {
    await supervisor.start();
    const selectContract = (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}`,
        capability: { ...fixtureContract().capability, allowedResources: [resourceId] } }),
      selection: { resourceId, policyGeneration: "fixture-v1" },
      tier: { resources: [{ resourceId, model: MODEL }] },
    });
    const observeAdmittedRoute = (snapshot) => { observations.push(snapshot); return Promise.reject(new Error("observer failure")); };
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath, controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"), extensionPaths: [EXTENSION_PATH], offline: true,
      resolveModelForResource: () => MODEL,
      routePreflight: async ({resourceId: candidate}) => ({ status: candidate === resourceId ? "ready" : "unavailable" }),
      selectContract, observeAdmittedRoute,
    });
    await resolver.preview(request("shadow-preview"));
    assert.equal(observations.length, 0);
    const abandoned = await resolver.resolve(request("shadow-unopened"));
    assert.equal(abandoned.action, "allow");
    await abandoned.policy.onBeforeChildAbandoned("fixture");
    assert.equal(observations.length, 0);
    const child = await resolver.resolve({ ...request("shadow-opened"), capabilityRequest: {
      taskDescription: "A bounded review brief", routingRouteMode: "auto", routingThinkingMode: "auto",
      routingRequestedThinking: "off", routingTaskClass: "review", routingBriefComplete: true,
    } });
    assert.equal(child.action, "allow");
    assert.equal(observations.length, 0);
    assert.equal((await child.policy.onChildSessionOpened()).status, "handed");
    assert.equal((await child.policy.onChildSessionOpened()).status, "handed");
    assert.equal(observations.length, 1, "one-shot optional observer cannot multiply inference calls");
    assert.equal(observations[0].task, "A bounded review brief");
    assert.deepEqual(observations[0].resourceIds, [resourceId]);
    await child.policy.onChildSessionClosed({ status: "failed" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    const incompleteBrief = await resolver.resolve({ ...request("shadow-role-hidden"), capabilityRequest: {
      taskDescription: "Task omits separate role/skills", routingRouteMode: "auto", routingThinkingMode: "auto",
      routingRequestedThinking: "off", routingTaskClass: "review", routingBriefComplete: false,
    } });
    assert.equal(incompleteBrief.action, "allow", "a partial shadow brief must not block ordinary work");
    await incompleteBrief.policy.onChildSessionOpened();
    assert.equal(observations.length, 1, "incomplete routing context must not be exported as full child task");
    await incompleteBrief.policy.onChildSessionClosed({ status: "failed" });
    const legacy = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath, controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"), extensionPaths: [EXTENSION_PATH], offline: true,
      resolveModelForResource: () => MODEL, selectContract, observeAdmittedRoute,
    });
    const unverified = await legacy.resolve(request("shadow-unverified"));
    assert.equal(unverified.action, "allow", "absence of exact preflight must not break ordinary delegation");
    await unverified.policy.onChildSessionOpened();
    assert.equal(observations.length, 1, "a no-preflight route is not a verified candidate snapshot for Jev");
    await unverified.policy.onChildSessionClosed({ status: "failed" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally { await supervisor.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("controller resolver admits a matching child with only scoped policy data and releases pre-handoff failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-"));
  const supervisor = signedSupervisor(root);
  let resolver;
  try {
    await supervisor.start();
    resolver = resolverFor(supervisor, root, (input) => {
      assert.equal(Object.hasOwn(input, "prompt"), false);
      assert.equal(input.promptDigest, "a".repeat(64));
      return {
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
        selection: { modelTier: "standard", preferenceSource: "auto", legacyExcluded: true, candidateCount: 2 },
      };
    });
    const decision = await resolver.resolve(request("child_A"));
    assert.equal(decision.action, "allow");
    assert.deepEqual(decision.selection, { modelTier: "standard", preferenceSource: "auto", legacyExcluded: true, candidateCount: 2 });
    assert.equal(decision.policy.environment.PI_BROKER_SOCKET, supervisor.socketPath);
    assert.match(decision.policy.environment.PI_BROKER_CAPABILITY, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(JSON.stringify(decision.policy).includes(CONTROLLER_TOKEN), false);
    assert.equal(resolver.admissions().length, 1);
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    assert.equal(existsSync(decision.policy.agentDir), true);
    const bound = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: decision.policy.environment.PI_BROKER_CAPABILITY,
      method: "getEffectiveChildCapability",
    });
    assert.equal(bound.status, "bound");
    assert.equal(bound.capability.capabilityFingerprint, decision.policy.authorizationPolicy.capabilityFingerprint);

    await decision.policy.onBeforeChildAbandoned("child_construction_failed");
    await decision.policy.onBeforeChildAbandoned("child_construction_failed");
    assert.equal(resolver.admissions().length, 0);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(decision.policy.agentDir), false);
    const ledger = JSON.stringify(supervisor.auditSnapshot().events);
    assert.equal(ledger.includes(CONTROLLER_TOKEN), false);
    assert.equal(ledger.includes(decision.policy.environment.PI_BROKER_CAPABILITY), false);

    const handed = await resolver.resolve(request("child_B"));
    assert.equal(handed.action, "allow");
    await handed.policy.onChildSessionClosed();
    await handed.policy.onChildSessionClosed();
    assert.equal(resolver.admissions().length, 0);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(handed.policy.agentDir), false);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver preserves and safely reconciles a release after controller IPC failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-rf-"));
  const supervisor = signedSupervisor(root);
  let restarted;
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const decision = await resolver.resolve(request("child_release_failure"));
    assert.equal(decision.action, "allow");
    await decision.policy.onChildSessionOpened();
    assert.deepEqual(await resolver.reconcilePendingReleases(), [], "active handed child must never be reconciled");
    assert.equal(supervisor.auditSnapshot().leases.length, 1);

    await supervisor.stop();
    // A completed child: its admission must await verification rather than requeue. Closing
    // without a result is deliberately treated as failure, so the intent is stated explicitly.
    await assert.rejects(() => decision.policy.onChildSessionClosed({ status: "completed" }));
    assert.deepEqual(resolver.admissions().map((admission) => admission.phase), ["closed_release_pending"]);
    assert.equal(existsSync(decision.policy.agentDir), true);

    restarted = signedSupervisor(root);
    await restarted.start();
    assert.deepEqual(await resolver.reconcilePendingReleases(), [{ childId: "child_release_failure", status: "released" }]);
    assert.equal(resolver.admissions().length, 0);
    assert.equal(restarted.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(decision.policy.agentDir), false);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact final read-only answer determines verifier outcome and routing label", async () => {
  const root=mkdtempSync(join(tmpdir(),"br-answer-"));
  const evidenceStore=new ControllerEvidenceStore({root:join(root,"evidence")});
  const authority=new ControllerVerificationAuthority({evidenceStore});
  const plans=new Map();
  const outcomes=[];
  let supervisor;
  const verifier=new ControllerQueuedTaskVerifier({authority,
    createVerifier:async({taskId,observedText})=>{
      const plan=plans.get(taskId);
      return new ControllerAcceptanceVerifier({evidenceStore,checks:plan.checks,
        runCheck:(check,options)=>plan.runCheck(check,{...options,observedText})});
    },
    finalize:({taskId,leaseId,fencingToken,verification})=>requestBrokerIpc({
      socketPath:supervisor.socketPath,authorization:supervisor.controllerToken,
      method:"finalizeVerifiedTask",params:{taskId,leaseId,fencingToken,verification},
    }),
    onFinalized:(event)=>{outcomes.push([event.taskId,event.verification.status,event.outcome.status]);},
  });
  supervisor=signedSupervisor(root,fixtureRegistry(),(receipt,binding)=>authority.verify(receipt,binding));
  try {
    await supervisor.start();
    for(const [index,text,expected] of [[1,"wrong final answer","rejected"],[2,"RIGHT","accepted"],[3,undefined,"rejected"]]) {
      const taskId=`answer-task-${index}`;
      const contract=fixtureContract({taskId});
      plans.set(taskId,createControllerAcceptancePlan([{id:"answer-equals",content:"RIGHT"}],{cwd:root,taskMode:"observe"}));
      const resolver=resolverFor(supervisor,root,()=>({expectedModel:MODEL,contract}),undefined,undefined,verifier);
      const decision=await resolver.resolve(request(`child-answer-${index}`));
      assert.equal(decision.action,"allow");
      await decision.policy.onChildSessionOpened();
      assert.deepEqual(await decision.policy.trackForVerification(),{status:"tracked"});
      const result=await decision.policy.onChildSessionClosed({status:"completed",...(text===undefined?{}:{text})});
      assert.equal(result.verification.verification.status,expected);
      assert.equal(result.verification.outcome.status,expected==="accepted"?"completed":"failed");
      assert.equal(supervisor.auditSnapshot().pendingTasks.at(-1).state,expected==="accepted"?"completed":"failed");
    }
    assert.deepEqual(outcomes.map(value=>value.slice(1)),[["rejected","failed"],["accepted","completed"],["rejected","failed"]]);
  } finally {await supervisor.stop().catch(()=>undefined);rmSync(root,{recursive:true,force:true});}
});

test("controller resolver claims an exact ready task, requeues pre-handoff failure, and runs controller verification before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-q-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const evidenceStore = new ControllerEvidenceStore({ root: join(root, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore });
  let supervisor;
  let routingFinalization;
  const queuedTaskVerifier = new ControllerQueuedTaskVerifier({
    authority,
    createVerifier: async ({ taskId }) => ({
      verify: async () => {
        const evidence = evidenceStore.captureObservation({
          kind: "command", claim: "controller completion check",
          observation: { exitCode: 0, stdout: `verified ${taskId}`, stderr: "" },
        });
        return {
          runId: "resolver-queue-verifier", status: "accepted", validation: { status: "accepted" },
          checks: [{ status: "passed" }], result: { evidence: [evidence] },
        };
      },
    }),
    finalize: ({ taskId, leaseId, fencingToken, verification }) => requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "finalizeVerifiedTask",
      params: { taskId, leaseId, fencingToken, verification },
    }),
    onFinalized: (input) => {
      routingFinalization = input;
      return { status: "recorded" };
    },
  });
  // This test dispatches explicitly; a background sweep racing those assertions makes the
  // same correct state transition intermittently disappear from dispatchPending's return.
  supervisor = signedSupervisor(root, registry, (receipt, binding) => authority.verify(receipt, binding), 60_000);
  try {
    await supervisor.start();
    const occupantContract = fixtureContract({ taskId: "resolver-queue-occupant" });
    const occupant = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "reserve",
      params: { contract: occupantContract },
    });
    const queuedContract = fixtureContract({ taskId: "resolver-queued", recovery: { owner: "resolver-controller", deadlineAt: Date.now() + 60_000 } });
    assert.equal((await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "submit",
      params: { contract: queuedContract },
    })).status, "queued");
    await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "release",
      params: { leaseId: occupant.lease.leaseId, fencingToken: occupant.lease.fencingToken },
    });
    let [ready] = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "dispatchPending",
    });
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: queuedContract,
      readyTask: { taskId: queuedContract.taskId, leaseId: ready.lease.leaseId },
    }), undefined, undefined, queuedTaskVerifier);

    const abandoned = await resolver.resolve(request("queued_abandoned"));
    assert.equal(abandoned.action, "allow");
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["claimed"]);
    await abandoned.policy.onBeforeChildAbandoned("child_construction_failed");
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["waiting"]);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);

    [ready] = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "dispatchPending",
    });
    const completed = await resolver.resolve(request("queued_completed"));
    assert.equal(completed.action, "allow");
    await completed.policy.onChildSessionOpened();
    const completion = await completed.policy.onChildSessionClosed({ status: "completed", effectiveThinking: "low" });
    assert.deepEqual(completion.verification.outcome, { status: "completed" });
    assert.deepEqual(completion.verification.routing, { status: "recorded" });
    assert.equal(routingFinalization.routingObservation.resourceId, "R1");
    assert.deepEqual(routingFinalization.routingObservation.capabilities, queuedContract.capability.required);
    assert.equal(routingFinalization.routingObservation.effectiveThinking, "low");
    assert.equal(authority.verify(completion.verification.verification, {
      taskId: queuedContract.taskId,
      leaseId: completed.policy.environment.PI_BROKER_LEASE_ID,
      fencingToken: Number(completed.policy.environment.PI_BROKER_FENCING_TOKEN),
    }), true);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["completed"]);
    assert.equal(resolver.admissions().length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver tracks only a terminal successful handoff before verifier finalization", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-terminal-track-"));
  const evidenceStore = new ControllerEvidenceStore({ root: join(root, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore });
  let supervisor;
  let observed;
  const queuedTaskVerifier = new ControllerQueuedTaskVerifier({
    authority,
    createVerifier: async () => ({
      verify: async () => {
        const evidence = evidenceStore.captureObservation({ kind: "command", claim: "terminal check", observation: { exitCode: 0, stdout: "ok", stderr: "" } });
        return { runId: "terminal-track", status: "accepted", validation: { status: "accepted" }, checks: [{ status: "passed" }], result: { evidence: [evidence] } };
      },
    }),
    finalize: ({ taskId, leaseId, fencingToken, verification }) => requestBrokerIpc({
      socketPath: supervisor.socketPath, authorization: supervisor.controllerToken,
      method: "finalizeVerifiedTask", params: { taskId, leaseId, fencingToken, verification },
    }),
    onFinalized: (input) => { observed = input.routingObservation; return { status: "recorded" }; },
  });
  supervisor = signedSupervisor(root, fixtureRegistry(), (receipt, binding) => authority.verify(receipt, binding));
  try {
    await supervisor.start();
    const contract = fixtureContract({ taskId: "terminal-logical-task" });
    const resolver = resolverFor(supervisor, root, () => ({ expectedModel: MODEL, contract }), undefined, undefined, queuedTaskVerifier);
    const decision = await resolver.resolve(request("terminal-child"));
    assert.equal(decision.action, "allow");
    await decision.policy.onChildSessionOpened();
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks, [], "failed/unfinished attempts never pre-track themselves");
    assert.deepEqual(await decision.policy.trackForVerification(), { status: "tracked" });
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["claimed"]);
    const closed = await decision.policy.onChildSessionClosed({ status: "completed", usage: { input: 8, output: 5 }, attempts: 2 });
    assert.deepEqual(closed.verification.outcome, { status: "completed" });
    assert.equal(observed.tokens, 13);
    assert.equal(observed.attempts, 2);
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["completed"]);
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver denies a child prompt not bound to the selected contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-prompt-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "wrong-frame", promptDigest: "b".repeat(64) }),
    }));
    const decision = await resolver.resolve(request("wrong_frame"));
    assert.deepEqual(decision, { action: "deny", reason: "child prompt is not bound to the selected broker contract" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver denies a model mismatch and reports temporary capacity contention", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-c-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const supervisor = signedSupervisor(root, registry);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const mismatch = await resolver.resolve({ ...request("child_mismatch"), model: { provider: "other", modelId: "wrong", thinkingLevel: "off" } });
    assert.deepEqual(mismatch, { action: "deny", reason: "resolved model is not approved for this broker contract" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);

    const first = await resolver.resolve(request("child_first"));
    assert.equal(first.action, "allow");
    const second = await resolver.resolve(request("child_second"));
    assert.deepEqual(second, { action: "deny", reason: "compatible broker capacity is temporarily busy" });
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    await first.policy.onBeforeChildAbandoned("cancelled_before_child");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller-resolved inherit accepts the same model on a sibling subscription account", async () => {
  const registry = catalogToBrokerRegistry([
    {
      provider: "openai-codex-account-7", baseUrl: "https://account-7.example", api: "openai-completions",
      models: [{ id: "strong", name: "Strong", contextWindow: 400_000, maxTokens: 32_000, reasoning: true, input: ["text"] }],
    },
    {
      provider: "openai-codex-account-2", baseUrl: "https://account-2.example", api: "openai-completions",
      models: [{ id: "strong", name: "Strong", contextWindow: 400_000, maxTokens: 32_000, reasoning: true, input: ["text"] }],
    },
  ], { confidence: "measured" });
  const root = mkdtempSync(join(tmpdir(), "br-inherit-sibling-"));
  const supervisor = signedSupervisor(root, registry);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, createSelectContract({
      registry,
      availability: () => supervisor.inventory(),
    }));
    const inherited = { provider: "openai-codex-account-7", modelId: "strong" };
    const decision = await resolver.resolve({
      childId: "inherit_sibling",
      promptDigest: "a".repeat(64),
      requestedCwd: tmpdir(),
      isolation: "none",
      schemaRequested: false,
      model: { ...inherited, thinkingLevel: "off" },
      capabilityRequest: {
        taskId: "inherit-sibling",
        taskDescription: "read this file and summarize it",
        operationClass: "observe",
        requireModelIdentity: inherited,
        allowSiblingAccounts: true,
        excludeResources: ["openai-codex-account-7/strong"],
      },
    });
    assert.equal(decision.action, "allow", decision.reason ?? "");
    assert.equal(decision.resource.id, "openai-codex-account-2/strong");
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("denied_capacity on a full group retries on the next allow-listed account", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-cap-retry-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const high = {
      minimumProfile: "reasoning-high/v1",
      required: ["code_reasoning", "repo_navigation"],
      downgradePolicy: "forbid",
    };
    const resolver = resolverFor(supervisor, root, (input) => {
      const excluded = new Set(input.capabilityRequest?.excludeResources ?? []);
      const allowedResources = excluded.has("R1") ? ["R2"] : ["R1"];
      return {
        expectedModel: MODEL,
        contract: fixtureContract({
          taskId: `task-${input.childId}`,
          capability: { ...high, allowedResources },
        }),
      };
    });
    const first = await resolver.resolve(request("child_slot"));
    assert.equal(first.action, "allow");
    const second = await resolver.resolve(request("child_teammate"));
    assert.equal(second.action, "allow");
    const leases = supervisor.auditSnapshot().leases.map((lease) => lease.resourceId).sort();
    assert.deepEqual(leases, ["R1", "R2"]);
    await first.policy.onBeforeChildAbandoned("test_cleanup");
    await second.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver refreshes provider state before selecting a launch route", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-refresh-"));
  const supervisor = signedSupervisor(root);
  let refreshes = 0;
  let selections = 0;
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => {
      selections += 1;
      assert.equal(refreshes, selections, "selection must observe a completed provider refresh");
      return { expectedModel: MODEL, contract: fixtureContract({ taskId: "refresh-task" }) };
    }, undefined, [EXTENSION_PATH], undefined, undefined, async () => { refreshes += 1; });
    const decision = await resolver.resolve(request("child_refresh"));
    assert.equal(decision.action, "allow");
    assert.equal(refreshes, 1);
    await resolver.releaseUnhanded("child_refresh");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver fails closed when the provider snapshot cannot be refreshed", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-refresh-fail-"));
  const supervisor = signedSupervisor(root);
  let selections = 0;
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => {
      selections += 1;
      return { expectedModel: MODEL, contract: fixtureContract({ taskId: "refresh-fail-task" }) };
    }, undefined, [EXTENSION_PATH], undefined, undefined, async () => { throw new Error("catalog unavailable"); });
    assert.deepEqual(await resolver.resolve(request("child_refresh_fail")), {
      action: "deny", reason: "controller provider snapshot unavailable",
    });
    assert.equal(selections, 0);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver preflights exact routes before reservation and excludes stale resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-preflight-"));
  const supervisor = signedSupervisor(root);
  const calls = [];
  const { model: _omit, ...requestWithoutModel } = request("child_preflight");
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => {
      const excluded = new Set(input.capabilityRequest?.excludeResources ?? []);
      const resourceId = excluded.has("R1") ? "R2" : "R1";
      return {
        expectedModel: MODEL,
        contract: fixtureContract({
          taskId: `task-${input.childId}`,
          capability: { ...fixtureContract().capability, allowedResources: [resourceId] },
        }),
      };
    }, undefined, [EXTENSION_PATH], undefined, async ({ resourceId }) => {
      calls.push(resourceId);
      return resourceId === "R1"
        ? { status: "unavailable", reason: "model_not_registered", scope: "resource" }
        : { status: "ready" };
    });
    const decision = await resolver.resolve(requestWithoutModel);
    assert.equal(decision.action, "allow");
    assert.deepEqual(calls, ["R1", "R2"]);
    assert.equal(decision.resource.id, "R2");
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    assert.equal(supervisor.auditSnapshot().leases[0].resourceId, "R2");
    assert.equal(supervisor.inventory().find((resource) => resource.resourceId === "R1").state, "unknown");
    await resolver.releaseUnhanded("child_preflight");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requested effort reaches preview and launch preflight without poisoning a healthy unsupported route", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-effort-preflight-"));
  const supervisor = signedSupervisor(root);
  const calls = [];
  const { model: _unusedModel, ...withoutModel } = request("effort_preview");
  const lowRequest = { ...withoutModel, capabilityRequest: { routingRequestedThinking: "low" } };
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => {
      const excluded = new Set(input.capabilityRequest?.excludeResources ?? []);
      const resourceId = excluded.has("R1") ? "R2" : "R1";
      return { expectedModel: MODEL, contract: fixtureContract({ taskId: `task-${input.childId}`,
        capability: { ...fixtureContract().capability, allowedResources: [resourceId] } }) };
    }, undefined, [EXTENSION_PATH], undefined, async ({ resourceId, requestedThinking }) => {
      calls.push({ resourceId, requestedThinking });
      return resourceId === "R1" && requestedThinking === "low"
        ? { status: "unavailable", reason: "reasoning_effort_unsupported", scope: "resource" }
        : { status: "ready" };
    });
    const preview = await resolver.preview(lowRequest);
    assert.equal(preview.status, "compatible_quota_unknown");
    assert.deepEqual(preview.resourceIds, ["R2"]);
    assert.deepEqual(preview.routeDiagnostics.excluded, [{resourceId:'R1',stage:'exact_preflight',reason:'reasoning_effort_unsupported',scope:'resource'}]);
    assert.equal(preview.routeDiagnostics.omittedExclusions,0);
    assert.equal(preview.routeDiagnostics.historicalExplanation,false);
    assert.deepEqual(calls, [{ resourceId: "R1", requestedThinking: "low" }, { resourceId: "R2", requestedThinking: "low" }]);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    const launch = await resolver.resolve({ ...lowRequest, childId: "effort_launch" });
    assert.equal(launch.action, "allow");
    assert.equal(launch.resource.id, "R2");
    assert.equal(supervisor.inventory().find((resource) => resource.resourceId === "R1").state, "healthy",
      "an unsupported effort is not a provider outage and must not quarantine healthy off-capable capacity");
    await launch.policy.onBeforeChildAbandoned();
    const off = await resolver.preview({ ...withoutModel, childId: "effort_off",
      capabilityRequest: { routingRequestedThinking: "off" } });
    assert.deepEqual(off.resourceIds, ["R1"], "ordinary off route remains available");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver adds a pinned final-extension attestation when controller configuration supplies every reviewed digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-attest-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const digest = createHash("sha256").update(readFileSync(BEHAVIORAL_EXTENSION_PATH)).digest("hex");
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-attested" }),
    }), {
      behavioralExtensionPath: BEHAVIORAL_EXTENSION_PATH,
      trustedExtensionDigests: [digest],
    }, [BEHAVIORAL_EXTENSION_PATH]);
    const decision = await resolver.resolve(request("child_attested"));
    assert.equal(decision.action, "allow");
    assert.equal(decision.policy.launcherAttestation.capabilityFingerprint, decision.policy.authorizationPolicy.capabilityFingerprint);
    assert.deepEqual(decision.policy.requiredActiveTools, ["broker_declare_action"]);
    assert.equal(decision.policy.launcherAttestation.extensions.at(-1).path, decision.policy.launcherAttestation.behavioralExtension.path);
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver refuses effect-capable launch before reservation when its extension bytes are not pinned", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-attest-required-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-effect-without-attestation", operationClass: "apply" }),
    }));
    assert.deepEqual(await resolver.resolve(request("child_effect_without_attestation")), {
      action: "deny", reason: "effect capable brokered launch requires pinned extension attestation",
    });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver policy includes compiled capability prompt rules and authorization policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-cap-"));
  const supervisor = signedSupervisor(root);
  let resolver;
  try {
    await supervisor.start();
    resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-capability" }),
    }));
    const decision = await resolver.resolve(request("child_cap"));
    assert.equal(decision.action, "allow");
    assert.equal(typeof decision.policy.promptRules, "string");
    assert.ok(decision.policy.promptRules.includes("operation_class: observe"));
    assert.ok(decision.policy.promptRules.includes("allowed_tools:"));
    assert.ok(decision.policy.authorizationPolicy);
    assert.ok(decision.policy.authorizationPolicy.allowedTools instanceof Set);
    assert.ok(decision.policy.authorizationPolicy.allowedTools.has("read"));
    assert.equal(decision.policy.authorizationPolicy.effectCapable, false);
    assert.equal(decision.policy.authorizationPolicy.operationClass, "observe");
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver admits a launch with no explicit model — the controller selector decides", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-auto-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const { model: _omit, ...withoutModel } = request("child_auto");
    const decision = await resolver.resolve(withoutModel);
    assert.equal(decision.action, "allow", `auto-selected launch must be admitted, got: ${decision.reason}`);
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    await resolver.releaseUnhanded("child_auto");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver still denies an explicit model that does not match the selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-mismatch-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const mismatched = { ...request("child_mm"), model: { provider: "smuggled", modelId: "unapproved", thinkingLevel: "off" } };
    const decision = await resolver.resolve(mismatched);
    assert.equal(decision.action, "deny");
    assert.match(decision.reason, /not approved/);
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "a denied mismatch reserves nothing");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provisionChildAuth runs with the leased resource's model before handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-auth-"));
  const supervisor = signedSupervisor(root);
  const calls = [];
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [EXTENSION_PATH],
      offline: true,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
      }),
      resolveModelForResource: (resourceId) => ({ provider: "broker-fake", modelId: `resolved-${resourceId}` }),
      provisionChildAuth: (input) => { calls.push({ ...input }); },
    });
    const decision = await resolver.resolve(request("child_hook"));
    assert.equal(decision.action, "allow");
    assert.equal(calls.length, 1, "auth provisioning ran exactly once");
    assert.equal(calls[0].childId, "child_hook");
    assert.equal(calls[0].model.provider, "broker-fake");
    assert.match(calls[0].model.modelId, /^resolved-/, "the hook sees the leased resource's model, not the prediction");
    assert.equal(calls[0].agentDir, decision.policy.agentDir);
    assert.equal(existsSync(calls[0].agentDir), true);
    await resolver.releaseUnhanded("child_hook");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing provisionChildAuth denies the launch, frees the lease, and removes the agent dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-authfail-"));
  const supervisor = signedSupervisor(root);
  let capturedDir;
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [EXTENSION_PATH],
      offline: true,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
      }),
      provisionChildAuth: ({ agentDir }) => {
        capturedDir = agentDir;
        throw new Error("no credential for leased provider: broker-fake");
      },
    });
    await assert.rejects(() => resolver.resolve(request("child_fail")), /no credential for leased provider/);
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "lease released after provisioning failure");
    assert.equal(existsSync(capturedDir), false, "agent dir removed after provisioning failure");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe launch lease keeps metered input against a hard catalog resource", async () => {
  const registry = catalogToBrokerRegistry([{
    provider: "solo",
    baseUrl: "https://solo.example",
    api: "openai-completions",
    models: [
      { id: "weak", name: "Weak", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, input: ["text"] },
      { id: "strong", name: "Strong", contextWindow: 400_000, maxTokens: 32_000, reasoning: true, input: ["text"] },
    ],
  }], { confidence: "measured" });
  const root = mkdtempSync(join(tmpdir(), "br-observe-metered-"));
  const supervisor = signedSupervisor(root, registry);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, createSelectContract({
      registry,
      availability: () => supervisor.inventory(),
    }));
    const { model: _omit, ...withoutModel } = request("child_observe_metered");
    const decision = await resolver.resolve({
      ...withoutModel,
      capabilityRequest: {
        taskId: "observe-metered-launch",
        taskDescription: "audit the repository and return evidence",
        operationClass: "observe",
        admissionClass: "work",
      },
    });
    assert.equal(decision.action, "allow", decision.reason ?? "");
    const [lease] = supervisor.auditSnapshot().leases;
    const resource = supervisor.inventory().find((row) => row.resourceId === lease.resourceId);
    assert.deepEqual(resource.enforcement, { input: "hard", output: "hard" });
    assert.deepEqual(lease.enforcement, { input: "metered_best_effort", output: "unavailable" });
    assert.deepEqual(decision.policy.authorizationPolicy.budget.enforcement, lease.enforcement);
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
