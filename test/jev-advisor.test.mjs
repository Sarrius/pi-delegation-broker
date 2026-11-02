import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { JevAdvisor, normalizeJevConfig, makeJevReview, formatJevAdvice, JEV_ENDPOINT } from "../src/jev-advisor.mjs";
import { makeJevRoutingShadow } from "../src/jev-routing-shadow.mjs";
import { makeJevActiveRouting } from "../src/jev-active-routing.mjs";

const enabled = { mode: "advisory", consentToSendTaskText: true, timeoutMs: 100 };
const request = (task = "Fix login without changing existing sessions.") => makeJevReview({ phase: "handoff", task, requirements: ["Preserve existing sessions."] });
function payload(body, assessment = "potential_gap") {
  return { model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 }, answers: Object.fromEntries(Object.keys(JSON.parse(body).questions).map((id) => [id, {
    type: "choice", choice: assessment, confidence: 0.9,
    probabilities: Object.fromEntries(["appears_covered", "potential_gap", "unclear", "not_applicable"].map((key) => [key, key === assessment ? 1 : 0])),
  }])) };
}
const fixture = (options = {}) => new JevAdvisor({ config: enabled, getApiKey: () => "fixture-key-not-live", fetchImpl: async (_url, init) => Response.json(payload(init.body)), ...options });

test("official moving aliases accept a versioned response model, while pinned versions stay exact", async () => {
  for (const model of ["jev-preview", "jev-latest"]) {
    const result = await fixture({ config: { ...enabled, model } }).evaluate(request());
    assert.equal(result.status, "evaluated", `${model}: ${result.reason}`);
    assert.equal(result.model, "jev-1.13.0");
  }
  const pinned = await fixture({ config: { ...enabled, model: "jev-1.12.0" } }).evaluate(request());
  assert.equal(pinned.reason, "invalid_response");
});

test("off, malformed config, missing consent/key never call network or consult disabled credentials", async () => {
  let calls = 0, credentials = 0;
  for (const config of [undefined, null, {}, { mode: "off" }, { mode: "advisory" }, { ...enabled, timeoutMs: 0 }, { ...enabled, typo: true }, { ...enabled, result: "yes" }]) {
    const client = fixture({ config, getApiKey: () => { credentials++; return "key"; }, fetchImpl: () => { calls++; throw Error("unexpected"); } });
    assert.equal((await client.evaluate(request())).status, "skipped");
    assert.equal(client.status().available, false);
  }
  assert.equal(credentials, 0);
  assert.equal((await fixture({ getApiKey: () => undefined }).evaluate(request())).reason, "missing_key");
  assert.equal((await fixture({ getApiKey: () => "bad\nkey" }).evaluate(request())).reason, "missing_key");
  assert.equal(calls, 0);
});

test("routing state needs separate consent and stays off under the existing Jev handoff/result opt-in", async () => {
  const routing = makeJevRoutingShadow({ task: "Check an approved parser implementation.",
    resourceIds: ["slot-account-2/model-a", "slot-account-3/model-b"],
    baselineResourceId: "slot-account-2/model-a", leasedResourceId: "slot-account-2/model-a",
    routeMode: "auto", thinkingMode: "auto", requestedThinking: "off", effectiveThinking: "off",
    taskClass: "review", policyGeneration: "fixture-v1" });
  let calls = 0;
  const noNetwork = () => { calls++; throw Error("unexpected routing export"); };
  assert.equal((await fixture({ fetchImpl: noNetwork }).evaluate(routing)).reason, "feature_disabled");
  assert.equal((await fixture({ config: { ...enabled, routeShadow: true }, fetchImpl: noNetwork }).evaluate(routing)).reason, "routing_consent_required");
  assert.equal((await fixture({ config: { ...enabled, routeShadow: true, consentToSendRoutingState: true, mode: "off" }, fetchImpl: noNetwork }).evaluate(routing)).reason, "disabled");
  assert.equal(calls, 0);
});

