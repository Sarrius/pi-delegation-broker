/**
 * Child-shim extension for brokered Pi children.
 *
 * Loaded via --extension into every child pi process spawned by the broker.
 * It reads a spec file from PI_SUBAGENT_SHIM_SPEC and writes the child's
 * active tool names to a file the parent reads before the first prompt.
 *
 * Without the spec environment variable the shim is completely inert.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { applyProposedPatch } from "../src/proposed-patch.mjs";

const SHIM_SPEC_ENV = "PI_SUBAGENT_SHIM_SPEC";

interface ShimSpec {
  schema?: Record<string, unknown>;
  toolReportPath: string;
  // The launcher derives this from the signed controller capability; the shim never trusts a
  // model's prompt to decide whether it should expose a mutation surface.
  effectCapable?: boolean;
}

function readShimSpec(path: string): ShimSpec {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ShimSpec;
  if (typeof parsed.toolReportPath !== "string" || parsed.toolReportPath.length === 0) {
    throw new Error("Shim spec is missing toolReportPath");
  }
  return parsed;
}

function writeToolReport(path: string, report: { activeTools: string[] }): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(report), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Clamp the child's provider request to the leased output budget. Pi exposes no max-tokens
 * flag, so without this the child asks each provider for that model's maximum and a leased
 * hard cap is advisory only — which a low-balance account rejects outright.
 */
function enforceLeasedOutputBudget(pi: any): void {
  const cap = Number.parseInt(process.env.PI_BROKER_MAX_OUTPUT_TOKENS ?? "", 10);
  if (!Number.isSafeInteger(cap) || cap < 1) return;
  pi.on("before_provider_request", (event: any) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const next: Record<string, unknown> = { ...payload };
    for (const key of ["max_tokens", "max_output_tokens", "maxOutputTokens", "max_completion_tokens"]) {
      const current = next[key];
      if (typeof current === "number" && Number.isFinite(current) && current > cap) next[key] = cap;
    }
    const generationConfig = next.generationConfig as Record<string, unknown> | undefined;
    if (generationConfig && typeof generationConfig.maxOutputTokens === "number" && generationConfig.maxOutputTokens > cap) {
      next.generationConfig = { ...generationConfig, maxOutputTokens: cap };
    }
    return next;
  });
}

export default function childShim(pi: any): void {
  enforceLeasedOutputBudget(pi);
  const specPath = process.env[SHIM_SPEC_ENV];
  if (!specPath) return;
  const spec = readShimSpec(specPath);
  if (spec.effectCapable === true) {
    pi.registerTool({
      name: "propose_patch",
      label: "Propose Patch",
      description: "Apply one unified Git diff only to the isolated child worktree. Declare this exact action with broker_declare_action immediately beforehand. The controller will independently verify the resulting patch; it will not be applied to the parent repository.",
      parameters: Type.Object({
        patch: Type.String({ minLength: 1, maxLength: 4 * 1024 * 1024, description: "A conventional unified git diff with diff --git headers." }),
      }, { additionalProperties: false }),
      async execute(_id: string, params: { patch: string }, _signal: AbortSignal, _onUpdate: unknown, ctx: { cwd: string }) {
        const result = applyProposedPatch({ cwd: ctx.cwd, patch: params.patch });
        return {
          content: [{ type: "text", text: `Patch applied in the isolated worktree for: ${result.changed.join(", ")}.` }],
          details: { changed: result.changed },
        };
      },
    });
  }
  if (spec.schema) {
    pi.registerTool({
      name: "report_result",
      label: "Report Result",
      description: "Call this exactly once with the final structured answer.",
      parameters: spec.schema as any,
      async execute(_id: string, params: unknown) {
        return { content: [{ type: "text", text: "Structured result accepted." }], details: undefined };
      },
    });
  }
  pi.on("resources_discover", () => {
    writeToolReport(spec.toolReportPath, { activeTools: pi.getActiveTools() });
    return undefined;
  });
}