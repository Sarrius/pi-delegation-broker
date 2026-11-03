import { createHash } from "node:crypto";

export const JEV_SKILL_SUGGEST_VERSION = "delegation-skill-suggest-v1";
const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * Build one pre-launch skill recommendation request.
 * Takes the proposed task brief and a set of candidate skills available to the controller.
 */
export function makeJevSkillSuggestion({ task, availableSkills } = {}) {
  if (!bounded(task, 24_000) || !Array.isArray(availableSkills) || availableSkills.length === 0 || availableSkills.length > 64) {
    return undefined;
  }

  const normalizedSkills = availableSkills.map((entry, index) => {
    if (typeof entry === "string") {
      const name = entry.split("/").pop()?.replace(/\.(md|mjs|ts|json)$/, "") || `skill_${index}`;
      return { id: `skill_${index}`, name, path: entry, description: entry };
    }
    const name = typeof entry.name === "string" ? entry.name : `skill_${index}`;
    const description = typeof entry.description === "string" ? entry.description.slice(0, 300) : name;
    return {
      id: `skill_${index}`,
      name,
      path: entry.path || name,
      description,
    };
  });

  const criteria = {
    none: "No specialized skill needed; the worker can proceed with core primitives alone.",
  };
  for (const s of normalizedSkills) {
    criteria[s.id] = `Skill: ${s.name} - ${s.description}`;
  }

  const questions = {
    selected_skill: {
      type: "choice",
      instructions: "From the supplied available skills, which ONE skill (if any) is directly relevant and helpful for this specific task? If none are strictly needed, choose 'none'.",
      criteria,
    },
    skill_necessity: {
      type: "noul",
      instructions: "Is a specialized skill strictly necessary to avoid defects on this specific task (0 = standard coding task, 1 = domain-specific expert knowledge required)?",
    },
  };

  return {
    version: JEV_SKILL_SUGGEST_VERSION,
    phase: "skill_suggest",
    state: {
      provenance: "Parent-supplied task brief and controller-attested candidate skill descriptors.",
      task,
      availableSkills: normalizedSkills,
      digest: createHash("sha256").update(task + JSON.stringify(normalizedSkills)).digest("hex"),
    },
    questions,
  };
}

/**
 * Interpret Jev's System One response for skill suggestion.
 */
export function describeJevSkillSuggestion(result, request) {
  if (result?.status !== "evaluated" || result.version !== JEV_SKILL_SUGGEST_VERSION
    || request?.version !== JEV_SKILL_SUGGEST_VERSION || !Array.isArray(result.assessments)) {
    return undefined;
  }

  const choiceAnswer = result.assessments.find((a) => a.id === "selected_skill");
  const necessityAnswer = result.assessments.find((a) => a.id === "skill_necessity");

  const choiceId = choiceAnswer?.assessment;
  const confidence = choiceAnswer?.confidence ?? 0;
  const necessityNoul = typeof necessityAnswer?.noul === "number" ? necessityAnswer.noul : 0.5;

  if (!choiceId || choiceId === "none") {
    return Object.freeze({
      authority: "none",
      selectedSkill: null,
      confidence,
      necessity: necessityNoul,
      reason: "no_skill_required",
    });
  }

  const matched = request.state.availableSkills.find((s) => s.id === choiceId);
  return Object.freeze({
    authority: "none",
    selectedSkill: matched ? Object.freeze({ name: matched.name, path: matched.path }) : null,
    confidence,
    necessity: necessityNoul,
    reason: matched ? "skill_recommended" : "unknown_skill_id",
  });
}

/**
 * High-level helper: suggest skills for a task with graceful fallback.
 * Returns an array of skill paths or undefined if skipped/fallback.
 */
export async function suggestChildSkills({ task, availableSkills, advisor, signal } = {}) {
  try {
    if (!advisor || typeof advisor.evaluate !== "function" || !task || !Array.isArray(availableSkills) || availableSkills.length === 0) {
      return undefined;
    }
    const request = makeJevSkillSuggestion({ task, availableSkills });
    if (!request) return undefined;

    const result = await advisor.evaluate(request, { signal });
    if (result.status !== "evaluated") return undefined;

    const suggestion = describeJevSkillSuggestion(result, request);
    if (suggestion?.selectedSkill?.path && suggestion.confidence >= 0.5) {
      return [suggestion.selectedSkill.path];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
