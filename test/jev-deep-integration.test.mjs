import assert from "node:assert/strict";
import test from "node:test";

import { JevAdvisor, normalizeJevConfig } from "../src/jev-advisor.mjs";
import {
  JEV_SKILL_SUGGEST_VERSION,
  describeJevSkillSuggestion,
  makeJevSkillSuggestion,
  suggestChildSkills,
} from "../src/jev-skill-suggest.mjs";
import {
  JEV_CONTEXT_RANK_VERSION,
  describeJevContextRank,
  makeJevContextRank,
  rankContextFilesWithJev,
} from "../src/jev-context-rank.mjs";
import {
  JEV_REPORT_VERIFY_VERSION,
  describeJevReportVerify,
  makeJevReportVerify,
  verifyChildReportWithJev,
} from "../src/jev-report-verify.mjs";

test("JevAdvisor handles choice, noul, and score primitives cleanly in evaluate()", async () => {
  const responses = {
    choice_q: {
      type: "choice",
      choice: "opt_a",
      confidence: 0.95,
      probabilities: { opt_a: 0.95, opt_b: 0.05 },
    },
    noul_q: {
      type: "noul",
      noul: 0.88,
    },
    score_q: {
      type: "score",
      score: 4,
      confidence: 0.9,
    },
  };

  const fakeFetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            const payload = JSON.stringify({
              model: "jev-1.13.0",
              answers: responses,
              usage: { input_tokens: 150, output_tokens: 30 },
            });
            return { done: false, value: Buffer.from(payload) };
          },
          cancel: async () => {},
        };
      },
    },
  });

  const advisor = new JevAdvisor({
    config: () => ({
      mode: "advisory",
      consentToSendTaskText: true,
      model: "jev-1.13.0",
    }),
    getApiKey: () => "test-key-mock",
    fetchImpl: fakeFetch,
  });

  const request = {
    version: JEV_SKILL_SUGGEST_VERSION,
    phase: "skill_suggest",
    state: { task: "Refactor SQLite queries" },
    questions: {
      choice_q: {
        type: "choice",
        instructions: "Choose best option",
        criteria: { opt_a: "Option A", opt_b: "Option B" },
      },
      noul_q: {
        type: "noul",
        instructions: "Is this query safe?",
      },
      score_q: {
        type: "score",
        instructions: "Score difficulty on 1-5 scale",
      },
    },
  };

  const result = await advisor.evaluate(request);
  assert.equal(result.status, "evaluated");
  assert.equal(result.assessments.length, 3);

  const choiceRes = result.assessments.find((a) => a.id === "choice_q");
  assert.equal(choiceRes.type, "choice");
  assert.equal(choiceRes.assessment, "opt_a");
  assert.equal(choiceRes.confidence, 0.95);

  const noulRes = result.assessments.find((a) => a.id === "noul_q");
  assert.equal(noulRes.type, "noul");
  assert.equal(noulRes.noul, 0.88);
  assert.equal(noulRes.assessment, "true");

  const scoreRes = result.assessments.find((a) => a.id === "score_q");
  assert.equal(scoreRes.type, "score");
  assert.equal(scoreRes.score, 4);
});

test("Jev Skill Suggestion selects relevant skill with high confidence, and falls back cleanly on error", async () => {
  const skills = [
    { name: "science", path: "/skills/science/SKILL.md", description: "Scientific computing and chemistry" },
    { name: "sqlite-opt", path: "/skills/sqlite-opt/SKILL.md", description: "SQLite query optimization and indexes" },
  ];

  const fakeFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.questions.selected_skill.criteria.skill_1, /sqlite-opt/);

    const answers = {
      selected_skill: {
        type: "choice",
        choice: "skill_1",
        confidence: 0.92,
        probabilities: { none: 0.05, skill_0: 0.03, skill_1: 0.92 },
      },
      skill_necessity: {
        type: "noul",
        noul: 0.85,
      },
    };

    return {
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return {
                done: false,
                value: Buffer.from(JSON.stringify({
                  model: "jev-1.13.0",
                  answers,
                  usage: { input_tokens: 120, output_tokens: 25 },
                })),
              };
            },
            cancel: async () => {},
          };
        },
      },
    };
  };

  const advisor = new JevAdvisor({
    config: () => ({ mode: "advisory", consentToSendTaskText: true, model: "jev-1.13.0" }),
    getApiKey: () => "test-key-mock",
    fetchImpl: fakeFetch,
  });

  const suggested = await suggestChildSkills({
    task: "Optimize index lookups in SQLite lease broker",
    availableSkills: skills,
    advisor,
  });

  assert.deepEqual(suggested, ["/skills/sqlite-opt/SKILL.md"]);

  // Fallback check: when advisor is disabled or throws, return undefined without crashing
  const brokenAdvisor = new JevAdvisor({
    config: () => ({ mode: "off" }),
  });
  const fallbackResult = await suggestChildSkills({
    task: "Some task",
    availableSkills: skills,
    advisor: brokenAdvisor,
  });
  assert.equal(fallbackResult, undefined, "disabled advisor must cleanly fall back to undefined");
});