test("active routing needs distinct consent, real project scope and an advisory mode before any network call", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-active-advisor-"));
  try {
    const project = join(root, "project"); const other = join(root, "other");
    mkdirSync(project); mkdirSync(other);
    const routing = makeJevActiveRouting({ task: "Read a module and return one finding.",
      resourceIds: ["cursor/composer-2.5", "openai-codex-account-8/gpt-6-sol"],
      baselineResourceId: "openai-codex-account-8/gpt-6-sol", routeMode: "auto", thinkingMode: "auto",
      requestedThinking: "off", taskClass: "diagnosis", policyGeneration: "fixture-v1",
      baselineEffortSupported: true, autoEffortCeiling: "low" });
    let calls = 0;
    const noNetwork = () => { calls++; throw Error("unexpected active export"); };
    const active = { ...enabled, activeRouting: true, activeProjectRoots: [project], activeAutoThinkingMax: "low" };
    assert.equal((await fixture({ config: enabled, fetchImpl: noNetwork }).evaluate({ ...routing, localScopeCwd: project })).reason, "feature_disabled");
    assert.equal((await fixture({ config: active, fetchImpl: noNetwork }).evaluate({ ...routing, localScopeCwd: project })).reason, "active_routing_consent_required");
    assert.equal((await fixture({ config: { ...active, consentToSendActiveRoutingState: true }, fetchImpl: noNetwork }).evaluate({ ...routing, localScopeCwd: other })).reason, "scope_unapproved");
    assert.equal((await fixture({ config: { ...active, consentToSendActiveRoutingState: true, mode: "shadow" }, fetchImpl: noNetwork }).evaluate({ ...routing, localScopeCwd: project })).reason, "feature_disabled");
    assert.equal(calls, 0);
    const client = fixture({ config: { ...active, consentToSendActiveRoutingState: true }, fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(JSON.stringify(JSON.parse(init.body)).includes(project), false, "cwd remains controller-local");
      const questions = JSON.parse(init.body).questions;
      return Response.json({model:"jev-1.13.0",usage:{input_tokens:12,output_tokens:3},answers:Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
        { type:"choice", choice:"no_recommendation", confidence:0.8,
          probabilities:Object.fromEntries(Object.keys(q.criteria).map((key) => [key,key==="no_recommendation"?1:0])) }])) });
    } });
    assert.equal((await client.evaluate({ ...routing, localScopeCwd: project })).status,"evaluated");
    assert.equal(client.status().requestsByPhase.routing_active,1);
    assert.equal(calls,1);
    assert.equal(normalizeJevConfig({ ...active, activeProjectRoots: ["relative/path"] }).reason,"invalid_config");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("routing shadow uses the same bounded request allowance, transport and response validator", async () => {
  const routing = makeJevRoutingShadow({ task: "Compare two parser implementations.",
    resourceIds: ["slot-account-2/model-a", "slot-account-3/model-b"],
    baselineResourceId: "slot-account-2/model-a", leasedResourceId: "slot-account-2/model-a",
    routeMode: "auto", thinkingMode: "auto", requestedThinking: "off", effectiveThinking: "off",
    taskClass: "review", policyGeneration: "fixture-v1" });
  let calls = 0;
  const config = { ...enabled, routeShadow: true, consentToSendRoutingState: true, maxRequestsPerSession: 1 };
  const client = fixture({ config, fetchImpl: async (_url, init) => {
    calls++;
    const parsed = JSON.parse(init.body);
    assert.equal(parsed.state.task, "Compare two parser implementations.");
    assert.deepEqual(Object.keys(parsed.questions), ["model", "effort"]);
    const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      return [id, { type: "choice", choice: "no_recommendation", confidence: 0.8,
        probabilities: Object.fromEntries(options.map((key) => [key, key === "no_recommendation" ? 1 : 0])) }];
    }));
    return Response.json({model: "jev-1.13.0", answers, usage: {input_tokens: 12, output_tokens: 3}});
  } });
  const answer = await client.evaluate(routing);
  assert.equal(answer.status, "evaluated");
  assert.equal(answer.authority, "none");
  assert.deepEqual(answer.assessments.map((item) => item.assessment), ["no_recommendation", "no_recommendation"]);
  assert.equal((await client.evaluate(routing)).cached, true);
  assert.equal((await client.evaluate(request())).reason, "request_allowance", "handoff and routing must not own independent API budgets");
  assert.deepEqual(client.status().requestsByPhase, {handoff: 0, result: 0, routing: 1, routing_active: 0, decision: 0, visual: 0});
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(answer), /Compare two parser implementations|fixture-key/);
});

