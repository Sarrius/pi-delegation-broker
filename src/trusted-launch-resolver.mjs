import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { compileEffectiveChildCapability, createEffectiveChildCapability, deriveAllowedTools } from "./capability-compiler.mjs";
import { provisionBrokeredAgentDir } from "./isolated-child-config.mjs";
import { requestBrokerIpc } from "./ipc.mjs";
import { createLauncherAttestation } from "./launcher-attestation.mjs";
import { baseRouteProvider } from "./model-provenance-policy.mjs";
import { qualityForModel } from "./model-quality-catalog.mjs";
import { parseResourceModel } from "./model-selector.mjs";
import { THINKING_LEVELS } from "./child-contract.mjs";

const CHILD_ID = /^[A-Za-z0-9_-]{1,160}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROUTE_PREFLIGHT_ROUNDS = 64;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const identityOf = (entry) => entry?.model ?? parseResourceModel(entry?.resourceId);
const sameIdentity = (left, right) => Boolean(left?.provider && left?.modelId && right?.provider && right?.modelId
  && baseRouteProvider(left.provider) === baseRouteProvider(right.provider) && left.modelId === right.modelId);

/** Total tokens a route consumed, or undefined when the transport reported no usage. */
function tokensOf(usage) {
  const total = (Number.isSafeInteger(usage?.input) ? usage.input : 0) + (Number.isSafeInteger(usage?.output) ? usage.output : 0);
  return total > 0 ? total : undefined;
}

function ownerOnlyDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error(`${label} must be an owner-only directory`);
  return canonical;
}

function expectedModel(selection) {
  const model = selection?.expectedModel;
  if (!model || typeof model.provider !== "string" || !model.provider || typeof model.modelId !== "string" || !model.modelId) {
    throw new Error("Broker launch selection needs an explicit expectedModel");
  }
  return model;
}

/**
 * Controller-side implementation of pi-subagent-workflow's trusted resolver.
 * It is intentionally separate from child code: only this object can use the
 * supervisor controller token to reserve/release; a child receives only the
 * lease-scoped capability placed into its normalized launch policy.
 */
export class BrokeredLaunchResolver {
  #socketPath;
  #controllerToken;
  #agentRoot;
  #extensionPaths;
  #offline;
  #selectContract;
  #launcherAttestationConfig;
  #queuedTaskVerifier;
  #trackImmediateTasks;
  #resolveModelForResource;
  #refreshProviderState;
  #routePreflight;
  #qualifyRoute;
  #provisionChildAuth;
  #controllerProxy;
  #observeAdmittedRoute;
  #activeRouteAllowed;
  #adviseActiveRoute;
  #observeEngineHandoff;
  #admissions = new Map();
  #resolving = new Set();