test("Jev Context File Ranking prioritizes relevant files for Thin Router, and falls back to candidate slice", async () => {
  const candidates = [
    "README.md",
    "docs/JEV.md",
    "src/broker.mjs",
    "package.json",
  ];

  const fakeFetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return {
              done: false,
              value: Buffer.from(JSON.stringify({
                model: "jev-1.13.0",
                answers: {
                  primary_target: {
                    type: "choice",
                    choice: "file_2", // src/broker.mjs
                    confidence: 0.89,
                    probabilities: { file_0: 0.02, file_1: 0.04, file_2: 0.89, file_3: 0.05, none: 0.0 },
                  },
                  context_sufficiency: {
                    type: "noul",
                    noul: 0.95,
                  },
                },
                usage: { input_tokens: 100, output_tokens: 20 },
              })),
            };
          },
          cancel: async () => {},
        };
      },
    },
  });

  const advisor = new JevAdvisor({
    config: () => ({ mode: "advisory", consentToSendTaskText: true, model: "jev-1.13.0" }),
    getApiKey: () => "test-key-mock",
    fetchImpl: fakeFetch,
  });

  const ranked = await rankContextFilesWithJev({
    task: "Add fencing token support to SQLite broker",
    candidatePaths: candidates,
    advisor,
    limit: 2,
  });

  assert.equal(ranked[0], "src/broker.mjs", "primary file identified by Jev must be ranked first");
  assert.equal(ranked.length, 2);

  // Fallback check: when advisor is unavailable, return candidatePaths.slice(0, limit)
  const offlineRanked = await rankContextFilesWithJev({
    task: "Add fencing token support",
    candidatePaths: candidates,
    advisor: null,
    limit: 2,
  });
  assert.deepEqual(offlineRanked, ["README.md", "docs/JEV.md"]);
});

test("Jev Universal Report Verification evaluates groundedness and defects, flagging ungrounded claims", async () => {
  const fakeFetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return {
              done: false,
              value: Buffer.from(JSON.stringify({
                model: "jev-1.13.0",
                answers: {
                  claims_grounded: {
                    type: "noul",
                    noul: 0.25, // ungrounded claims!
                  },
                  unresolved_defects: {
                    type: "noul",
                    noul: 0.8, // defects remain!
                  },
                  defect_category: {
                    type: "choice",
                    choice: "test_failure",
                    confidence: 0.85,
                    probabilities: {
                      none: 0.05,
                      syntax_or_compile: 0.05,
                      missing_dependency: 0.03,
                      test_failure: 0.85,
                      incomplete_scope: 0.01,
                      other: 0.01,
                    },
                  },
                },
                usage: { input_tokens: 150, output_tokens: 30 },
              })),
            };
          },
          cancel: async () => {},
        };
      },
    },
  });

  const advisor = new JevAdvisor({
    config: () => ({ mode: "advisory", consentToSendTaskText: true, model: "jev-1.13.0" }),
    getApiKey: () => "test-key-mock",
    fetchImpl: fakeFetch,
  });

  const verification = await verifyChildReportWithJev({
    task: "Fix failing test in broker suite",
    report: "I ran all tests and everything passed with 100% success.",
    patch: "",
    checksSummary: "Exit code 1: 3 assertions failed",
    advisor,
  });

  assert.equal(verification.grounded, false, "low groundedness score (<0.6) must mark grounded as false");
  assert.equal(verification.hasUnresolvedDefects, true);
  assert.equal(verification.defectCategory, "test_failure");

  // Fallback check: when advisor fails, returns undefined gracefully
  const brokenResult = await verifyChildReportWithJev({
    task: "Task",
    report: "Report",
    advisor: null,
  });
  assert.equal(brokenResult, undefined);
});
