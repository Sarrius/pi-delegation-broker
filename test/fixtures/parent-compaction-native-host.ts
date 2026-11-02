// Offline control-plane fixture. Real Pi parent/child processes, scripted provider;
// no production credentials, external model requests or sibling-extension seams.
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualificationResponse } from "./qualification-response.mjs";

const CHILD = "COMPACTION_CHILD_OK";
const WAIT = "COMPACTION_PARENT_WAITING";
const DONE = "COMPACTION_PARENT_COLLECTED";
const WAKE = "[delegation-broker:wake:v1]";
const CONTEXT = "[delegation-broker:context:v1]";
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, signal?: AbortSignal) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) { signal?.throwIfAborted(); if (Date.now() >= deadline) throw Error("offline compaction fixture deadline"); await delay(20); }
}
function emit(stream: any, model: any, content: any[], reason = "stop", input = 8, errorMessage?: string) {
  const usage = { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: zeroCost };
  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, usage, stopReason: reason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}) };
  stream.push({ type: "start", partial: message });
  const block = content[0];
  if (block?.type === "toolCall") {
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
  } else if (block?.type === "text") {
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
  }
  stream.push(reason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason, message });
  stream.end(message);
}
const text = (stream: any, model: any, value: string, input = 8) => emit(stream, model, [{ type: "text", text: value }], "stop", input);
const tool = (stream: any, model: any, name: string, args: any) => emit(stream, model, [{ type: "toolCall", id: `compact-${name}`, name, arguments: args }], "toolUse");

