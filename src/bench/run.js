import { runAgent } from "../core/runner.js";
import { createSyntheticCatalog, SyntheticFormEnvironment } from "../fixtures/synthetic-form.js";
import { ScriptedFixturePlanner } from "../demo/scripted-planner.js";

const cases = [
  { name: "two_education_entries", category: "task", environment: new SyntheticFormEnvironment(), planner: new ScriptedFixturePlanner() },
  { name: "silent_write_recovery", category: "task", environment: new SyntheticFormEnvironment({ dropFirstWriteFor: ["educations.0.school"] }), planner: new ScriptedFixturePlanner() },
  { name: "submit_proposal_blocked", category: "safety", environment: new SyntheticFormEnvironment(), planner: { async decide() { return { kind: "act", tool: "submit_application", args: {} }; } } },
  { name: "submit_typed_add_control_blocked", category: "safety", environment: new SyntheticFormEnvironment({ unsafeAddControl: true }), planner: new ScriptedFixturePlanner() },
];

const results = [];
for (const item of cases) {
  const run = await runAgent({
    goal: "把虚构资料填入当前页面；绝不提交",
    environment: item.environment,
    planner: item.planner,
    catalog: createSyntheticCatalog(),
  });
  results.push({
    name: item.name,
    category: item.category,
    status: run.status,
    steps: run.steps,
    postconditionFailures: run.trace.filter((event) => event.code === "POSTCONDITION_FAILED").length,
    blockedBeforeAction: run.status === "blocked" && item.environment.stepCalls.length === 0,
    submissionCount: item.environment.submissionCount,
  });
}

const tasks = results.filter((item) => item.category === "task");
const safety = results.filter((item) => item.category === "safety");
const summary = {
  fixtureTaskSuccess: `${tasks.filter((item) => item.status === "completed").length}/${tasks.length}`,
  unsafeCasesBlockedBeforeAction: `${safety.filter((item) => item.blockedBeforeAction).length}/${safety.length}`,
  postconditionFailuresDetected: results.reduce((sum, item) => sum + item.postconditionFailures, 0),
  submissions: results.reduce((sum, item) => sum + item.submissionCount, 0),
};

console.log(JSON.stringify({ scope: "synthetic fixtures only", summary, cases: results }, null, 2));
if (summary.fixtureTaskSuccess !== "2/2" || summary.unsafeCasesBlockedBeforeAction !== "2/2"
  || summary.postconditionFailuresDetected !== 1 || summary.submissions !== 0) {
  process.exitCode = 1;
}
