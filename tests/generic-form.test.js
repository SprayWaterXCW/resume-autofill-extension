import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { genericFormHtml, genericProfile } from "../src/fixtures/generic-form.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createProfileLedger } from "../src/core/profile-ledger.js";
import { withDateParts } from "../src/core/date-parts.js";
import { withLatestRecordAnswers } from "../src/core/latest-record-answers.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { runRealForm } from "../src/core/real-runner.js";
import { formDiagnostic } from "../src/core/form-diagnostics.js";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";

const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const url = "https://fictional-layout.example.test/form";
function fixture(layout) {
  const form = genericFormHtml(layout), dom = new JSDOM(form.html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{ width: 200, height: 30 }]; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  dom.window.eval(bundle.outputFiles[0].text);
  dom.window.document.querySelector("#fixture-add").addEventListener("click", () => {
    const root = dom.window.document.querySelector("#fixture-education");
    root.insertAdjacentHTML("beforeend", form.education(root.children.length));
  });
  dom.window.document.querySelector("#fixture-add-award").addEventListener("click", () => {
    const root = dom.window.document.querySelector("#fixture-awards");
    root.insertAdjacentHTML("beforeend", form.award(root.children.length));
  });
  return { dom, ...form };
}

for (const layout of ["plain", "flat", "aria"]) test(`logical groups and record-local dates fill through the real runtime in ${layout} layout`, async () => {
  const { dom, names } = fixture(layout);
  try {
    const ledger = ledgerFromProfile(importProfile(genericProfile()).stored), runtime = dom.window.__resumeAgentRuntime;
    let token, submits = 0;
    dom.window.document.querySelector('button[type="submit"]').addEventListener("click", () => { submits++; });
    const environment = {
      async observe() { const observation = runtime.scan(url); token = observation.token; return observation.report; },
      async add(groupId) { return runtime.add({ token, groupId }); },
      async fill(item) { return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath,
        value: ledger.getValue(item.sourcePath), semanticRole: item.semanticRole }); },
      async audit(targets) { return runtime.audit({ token, targets }); },
    };
    const events = [], contexts = [];
    const result = await runRealForm({ environment, ledger, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) {
        contexts.push(context);
        const state = dom.window.__resumeAgentBindings;
        const fieldMappings = context.page.fields.flatMap((field) => {
          const target = state.fields.get(field.id).element.getAttribute("data-fixture-target");
          return target ? [{ fieldId: field.id, sourcePath: target }] : [];
        });
        return { snapshotId: context.snapshotId, groupMappings: context.page.groups.flatMap((group) => {
          const section = ({ [names[0]]: ["personal", "formAnswers"], [names[1]]: ["educations"], [names[2]]: ["internships"],
            [names[3]]: ["projects"], [names[4]]: ["languages"], [names[5]]: ["awards"] })[group.label];
          return section ? [{ groupId: group.id, sectionKeys: section }] : [];
        }), fieldMappings, unresolved: [] };
      },
    } });
    const evidence = JSON.stringify({ exclusions: result.plan.mappingExclusions, failures: result.outcomes.filter((outcome) => !outcome.verified),
      groups: result.report.groups, skipped: result.plan.items.filter((item) => !item.sourcePath || item.status === "label_missing") });
    assert.equal(result.result.agentAddedCards, 2, evidence);
    assert.equal(result.result.agentWrittenFields, 24, evidence);
    assert.equal(result.result.discardedMappingCount, 0);
    assert.equal(submits, 0);
    assert.equal(dom.window.document.querySelector("#fixture-code").value, "");
    const education = result.report.groups.find((group) => group.label === names[1]);
    assert.equal(education.entryCount, 2);
    assert.deepEqual(Array.from(result.report.fields.filter((field) => field.groupId === education.id), (field) => field.entryIndex), [0, 0, 0, 0, 1, 1, 1, 1]);
    for (const control of dom.window.document.querySelectorAll("[data-fixture-target]")) {
      const path = control.getAttribute("data-fixture-target");
      assert.equal(control.value, path === "languages.0.proficiency" ? "熟练" : ledger.getValue(path));
    }
    const diagnostics = events.filter((event) => event.formDiagnostic);
    assert.ok(diagnostics.length >= 2);
    assert.equal(diagnostics.at(-1).formDiagnostic.fields.length, 25);
    for (const value of ["虚构公司甲", "虚构大学乙", "fictional-generic@example.test", "+86"]) {
      assert.equal(JSON.stringify(contexts).includes(value), false);
      assert.equal(JSON.stringify(diagnostics).includes(value), false);
    }
  } finally { dom.window.close(); }
});

