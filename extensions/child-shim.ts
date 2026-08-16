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

const SHIM_SPEC_ENV = "PI_SUBAGENT_SHIM_SPEC";

interface ShimSpec {
  schema?: Record<string, unknown>;
  toolReportPath: string;
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

export default function childShim(pi: any): void {
  const specPath = process.env[SHIM_SPEC_ENV];
  if (!specPath) return;
  const spec = readShimSpec(specPath);
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