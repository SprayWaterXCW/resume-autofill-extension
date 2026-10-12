import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { decoratedFormHtml, decoratedProfile, installDecoratedControls } from "../src/fixtures/decorated-form.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { runRealForm } from "../src/core/real-runner.js";

const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const url = "https://fictional-decorated.example.test/form";
function fixture(options = {}) {
  const form = decoratedFormHtml(), dom = new JSDOM(form.html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  dom.window.eval(bundle.outputFiles[0].text);
  installDecoratedControls(dom.window.document, form, options);
  return dom;
}

test("decorated field titles stay under their section and each Add belongs to the same region", () => {
  const dom = fixture();
  try {
    const report = dom.window.__resumeAgentRuntime.scan(url).report;
    assert.deepEqual(Array.from(report.groups.filter((group) => group.fieldCount), (group) => group.label),
      ["申请信息", "个人信息", "求职意向", "工作经历", "教育背景", "实习经历", "项目经验", "语言能力", "自我描述", "获奖经历"]);
    assert.equal(report.summary.auxiliaryFieldCount, 1);
    assert.equal(report.fields.some((field) => /关键字/.test(field.label)), false);
    for (const section of ["工作经历", "教育背景", "实习经历", "项目经验", "语言能力", "获奖经历"]) {
      const group = report.groups.find((group) => group.label === section);
      assert.equal(report.controls.filter((control) => control.groupId === group.id && control.intent === "add-candidate").length, 1, section);
    }
    const dates = report.fields.filter((field) => field.datePart && field.dateRole);
    assert.equal(dates.length, 12);
    assert.deepEqual(Array.from(dates.slice(0, 4), (field) => [field.datePart, field.dateRole]),
      [["year", "start"], ["month", "start"], ["year", "end"], ["month", "end"]]);
    assert.equal(dates.every((field) => field.kind === "custom-select"), true);
    assert.equal(report.fields.filter((field) => field.datePart && /获奖时间/.test(field.label)).length, 2);
  } finally { dom.window.close(); }
});

test("decorated selects commit nested options and repeated cards keep record-local dates", async () => {
  const dom = fixture({ clearUnitPlaceholder: true, coupledDateDefaults: true });
  try {
    const ledger = ledgerFromProfile(importProfile(decoratedProfile()).stored), runtime = dom.window.__resumeAgentRuntime;
    let token, submits = 0;
    dom.window.document.querySelector("#fixture-submit").addEventListener("click", () => submits++);
    const contexts = [], events = [];
    const result = await runRealForm({ ledger, onEvent: (event) => events.push(event), environment: {
      async observe() { const observation = runtime.scan(url); token = observation.token; return observation.report; },
      async add(groupId) { return runtime.add({ token, groupId }); },
      async fill(item) { return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: ledger.getValue(item.sourcePath) }); },
      async audit(targets) { return runtime.audit({ token, targets }); },
    }, planner: { async planMappings(context) {
      contexts.push(context);
      const state = dom.window.__resumeAgentBindings;
      const fieldMappings = [], unresolved = [];
      for (const field of context.page.fields) {
        if (field.kind === "checkbox") continue;
        const path = state.fields.get(field.id).element.getAttribute("data-fixture-target");
        if (ledger.hasPath(path)) fieldMappings.push({ fieldId: field.id, sourcePath: path });
        else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
      }
      return { snapshotId: context.snapshotId, groupMappings: [], fieldMappings, unresolved };
    } } });
    const evidence = JSON.stringify({ outcomes: result.outcomes.filter((outcome) => !outcome.verified), counts: result.plan.summary, sections: result.plan.sections });
    assert.equal(result.result.agentAddedCards, 3, evidence);
    assert.equal(result.result.discardedMappingCount, 0, evidence);
    assert.equal(submits, 0);
    assert.equal(dom.window.document.querySelector("#fixture-search").value, "");
    assert.equal(dom.window.document.querySelectorAll(".dropdown-menu").length, 0);
    for (const input of dom.window.document.querySelectorAll("[data-fixture-target]")) {
      const path = input.getAttribute("data-fixture-target");
      const selected = input.closest(".widget-select-container")?.querySelector(".widget-display-value");
      const value = selected ? selected.textContent : input.value;
      if (!ledger.hasPath(path)) assert.equal(value, "", path);
      else if (/DateYear$/.test(path)) assert.equal(value, ledger.getValue(path) + "年", path);
      else if (/DateMonth$/.test(path)) assert.equal(value, ledger.getValue(path) + "月", path);
      else assert.equal(value, path === "languages.0.proficiency" ? "熟练" : ledger.getValue(path), path);
    }
    assert.equal(result.result.agentWrittenFields, 35, evidence);
    assert.equal(result.result.pendingEntries, 0);
    const finalReport = runtime.scan(url).report;
    const finalDates = finalReport.fields.filter((field) => field.datePart && field.dateRole);
    assert.equal(finalDates.length, 20);
    const workGroup = finalReport.groups.find((group) => group.label === "工作经历");
    assert.equal(finalDates.filter((field) => field.groupId !== workGroup.id)
      .every((field) => field.hasValue === true && /开始|结束/.test(field.label)), true);
    assert.equal(events.some((event) => event.formDiagnostic?.fields.some((field) => field.dateRole)), true);
    assert.equal(result.outcomes.filter((outcome) => outcome.diagnostic?.replacedDateDefault).length, 8);
    assert.equal(JSON.stringify(contexts).includes("虚构大学甲"), false);
  } finally { dom.window.close(); }
});