test("date parts retain their parent and never invent days or project conflicting dates", () => {
  const facts = [{ path: "internships.0.startDate", value: "2025-03" }, { path: "projects.0.endDate", value: "2024-02-29" },
    { path: "educations.0.endDate", value: "2023-02-29" }].map(({ path, value }) => ({ path, label: "虚构日期", sectionKey: path.split(".")[0], entryIndex: 0,
      candidates: [{ sourceId: "fixture", value, status: "verified" }] }));
  const ledger = withDateParts(createProfileLedger({ schemaVersion: 1, sources: [{ id: "fixture", kind: "fixture" }], facts }));
  assert.equal(ledger.getValue("internships.0.startDateYear"), "2025");
  assert.equal(ledger.getValue("internships.0.startDateMonth"), "3");
  assert.equal(ledger.hasPath("internships.0.startDateDay"), false);
  assert.equal(ledger.getValue("projects.0.endDateDay"), "29");
  assert.equal(ledger.hasPath("educations.0.endDateYear"), false);
  assert.deepEqual(ledger.publicFacts.find((fact) => fact.path === "projects.0.endDateDay").derivedFrom, ["projects.0.endDate"]);
});

test("latest-record summaries require unique confirmed ordering and remain separate from full record paths", () => {
  const source = genericProfile();
  const ledger = ledgerFromProfile(importProfile(source).stored);
  assert.equal(ledger.getValue("formAnswers.internshipsLatestCompany"), "虚构公司甲");
  assert.ok(ledger.publicFacts.find((fact) => fact.path === "formAnswers.internshipsLatestCompany").derivedFrom.includes("internships.1.endDate"));
  for (const record of source.profile.internships) { record.startDate = "2024-03"; record.endDate = "2024-06"; }
  const ambiguous = ledgerFromProfile(importProfile(source).stored);
  assert.equal(ambiguous.hasPath("formAnswers.internshipsLatestCompany"), false);
});

test("unrelated record pools in one coarse region stay independent and cannot route a shared Add button", async () => {
  const { dom } = fixture("plain");
  try {
    const ledger = ledgerFromProfile(importProfile(genericProfile()).stored);
    const report = dom.window.__resumeAgentRuntime.scan(url).report;
    const selected = report.fields.filter((field) => ["公司名称", "就读学校", "项目名称", "奖项名称"].includes(field.label)).slice(0, 1);
    // Explicitly manufacture a coarse observation, rather than pretending it
    // has the DOM headings that the preceding integration scenarios exercise.
    report.groups = [{ id: "group-1", label: "未命名容器", source: "fallback", entryCount: 1 }]; report.controls = [];
    report.fields = ["educations.0.school", "internships.0.company", "projects.0.name", "awards.0.name"].map((path, i) => ({
      ...selected[0], id: `field-${i + 1}`, groupId: "group-1", entryIndex: 0,
      label: ["就读学校", "公司名称", "项目名称", "奖项名称"][i] }));
    const context = await createPlanContext(report, ledger);
    const proposal = { snapshotId: context.snapshotId, groupMappings: [{ groupId: "group-1", sectionKeys: ["educations", "internships", "projects", "awards"] }],
      fieldMappings: report.fields.map((field, i) => ({ fieldId: field.id, sourcePath: ["educations.0.school", "internships.0.company", "projects.0.name", "awards.0.name"][i] })), unresolved: [] };
    const plan = await buildFillPlan(context, proposal);
    assert.equal(plan.items.filter((item) => item.sourcePath).length, 4);
    assert.equal(plan.summary.additionalEntries, 0);
    assert.equal(plan.sections[0].additionPolicy, "section_boundary_unresolved");
    const wrong = structuredClone(proposal); wrong.fieldMappings[1].sourcePath = "internships.1.company";
    await assert.rejects(buildFillPlan(context, wrong), { code: "PLAN_RECORD_MISMATCH" });
    assert.equal(JSON.stringify(formDiagnostic(context, plan)).includes("未命名容器"), false);
  } finally { dom.window.close(); }
});

