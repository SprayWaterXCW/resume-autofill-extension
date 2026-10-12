import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/core/runner.js";
import { createSyntheticCatalog, SyntheticFormEnvironment, syntheticProfileFields } from "../src/fixtures/synthetic-form.js";
import { ScriptedFixturePlanner } from "../src/demo/scripted-planner.js";

const goal = "填写全部教育经历，不提交简历";

function run(environment, planner = new ScriptedFixturePlanner(), maxSteps = 20) {
  return runAgent({ goal, environment, planner, catalog: createSyntheticCatalog(), maxSteps });
}

test("adds a second education entry and verifies all four writes", async () => {
  const environment = new SyntheticFormEnvironment();
  const outcome = await run(environment);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.steps, 5);
  assert.equal(outcome.assessment.entryCount, 2);
  assert.equal(outcome.assessment.missingCount, 0);
  assert.equal(outcome.assessment.submissionCount, 0);
  assert.equal(environment.stepCalls.filter((call) => call.tool === "add_entry").length, 1);
  assert.ok(outcome.trace.every((event) => event.verified));
});

test("a silent page write failure is observed and retried", async () => {
  const environment = new SyntheticFormEnvironment({ dropFirstWriteFor: ["educations.0.school"] });
  const outcome = await run(environment);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.steps, 6);
  assert.equal(outcome.trace.filter((event) => event.code === "POSTCONDITION_FAILED").length, 1);
  assert.equal(outcome.assessment.missingCount, 0);
});

test("a model-proposed submit action cannot reach the environment", async () => {
  const environment = new SyntheticFormEnvironment();
  const outcome = await run(environment, {
    async decide() { return { kind: "act", tool: "submit_application", args: { buttonId: "submit-application" } }; },
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.trace[0].code, "UNKNOWN_TOOL");
  assert.equal(environment.stepCalls.length, 0);
  assert.equal(environment.submissionCount, 0);
});

test("an add control with submit semantics is rejected before clicking", async () => {
  const environment = new SyntheticFormEnvironment({ unsafeAddControl: true });
  const outcome = await run(environment);
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.trace[0].code, "UNSAFE_ADD_CONTROL");
  assert.equal(environment.stepCalls.length, 0);
});

test("submit wording is rejected even when a control claims to be an add button", async () => {
  const environment = new SyntheticFormEnvironment();
  const originalObserve = environment.observe.bind(environment);
  environment.observe = () => {
    const observation = originalObserve();
    observation.sections[0].addControl.text = "保存并提交简历";
    return observation;
  };
  const outcome = await run(environment);
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.trace[0].code, "UNSAFE_ADD_CONTROL");
  assert.equal(environment.stepCalls.length, 0);
});

test("the agent does not overwrite a different value already entered by a user", async () => {
  const environment = new SyntheticFormEnvironment();
  const originalReset = environment.reset.bind(environment);
  environment.reset = () => {
    originalReset();
    environment.fields[0].value = "用户手动填写的学校";
    return environment.observe();
  };
  const outcome = await run(environment, {
    async decide({ page }) {
      return { kind: "act", tool: "fill_field", args: { fieldId: page.fields[0].id, sourcePath: "educations.0.school" } };
    },
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.trace[0].code, "WOULD_OVERWRITE_EXISTING_VALUE");
  assert.equal(environment.fields[0].value, "用户手动填写的学校");
  assert.equal(environment.stepCalls.length, 0);
});

test("an early finish claim is rejected by the private evaluator", async () => {
  const environment = new SyntheticFormEnvironment();
  const fixturePlanner = new ScriptedFixturePlanner();
  let first = true;
  const planner = {
    async decide(context) {
      if (first) { first = false; return { kind: "finish" }; }
      return fixturePlanner.decide(context);
    },
  };
  const outcome = await run(environment, planner);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.trace[0].code, "PREMATURE_FINISH");
  assert.equal(outcome.steps, 6);
});

test("planner context and trace omit all profile values", async () => {
  const environment = new SyntheticFormEnvironment();
  const fixturePlanner = new ScriptedFixturePlanner();
  const contexts = [];
  const planner = {
    async decide(context) {
      contexts.push(context);
      return fixturePlanner.decide(context);
    },
  };
  const outcome = await run(environment, planner);
  const exposed = JSON.stringify({ contexts, trace: outcome.trace });
  for (const { value } of syntheticProfileFields) assert.equal(exposed.includes(value), false);
  assert.equal(outcome.status, "completed");
});

