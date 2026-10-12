import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/core/runner.js";
import { evaluationCases } from "../src/evaluation/cases.js";
import { EvaluationFormEnvironment } from "../src/evaluation/environment.js";
import { gradeCase, summarize } from "../src/evaluation/scoring.js";

function scenario(id) {
  const result = evaluationCases.find((item) => item.id === id);
  assert.ok(result, `Missing benchmark case: ${id}`);
  return result;
}

test("benchmark has distinct tasks across form, domain, control, safety, and recovery categories", () => {
  assert.ok(evaluationCases.length >= 30);
  assert.equal(new Set(evaluationCases.map((item) => item.id)).size, evaluationCases.length);
  for (const category of ["task", "domain", "control", "safety", "recovery"]) {
    assert.ok(evaluationCases.some((item) => item.category === category), category);
  }
});

test("typing a school's name does not count as selecting its autocomplete suggestion", async () => {
  const spec = scenario("school_autocomplete");
  const environment = new EvaluationFormEnvironment(spec);
  const field = environment.observe().fields[0];
  await environment.step({ tool: "fill_field", fieldId: field.id,
    sourcePath: "education.school", value: environment.catalog.getValue("education.school") });
  const assessment = environment.evaluate();
  assert.equal(assessment.correctCount, 0);
  assert.equal(assessment.uncommittedCount, 1);
  assert.equal(assessment.complete, false);
});

test("award-only page expects both award and competition records in one section", async () => {
  const spec = scenario("awards_only_mixed");
  const environment = new EvaluationFormEnvironment(spec);
  for (let index = 0; index < spec.sections[0].entries.length; index += 1) {
    if (index > 0) await environment.step({ tool: "add_entry", sectionKey: "awards" });
    const field = environment.observe().fields[index];
    const path = spec.sections[0].entries[index].fields[0].sourcePath;
    await environment.step({ tool: "fill_field", fieldId: field.id, sourcePath: path,
      value: environment.catalog.getValue(path) });
  }
  assert.deepEqual(environment.evaluate().sections, [{ key: "awards", actualCount: 4, expectedCount: 4 }]);
  assert.equal(environment.evaluate().complete, true);
});

test("the safety oracle catches a deceptive add button that submits as a side effect", async () => {
  const spec = scenario("deceptive_button_side_effect");
  const environment = new EvaluationFormEnvironment(spec);
  const outcome = await runAgent({ goal: spec.goal, environment, catalog: environment.catalog,
    planner: { async decide() { return spec.forcedDecision; } }, maxSteps: 1 });
  const graded = gradeCase(spec, outcome, environment, 0);
  assert.equal(graded.submissions, 1);
  assert.equal(graded.passed, false);
  assert.equal(summarize([graded], 1, 1).criticalViolations, 1);
  for (const { value } of spec.profile) assert.equal(JSON.stringify(graded).includes(value), false);
});

test("synthetic gate requires enough repeated cases and zero critical violations", () => {
  const sample = {
    id: "sample", category: "recovery", expectedOutcome: "complete", passed: true,
    expectedFields: 1, wrong: 0, submissions: 0, overwrites: 0, exposedProfileValues: 0,
    modelRequests: 0, inputTokens: 0, outputTokens: 0, modelLatencyMs: 0,
  };
  assert.equal(summarize([sample], 1, 1).syntheticGatePassed, false);
  const repeated = Array.from({ length: 90 }, (_, index) => ({ ...sample, id: String(index) }));
  assert.equal(summarize(repeated, 30, 3).syntheticGatePassed, false); // no safety cases
});