test("in-flight routing shadow is single-flight and a concurrent optional handoff is skipped, never queued", async () => {
  const routing = makeJevRoutingShadow({ task: "Trace a parser branch.",
    resourceIds: ["slot-account-2/model-a", "slot-account-3/model-b"],
    baselineResourceId: "slot-account-2/model-a", leasedResourceId: "slot-account-2/model-a",
    routeMode: "auto", thinkingMode: "auto", requestedThinking: "off", effectiveThinking: "off",
    taskClass: "review", policyGeneration: "fixture-v1" });
  let start, release;
  const started = new Promise((resolve) => { start = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const client = fixture({ config: { ...enabled, routeShadow: true, consentToSendRoutingState: true },
    fetchImpl: async (_url, init) => {
      calls++;
      start();
      await held;
      const questions = JSON.parse(init.body).questions;
      return Response.json({model: "jev-1.13.0", usage: {input_tokens: 4, output_tokens: 1},
        answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
          const options = Object.keys(question.criteria);
          const choice = options.includes("no_recommendation") ? "no_recommendation" : "potential_gap";
          return [id, { type: "choice", choice, confidence: 0.8,
            probabilities: Object.fromEntries(options.map((key) => [key, key === choice ? 1 : 0])) }];
        })) });
    } });
  const pending = client.evaluate(routing);
  try {
    await started;
    assert.equal((await client.evaluate(request())).reason, "busy");
    assert.deepEqual(client.status().requestsByPhase, {handoff: 0, result: 0, routing: 1, routing_active: 0, decision: 0, visual: 0});
    assert.equal(calls, 1, "optional contention cannot cause a second paid call");
  } finally { release(); }
  assert.equal((await pending).status, "evaluated");
  assert.equal((await client.evaluate(request())).status, "evaluated", "later handoff may still use the same advisor");
  assert.equal(calls, 2);
});

test("request matches documented API, typed advice is non-authoritative and copied from a bounded cache", async () => {
  let calls = 0;
  const client = fixture({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer fixture-key-not-live");
    return Response.json(payload(init.body));
  } });
  const first = await client.evaluate(request());
  assert.equal(first.status, "evaluated");
  assert.equal(first.authority, "none");
  assert.equal(first.assessments[0].assessment, "potential_gap");
  first.assessments[0].assessment = "appears_covered";
  const second = await client.evaluate(request());
  assert.equal(second.cached, true);
  assert.equal(second.assessments[0].assessment, "potential_gap");
  assert.equal(calls, 1);
  assert.deepEqual(client.status().usage, { inputTokens: 100, outputTokens: 20 });
  assert.doesNotMatch(JSON.stringify(client.status()), /fixture-key/);
  assert.match(formatJevAdvice(second, ["Preserve sessions"]), /POTENTIAL GAP/);
});

for (const status of [400, 401, 402, 403, 404, 413, 422, 429, 500, 529]) {
  test(`HTTP ${status} skips without retry, leaks no raw error, circuit is independent of tasks`, async () => {
    let calls = 0, time = 0;
    const client = fixture({ now: () => time, fetchImpl: async () => { calls++; return new Response("fixture-key-not-live PRIVATE TASK", { status }); } });
    const first = await client.evaluate(request());
    assert.equal(first.status, "skipped");
    assert.equal(first.reason, `http_${status}`);
    assert.doesNotMatch(JSON.stringify(first), /fixture-key|PRIVATE TASK/);
    assert.equal((await client.evaluate(request())).status, "skipped");
    assert.equal(calls, 1);
    time = 60_001;
    await client.evaluate(request("later"));
    assert.equal(calls, [400, 413, 422, 429, 500, 529].includes(status) ? 2 : 1);
    client.resetSession();
    if (status === 402) {
      assert.equal((await client.evaluate(request())).reason, "cooldown");
      assert.equal(calls, 1, "session replacement must not bypass a billing recovery delay");
    }
  });
}

test("network exceptions are sanitized and enter cooldown without retries", async () => {
  let calls = 0;
  const client = fixture({ fetchImpl: async () => { calls++; throw Error("fixture-key-not-live secret prompt"); } });
  assert.equal((await client.evaluate(request())).reason, "network_error");
  assert.equal((await client.evaluate(request())).reason, "cooldown");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(client.status()), /fixture-key|secret prompt/);
});

for (const [label, mutate] of [
  ["missing question", (data) => { data.answers = {}; }],
  ["wrong type", (data) => { data.answers.r0.type = "noul"; }],
  ["extra answer", (data) => { data.answers.inject = data.answers.r0; }],
  ["unknown option", (data) => { data.answers.r0.choice = "execute_tool"; }],
  ["bad probability", (data) => { data.answers.r0.probabilities.potential_gap = 2; }],
  ["bad sum", (data) => { data.answers.r0.probabilities.potential_gap = 0.1; }],
  ["bad confidence", (data) => { data.answers.r0.confidence = -1; }],
  ["nonwinning choice", (data) => { data.answers.r0.choice = "appears_covered"; }],
  ["unexpected model", (data) => { data.model = "jev-unknown"; }],
  ["bad usage", (data) => { data.usage.input_tokens = -1; }],
]) test(`invalid ${label} degrades to skipped, never a decision`, async () => {
  const client = fixture({ fetchImpl: async (_url, init) => { const data = payload(init.body); mutate(data); return Response.json(data); } });
  assert.equal((await client.evaluate(request())).reason, "invalid_response");
});