  constructor({
    socketPath,
    controllerToken,
    agentRoot,
    extensionPaths,
    offline = false,
    selectContract,
    launcherAttestationConfig,
    queuedTaskVerifier,
    trackImmediateTasks = false,
    resolveModelForResource,
    refreshProviderState,
    routePreflight,
    qualifyRoute,
    provisionChildAuth,
    controllerProxy,
    observeAdmittedRoute,
    activeRouteAllowed,
    adviseActiveRoute,
    observeEngineHandoff,
  }) {
    if (typeof socketPath !== "string" || !isAbsolute(socketPath)) throw new Error("Broker launch resolver needs an absolute socketPath");
    if (typeof controllerToken !== "string" || controllerToken.length < 32) throw new Error("Broker launch resolver needs a controller-only token");
    if (!Array.isArray(extensionPaths) || extensionPaths.length === 0 || extensionPaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
      throw new Error("Broker launch resolver needs non-empty absolute explicit extension paths");
    }
    if (typeof offline !== "boolean") throw new Error("Broker launch resolver offline must be boolean");
    if (typeof selectContract !== "function") throw new Error("Broker launch resolver needs a controller selectContract function");
    if (resolveModelForResource !== undefined && typeof resolveModelForResource !== "function") {
      throw new Error("Broker launch resolver resolveModelForResource must be a controller-owned function");
    }
    if (refreshProviderState !== undefined && typeof refreshProviderState !== "function") {
      throw new Error("Broker launch resolver refreshProviderState must be a controller-owned function");
    }
    if (routePreflight !== undefined && typeof routePreflight !== "function") {
      throw new Error("Broker launch resolver routePreflight must be a controller-owned function");
    }
    if (qualifyRoute !== undefined && typeof qualifyRoute !== "function") throw new Error("Broker qualification must be controller-owned");
    if (provisionChildAuth !== undefined && typeof provisionChildAuth !== "function") {
      throw new Error("Broker launch resolver provisionChildAuth must be a controller-owned function");
    }
    if (observeAdmittedRoute !== undefined && typeof observeAdmittedRoute !== "function") {
      throw new Error("Broker launch resolver observeAdmittedRoute must be a controller-owned function");
    }
    if ((activeRouteAllowed === undefined) !== (adviseActiveRoute === undefined)
      || (activeRouteAllowed !== undefined && typeof activeRouteAllowed !== "function")
      || (adviseActiveRoute !== undefined && typeof adviseActiveRoute !== "function")) {
      throw new Error("Broker active route needs paired controller-owned scope and advice functions");
    }
    if(observeEngineHandoff!==undefined&&typeof observeEngineHandoff!=='function')
      throw new Error('engine handoff observer must be controller-owned');
    if (controllerProxy !== undefined && (!controllerProxy || typeof controllerProxy !== "object"
      || typeof controllerProxy.providerId !== "string" || !PROVIDER_ID.test(controllerProxy.providerId))) {
      throw new Error("controllerProxy requires a bounded providerId");
    }
    if (controllerProxy !== undefined && provisionChildAuth !== undefined) {
      throw new Error("controllerProxy and provisionChildAuth are mutually exclusive");
    }
    if (queuedTaskVerifier !== undefined && typeof queuedTaskVerifier.verifyAndFinalize !== "function") {
      throw new Error("Broker launch resolver queuedTaskVerifier must be a controller-owned verifier coordinator");
    }
    if (typeof trackImmediateTasks !== "boolean" || (trackImmediateTasks && !queuedTaskVerifier)) {
      throw new Error("tracked immediate tasks require a controller-owned verifier coordinator");
    }
    if (launcherAttestationConfig !== undefined) {
      if (!launcherAttestationConfig || typeof launcherAttestationConfig !== "object" || Array.isArray(launcherAttestationConfig)
        || !Array.isArray(launcherAttestationConfig.trustedExtensionDigests)
        || launcherAttestationConfig.trustedExtensionDigests.length !== extensionPaths.length
        || typeof launcherAttestationConfig.behavioralExtensionPath !== "string" || !isAbsolute(launcherAttestationConfig.behavioralExtensionPath)) {
        throw new Error("Broker launch resolver launcherAttestationConfig needs final behavioralExtensionPath and one pinned digest per explicit extension");
      }
    }
    this.#socketPath = socketPath;
    this.#controllerToken = controllerToken;
    this.#agentRoot = ownerOnlyDirectory(agentRoot, "Broker child agent root");
    this.#extensionPaths = Object.freeze([...extensionPaths]);
    this.#offline = offline;
    this.#selectContract = selectContract;
    this.#launcherAttestationConfig = launcherAttestationConfig === undefined ? undefined : Object.freeze({
      behavioralExtensionPath: launcherAttestationConfig.behavioralExtensionPath,
      trustedExtensionDigests: Object.freeze([...launcherAttestationConfig.trustedExtensionDigests]),
    });
    this.#queuedTaskVerifier = queuedTaskVerifier;
    this.#trackImmediateTasks = trackImmediateTasks;
    this.#resolveModelForResource = resolveModelForResource;
    this.#refreshProviderState = refreshProviderState;
    this.#routePreflight = routePreflight;
    this.#qualifyRoute = qualifyRoute;
    this.#provisionChildAuth = provisionChildAuth;
    this.#controllerProxy = controllerProxy === undefined ? undefined : Object.freeze({ providerId: controllerProxy.providerId });
    this.#observeAdmittedRoute = observeAdmittedRoute;
    this.#activeRouteAllowed = activeRouteAllowed;
    this.#adviseActiveRoute = adviseActiveRoute;
    this.#observeEngineHandoff=observeEngineHandoff;
  }

  /**
   * Advisory pre-submission route inspection. Uses the very same selector and exact-route
   * checks as resolve(), but does not reserve a lease, mark a provider unhealthy, or create a
   * child. A compatible result says nothing about provider quota on the next inference call.
   */
  async preview(request) {
    if (!request || !CHILD_ID.test(request.childId ?? "")) throw new Error("Broker preview request has an invalid childId");
    const excluded = [...(Array.isArray(request.capabilityRequest?.excludeResources)
      ? request.capabilityRequest.excludeResources : [])];
    const observations=[];let omittedExclusions=0;
    const diagnostics=()=>Object.freeze({scope:'current_preview_exact_preflight',historicalExplanation:false,
      excluded:Object.freeze([...observations]),omittedExclusions});
    for (let round = 1; round <= ROUTE_PREFLIGHT_ROUNDS + 1; round++) {
      const inspected = await this.#inspectSelection(request, excluded, round, false);
      if (inspected.action === "exclude") {
        for (const entry of inspected.exclusions ?? []) {
          if(observations.length<64)observations.push(Object.freeze({...entry,stage:'exact_preflight'}));
          else omittedExclusions++;
        }
        for (const resourceId of inspected.resourceIds) if (!excluded.includes(resourceId)) excluded.push(resourceId);
        continue;
      }
      if (inspected.action === "deny") {
        const indeterminate = ["controller provider snapshot unavailable", "controller route preflight failed"].includes(inspected.reason);
        const contractMismatch = ["effect capable brokered launch requires pinned extension attestation",
          "child prompt is not bound to the selected broker contract",
          "resolved model is not approved for this broker contract"].includes(inspected.reason);
        return Object.freeze({ status: indeterminate ? "indeterminate" : contractMismatch ? "known_unfit" : "unavailable_now",
          reason: inspected.reason, reserved: false, checkedAt: Date.now(),routeDiagnostics:diagnostics() });
      }
      if (!inspected.routeVerified) return Object.freeze({ status: "indeterminate",
        reason: "controller exact route preflight unavailable", reserved: false, checkedAt: Date.now(),routeDiagnostics:diagnostics() });
      const resourceIds = inspected.resourceIds;
      return Object.freeze({ status: "compatible_quota_unknown", reserved: false,
        budgetSufficiency: "unknown", checkedAt: Date.now(),routeDiagnostics:diagnostics(),
        resourceIds: Object.freeze(resourceIds.slice(0, 32)), candidateCount: resourceIds.length });
    }
    return Object.freeze({ status: "unavailable_now", reason: "controller route readiness could not be established",
      reserved: false, checkedAt: Date.now(),routeDiagnostics:diagnostics() });
  }

  async #inspectSelection(request, excludeResources, attempt, quarantine) {
    // Refresh and select through one path for both preview and physical launch. Preview has no
    // side effects; launch additionally quarantines routes that this exact preflight rejects.
    if (this.#refreshProviderState !== undefined) {
      try { await this.#refreshProviderState(); }
      catch { return { action: "deny", reason: "controller provider snapshot unavailable" }; }
    }
    const selection = await this.#selectContract(Object.freeze({
      ...request,
      capabilityRequest: Object.freeze({
        ...(request.capabilityRequest ?? {}),
        ...(excludeResources.length > 0 ? { excludeResources: Object.freeze([...excludeResources]) } : {}),
      }),
    }));
    if (selection?.action === "deny") return { action: "deny", reason: safeReason(selection.reason) };
    if (!selection?.contract) throw new Error("Broker launch selection did not return a contract");
    if (["propose_patch", "apply", "external_write"].includes(selection.contract.operationClass) && !this.#launcherAttestationConfig) {
      return { action: "deny", reason: "effect capable brokered launch requires pinned extension attestation" };
    }
    if (selection.contract.promptDigest !== request.promptDigest) {
      return { action: "deny", reason: "child prompt is not bound to the selected broker contract" };
    }
    const expected = expectedModel(selection);
    const inherited = request.capabilityRequest?.requireModelIdentity;
    const inheritedSibling = request.capabilityRequest?.allowSiblingAccounts === true
      && request.model !== undefined
      && inherited?.provider === request.model.provider
      && inherited?.modelId === request.model.modelId
      && request.model.modelId === expected.modelId
      && baseRouteProvider(request.model.provider) === baseRouteProvider(expected.provider);
    if (request.model !== undefined
      && (request.model.provider !== expected.provider || request.model.modelId !== expected.modelId)
      && !inheritedSibling) {
      return { action: "deny", reason: "resolved model is not approved for this broker contract" };
    }
    const candidates = Array.isArray(selection.contract.capability?.allowedResources)
      && selection.contract.capability.allowedResources.length > 0
      ? [...new Set(selection.contract.capability.allowedResources)]
      : [`${expected.provider}/${expected.modelId}`];
    if (this.#routePreflight === undefined) return { action: "ready", selection, resourceIds: candidates, routeVerified: false };
    if (attempt > ROUTE_PREFLIGHT_ROUNDS) return { action: "deny", reason: "controller route readiness could not be established" };
    const unavailable = [];
    // The caller's requested level is part of route compatibility, not just the model name.
    // The native route resolver repeats this check after leasing, guarding catalog drift.
    const requestedThinking = THINKING_LEVELS.includes(request.capabilityRequest?.routingRequestedThinking)
      ? request.capabilityRequest.routingRequestedThinking
      : THINKING_LEVELS.includes(request.model?.thinkingLevel) ? request.model.thinkingLevel : undefined;
    try {
      for (const resourceId of candidates) {
        const result = await this.#routePreflight(Object.freeze({ resourceId,
          ...(requestedThinking ? { requestedThinking } : {}),
          ...(request.capabilityRequest?.jevActiveEffort === true ? { requireExactEffortSupport: true } : {}),
        }));
        if (!result || typeof result !== "object" || !["ready", "unavailable"].includes(result.status)) {
          throw new Error("invalid route preflight result");
        }
        if (result.status === "ready" && quarantine && this.#qualifyRoute) {
          const qualified = await this.#qualifyRoute({resourceId, thinking: requestedThinking ?? "off", signal: request.signal, fresh: true});
          if (qualified?.status !== "verified") {
            unavailable.push({resourceId, reason: "route_not_qualified", scope: "resource"});
            continue;
          }
        }
        if (result.status === "unavailable") unavailable.push({
          resourceId,
          reason: safeReason(result.reason ?? "controller route unavailable"),
          scope: result.scope === "capacity_group" ? "capacity_group" : "resource",
        });
      }
    } catch { return { action: "deny", reason: "controller route preflight failed" }; }
    if (unavailable.length > 0) {
      if (quarantine) for (const entry of unavailable) {
        // A healthy route can lack one requested effort level. Exclude it for this launch,
        // but never poison provider health for the next (possibly off-level) task.
        if (["reasoning_effort_unsupported", "route_not_qualified"].includes(entry.reason)) continue;
        await this.#controller("markUnknown", {
          resourceId: entry.resourceId, reason: entry.reason, scope: entry.scope,
          // Exact dispatch observation outranks a later bulk catalog listing.
          evidence: "dispatch",
        }).catch(() => undefined);
      }
      return { action: "exclude", resourceIds: unavailable.map((entry) => entry.resourceId),exclusions:unavailable };
    }
    return { action: "ready", selection, resourceIds: candidates, routeVerified: true };
  }

  #activeCandidates(selection) {
    const allowed = selection?.contract?.capability?.allowedResources;
    const resources = selection?.tier?.resources;
    const baselineId = selection?.selection?.resourceId;
    const profile = selection?.tier?.profile;
    if (!Array.isArray(allowed) || !Array.isArray(resources) || !allowed.includes(baselineId)
      || typeof profile !== "string" || selection?.contract?.capability?.minimumProfile !== profile
      || typeof selection.selection?.policyGeneration !== "string") return undefined;
    const baseline = resources.find((entry) => entry.resourceId === baselineId);
    const quality = qualityForModel({ ...identityOf(baseline), generation: baseline?.generation });
    if (!quality || quality === "apex") return undefined;
    const resourceIds = resources.filter((entry) => allowed.includes(entry.resourceId)
      && qualityForModel({ ...identityOf(entry), generation: entry.generation }) === quality)
      .map((entry) => entry.resourceId);
    if (!resourceIds.includes(baselineId) || resourceIds.length > 128) return undefined;
    return Object.freeze({ resourceIds: Object.freeze(resourceIds), baselineId, profile, quality,
      modelTier: selection.selection.modelTier, policyGeneration: selection.selection.policyGeneration,
      fingerprint: sha256(JSON.stringify({ allowed, resourceIds, baselineId, profile,
        quality, policyGeneration: selection.selection.policyGeneration, modelTier: selection.selection.modelTier })) });
  }

  async #activeProposal(request, inspected) {
    const capability = request.capabilityRequest;
    if (!this.#routePreflight || !this.#adviseActiveRoute || !this.#activeRouteAllowed
      || this.#trackImmediateTasks || !inspected.routeVerified || request.model !== undefined
      || capability?.routingRouteMode !== "auto" || capability.routingThinkingMode !== "auto"
      || capability.routingRequestedThinking !== "off" || capability.routingBriefComplete !== true
      || capability.routingActiveBriefComplete === false
      || capability.requireModelIdentity !== undefined || capability.apexAdmission !== undefined
      || capability.jevActivePreference === true
      || inspected.selection?.contract?.operationClass !== "observe"
      || inspected.selection.contract.admissionClass !== "work"
      || inspected.selection.selection?.preferenceSource !== "auto"
      || inspected.selection?.readyTask !== undefined
      || typeof capability.taskDescription !== "string"
      || sha256(capability.taskDescription) !== request.promptDigest
      || capability.taskDescription.length > 24_000
      || request.signal?.aborted) return undefined;
    try { if (!this.#activeRouteAllowed({ cwd: request.requestedCwd })) return undefined; }
    catch { return undefined; }
    const candidates = this.#activeCandidates(inspected.selection);
    if (!candidates) return undefined;
    let baselineEffortSupported = false;
    if (capability.routingThinkingMode === "auto" && capability.routingRequestedThinking === "off") {
      try { baselineEffortSupported = (await this.#routePreflight(Object.freeze({
        resourceId: candidates.baselineId, requestedThinking: "low", requireExactEffortSupport: true,
      })))?.status === "ready"; } catch { /* optional effort hypothesis is unsupported */ }
    }
    if (new Set(candidates.resourceIds.map((id) => {
      const model = parseResourceModel(id);
      return `${baseRouteProvider(model.provider)}/${model.modelId}`;
    })).size < 2 && !baselineEffortSupported) return undefined;
    // Exact preflight is asynchronous. Off/revocation during that wait must stop the
    // first external text export even if an injected advisor omits its own consent gate.
    let stillAllowed = false;
    try { stillAllowed = this.#activeRouteAllowed({ cwd: request.requestedCwd }) === true; }
    catch { /* a broken advisor cannot block the admitted baseline */ }
    if (request.signal?.aborted || !stillAllowed) return undefined;
    let advice;
    try { advice = await this.#adviseActiveRoute(Object.freeze({
      task: capability.taskDescription, taskId:inspected.selection.contract.taskId,
      taskClass: capability.routingTaskClass ?? "general",
      resourceIds: candidates.resourceIds, baselineResourceId: candidates.baselineId,
      routeMode: "auto", thinkingMode: capability.routingThinkingMode,
      requestedThinking: capability.routingRequestedThinking,
      policyGeneration: candidates.policyGeneration, baselineEffortSupported,
      cwd: request.requestedCwd,
    }), request.signal); }
    catch { /* JEV cannot turn an admitted baseline into a denial */ }
    return { candidates, baselineEffortSupported, advice };
  }

  /** Compatible with TrustedChildLaunchResolver; request has no raw prompt. */
  async resolve(request) {
    const childId = request?.childId;
    if (typeof childId !== "string" || !CHILD_ID.test(childId)) throw new Error("Broker launch request has an invalid childId");
    if (this.#resolving.has(childId) || this.#admissions.has(childId)) return { action: "deny", reason: "duplicate child admission" };
    this.#resolving.add(childId);
    try { return await this.#resolveOwned({ ...request, childId }); }
    finally { this.#resolving.delete(childId); }
  }

  async #resolveOwned(request) {
    const recursion = request.recursion;
    if (recursion !== undefined) {
      const context = recursion?.context;
      if (recursion?.mode !== "depth2_readonly_canary" || !context || context.maxDepth !== 2
        || typeof context.rootId !== "string" || typeof context.parentTaskId !== "string"
        || !Number.isSafeInteger(context.depth) || context.depth !== 1) {
        return { action: "deny", reason: "recursive launch policy denied" };
      }
    }

    // A full capacity group is not "no compatible resource". The selector's first allow-list
    // is often one account (Cursor); a teammate already holding that slot must land elsewhere.
    // Narrow the allow-list and select again instead of failing the whole launch.
    const excludeResources = [...(Array.isArray(request.capabilityRequest?.excludeResources)
      ? request.capabilityRequest.excludeResources : [])];
    let selection;
    let reservation;
    let queuedTaskId;
    let routeVerified = false;
    let sawCapacityContention = false;
    let adviceAttempted = false;
    let activePreference;
    let activeThinking;
    let activeMeta;
    const resetAdvice = () => { activePreference = undefined; activeThinking = undefined; activeMeta = undefined; };
    const releaseRejectedActiveLease = async () => {
      try {
        if (queuedTaskId === undefined) await this.#releaseLease(reservation.lease);
        else await this.#abandonClaimed(queuedTaskId, reservation.lease);
        return true;
      } catch { return false; }
    };
    const activeAllowed = () => {
      try { return this.#activeRouteAllowed?.({ cwd: request.requestedCwd }) === true; }
      catch { return false; }
    };
    for (let attempt = 1; ; attempt++) {
      if (request.signal?.aborted) return { action: "deny", reason: "child launch cancelled" };
      const active = Boolean(activePreference || activeThinking);
      const selectRequest = !active ? request : { ...request, capabilityRequest: {
        ...request.capabilityRequest,
        requireModelIdentity: activePreference, allowSiblingAccounts: true,
        jevActivePreference: true,
        ...(activeThinking ? { routingRequestedThinking: activeThinking, jevActiveEffort: true } : {}),
      } };
      let inspected = await this.#inspectSelection(selectRequest, excludeResources, attempt, true);
      if (inspected.action === "deny" || inspected.action === "exclude") {
        if (active) { resetAdvice(); continue; } // An optional hint can never strand the baseline.
        if (inspected.action === "deny") return { action: "deny",
          reason: sawCapacityContention ? "compatible broker capacity is temporarily busy" : inspected.reason };
        for (const resourceId of inspected.resourceIds) if (!excludeResources.includes(resourceId)) excludeResources.push(resourceId);
        continue;
      }
      if (!adviceAttempted) {
        adviceAttempted = true;
        const proposal = await this.#activeProposal(request, inspected);
        if (request.signal?.aborted) return { action: "deny", reason: "child launch cancelled" };
        if (proposal) {
          // Jev waited before any reservation. Reinspect the whole baseline, not only its
          // suggested model; any changed candidate, policy or capability invalidates the hint.
          const fresh = await this.#inspectSelection(request, excludeResources, attempt, true);
          if (fresh.action === "deny") return { action: "deny", reason: fresh.reason };
          if (fresh.action === "exclude") {
            for (const resourceId of fresh.resourceIds) if (!excludeResources.includes(resourceId)) excludeResources.push(resourceId);
            continue;
          }
          inspected = fresh;
          const candidates = this.#activeCandidates(fresh.selection);
          const hint = proposal.advice;
          const adviceStillValid = activeAllowed() && !request.signal?.aborted
            && candidates?.fingerprint === proposal.candidates.fingerprint
            && hint?.authority === "none"
            && hint?.candidateSetDigest === sha256(JSON.stringify(candidates.resourceIds));
          if (adviceStillValid) {
            const target = hint.model;
            const validTarget = target && typeof target.provider === "string" && typeof target.modelId === "string";
            const matched = validTarget && candidates.resourceIds.some((id) => sameIdentity(parseResourceModel(id), target));
            const raiseEffort = hint.thinking === "low" && proposal.baselineEffortSupported === true
              && (!target || (validTarget && sameIdentity(target, parseResourceModel(candidates.baselineId))))
              && request.capabilityRequest?.routingThinkingMode === "auto"
              && request.capabilityRequest.routingRequestedThinking === "off";
            if (matched || raiseEffort) {
              activePreference = matched ? target : parseResourceModel(candidates.baselineId);
              activeThinking = raiseEffort ? "low" : undefined;
              activeMeta = { candidates, digest: hint.digest, modelAnswer: hint.modelAnswer,
                effortAnswer: hint.effortAnswer, baselineResourceId: candidates.baselineId,
                baselineThinking: request.capabilityRequest.routingRequestedThinking };
              continue; // Re-select the *actual* identity and re-preflight it before reserving.
            }
          }
        }
      }
      if (active && (!activeAllowed() || !activeMeta
        || inspected.selection.tier?.profile !== activeMeta.candidates.profile
        || inspected.selection.selection?.policyGeneration !== activeMeta.candidates.policyGeneration
        || inspected.selection.selection?.modelTier !== activeMeta.candidates.modelTier
        || inspected.selection.selection?.preferenceSource !== "auto"
        || inspected.selection.contract.capability.allowedResources.some((id) => {
          const entry = inspected.selection.tier.resources.find((resource) => resource.resourceId === id);
          return !activeMeta.candidates.resourceIds.includes(id)
            || !sameIdentity(parseResourceModel(id), activePreference)
            || qualityForModel({ ...identityOf(entry), generation: entry?.generation }) !== activeMeta.candidates.quality;
        }))) {
        resetAdvice(); continue;
      }
      if (request.signal?.aborted) return { action: "deny", reason: "child launch cancelled" };
      selection = inspected.selection;
      routeVerified = inspected.routeVerified === true;
      queuedTaskId = undefined;
      if (selection.readyTask !== undefined) {
        if (!selection.readyTask || selection.readyTask.taskId !== selection.contract.taskId
          || typeof selection.readyTask.leaseId !== "string" || !selection.readyTask.leaseId) {
          return { action: "deny", reason: "ready task selection does not match broker contract" };
        }
        queuedTaskId = selection.readyTask.taskId;
        reservation = await this.#controller("claimReadyTask", {
          taskId: queuedTaskId,
          leaseId: selection.readyTask.leaseId,
          contract: selection.contract,
        });
      } else {
        reservation = await this.#controller("reserve", { contract: selection.contract });
      }
      if (reservation?.status === "leased") {
        if (request.signal?.aborted) {
          if (!await releaseRejectedActiveLease()) return { action: "deny", reason: "broker could not release cancelled child lease" };
          return { action: "deny", reason: "child launch cancelled" };
        }
        if (active && !activeAllowed()) {
          if (!await releaseRejectedActiveLease()) return { action: "deny", reason: "broker could not release rejected active lease" };
          resetAdvice();
          continue;
        }
        if (activeThinking === "low") {
          let effortReady = false;
          try { effortReady = (await this.#routePreflight({ resourceId: reservation.lease.resourceId,
            requestedThinking: "low", requireExactEffortSupport: true }))?.status === "ready"; }
          catch { /* no provider dispatch on an unverified effort */ }
          if (!effortReady || !activeAllowed() || request.signal?.aborted) {
            if (!await releaseRejectedActiveLease()) return { action: "deny", reason: "broker could not release rejected active lease" };
            resetAdvice();
            if (request.signal?.aborted) return { action: "deny", reason: "child launch cancelled" };
            continue;
          }
        }
        break;
      }
      if (reservation?.status === "denied_capacity") sawCapacityContention = true;
      const blocked = selection.contract.capability?.allowedResources;
      if (active && reservation?.status === "denied_capacity") {
        // An optional preference that is busy cannot strand unrelated eligible capacity.
        resetAdvice();
        for (const id of blocked ?? []) if (!excludeResources.includes(id)) excludeResources.push(id);
        continue;
      }
      const canNarrow = reservation?.status === "denied_capacity"
        && Array.isArray(blocked) && blocked.length > 0
        && attempt < 4
        && blocked.some((id) => typeof id === "string" && !excludeResources.includes(id));
      if (!canNarrow) {
        return { action: "deny", reason: reservation?.status === "denied_capacity"
          ? "compatible broker capacity is temporarily busy"
          : "broker policy denied launch" };
      }
      for (const id of blocked) if (typeof id === "string" && !excludeResources.includes(id)) excludeResources.push(id);
    }
    const lease = reservation.lease;
    let agentDir;
    const assertLaunchLive = () => {
      if (request.signal?.aborted) throw new Error("child launch cancelled");
      if (activeMeta && !activeAllowed()) throw new Error("active JEV scope revoked during handoff");
    };
    try {
      if (queuedTaskId === undefined && this.#trackImmediateTasks && selection.trackImmediateTask === true) {
        const tracked = await this.#controller("trackLeasedTask", {
          contract: selection.contract,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
        });
        if (tracked?.status !== "tracked") {
          await this.#releaseLease(lease).catch(() => undefined);
          return { action: "deny", reason: "broker could not durably track launch" };
        }
        queuedTaskId = selection.contract.taskId;
      }
      assertLaunchLive();
      const issued = await this.#controller("issueLeaseCapability", { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
      if (issued?.status !== "issued" || typeof issued.capability !== "string") throw new Error("Broker declined lease capability issuance");
      assertLaunchLive();
      agentDir = provisionBrokeredAgentDir(join(this.#agentRoot, request.childId)).agentDir;
      // The broker may lease a different resource in the contracted class than the selector
      // predicted, so the child runs on the model its lease is accounted against. Compute it
      // before auth provisioning: the scoped credential written next is for THIS account.
      const resolvedModel = this.#resolveModelForResource?.(lease.resourceId);
      if (activeMeta && (!activeMeta.candidates.resourceIds.includes(lease.resourceId)
        || !sameIdentity(resolvedModel, activePreference))) {
        throw new Error("controller leased a model outside the revalidated JEV candidate identity");
      }
      if (this.#provisionChildAuth !== undefined) {
        await this.#provisionChildAuth({
          agentDir,
          childId: request.childId,
          resourceId: lease.resourceId,
          model: resolvedModel?.provider && resolvedModel?.modelId
            ? Object.freeze({ provider: resolvedModel.provider, modelId: resolvedModel.modelId })
            : undefined,
          contract: selection.contract,
        });
        assertLaunchLive();
      }
      const childModel = this.#controllerProxy && resolvedModel?.modelId
        ? Object.freeze({ provider: this.#controllerProxy.providerId, modelId: resolvedModel.modelId })
        : resolvedModel;
      const baseAllowedTools = selection.contract.allowedTools ?? deriveAllowedTools(selection.contract.operationClass);
      const delegation = recursion ? {
        mode: "read_only_canary",
        grantId: lease.leaseId,
        rootTaskId: recursion.context.rootId,
        parentTaskId: recursion.context.parentTaskId,
        depth: recursion.context.depth,
        maxDepth: recursion.context.maxDepth,
        maxChildren: recursion.context.maxDirectChildren,
        maxParallel: recursion.context.maxParallel,
        maxAttemptsPerChild: recursion.context.maxAttempts ?? 1,
        maxResultBytes: 256 * 1024,
      } : undefined;
      const capability = createEffectiveChildCapability({
        schemaVersion: 1,
        taskId: lease.taskId,
        operationClass: selection.contract.operationClass,
        admissionClass: selection.contract.admissionClass,
        doneWhen: selection.contract.doneWhen,
        allowedTools: Object.freeze([...new Set([...baseAllowedTools, ...(delegation ? ["broker_request_child", "broker_cancel_child"] : [])])]),
        profileSupports: selection.contract.capability.required,
        budget: {
          ...(lease.maxOutputTokens !== undefined ? { maxOutputTokens: lease.maxOutputTokens } : {}),
          ...(lease.maxInputTokens !== undefined ? { maxInputTokens: lease.maxInputTokens } : {}),
          enforcement: lease.enforcement,
        },
        latencyBudgetMs: selection.contract.latencyBudgetMs,
        leaseTtlMs: selection.contract.leaseTtlMs ?? 30_000,
        promptDigest: selection.contract.promptDigest,
        behavioralEnforcement: lease.behavioralEnforcement,
        downgradePolicy: selection.contract.capability.downgradePolicy,
        ...(delegation ? { delegation } : {}),
      });
      const compiled = compileEffectiveChildCapability(capability);
      const launcherAttestation = this.#launcherAttestationConfig === undefined ? undefined : createLauncherAttestation({
        capabilityFingerprint: capability.capabilityFingerprint,
        extensionPaths: this.#extensionPaths,
        trustedExtensionDigests: this.#launcherAttestationConfig.trustedExtensionDigests,
        behavioralExtensionPath: this.#launcherAttestationConfig.behavioralExtensionPath,
      });
      const bound = await this.#controller("bindEffectiveChildCapability", {
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        capability,
      });
      if (bound?.status !== "bound" || bound.capabilityFingerprint !== capability.capabilityFingerprint) {
        throw new Error("Broker declined effective child capability binding");
      }
      assertLaunchLive();
      const activeCohort = activeMeta
        ? `routing-active-v2:${request.capabilityRequest?.routingTaskClass ?? "general"}:requested-${activeMeta.baselineThinking}:selected-${activeThinking ?? activeMeta.baselineThinking}`
        : undefined;
      const admission = {
        lease,
        agentDir,
        ...(activeCohort ? { activeCohort } : {}),
        capability: issued.capability,
        contract: selection.contract,
        phase: "pending_handoff",
        ...(queuedTaskId === undefined ? {} : {
          queuedTaskId,
          routingObservation: Object.freeze({
            resourceId: lease.resourceId,
            capabilities: Object.freeze([...selection.contract.capability.required]),
            issuedAt: lease.issuedAt,
            ...(activeCohort ? { activeCohort } : {}),
          }),
        }),
      };
      this.#admissions.set(request.childId, admission);
      const owned = (callback) => (...args) => this.#admissions.get(request.childId) === admission
        ? callback(...args) : Promise.resolve({ status: "already_released" });
      // Capture only a vetted, identity-consistent candidate set. The observer is invoked
      // *after child handoff* below, never during preview or for an unlaunched lease. It is
      // fire-and-forget: neither an answer nor an error can change admission or effort.
      const candidates = selection.contract.capability?.allowedResources;
      const candidateModel = (id) => selection.tier?.resources?.find((entry) => entry.resourceId === id)?.model;
      const expected = selection.expectedModel;
      const observation = this.#observeAdmittedRoute && routeVerified
        && request.capabilityRequest?.routingBriefComplete === true
        && selection.contract.operationClass === "observe"
        && Array.isArray(candidates) && candidates.length > 0
        && candidates.includes(selection.selection?.resourceId) && candidates.includes(lease.resourceId)
        && expected?.provider && expected?.modelId
        && candidateModel(selection.selection.resourceId)?.provider === expected.provider
        && candidateModel(selection.selection.resourceId)?.modelId === expected.modelId
        && candidateModel(lease.resourceId)?.provider === resolvedModel?.provider
        && candidateModel(lease.resourceId)?.modelId === resolvedModel?.modelId
        ? Object.freeze({
          task: request.capabilityRequest?.taskDescription,
          taskId: selection.contract.taskId, leaseId: lease.leaseId,
          resourceIds: Object.freeze([...candidates]),
          baselineResourceId: selection.selection.resourceId,
          leasedResourceId: lease.resourceId,
          routeMode: request.capabilityRequest?.routingRouteMode,
          thinkingMode: request.capabilityRequest?.routingThinkingMode,
          requestedThinking: request.capabilityRequest?.routingRequestedThinking,
          ...(activeThinking ? { appliedThinking: activeThinking } : {}),
          taskClass: request.capabilityRequest?.routingTaskClass,
          policyGeneration: selection.selection.policyGeneration,
        }) : undefined;
      let observationIssued = false;
      let engineHandoffIssued=false;
      return {
        action: "allow",
        resource: Object.freeze({ id: lease.resourceId, profile: lease.profile, capacityGroup: lease.capacityGroup }),
        // Selector provenance is controller-only, prompt-free metadata. Carry it to the parent
        // result so "why this route?" never has to reconstruct a decision from opaque logs.
        ...(selection.selection && typeof selection.selection === "object" ? { selection: activeMeta
          ? Object.freeze({ ...selection.selection, jevActive: Object.freeze({
            version: "delegation-routing-active-v2", applied: true,
            baselineResourceId: activeMeta.baselineResourceId,
            requestedThinking: activeMeta.baselineThinking,
            recommendedThinking: activeThinking ?? null,
            modelAnswer: activeMeta.modelAnswer, effortAnswer: activeMeta.effortAnswer,
            digest: activeMeta.digest,
          }) }) : selection.selection } : {}),
        ...(activeThinking ? { selectedThinking: activeThinking } : {}),
        ...(resolvedModel?.provider && resolvedModel?.modelId
          ? { resolvedModel: Object.freeze({ provider: resolvedModel.provider, modelId: resolvedModel.modelId }) }
          : {}),
        ...(childModel?.provider && childModel?.modelId
          ? { childModel: Object.freeze({ provider: childModel.provider, modelId: childModel.modelId }) }
          : {}),
        policy: {
          policyId: lease.leaseId,
          agentDir,
          promptRules: compiled.promptRules,
          authorizationPolicy: compiled.authorizationPolicy,
          offline: this.#offline,
          extensionPaths: launcherAttestation === undefined
            ? this.#extensionPaths
            : Object.freeze(launcherAttestation.extensions.map((extension) => extension.path)),
          ...(launcherAttestation === undefined ? {} : {
            launcherAttestation,
            requiredActiveTools: ["broker_declare_action", ...(delegation ? ["broker_request_child"] : [])],
          }),
          ...(recursion ? { recursion: Object.freeze({ ...recursion.context }) } : {}),
          environment: {
            PI_BROKER_SOCKET: this.#socketPath,
            PI_BROKER_LEASE_ID: lease.leaseId,
            PI_BROKER_FENCING_TOKEN: String(lease.fencingToken),
            PI_BROKER_CAPABILITY: issued.capability,
            ...(recursion ? { PI_BROKER_RECURSION: recursion.mode } : {}),
            // Pi's CLI has no max-tokens flag, so the leased hard output cap has to reach the
            // child's provider request itself; without it a child asks for the model maximum
            // and a low-balance account rejects the whole attempt.
            ...(lease.maxOutputTokens === undefined ? {} : { PI_BROKER_MAX_OUTPUT_TOKENS: String(lease.maxOutputTokens) }),
            ...(this.#controllerProxy && resolvedModel?.modelId ? {
              PI_BROKER_PROXY_MODEL_ID: resolvedModel.modelId,
              PI_BROKER_PROXY_INPUT_MODALITIES: selection.contract.capability.required.includes("vision_input")
                ? "text,image"
                : "text",
            } : {}),
            ...(this.#launcherAttestationConfig === undefined ? {} : { PI_BROKER_EXPECT_BEHAVIORAL_TOOLS: "1" }),
          },
          onBeforeChildAbandoned: owned(() => this.releaseUnhanded(request.childId)),
          onChildSessionOpened: owned(async () => {
            // Child construction is asynchronous, so revoke a now-disallowed active
            // choice before marking the session handed or sending its first prompt.
            if (request.signal?.aborted || (activeMeta && !activeAllowed())) return { status: "revoked" };
            const handed = await this.markChildHanded(request.childId);
            if (handed.status === "handed" && observation && !observationIssued) {
              observationIssued = true;
              try { void Promise.resolve(this.#observeAdmittedRoute(observation)).catch(() => undefined); }
              catch { /* optional observer cannot fail a child after handoff */ }
            }
            if(handed.status==='handed'&&!engineHandoffIssued&&this.#observeEngineHandoff){
              engineHandoffIssued=true;
              try{void Promise.resolve(this.#observeEngineHandoff(Object.freeze({
                taskId:selection.contract.taskId,operationClass:selection.contract.operationClass,
                routeMode:request.capabilityRequest?.routingRouteMode,
                thinkingMode:request.capabilityRequest?.routingThinkingMode,
                taskClass:request.capabilityRequest?.routingTaskClass,
                resourceId:lease.resourceId,baselineResourceId:activeMeta?.baselineResourceId??selection.selection?.resourceId,
                ...(activeMeta?{applied:true,digest:activeMeta.digest}:{}),
                requestedThinking:request.capabilityRequest?.routingRequestedThinking,
                effectiveThinking:activeThinking??request.capabilityRequest?.routingRequestedThinking,
              }))).catch(()=>undefined);}catch{/* metrics cannot fail a handed child */}
            }
            return handed;
          }),
          // A completed direct-provider child is evidence that the exact leased route is live.
          // Report it while the lease still exists so a half-open probe can close its breaker.
          onProviderSucceeded: owned(() => this.markHandedProviderSucceeded(request.childId)),
          // The runner calls this only after its final successful route is known. Tracking an
          // earlier failover attempt would let a verifier accept stale work or lose the final
          // route's efficiency observation.
          trackForVerification: owned(() => this.trackHandedChildForVerification(request.childId)),
          onChildSessionClosed: owned((result) => this.finalizeHandedChild(request.childId, result)),
        },
      };
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      const revoked = activeMeta && !activeAllowed();
      let released = false;
      try {
        if (queuedTaskId === undefined) await this.#releaseLease(lease);
        else await this.#abandonClaimed(queuedTaskId, lease);
        released = true;
      } catch { /* never retry or promote a lease whose cleanup is unknown */ }
      if (agentDir) this.#removeAgentDir(agentDir);
      if (cancelled || revoked) {
        if (!released) return { action: "deny", reason: "broker could not release cancelled or revoked child lease" };
        if (cancelled) return { action: "deny", reason: "child launch cancelled" };
        // An optional hint revoked during controller handoff must not strand the baseline.
        // The one-shot brief flag prevents a second Jev request or recursive active retry.
        return this.#resolveOwned({ ...request, capabilityRequest: {
          ...request.capabilityRequest, routingActiveBriefComplete: false,
        } });
      }
      throw error;
    }
  }

  /**
   * Report that a provider refused the work with a rate limit. This is the only way staleness
   * can be observed at all: a throttled account still appears connected in Pi's own files, so
   * nothing short of a failed attempt reveals it. The whole capacity group cools down, because
   * every model of one account draws on one quota, and the broker's existing half-open probe
   * brings it back on its own once the cooldown expires.
   */
  async reportProviderRateLimited(resourceId, retryAfterMs) {
    return this.#controller("markRateLimited", {
      resourceId,
      ...(Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {}),
    });
  }

  /**
   * Report that a provider/model is currently unusable. The broker quarantines the proven
   * scope, then permits one registry-bounded half-open probe after its retry interval. This
   * avoids hot-looping a revoked credential while still letting a refreshed credential or
   * repaired proxy recover without manual database surgery.
   */
  async reportProviderUnavailable(resourceId, reason, scope = "resource", evidence = "dispatch") {
    if (scope !== "resource" && scope !== "capacity_group") throw new Error("provider unavailable scope must be resource or capacity_group");
    return this.#controller("markUnknown", { resourceId, reason: safeReason(reason), scope, evidence });
  }

  /** Idempotent pre-handoff cleanup called only by the trusted parent runner. */
  async releaseUnhanded(childId) {
    return this.#releaseAdmission(childId, "release_pending");
  }

  /** Called after the trusted runner has a real ChildSession/process. */
  async markChildHanded(childId) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "already_released" };
    if (admission.phase === "pending_handoff") admission.phase = "handed";
    return { status: admission.phase };
  }

  /** Record provider success against the exact still-live lease, not an unauthenticated id. */
  async markHandedProviderSucceeded(childId) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "already_released" };
    if (admission.phase !== "handed") return { status: "denied_policy", reason: `admission_phase_${admission.phase}` };
    return this.#controller("markProviderSucceeded", {
      leaseId: admission.lease.leaseId,
      fencingToken: admission.lease.fencingToken,
    });
  }

  /**
   * Convert a handed final child into a durably tracked task immediately before controller
   * verification. Earlier failed attempts deliberately never enter the pending-task ledger.
   */
  async trackHandedChildForVerification(childId) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "denied_policy", reason: "admission_missing" };
    if (admission.phase !== "handed") return { status: "denied_policy", reason: `admission_phase_${admission.phase}` };
    if (admission.queuedTaskId) return { status: "tracked" };
    const tracked = await this.#controller("trackLeasedTask", {
      contract: admission.contract,
      leaseId: admission.lease.leaseId,
      fencingToken: admission.lease.fencingToken,
    });
    if (tracked?.status !== "tracked") return tracked ?? { status: "denied_policy" };
    admission.queuedTaskId = admission.contract.taskId;
    admission.routingObservation = Object.freeze({
      resourceId: admission.lease.resourceId,
      capabilities: Object.freeze([...admission.contract.capability.required]),
      issuedAt: admission.lease.issuedAt,
      ...(admission.activeCohort ? { activeCohort: admission.activeCohort } : {}),
    });
    return Object.freeze({ status: "tracked" });
  }

  /**
   * Child teardown releases capacity but cannot complete the queued task. The
   * durable task waits for a separate controller verifier receipt.
   */
  async finalizeHandedChild(childId, result) {
    // Do not let the caller's child result influence terminal acceptance.
    const admission = this.#admissions.get(childId);
    // Only a completed child may move its task toward verification. A failed route requeues the
    // task instead, so the next attempt can claim the same logical work; sending a failure down
    // the verification path would ask the verifier to judge work that was never produced.
    const succeeded = result?.status === "completed";
    const released = await this.#releaseAdmission(childId, succeeded ? "closed_release_pending" : "release_pending");
    if (!admission?.queuedTaskId || released.status !== "awaiting_verification" || !this.#queuedTaskVerifier) return released;
    const verification = await this.#queuedTaskVerifier.verifyAndFinalize({
      taskId: admission.queuedTaskId,
      leaseId: admission.lease.leaseId,
      fencingToken: admission.lease.fencingToken,
      observedText: result?.text,
      routingObservation: Object.freeze({
        resourceId: admission.routingObservation.resourceId,
        capabilities: admission.routingObservation.capabilities,
        ...(admission.routingObservation.activeCohort ? { activeCohort: admission.routingObservation.activeCohort } : {}),
        latencyMs: Math.max(0, Date.now() - admission.routingObservation.issuedAt),
        // What this route consumed to reach a verifiable result. Absent when the transport
        // reported no usage; the journal then records reliability without an efficiency sample.
        ...(tokensOf(result?.usage) === undefined ? {} : { tokens: tokensOf(result.usage) }),
        ...(Number.isSafeInteger(result?.attempts) && result.attempts >= 1 ? { attempts: result.attempts } : {}),
        ...(THINKING_LEVELS.includes(result?.effectiveThinking)
          ? { effectiveThinking: result.effectiveThinking } : {}),
      }),
    });
    return Object.freeze({ ...released, verification });
  }

  /** Retry only records explicitly known to be unhanded or session-closed. */
  async reconcilePendingReleases() {
    const outcomes = [];
    for (const [childId, admission] of this.#admissions) {
      if (admission.phase !== "release_pending" && admission.phase !== "closed_release_pending") continue;
      try {
        outcomes.push(Object.freeze({ childId, ...(await this.#releaseAdmission(childId, admission.phase)) }));
      } catch {
        outcomes.push(Object.freeze({ childId, status: "pending" }));
      }
    }
    return Object.freeze(outcomes);
  }

  /** Redacted controller-local visibility; capabilities/controller token stay private. */
  admissions() {
    return Object.freeze([...this.#admissions.entries()].map(([childId, admission]) => Object.freeze({
      childId,
      leaseId: admission.lease.leaseId,
      fencingToken: admission.lease.fencingToken,
      expiresAt: admission.lease.expiresAt,
      phase: admission.phase,
      ...(admission.queuedTaskId === undefined ? {} : { queuedTaskId: admission.queuedTaskId }),
    })));
  }

  async #releaseAdmission(childId, pendingPhase) {
    const admission = this.#admissions.get(childId);
    if (!admission) return { status: "already_released" };
    admission.phase = pendingPhase;
    // Do not forget an admission before controller IPC confirms. On a broker
    // transport failure the controller retains a redacted record and agent dir
    // for explicit retry/reconciliation instead of silently relying on TTL.
    let result;
    if (admission.queuedTaskId === undefined) {
      await this.#releaseLease(admission.lease);
      result = { status: "released" };
    } else if (pendingPhase === "release_pending") {
      result = await this.#abandonClaimed(admission.queuedTaskId, admission.lease);
    } else {
      result = await this.#releaseClaimedForVerification(admission.queuedTaskId, admission.lease);
    }
    if (this.#admissions.get(childId) === admission) {
      this.#removeAgentDir(admission.agentDir);
      this.#admissions.delete(childId);
    }
    return result;
  }

  async #controller(method, params) {
    return requestBrokerIpc({
      socketPath: this.#socketPath,
      authorization: this.#controllerToken,
      method,
      params,
    });
  }

  async #releaseLease(lease) {
    await this.#controller("release", { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
  }

  async #abandonClaimed(taskId, lease) {
    return this.#controller("abandonClaimedTask", {
      taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
  }

  async #releaseClaimedForVerification(taskId, lease) {
    return this.#controller("releaseClaimedTaskForVerification", {
      taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
  }

  #removeAgentDir(agentDir) {
    // agentDir was constructed from a validated child ID under the canonical
    // root. Refuse a surprising path rather than recursively removing outside.
    if (join(this.#agentRoot, agentDir.slice(this.#agentRoot.length + 1)) !== agentDir || !agentDir.startsWith(`${this.#agentRoot}/`)) {
      throw new Error("Broker resolver refused to remove an agent directory outside its root");
    }
    if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
  }
}

function safeReason(reason) {
  if (typeof reason !== "string") return "broker policy denied launch";
  // Denial enters a child-visible runner error; do not pass controller detail.
  return /^[A-Za-z0-9 _.-]{1,120}$/.test(reason) ? reason : "broker policy denied launch";
}