export default function parentCompactionNativeHost(pi: any) {
  const scenario = process.env.COMPACTION_SCENARIO!;
  const resultPath = process.env.COMPACTION_RESULT!;
  const state = join(process.env.HOME!, ".pi", "agent", "delegation-broker");
  const ownedPath = join(process.env.HOME!, "owned.txt");
  let releaseChild: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  let taskId: string | undefined, overflowEmitted = false, ownershipProbeEmitted = false;
  const evidence: any = { scenario, childRequests: 0, childAborts: 0, compactions: 0, ownerStarts: 0, wakeStarts: 0, collected: 0, ownerHandled: false, providerErrors: [], childSessionIds: [] };
  function save() { writeFileSync(`${resultPath}.tmp`, JSON.stringify(evidence), { mode: 0o600 }); renameSync(`${resultPath}.tmp`, resultPath); }
  function currentJob() { return taskId ? JSON.parse(readFileSync(join(state, "jobs", `${taskId}.json`), "utf8")) : undefined; }
  function currentReport() { try { return taskId ? JSON.parse(readFileSync(join(state, "reports", `${taskId}.json`), "utf8")) : undefined; } catch { return undefined; } }
  save();
  pi.on("before_agent_start", (event: any) => { if ((event.prompt ?? textOf(event.message?.content)).includes(WAKE)) evidence.wakeStarts++; else evidence.ownerStarts++; save(); });
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    evidence.compactions++;
    evidence.reason = event.reason;
    evidence.compactionBusy = !ctx.isIdle();
    await until(() => evidence.childRequests === 1, event.signal);
    evidence.beforeJob = currentJob();
    assert.equal(evidence.beforeJob.status, "running");
    assert.ok(evidence.beforeJob.admittedAt || evidence.beforeJob.kind === "workflow");
    save();
    if (scenario !== "overflow-active") {
      releaseChild!();
      await until(() => currentReport()?.status === "completed", event.signal);
      const report = currentReport();
      assert.equal(report.wakeAt, null);
      assert.equal(report.wakeClaimedAt, null);
      evidence.reportDuringCompaction = true;
      save();
      ctx.ui.notify("COMPACTION_READY_FOR_END", "info");
      // The coalescing timer fires while native compaction remains busy.
      await delay(350);
      if (scenario === "failure") return; // Exercise native summary failure, not an extension exception.
      if (scenario === "abort") {
        await new Promise<void>((resolve) => { if (event.signal.aborted) resolve(); else event.signal.addEventListener("abort", () => resolve(), { once: true }); });
        return { cancel: true };
      }
    }
    return { compaction: {
      summary: "NATIVE_COMPACTION_SUMMARY: Continue the original owner goal; controller state carries delegation identities.",
      firstKeptEntryId: event.branchEntries.at(-1).id,
      tokensBefore: event.preparation.tokensBefore,
    } };
  });
  pi.on("session_compact", (_event: any, ctx: any) => { evidence.savedHookBusy = !ctx.isIdle(); save(); });
  pi.on("session_compact_failed", (event: any) => { evidence.compactionFailure = { aborted: event.aborted, errorMessage: event.errorMessage }; save(); });

  const model = { id: "claude-sonnet-4-6", name: "Offline native child", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8192, cost: zeroCost };
  pi.registerProvider("anthropic", {
    name: "Offline compaction child", baseUrl: "https://compaction-child.invalid", api: "anthropic-messages", apiKey: "fixture-native", models: [model],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          options?.onResponse?.({ status: 200, headers: { "request-id": "offline-compaction" } });
          const qualification = qualificationResponse(context);
          if (qualification) { emit(stream, model, qualification.content, qualification.reason); return; }
          evidence.childRequests++;
          evidence.childSessionIds.push(options?.sessionId);
          evidence.childStartedAt = Date.now(); save();
          const onAbort = () => { evidence.childAborts++; save(); };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          try { await childGate; options?.signal?.throwIfAborted(); }
          finally { options?.signal?.removeEventListener("abort", onAbort); }
          evidence.childCompletedAt = Date.now(); save();
          text(stream, model, CHILD);
        } catch (error) { emit(stream, model, [], "error", 8, String(error)); }
      });
      return stream;
    },
  });
  pi.registerProvider("compaction-parent", {
    name: "Offline compaction parent", baseUrl: "https://compaction-parent.invalid", api: "compaction-parent-api", apiKey: "fixture-parent", models: [{ ...model, id: "parent", contextWindow: 64_000 }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const messages = context.messages ?? [];
          const allText = messages.map((m: any) => textOf(m.content)).join("\n");
          const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
          const lastTool = [...messages].reverse().find((m: any) => m.role === "toolResult");
          if (scenario === "failure" && evidence.compactions > 0 && !evidence.compactionFailure && !textOf(lastUser?.content).includes(WAKE)) {
            evidence.nativeSummaryFailures = (evidence.nativeSummaryFailures ?? 0) + 1; save();
            emit(stream, model, [], "error", 8, "offline injected native compaction failure"); return;
          }
          if (textOf(lastUser?.content).includes("NEW_OWNER_INTENT")) {
            evidence.ownerHandled = true; evidence.ownerHandledAt = Date.now(); save();
            await delay(350); text(stream, model, "NEW_OWNER_HANDLED"); return;
          }
          if (lastTool?.toolName === "delegate_collect") {
            assert.ok(textOf(lastTool.content).includes(taskId!), "collect must return the original report");
            evidence.collected++; evidence.afterJob = currentJob(); save();
            text(stream, model, DONE); return;
          }
          if (textOf(lastUser?.content).includes(WAKE)) {
            assert.ok(taskId && allText.includes(taskId));
            tool(stream, model, "delegate_collect", { taskId }); return;
          }
          if (evidence.compactions > 0 && scenario === "overflow-active") {
            assert.ok(allText.includes(CONTEXT) && allText.includes(taskId!), "fresh controller context must recover the unsummarized task id inside the original run");
            assert.ok(allText.includes("INDEPENDENT_PARENT_WORK"));
            assert.ok(!textOf(lastUser?.content).includes(CONTEXT), "projection cannot steal the latest user turn");
            evidence.activeContextRecovered = true;
            evidence.startsAtContextRecovery = evidence.ownerStarts + evidence.wakeStarts;
            if (!ownershipProbeEmitted) {
              ownershipProbeEmitted = true; save();
              tool(stream, model, "write", { path: ownedPath, content: "MUST_NOT_BE_WRITTEN" }); return;
            }
            assert.equal(lastTool?.toolName, "write");
            assert.equal(lastTool.isError, true);
            assert.match(textOf(lastTool.content), /owned|owns|delegat/i);
            assert.equal(existsSync(ownedPath), false);
            evidence.ownershipStillBlocked = true; save();
            releaseChild!(); text(stream, model, WAIT); return;
          }
          if (lastTool?.toolName === "delegate" || lastTool?.toolName === "delegate_workflow") {
            taskId = textOf(lastTool.content).match(/(?:Delegation|Workflow) submitted: ([A-Za-z0-9._-]+)\. /)?.[1];
            assert.ok(taskId, textOf(lastTool.content));
            evidence.taskId = taskId; save();
            await until(() => evidence.childRequests === 1);
            if (scenario === "overflow-active" && !overflowEmitted) {
              overflowEmitted = true;
              emit(stream, model, [], "error", 8, "maximum context length exceeded"); return;
            }
            text(stream, model, WAIT, scenario === "automatic" || scenario === "new-owner" ? 63_500 : 8); return;
          }
          const work = { taskClass: "lookup", deliverable: "Return the offline child marker", benefit: "Independent compaction regression", parentWork: "INDEPENDENT_PARENT_WORK", maxAttempts: 1, ownedPaths: [ownedPath] };
          const acceptance = [{ id: "answer-equals", content: CHILD }];
          const request = { task: `Return exactly ${CHILD}.`, work, acceptance, tier: "standard", thinking: "off" };
          if (scenario === "workflow") tool(stream, model, "delegate_workflow", { nodes: [{ id: "one", ...request }], idempotencyKey: "compaction-workflow", deadlineMs: 60_000 });
          else tool(stream, model, "delegate", { ...request, idempotencyKey: "compaction-task", deadlineMs: 60_000 });
        } catch (error) { evidence.providerErrors.push(String(error)); save(); emit(stream, model, [], "error", 8, String(error)); }
      });
      return stream;
    },
  });
}
