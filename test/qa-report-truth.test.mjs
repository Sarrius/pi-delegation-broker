import assert from "node:assert/strict";
import test from "node:test";
import { formatParentWake } from "../src/parent-wake.mjs";

test("quota QA: terminal execution must not be advertised as controller quality acceptance", () => {
  for (const status of ["completed", "failed"]) {
    const text = formatParentWake([{ taskId: "qa-report-1", status }]);
    assert.doesNotMatch(text, /completed results are controller-verified/i);
    assert.match(text, /verificationStatus|acceptance.*separate|not.*acceptance/i);
  }
});
