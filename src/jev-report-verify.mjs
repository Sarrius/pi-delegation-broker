import { createHash } from "node:crypto";

export const JEV_REPORT_VERIFY_VERSION = "delegation-report-verify-v1";
const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * Build one post-run report verification request to detect hallucinations and ungrounded claims.
 */
export function makeJevReportVerify({ task, report, patch, checksSummary } = {}) {
  if (!bounded(task, 24_000) || typeof report !== "string") {
    return undefined;
  }

  const boundedReport = report.slice(0, 16_000);
  const boundedPatch = typeof patch === "string" ? patch.slice(0, 16_000) : "";
  const boundedChecks = typeof checksSummary === "string" ? checksSummary.slice(0, 4_000) : "";

  const questions = {
    claims_grounded: {
      type: "noul",
      instructions: "Are the success claims in the worker report supported by concrete artifacts, test outputs, or actual patch changes present in state (0 = ungrounded prose or empty claims, 1 = verified by tangible evidence)?",
    },
    unresolved_defects: {
      type: "noul",
      instructions: "Does the report indicate any remaining unresolved blockers, broken tests, or incomplete requirements (0 = work appears complete, 1 = unaddressed defects remain)?",
    },
    defect_category: {
      type: "choice",
      instructions: "If defects or gaps remain, what is the primary category of the failure?",
      criteria: {
        none: "No defects detected; work appears satisfactory",
        syntax_or_compile: "Syntax error, type checking failure, or uncompilable code",
        missing_dependency: "Missing import, module not found, or unresolved package",
        test_failure: "Test assertion or test suite failure",
        incomplete_scope: "Missed part of the delegated task requirements",
        other: "Other execution or environment issue",
      },
    },
  };

  return {
    version: JEV_REPORT_VERIFY_VERSION,
    phase: "report_verify",
    state: {
      provenance: "Worker-produced report and controller-collected execution evidence.",
      task,
      report: boundedReport,
      ...(boundedPatch ? { patch: boundedPatch } : {}),
      ...(boundedChecks ? { checksSummary: boundedChecks } : {}),
      digest: createHash("sha256").update(task + boundedReport + boundedPatch).digest("hex"),
    },
    questions,
  };
}

/**
 * Interpret Jev's System One response for report verification.
 */
export function describeJevReportVerify(result, request) {
  if (result?.status !== "evaluated" || result.version !== JEV_REPORT_VERIFY_VERSION
    || request?.version !== JEV_REPORT_VERIFY_VERSION || !Array.isArray(result.assessments)) {
    return undefined;
  }

  const groundedAnswer = result.assessments.find((a) => a.id === "claims_grounded");
  const defectsAnswer = result.assessments.find((a) => a.id === "unresolved_defects");
  const categoryAnswer = result.assessments.find((a) => a.id === "defect_category");

  const groundedScore = typeof groundedAnswer?.noul === "number" ? groundedAnswer.noul : 0.5;
  const defectsScore = typeof defectsAnswer?.noul === "number" ? defectsAnswer.noul : 0.5;
  const defectCategory = categoryAnswer?.assessment ?? "none";
  const confidence = categoryAnswer?.confidence ?? 0;

  return Object.freeze({
    authority: "none",
    grounded: groundedScore >= 0.6,
    groundedScore,
    hasUnresolvedDefects: defectsScore >= 0.6,
    defectsScore,
    defectCategory,
    confidence,
  });
}

/**
 * High-level helper: verify a completed child report with Jev.
 */
export async function verifyChildReportWithJev({ task, report, patch, checksSummary, advisor, signal } = {}) {
  try {
    if (!advisor || typeof advisor.evaluate !== "function" || !task || typeof report !== "string") {
      return undefined;
    }
    const request = makeJevReportVerify({ task, report, patch, checksSummary });
    if (!request) return undefined;

    const result = await advisor.evaluate(request, { signal });
    if (result.status !== "evaluated") return undefined;

    return describeJevReportVerify(result, request);
  } catch {
    return undefined;
  }
}
