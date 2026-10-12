import { existsSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { genericFormHtml, genericProfile } from "../fixtures/generic-form.js";
import { importProfile, ledgerFromProfile } from "../core/profile-import.js";
import { createPlanContext, buildFillPlan, createPartialProposal, validatePartialProposal } from "../core/fill-plan.js";
import { formDiagnostic } from "../core/form-diagnostics.js";
import { OpenAICompatiblePlanner } from "../llm/openai-compatible-planner.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Configure the model API key before fictional evaluation");
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const model = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const planner = new OpenAICompatiblePlanner({ apiKey, baseUrl, model,
  timeoutMs: Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000), disableThinking: new URL(baseUrl).hostname === "api.deepseek.com" });
const ledger = ledgerFromProfile(importProfile(genericProfile()).stored);
const bundle = await build({ entryPoints: [new URL("../../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const url = "https://fictional-layout.example.test/form", cases = [];
for (const layout of ["plain", "flat", "aria"]) {
  const fixture = genericFormHtml(layout), dom = new JSDOM(fixture.html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{ width: 200, height: 30 }]; };
  dom.window.crypto.randomUUID = randomUUID;
  dom.window.eval(bundle.outputFiles[0].text);
  const observation = dom.window.__resumeAgentRuntime.scan(url);
  const context = await createPlanContext(observation.report, ledger);
  const expected = context.page.fields.map((field) => ({ fieldId: field.id,
    sourcePath: dom.window.__resumeAgentBindings.fields.get(field.id).element.getAttribute("data-fixture-target") }));
  let result, proposal;
  try {
    proposal = await planner.planMappings(context);
    const plan = await buildFillPlan(context, proposal);
    const differences = expected.filter((item) => item.sourcePath && plan.items.find((target) => target.fieldId === item.fieldId)?.sourcePath !== item.sourcePath)
      .map((item) => ({ fieldId: item.fieldId, expectedPath: item.sourcePath, actualPath: plan.items.find((target) => target.fieldId === item.fieldId)?.sourcePath || null }));
    result = { passed: !differences.length && plan.summary.additionalEntries === 2,
      matchedFields: expected.filter((item) => item.sourcePath).length - differences.length,
      expectedFields: expected.filter((item) => item.sourcePath).length, additionalEntries: plan.summary.additionalEntries,
      differences, diagnostic: formDiagnostic(context, plan) };
  } catch (error) {
    let exclusions;
    if (proposal) { try { exclusions = (await validatePartialProposal(context, await createPartialProposal(context, proposal))).partial.exclusions; } catch {} }
    result = { passed: false, code: /^(PLAN_|MODEL_)[A-Z_]+$/.test(error.code || "") ? error.code : "EVALUATION_FAILED",
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}), ...(error.responseDiagnostic ? { responseDiagnostic: error.responseDiagnostic } : {}),
      ...(exclusions ? { exclusions } : {}) };
  } finally { dom.window.close(); }
  cases.push({ layout, fieldCount: context.page.fields.length, groupCount: context.page.groups.length, result });
  console.log(JSON.stringify({ layout, passed: result.passed, matchedFields: result.matchedFields,
    expectedFields: result.expectedFields, code: result.code, differences: result.differences, exclusions: result.exclusions }));
}
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), model,
  scope: "Three fictional DOM layouts, actual model planning, zero page writes; no real applicant metadata or values",
  passed: cases.every((item) => item.result.passed), cases, metrics: planner.metrics };
const output = process.argv.slice(2).find((arg) => arg.startsWith("--output="))?.slice(9);
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, cases: cases.length, metrics: report.metrics }));
if (!report.passed) process.exitCode = 1;