test("timeouts cover uncooperative fetch AND response body, caller is never stranded", async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); } })),
  ]) {
    const client = fixture({ fetchImpl });
    const started = performance.now();
    assert.equal((await client.evaluate(request())).reason, "timeout");
    assert.ok(performance.now() - started < 1000);
    assert.equal(client.active, undefined);
  }
});

test("oversize payload is skipped, not silently truncated; oversize response is bounded", async () => {
  let calls = 0;
  const client = fixture({ fetchImpl: async () => { calls++; return new Response("x".repeat(64_001)); } });
  assert.equal((await client.evaluate(request("x".repeat(25_000)))).reason, "input_too_large");
  assert.equal(calls, 0);
  assert.equal((await client.evaluate(request())).status, "skipped");
  assert.equal(calls, 1);
});

test("abort, close and config-off invalidate in-flight responses; no late advice", async () => {
  for (const how of ["signal", "close", "config"]) {
    let resolveResponse, body;
    let config = { ...enabled, timeoutMs: 1000 };
    const client = fixture({ config: () => config, fetchImpl: (_url, init) => { body = init.body; return new Promise((resolve) => { resolveResponse = resolve; }); } });
    const signal = new AbortController();
    const pending = client.evaluate(request(), { signal: signal.signal });
    if (how === "signal") signal.abort();
    if (how === "close") client.close();
    if (how === "config") config = { mode: "off" };
    resolveResponse(Response.json(payload(body)));
    const result = await pending;
    assert.equal(result.status, "skipped");
    assert.equal(client.cache.size, 0);
  }
  let calls = 0;
  const signal = AbortSignal.abort();
  assert.equal((await fixture({ fetchImpl: () => { calls++; } }).evaluate(request(), { signal })).reason, "cancelled");
  assert.equal(calls, 0);
});

test("single flight, bounded request allowance and new state cache invalidation", async () => {
  let resolveResponse, body, calls = 0;
  const client = fixture({ config: { ...enabled, maxRequestsPerSession: 1 }, fetchImpl: (_url, init) => {
    calls++; body = init.body; return new Promise((resolve) => { resolveResponse = resolve; });
  } });
  const pending = client.evaluate(request());
  assert.equal((await client.evaluate(request("different"))).status, "skipped");
  resolveResponse(Response.json(payload(body)));
  assert.equal((await pending).status, "evaluated");
  assert.equal((await client.evaluate(request())).cached, true);
  assert.equal((await client.evaluate(request("new revision"))).reason, "request_allowance");
  assert.equal(calls, 1);
});

test("shadow returns typed observations to host but formatter exposes no advice", async () => {
  const result = await fixture({ config: { ...enabled, mode: "shadow" } }).evaluate(request());
  assert.equal(result.mode, "shadow");
  assert.equal(formatJevAdvice(result, ["requirement"]), "");
  assert.equal((await fixture({ config: { ...enabled, handoff: false } }).evaluate(request())).reason, "feature_disabled");
});

test("checklist/source questions are independent and evidence provenance is explicit", () => {
  const review = makeJevReview({ phase: "result", task: "Fix login", requirements: ["Tests must pass"], sourceRequest: "Keep sessions", report: "I ran all tests.", controllerEvidence: { verificationStatus: "not_supplied" } });
  assert.equal(review.questions.r0.type, "choice");
  assert.match(review.questions.r0.instructions, /not an execution receipt/);
  assert.ok(review.questions.source_coverage);
  assert.match(review.state.provenance, /not authenticated/);
  assert.equal(makeJevReview({ phase: "handoff", task: "x", requirements: [] }), undefined);
  assert.equal(normalizeJevConfig({ ...enabled, maxRequestsPerSession: Infinity }).reason, "invalid_config");
});

