import { createHash } from "node:crypto";

export const JEV_CONTEXT_RANK_VERSION = "delegation-context-rank-v1";
const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * Build one pre-launch context file ranking request for Thin Router pointers.
 */
export function makeJevContextRank({ task, candidatePaths } = {}) {
  if (!bounded(task, 24_000) || !Array.isArray(candidatePaths) || candidatePaths.length === 0 || candidatePaths.length > 64) {
    return undefined;
  }

  const normalizedPaths = candidatePaths
    .filter((p) => typeof p === "string" && p.trim().length > 0)
    .slice(0, 32);

  if (normalizedPaths.length === 0) return undefined;

  const criteria = {};
  for (let i = 0; i < normalizedPaths.length; i++) {
    criteria[`file_${i}`] = `File path: ${normalizedPaths[i]}`;
  }
  criteria["none"] = "None of the candidate files appear directly relevant";

  const questions = {
    primary_target: {
      type: "choice",
      instructions: "From the supplied candidate file paths, which ONE file is the single most important primary entry point or context file for this delegated task?",
      criteria,
    },
    context_sufficiency: {
      type: "noul",
      instructions: "Does the proposed candidate file set cover the core codebase context needed for this task without requiring additional file scans?",
    },
  };

  return {
    version: JEV_CONTEXT_RANK_VERSION,
    phase: "context_rank",
    state: {
      provenance: "Parent-supplied task brief and candidate file paths.",
      task,
      candidatePaths: normalizedPaths,
      digest: createHash("sha256").update(task + JSON.stringify(normalizedPaths)).digest("hex"),
    },
    questions,
  };
}

/**
 * Interpret Jev's System One response for context file ranking.
 */
export function describeJevContextRank(result, request) {
  if (result?.status !== "evaluated" || result.version !== JEV_CONTEXT_RANK_VERSION
    || request?.version !== JEV_CONTEXT_RANK_VERSION || !Array.isArray(result.assessments)) {
    return undefined;
  }

  const primaryAnswer = result.assessments.find((a) => a.id === "primary_target");
  const sufficiencyAnswer = result.assessments.find((a) => a.id === "context_sufficiency");

  const choiceId = primaryAnswer?.assessment;
  const confidence = primaryAnswer?.confidence ?? 0;
  const probabilities = primaryAnswer?.probabilities ?? {};
  const sufficiency = typeof sufficiencyAnswer?.noul === "number" ? sufficiencyAnswer.noul : 0.5;

  const candidatePaths = request.state.candidatePaths;
  const ranked = candidatePaths.map((path, index) => {
    const id = `file_${index}`;
    const prob = probabilities[id] ?? 0;
    return { path, score: prob };
  });

  ranked.sort((a, b) => b.score - a.score);

  const primaryIndex = choiceId && choiceId.startsWith("file_") ? Number(choiceId.slice(5)) : -1;
  const primaryPath = primaryIndex >= 0 && primaryIndex < candidatePaths.length ? candidatePaths[primaryIndex] : null;

  return Object.freeze({
    authority: "none",
    primaryPath,
    confidence,
    sufficiency,
    rankedPaths: Object.freeze(ranked.map((r) => r.path)),
  });
}

/**
 * High-level helper: select top context files using Jev with automatic fallback.
 */
export async function rankContextFilesWithJev({ task, candidatePaths, advisor, limit = 5, signal } = {}) {
  if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) return [];
  if (candidatePaths.length <= limit) return candidatePaths;

  try {
    if (!advisor || typeof advisor.evaluate !== "function" || !task) {
      return candidatePaths.slice(0, limit);
    }

    const request = makeJevContextRank({ task, candidatePaths });
    if (!request) return candidatePaths.slice(0, limit);

    const result = await advisor.evaluate(request, { signal });
    if (result.status !== "evaluated") return candidatePaths.slice(0, limit);

    const description = describeJevContextRank(result, request);
    if (description?.rankedPaths && description.rankedPaths.length > 0) {
      return description.rankedPaths.slice(0, limit);
    }
    return candidatePaths.slice(0, limit);
  } catch {
    return candidatePaths.slice(0, limit);
  }
}
