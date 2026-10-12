import { runAgent } from "../core/runner.js";
import { createSyntheticCatalog, SyntheticFormEnvironment } from "../fixtures/synthetic-form.js";
import { ScriptedFixturePlanner } from "./scripted-planner.js";

const run = await runAgent({
  goal: "用资料库填写教育经历；不提交简历。",
  environment: new SyntheticFormEnvironment(),
  planner: new ScriptedFixturePlanner(),
  catalog: createSyntheticCatalog(),
});

console.log(JSON.stringify(run, null, 2));
if (run.status !== "completed") process.exitCode = 1;