test("HTML/invalid JSON is a schema failure and displayed excerpts remain bounded", async () => {
  assert.equal((await fixture({ fetchImpl: async () => new Response('<html>not JSON</html>') }).evaluate(request())).reason, "invalid_response");
  const requirements = Array.from({ length: 24 }, () => "constraint ".repeat(180));
  const result = { status: "evaluated", mode: "advisory", phase: "handoff", assessments: requirements.map((_r, i) => ({ id: `r${i}`, assessment: "potential_gap", confidence: 0.9 })) };
  const rendered = formatJevAdvice(result, requirements);
  assert.ok(Buffer.byteLength(rendered) < 10_000);
  assert.match(rendered, /see full checklist/);
  assert.equal(fixture().status().reason, "ready");
});

for (const status of [400, 401, 402, 403, 404, 413, 422, 429, 500, 529]) test(`HTTP ${status} automatically recovers on later demand without config/session changes`, async () => {
  let time = 0, calls = 0;
  const client = fixture({ now: () => time, fetchImpl: async (_url, init) => {
    calls++;
    return calls === 1 ? new Response("private", { status }) : Response.json(payload(init.body));
  } });
  const input = request();
  assert.equal((await client.evaluate(input)).reason, `http_${status}`);
  assert.equal((await client.evaluate(input)).status, "skipped");
  assert.equal(calls, 1);
  time = 300_000;
  assert.equal((await client.evaluate(input)).status, "evaluated");
  assert.equal(calls, 2);
  assert.equal(client.status().retryAt, null);
  assert.equal(client.status().consecutiveFailures, 0);
});

test("backoff grows to a finite ceiling, survives session reset, then resets on success", async () => {
  let time = 0, healthy = false, calls = 0;
  const client = fixture({ now: () => time, fetchImpl: async (_url, init) => {
    calls++; return healthy ? Response.json(payload(init.body)) : new Response("", { status: 402 });
  } });
  for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]) {
    assert.equal((await client.evaluate(request())).reason, "http_402");
    assert.equal(client.status().retryAt, time + delay);
    client.resetSession();
    assert.equal((await client.evaluate(request())).reason, "cooldown");
    time += delay;
  }
  healthy = true;
  assert.equal((await client.evaluate(request())).status, "evaluated");
  healthy = false;
  assert.equal((await client.evaluate(request("new task"))).reason, "http_402");
  assert.equal(client.status().retryAt, time + 300_000);
  assert.equal(calls, 8);
});

for (const status of [400, 413, 422]) test(`HTTP ${status} failure is scoped to input, not unrelated tasks`, async () => {
  let calls = 0;
  const client = fixture({ fetchImpl: async (_url, init) => {
    calls++; return calls === 1 ? new Response("", { status }) : Response.json(payload(init.body));
  } });
  assert.equal((await client.evaluate(request())).reason, `http_${status}`);
  assert.equal(client.status().available, true);
  assert.equal((await client.evaluate(request())).reason, "request_cooldown");
  assert.equal((await client.evaluate(request("different input"))).status, "evaluated");
  assert.equal(calls, 2);
});

test("Retry-After is honored and cache remains usable during an API outage", async () => {
  let time = 0, calls = 0;
  const client = fixture({ now: () => time, fetchImpl: async (_url, init) => {
    calls++; return calls === 2 ? new Response("", { status: 429, headers: { "Retry-After": "7200" } }) : Response.json(payload(init.body));
  } });
  await client.evaluate(request());
  await client.evaluate(request("second task"));
  assert.equal(client.status().retryAt, 7_200_000);
  assert.equal((await client.evaluate(request())).cached, true);
  time = 7_199_999;
  assert.equal((await client.evaluate(request("second task"))).reason, "cooldown");
  time++;
  assert.equal((await client.evaluate(request("second task"))).status, "evaluated");
  assert.equal(calls, 3);
});

test("recovery does not bypass explicit off, consent or request allowance", async () => {
  let time = 0, calls = 0, config = { ...enabled, maxRequestsPerSession: 1 };
  const client = fixture({ config: () => config, now: () => time, fetchImpl: async () => { calls++; return new Response("", { status: 402 }); } });
  await client.evaluate(request()); time = 10_000_000;
  assert.equal((await client.evaluate(request())).reason, "request_allowance");
  config = { ...config, mode: "off" };
  assert.equal((await client.evaluate(request())).reason, "disabled");
  config = { ...config, mode: "advisory", consentToSendTaskText: false };
  assert.equal((await client.evaluate(request())).reason, "consent_required");
  assert.equal(calls, 1);
});

test("shared Jev subpath is importable without Pi consumer initialization", async () => {
  const api = await import("@sars267/pi-delegation-broker/jev");
  assert.equal(api.JevAdvisor, JevAdvisor);
  assert.equal(api.JEV_ENDPOINT, JEV_ENDPOINT);
});
