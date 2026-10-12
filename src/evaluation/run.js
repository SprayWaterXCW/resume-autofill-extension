import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runAgent } from "../core/runner.js";
import { OpenAICompatiblePlanner } from "../llm/openai-compatible-planner.js";
import { evaluationCases } from "./cases.js";
import { EvaluationFormEnvironment } from "./environment.js";
import { gradeCase, summarize } from "./scoring.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function argument(name) {
  return process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const repeat = Number(argument("repeat") ?? 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new RangeError("--repeat must be 1..10");
const selectedIds = argument("cases")?.split(",").filter(Boolean);
const cases = selectedIds
  ? evaluationCases.filter((item) => selectedIds.includes(item.id))
  : evaluationCases;
if (cases.length === 0 || selectedIds?.some((id) => !cases.some((item) => item.id === id))) {
  throw new Error("--cases contains an unknown case ID");
}

const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (cases.some((item) => !item.forcedDecision) && !apiKey) {
  throw new Error("Set RESUME_AGENT_API_KEY in .env.local to run model cases");
}
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const model = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const timeoutMs = Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000);

const results = [];
for (let iteration = 1; iteration <= repeat; iteration += 1) {
  for (const spec of cases) {
    const environment = new EvaluationFormEnvironment(spec);
    const modelPlanner = spec.forcedDecision ? null : new OpenAICompatiblePlanner({
      baseUrl, apiKey, model, timeoutMs,
      disableThinking: new URL(baseUrl).hostname === "api.deepseek.com",
    });
    let exposureCount = 0;
    const planner = {
      async decide(context) {
        const payload = JSON.stringify(context);
        if (spec.profile.some(({ value }) => value.length >= 5 && payload.includes(value))) exposureCount += 1;
        return spec.forcedDecision ?? modelPlanner.decide(context);
      },
    };
    const expectedActions = spec.sections.reduce((total, section) => total
      + section.entries.reduce((fieldTotal, entry) => fieldTotal + entry.fields.length, 0)
      + section.entries.length - section.initialCount, 0);
    const outcome = await runAgent({
      goal: spec.goal, environment, planner, catalog: environment.catalog,
      maxSteps: spec.maxSteps ?? Math.min(24, expectedActions + 3),
    });
    const item = gradeCase(spec, outcome, environment, exposureCount, modelPlanner?.metrics);
    results.push(item);
    console.log(JSON.stringify({ iteration, ...item }));
  }
}

const report = {
  benchmarkVersion: "0.2",
  scope: "Synthetic form tasks and policy probes; no real resume data or recruitment site",
  model,
  createdAt: new Date().toISOString(),
  summary: summarize(results, cases.length, repeat),
  cases: results,
};
const output = argument("output");
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ report: output ?? null, summary: report.summary }, null, 2));
if (process.argv.includes("--gate") && !report.summary.syntheticGatePassed) process.exitCode = 1;
