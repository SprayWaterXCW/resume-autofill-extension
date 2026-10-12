import { existsSync, writeFileSync } from "node:fs";
import { largeFormPlanFixture } from "../fixtures/large-form-plan.js";
import { createPlanContext, buildFillPlan } from "../core/fill-plan.js";
import { OpenAICompatiblePlanner } from "../llm/openai-compatible-planner.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Configure the model API key before synthetic evaluation");
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const model = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const fixture = largeFormPlanFixture();
const protectedForm = process.argv.includes("--existing");
if (protectedForm) {
  for (const field of fixture.report.fields.slice(0, 56)) field.hasValue = true;
  fixture.expectedPaths = fixture.expectedPaths.map((path, i) => i < 56 ? null : path);
}
const context = await createPlanContext(fixture.report, fixture.ledger);
const planner = new OpenAICompatiblePlanner({ apiKey, baseUrl, model,
  timeoutMs: Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000),
  disableThinking: new URL(baseUrl).hostname === "api.deepseek.com" });
let result;
try {
  const proposal = await planner.planMappings(context);
  const plan = await buildFillPlan(context, proposal);
  const paths = plan.items.map((item) => item.sourcePath);
  result = { passed: JSON.stringify(paths) === JSON.stringify(fixture.expectedPaths), paths,
    roles: plan.items.map((item) => item.semanticRole || null), additionalEntries: plan.summary.additionalEntries,
    fieldStatuses: plan.items.map((item) => item.status) };
} catch (error) {
  result = { passed: false, code: /^(PLAN_|MODEL_)[A-Z_]+$/.test(error.code || "") ? error.code : "EVALUATION_FAILED",
    ...(error.responseDiagnostic ? { responseDiagnostic: error.responseDiagnostic } : {}),
    ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}
const output = process.argv.slice(2).find((arg) => arg.startsWith("--output="))?.slice(9);
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), model,
  scope: "Fictional 57-field, 3-group, 201-path model planning only; no real applicant values or browser actions",
  fieldCount: context.page.fields.length, groupCount: context.page.groups.length,
  factCount: context.profileCatalog.length, derivedFactCount: context.profileCatalog.filter((fact) => fact.derivedFrom).length,
  protectedForm,
  result, metrics: planner.metrics };
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!result.passed) process.exitCode = 1;
