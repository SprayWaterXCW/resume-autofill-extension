import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";

async function contextFor(dimensions = true) {
  const language = { name: "英语", proficiency: "流利", testScore: "FICTIONAL_EXAM_SCORE",
    ...(dimensions ? { listeningSpeaking: "良好", readingWriting: "熟练" } : {}) };
  const stored = importProfile({ profile: { languages: [language] }, agentProfilePurpose: "synthetic_evaluation" }).stored;
  const ledger = ledgerFromProfile(stored);
  const dom = new JSDOM('<section><h2>语言能力</h2><label>听说<input></label><label>读写<input></label></section>',
    { url: "https://fictional-language.example.test/form", runScripts: "outside-only" });
  try {
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(dom.window.location.href)})`);
    return { ledger, stored, context: await createPlanContext(report, ledger) };
  } finally { dom.window.close(); }
}

test("confirmed listening/speaking and reading/writing remain independent facts and reject overall or exam substitutions", async () => {
  const { context, ledger, stored } = await contextFor();
  const mappings = context.page.fields.map((field) => ({ fieldId: field.id,
    sourcePath: "languages.0." + (field.label === "听说" ? "listeningSpeaking" : "readingWriting") }));
  const proposal = { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: mappings, unresolved: [] };
  assert.equal((await buildFillPlan(context, proposal)).summary.mappedCount, 2);
  assert.equal(ledger.getValue("languages.0.listeningSpeaking"), "良好");
  assert.equal(ledger.getValue("languages.0.readingWriting"), "熟练");
  assert.equal(ledgerFromProfile(importProfile({ profile: stored.profile }).stored).getValue("languages.0.readingWriting"), "熟练");
  for (const sourcePath of ["languages.0.testScore", "languages.0.proficiency", "languages.0.readingWriting"]) {
    const wrong = structuredClone(proposal); wrong.fieldMappings[0].sourcePath = sourcePath;
    await assert.rejects(buildFillPlan(context, wrong), { code: "PLAN_SEMANTIC_MISMATCH" });
  }
  assert.equal(JSON.stringify(context).includes("FICTIONAL_EXAM_SCORE"), false);
});

test("model candidates exclude exam/overall substitutions and missing dimensions resolve without a model request", async () => {
  for (const dimensions of [false, true]) {
    const { context } = await contextFor(dimensions);
    let request;
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://model.example.test/v1", apiKey: "test-only-key", model: "fixture",
      fetchImpl: async (_url, init) => {
        request = JSON.parse(init.body);
        const proposal = { snapshotId: context.snapshotId, groupMappings: [],
          fieldMappings: dimensions ? context.page.fields.map((field) => ({ fieldId: field.id,
            sourcePath: "languages.0." + (field.label === "听说" ? "listeningSpeaking" : "readingWriting") })) : [],
          unresolved: dimensions ? [] : context.page.fields.map(({ id }) => ({ fieldId: id, reason: "missing_profile" })) };
        return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "fictional", type: "function",
          function: { name: "propose_form_mapping", arguments: JSON.stringify(proposal) } }] } }] }), { status: 200 });
      } });
    const proposal = await planner.planMappings(context);
    if (!dimensions) {
      assert.equal(request, undefined);
      assert.equal(planner.metrics.requests, 0);
      assert.equal(proposal.unresolved.length, 2);
    } else {
      const parameters = request.tools[0].function.parameters;
      const branches = parameters.properties.fieldMappings.items.anyOf || [];
      for (const branch of branches) {
        assert.equal(branch.properties.sourcePath.enum.includes("languages.0.testScore"), false);
        assert.equal(branch.properties.sourcePath.enum.includes("languages.0.proficiency"), false);
      }
      assert.equal((await buildFillPlan(context, proposal)).summary.mappedCount, 2);
      assert.equal(JSON.stringify(request).includes("FICTIONAL_EXAM_SCORE"), false);
    }
  }
});