test("step events expose observation, proposal, execution and verified readback without profile values", async () => {
  const events = [];
  const outcome = await runAgent({
    goal, environment: new SyntheticFormEnvironment(), planner: new ScriptedFixturePlanner(),
    catalog: createSyntheticCatalog(), maxSteps: 1,
    onEvent(event) { events.push(event); },
  });
  assert.equal(outcome.status, "incomplete");
  assert.deepEqual(events.map((event) => event.type), ["deciding", "proposed", "executing", "step"]);
  assert.equal(events[0].page.sections[0].entryCount, 1);
  assert.equal(events[3].page.sections[0].entryCount, 2);
  assert.equal(events[3].beforePage.sections[0].entryCount, 1);
  assert.equal(events[3].event.verified, true);
  for (const { value } of syntheticProfileFields) assert.equal(JSON.stringify(events).includes(value), false);
});

test("a rejected action reports the proposal but never an execution event", async () => {
  const events = [];
  const environment = new SyntheticFormEnvironment();
  const outcome = await runAgent({
    goal, environment, catalog: createSyntheticCatalog(),
    planner: { async decide() { return { kind: "act", tool: "submit_application", args: {} }; } },
    onEvent(event) { events.push(event); },
  });
  assert.equal(outcome.status, "blocked");
  assert.deepEqual(events.map((event) => event.type), ["deciding", "proposed", "step"]);
  assert.equal(environment.stepCalls.length, 0);
});

test("a model explanation containing a profile value is redacted in display events", async () => {
  const events = [];
  await runAgent({
    goal, environment: new SyntheticFormEnvironment(), catalog: createSyntheticCatalog(), maxSteps: 1,
    planner: { async decide() {
      return { kind: "act", tool: "add_entry", args: { sectionKey: "educations" },
        rationale: `先为 ${syntheticProfileFields[0].value} 增加经历卡片。` };
    } },
    onEvent(event) { events.push(event); },
  });
  const proposal = events.find((event) => event.type === "proposed");
  assert.match(proposal.decision.rationale, /资料值已隐藏/);
  for (const { value } of syntheticProfileFields) assert.equal(JSON.stringify(events).includes(value), false);
});

test("step budget stops an unfinished run", async () => {
  const environment = new SyntheticFormEnvironment();
  const outcome = await run(environment, new ScriptedFixturePlanner(), 1);
  assert.equal(outcome.status, "incomplete");
  assert.equal(outcome.steps, 1);
  assert.equal(outcome.assessment.entryCount, 2);
  assert.ok(outcome.assessment.missingCount > 0);
});

test("prototype-property tool names are treated as unknown", async () => {
  const environment = new SyntheticFormEnvironment();
  const outcome = await run(environment, {
    async decide() { return { kind: "act", tool: "constructor", args: {} }; },
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.trace[0].code, "UNKNOWN_TOOL");
  assert.equal(environment.stepCalls.length, 0);
});

test("tool exceptions become retryable evidence instead of false success", async () => {
  const environment = new SyntheticFormEnvironment();
  const originalStep = environment.step.bind(environment);
  let thrown = false;
  environment.step = async (action) => {
    if (action.tool === "fill_field" && !thrown) {
      thrown = true;
      throw new Error("Synthetic widget temporarily unavailable");
    }
    return originalStep(action);
  };
  const outcome = await run(environment);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.trace.filter((event) => event.code === "TOOL_ERROR").length, 1);
  assert.equal(outcome.assessment.missingCount, 0);
});

test("a blocked browser request stops the agent immediately", async () => {
  const environment = new SyntheticFormEnvironment();
  environment.step = async () => {
    throw Object.assign(new Error("Browser blocked a network request"), { code: "NETWORK_SIDE_EFFECT_BLOCKED" });
  };
  const outcome = await run(environment);
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.steps, 1);
  assert.equal(outcome.trace[0].code, "NETWORK_SIDE_EFFECT_BLOCKED");
  assert.equal(outcome.trace[0].verified, false);
});