test("linked date defaults can be completed but existing or subsequently edited months remain protected", async () => {
  for (const userMonth of ["existing", "later_edit"]) {
    const dom = fixture({ clearUnitPlaceholder: true, coupledDateDefaults: true });
    try {
      const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document;
      const month = document.querySelector('[data-fixture-target="educations.0.startDateMonth"]');
      const display = month.closest(".widget-select-container").querySelector(".widget-display-value");
      if (userMonth === "existing") display.textContent = "7月";
      const observation = runtime.scan(url), fields = observation.report.fields;
      const yearField = fields.find((field) => /就读时间/.test(field.label) && field.datePart === "year" && field.dateRole === "start");
      const monthField = fields.find((field) => /就读时间/.test(field.label) && field.datePart === "month" && field.dateRole === "start");
      assert.equal((await runtime.fill({ token: observation.token, fieldId: yearField.id, sourcePath: "educations.0.startDateYear", value: "2024" })).verified, true);
      if (userMonth === "later_edit") display.textContent = "7月";
      const outcome = await runtime.fill({ token: observation.token, fieldId: monthField.id, sourcePath: "educations.0.startDateMonth", value: "9", fillMode: "empty" });
      assert.equal(outcome.code, "PROTECTED", userMonth);
      assert.equal(display.textContent, "7月", userMonth);
    } finally { dom.window.close(); }
  }
});

test("a cached date unit cannot hide a real title, unit or widget change", () => {
  const dom = fixture();
  try {
    const runtime = dom.window.__resumeAgentRuntime, observation = runtime.scan(url);
    const field = observation.report.fields.find((field) => /就读时间/.test(field.label) && field.datePart === "year" && field.dateRole === "start");
    const binding = dom.window.__resumeAgentBindings.fields.get(field.id), input = binding.element;
    input.placeholder = "";
    assert.equal(binding.assertIdentity(), true, "clearing a transient search placeholder preserves the observed unit");
    input.placeholder = "月";
    assert.equal(binding.assertIdentity(), false, "an explicit new unit changes identity");
    input.placeholder = "年";
    const caption = input.closest(".field-shell").querySelector(".title-decoration");
    caption.textContent = "出生日期";
    assert.equal(binding.assertIdentity(), false, "a changed field title is not hidden by the unit hint");
    caption.textContent = "就读时间";
    const oldWidget = input.closest(".widget-select-container");
    const replacement = oldWidget.cloneNode(false);
    oldWidget.replaceWith(replacement); replacement.append(input); input.placeholder = "";
    assert.equal(binding.assertIdentity(), false, "hints do not transfer to a replacement widget root");
  } finally { dom.window.close(); }
});

test("date purpose and endpoints are validated before any control operation", async () => {
  const dom = fixture();
  try {
    const report = dom.window.__resumeAgentRuntime.scan(url).report, ledger = ledgerFromProfile(importProfile(decoratedProfile()).stored);
    const context = await createPlanContext(report, ledger);
    const awardDate = report.fields.find((field) => /获奖时间/.test(field.label) && field.datePart === "year");
    const startDate = report.fields.find((field) => /就读时间/.test(field.label) && field.datePart === "year" && field.dateRole === "start");
    for (const [field, path] of [[awardDate, "formAnswers.graduationYear"], [startDate, "educations.0.endDateYear"]]) {
      await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [],
        fieldMappings: [{ fieldId: field.id, sourcePath: path }], unresolved: [] }), { code: "PLAN_SEMANTIC_MISMATCH" });
    }
  } finally { dom.window.close(); }
});

test("selected labels do not replace field names and existing display values remain protected", async () => {
  const dom = fixture();
  try {
    const root = dom.window.document.querySelector('[data-fixture-target="languages.0.proficiency"]').closest(".widget-select-container");
    root.querySelector(".widget-display-value").textContent = "良好";
    const tooltip = dom.window.document.createElement("div");
    tooltip.textContent = "良好"; root.parentElement.parentElement.append(tooltip);
    const observation = dom.window.__resumeAgentRuntime.scan(url);
    const field = observation.report.fields.find((field) => field.label === "掌握程度");
    assert.equal(field.hasValue, true);
    assert.equal(field.kind, "custom-select");
    const outcome = await dom.window.__resumeAgentRuntime.fill({ token: observation.token, fieldId: field.id,
      sourcePath: "languages.0.proficiency", value: "熟练", fillMode: "empty" });
    assert.equal(outcome.code, "PROTECTED");
    assert.equal(root.querySelector(".widget-display-value").textContent, "良好");
  } finally { dom.window.close(); }
});
