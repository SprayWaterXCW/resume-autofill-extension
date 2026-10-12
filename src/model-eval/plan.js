import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateReadOnlyPlan } from "../core/fill-plan.js";
import { planCases } from "../fixtures/plan-cases.js";
import { OpenAICompatiblePlanner } from "../llm/openai-compatible-planner.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set RESUME_AGENT_API_KEY in .env.local to run plan evaluation");
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const model = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const results = [];
for (const spec of planCases()) {
  const planner = new OpenAICompatiblePlanner({
    apiKey, baseUrl, model, timeoutMs: Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000),
    disableThinking: new URL(baseUrl).hostname === "api.deepseek.com",
  });
  try {
    const { plan } = await generateReadOnlyPlan({ scan: async () => structuredClone(spec.report), ledger: spec.ledger, planner });
    const routes = plan.sections.map((section) => section.sectionKeys);
    const paths = plan.items.map((item) => item.sourcePath);
    const passed = plan.executable === false && plan.summary.additionalEntries === spec.expected.additionalEntries
      && JSON.stringify(routes) === JSON.stringify(spec.expected.routes)
      && JSON.stringify(paths) === JSON.stringify(spec.expected.paths);
    results.push({ id: spec.id, passed, additionalEntries: plan.summary.additionalEntries, routes, paths,
      fieldStatuses: plan.items.map((item) => item.status), metrics: planner.metrics });
  } catch (error) {
    results.push({ id: spec.id, passed: false, code: /^(PLAN_|MODEL_)[A-Z_]+$/.test(error?.code || "")
      ? error.code : "PLAN_EVALUATION_FAILED", metrics: planner.metrics });
  }
  console.log(JSON.stringify(results.at(-1)));
}
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), model,
  scope: "Three synthetic metadata cases, actual LLM mapping requests; no recruitment page or browser actions",
  passed: results.filter((item) => item.passed).length, total: results.length, cases: results };
const output = process.argv.slice(2).find((item) => item.startsWith("--output="))?.slice("--output=".length);
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ output: output || null, passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