test("year and month targets reject a duplicated full date before any DOM action", async () => {
  const { dom } = fixture("plain");
  try {
    const ledger = ledgerFromProfile(importProfile(genericProfile()).stored);
    const report = dom.window.__resumeAgentRuntime.scan(url).report;
    const context = await createPlanContext(report, ledger);
    const fields = context.page.fields.filter((field) => field.datePart).slice(0, 2);
    const bad = { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: fields.map((field) => ({ fieldId: field.id, sourcePath: "educations.0.startDate" })), unresolved: [] };
    await assert.rejects(buildFillPlan(context, bad), { code: "PLAN_SEMANTIC_MISMATCH" });
    const good = structuredClone(bad);
    good.fieldMappings[0].sourcePath = "educations.0.startDateYear";
    good.fieldMappings[1].sourcePath = "educations.0.startDateMonth";
    assert.equal((await buildFillPlan(context, good)).items.filter((item) => item.sourcePath).length, 2);
  } finally { dom.window.close(); }
});

test("a scalar latest projection cannot be reused as a record in an expandable region", async () => {
  const { dom } = fixture("plain");
  try {
    const ledger = ledgerFromProfile(importProfile(genericProfile()).stored);
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, ledger);
    const education = context.page.groups.find((group) => group.label === "学习经历");
    const field = context.page.fields.find((field) => field.groupId === education.id && field.label === "就读学校");
    const proposal = { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [{ fieldId: field.id, sourcePath: "formAnswers.educationsLatestSchool" }], unresolved: [] };
    await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_SEMANTIC_MISMATCH" });
    const year = context.page.fields.find((field) => field.groupId === education.id && field.datePart === "year");
    proposal.fieldMappings = [{ fieldId: year.id, sourcePath: "formAnswers.educationsLatestStartDateYear" }];
    await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_SEMANTIC_MISMATCH" });
  } finally { dom.window.close(); }
});

test("moving an observed field into another region invalidates its binding before write", async () => {
  const { dom } = fixture("flat");
  try {
    const runtime = dom.window.__resumeAgentRuntime, observation = runtime.scan(url);
    const field = observation.report.fields.find((field) => field.label === "就读学校");
    const element = dom.window.__resumeAgentBindings.fields.get(field.id).element;
    dom.window.document.querySelector("#fixture-awards").append(element);
    const result = await runtime.fill({ token: observation.token, fieldId: field.id, sourcePath: "educations.0.school", value: "虚构学校" });
    assert.equal(result.code, "REAL_PAGE_CHANGED");
    assert.equal(element.value, "");
  } finally { dom.window.close(); }
});

test("model input explicitly grounds each field's candidate sets as well as its function contract", async () => {
  const { dom } = fixture("plain");
  try {
    const ledger = ledgerFromProfile(importProfile(genericProfile()).stored);
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, ledger);
    let checkedEducation = false, calls = 0;
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://api.example.test", apiKey: "fictional-key", model: "fixture",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body), text = body.messages[1].content;
        const view = JSON.parse(text.slice(text.indexOf("{")));
        calls++;
        assert.equal(new Set(view.page.fields.map((field) => field.groupId)).size, 1);
        const group = view.page.groups.find((group) => group.label === "学习经历");
        const year = view.page.fields.find((field) => field.groupId === group.id && field.datePart === "year");
        if (year) {
          checkedEducation = true;
          const paths = year.sourceChoiceIds.flatMap((id) => view.sourceChoices.find((choice) => choice.id === id).sourcePaths);
          assert.ok(paths.includes("educations.0.startDateYear"));
          assert.equal(paths.includes("educations.0.startDate"), false);
          assert.equal(paths.includes("formAnswers.educationsLatestStartDateYear"), false);
          const school = view.page.fields.find((field) => field.groupId === group.id && field.label === "就读学校");
          assert.equal(school.sourceChoiceIds.flatMap((id) => view.sourceChoices.find((choice) => choice.id === id).sourcePaths)
            .includes("formAnswers.currentSchool"), false);
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: {
          name: "propose_form_mapping", arguments: JSON.stringify({ snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [], unresolved: [] }),
        } }] } }] }));
      } });
    await planner.planMappings(context);
    assert.equal(checkedEducation, true);
    assert.equal(calls, 6);
  } finally { dom.window.close(); }
});

test("latest record ordering respects day precision and leaves overlapping month/day intervals unresolved", () => {
  const source = genericProfile();
  source.profile.internships[0].endDate = "2025-06-10";
  source.profile.internships[1].endDate = "2025-06-20";
  let ledger = ledgerFromProfile(importProfile(source).stored);
  assert.equal(ledger.getValue("formAnswers.internshipsLatestCompany"), "虚构公司乙");
  source.profile.internships[0].endDate = "2025-06";
  ledger = ledgerFromProfile(importProfile(source).stored);
  assert.equal(ledger.hasPath("formAnswers.internshipsLatestCompany"), false);
});
