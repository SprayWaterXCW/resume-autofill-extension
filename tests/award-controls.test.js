import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { normalizeAgentProfile } from "../src/core/award-details.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan, createPartialProposal } from "../src/core/fill-plan.js";
import { runRealForm } from "../src/core/real-runner.js";
import { ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { awardPlanningDiagnostic } from "../src/core/award-planning-diagnostics.js";

const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const url = "https://jobs.example.test/fictional-awards";
function fixture(html) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{ width: 200, height: 30 }]; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  dom.window.eval(bundle.outputFiles[0].text);
  return dom;
}
const select = (label, choices) => '<label>' + label + '<select><option value="">请选择</option>'
  + choices.map((text, i) => '<option value="choice-' + i + '">' + text + '</option>').join("") + '</select></label>';
function privateLedger() {
  const profile = normalizeAgentProfile({ additional: { awards: "• 虚构荣誉甲\n• 虚构荣誉乙", competitions: "• 虚构竞赛甲" } });
  Object.assign(profile.awardRecords.awards[0], { scope: "国家级", rank: "一等奖", description: "虚构获奖详情甲" });
  Object.assign(profile.awardRecords.awards[1], { rank: "二等奖", description: "虚构获奖详情乙" });
  Object.assign(profile.awardRecords.competitions[0], { scope: "省级", rank: "优秀奖", description: "虚构竞赛详情甲" });
  return ledgerFromProfile(importProfile({ profile, agentProfilePurpose: "synthetic_evaluation" }).stored);
}

function runtimeEnvironment(dom, onAdd = () => {}) {
  const runtime = dom.window.__resumeAgentRuntime;
  let token;
  return {
    async observe() { const scan = runtime.scan(url); token = scan.token; return scan.report; },
    async add(groupId) { onAdd(); return runtime.add({ token, groupId }); },
    async fill(item, ledger) { return runtime.fill({ token, ...item, value: ledger.getValue(item.sourcePath) }); },
    async audit(targets) { return runtime.audit({ token, targets }); },
  };
}

for (const rankRole of ["rank", "level"]) test("new-company wording uses typed semantics and grounds " + rankRole + " against actual options", async () => {
  const dom = fixture('<section data-agent-group><h2>奖励记录</h2>' + Array.from({ length: 3 }, () =>
    '<div data-agent-entry><label>荣誉事项<input></label>'
    + select("评定层次", ["国家级", "省级", "校级"]) + select("奖励档次", ["一等奖", "二等奖", "优秀奖"])
    + '<label>成果叙事<textarea></textarea></label></div>').join("") + '</section>');
  const ledger = privateLedger(), events = [];
  try {
    const roles = { 荣誉事项: "name", 评定层次: "scope", 奖励档次: rankRole, 成果叙事: "description" };
    const run = await runRealForm({ environment: runtimeEnvironment(dom), ledger, onEvent: (event) => events.push(event),
      planner: { async planMappings(context) {
        const fieldMappings = [], unresolved = [];
        for (const field of context.page.fields) {
          const prefix = field.entryIndex < 2 ? "awards." + field.entryIndex : "competitions.0";
          const role = roles[field.label], sourcePath = prefix + "." + role;
          if (ledger.hasPath(sourcePath)) fieldMappings.push({ fieldId: field.id, sourcePath, semanticRole: role });
          else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
        }
        return { snapshotId: context.snapshotId, groupMappings: [{ groupId: context.page.groups[0].id, sectionKeys: ["awards"] }],
          fieldMappings, unresolved };
      } } });
    assert.equal(run.result.agentWrittenFields, 11);
    const cards = [...dom.window.document.querySelectorAll("[data-agent-entry]")];
    assert.deepEqual(cards.map((card) => card.querySelector("input").value), ["虚构荣誉甲", "虚构荣誉乙", "虚构竞赛甲"]);
    assert.deepEqual(cards.map((card) => card.querySelector("textarea").value), ["虚构获奖详情甲", "虚构获奖详情乙", "虚构竞赛详情甲"]);
    assert.deepEqual(cards.map((card) => card.querySelectorAll("select")[0].selectedOptions[0].textContent), ["国家级", "请选择", "省级"]);
    assert.deepEqual(cards.map((card) => card.querySelectorAll("select")[1].selectedOptions[0].textContent), ["一等奖", "二等奖", "优秀奖"]);
    assert.equal(JSON.stringify({ events, plan: run.plan }).includes("虚构获奖详情甲"), false);
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, ledger);
    for (const field of context.page.fields) field.label = "PRIVATE_LABEL_SENTINEL";
    const diagnostic = awardPlanningDiagnostic(context, { plan: run.plan });
    assert.equal(diagnostic.fields.length, 12, "typed source references include groups with unfamiliar labels");
    assert.equal(diagnostic.fields[3].resolvedSemanticRole, "description");
    assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_LABEL_SENTINEL"), false);
  } finally { dom.window.close(); }
});

test("five duplicated award-name references no longer discard the five recognized name fields", async () => {
  const profile = normalizeAgentProfile({ additional: { awards: Array.from({ length: 5 }, (_, i) => "• 虚构表彰" + i).join("\n") } });
  for (const record of profile.awardRecords.awards) record.scope = "国家级";
  const ledger = ledgerFromProfile(importProfile({ profile }).stored), events = [];
  const dom = fixture('<section data-agent-group><h2>获奖情况</h2>' + Array.from({ length: 5 }, () =>
    '<div data-agent-entry><label>奖项名称<input></label>' + select("获奖级别", ["国家级", "省级"])
    + '<label>补充事项<textarea></textarea></label></div>').join("") + '</section>');
  try {
    const run = await runRealForm({ environment: runtimeEnvironment(dom), ledger, onEvent: (event) => events.push(event),
      planner: { async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: context.page.fields.map((field) => ({ fieldId: field.id,
          sourcePath: "awards." + field.entryIndex + (field.label === "获奖级别" ? ".scope" : ".name") })) }; } } });
    assert.equal(run.result.modelCalls, 3);
    assert.equal(run.result.agentWrittenFields, 10);
    assert.equal(run.result.discardedMappingCount, 5);
    assert.deepEqual([...dom.window.document.querySelectorAll("input")].map((field) => field.value),
      Array.from({ length: 5 }, (_, i) => "虚构表彰" + i));
    assert.ok([...dom.window.document.querySelectorAll("textarea")].every((field) => field.value === ""));
    const diagnostic = events.find((event) => event.tool === "award_plan").awardPlanning;
    assert.equal(diagnostic.fields.filter((field) => field.semanticRole === "name" && field.discarded).length, 0);
    assert.equal(diagnostic.fields.filter((field) => field.semanticRole === "unknown" && field.discarded).length, 5);
    assert.ok(diagnostic.records.every((record) => !record.availableProperties.includes("description")));
    assert.equal(JSON.stringify(events).includes("虚构表彰"), false);
  } finally { dom.window.close(); }
});

test("two equally plausible name targets remain quarantined, never chosen arbitrarily", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry>'
    + '<label>奖项名称<input></label><label>荣誉名称<input></label></div></section>');
  try {
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, privateLedger());
    const partial = await createPartialProposal(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
      fieldMappings: context.page.fields.map((field) => ({ fieldId: field.id, sourcePath: "awards.0.name", semanticRole: "name" })) });
    assert.equal(partial.proposal.fieldMappings.length, 0);
    assert.equal(partial.discardedFieldIds.length, 2);
  } finally { dom.window.close(); }
});

test("one prose box receives every award and competition without adding nonexistent cards", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖情况</h2><label>获奖情况<textarea></textarea></label></section>');
  const ledger = privateLedger();
  let attemptedAdds = 0;
  try {
    const run = await runRealForm({ environment: runtimeEnvironment(dom, () => attemptedAdds++), ledger,
      planner: { async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "formAnswers.awardsAndCompetitionsSummary", semanticRole: "summary" }] }; } } });
    assert.equal(run.result.agentWrittenFields, 1);
    assert.equal(run.result.agentAddedCards, 0);
    assert.equal(attemptedAdds, 0);
    assert.equal(run.plan.sections[0].additionalEntries, 0);
    const value = dom.window.document.querySelector("textarea").value;
    assert.equal(value, ledger.getValue("formAnswers.awardsAndCompetitionsSummary"));
    for (const name of ["虚构荣誉甲", "虚构荣誉乙", "虚构竞赛甲"]) assert.ok(value.includes(name));
    assert.equal(JSON.stringify(run.plan).includes("虚构荣誉甲"), false);
  } finally { dom.window.close(); }
});

test("separate prose groups keep awards and competitions separate; add candidates prevent collapsing a repeated form", async () => {
  const dom = fixture('<section data-agent-group><h2>荣誉记录</h2><label>所获表彰说明<textarea></textarea></label></section>'
    + '<section data-agent-group><h2>竞赛经历</h2><label>参赛成果说明<textarea></textarea></label></section>');
  const ledger = privateLedger();
  try {
    const run = await runRealForm({ environment: runtimeEnvironment(dom), ledger,
      planner: { async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: context.page.fields.map((field, index) => ({ fieldId: field.id,
          sourcePath: index ? "formAnswers.competitionsSummary" : "formAnswers.awardsSummary", semanticRole: "summary" })) }; } } });
    assert.equal(run.result.agentWrittenFields, 2);
    assert.equal(run.plan.summary.additionalEntries, 0);
    const [awards, competitions] = [...dom.window.document.querySelectorAll("textarea")].map((field) => field.value);
    assert.equal(awards.includes("虚构竞赛甲"), false);
    assert.equal(competitions.includes("虚构荣誉甲"), false);
    assert.equal(awards, ledger.getValue("formAnswers.awardsSummary"));
    assert.equal(competitions, ledger.getValue("formAnswers.competitionsSummary"));
  } finally { dom.window.close(); }
  const repeated = fixture('<section data-agent-group><h2>获奖情况</h2><div data-agent-entry><label>获奖情况<textarea></textarea></label></div>'
    + '<button type="button">添加获奖</button></section>');
  try {
    const context = await createPlanContext(repeated.window.__resumeAgentRuntime.scan(url).report, ledger);
    await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
      fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "formAnswers.awardsAndCompetitionsSummary", semanticRole: "summary" }] }),
    (error) => error.code === "PLAN_SEMANTIC_MISMATCH");
  } finally { repeated.window.close(); }
});

test("manual award contents stay protected and diagnostics contain role decisions without labels or values", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖情况</h2><label>获奖情况<textarea>虚构手工内容</textarea></label></section>');
  const ledger = privateLedger();
  try {
    const run = await runRealForm({ environment: runtimeEnvironment(dom), ledger, fillMode: "empty",
      planner: { async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "formAnswers.awardsAndCompetitionsSummary", semanticRole: "summary" }] }; } } });
    assert.equal(run.result.agentWrittenFields, 0);
    assert.equal(dom.window.document.querySelector("textarea").value, "虚构手工内容");
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, ledger);
    context.page.fields[0].label = "PRIVATE_LABEL_SENTINEL";
    const diagnostic = awardPlanningDiagnostic(context, { proposal: { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
      fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "formAnswers.awardsAndCompetitionsSummary", semanticRole: "summary" }] } });
    assert.equal(diagnostic.fields[0].proposedSemanticRole, "summary");
    assert.equal(diagnostic.fields[0].resolvedSemanticRole, "summary");
    for (const value of ["PRIVATE_LABEL_SENTINEL", "虚构手工内容", "虚构荣誉甲", "虚构获奖详情甲"]) assert.equal(JSON.stringify(diagnostic).includes(value), false);
  } finally { dom.window.close(); }
});

test("merged award cards add every source record and fill four independent properties without shifting unknown levels", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry><label>奖项名称<input></label>'
    + select("获奖级别", ["国家", "省", "市", "校"]) + select("获奖等次", ["一等奖", "二等奖", "优秀奖"])
    + '<label>详细信息<textarea></textarea></label></div><button type="button" id="add">添加获奖</button><button type="submit" id="submit">提交简历</button></section>');
  try {
    const document = dom.window.document;
    let submitted = 0;
    document.getElementById("submit").addEventListener("click", () => submitted += 1);
    document.getElementById("add").addEventListener("click", () => {
      const card = document.querySelector("[data-agent-entry]").cloneNode(true);
      for (const field of card.querySelectorAll("input,select,textarea")) field.value = "";
      document.getElementById("add").before(card);
    });
    const runtime = dom.window.__resumeAgentRuntime, ledger = privateLedger();
    let token;
    const events = [], contexts = [];
    const environment = {
      async observe() { const observation = runtime.scan(url); token = observation.token; return observation.report; },
      async add(groupId) { return runtime.add({ token, groupId }); },
      async fill(item) { return runtime.fill({ token, ...item, value: ledger.getValue(item.sourcePath) }); },
      async audit(targets) { return runtime.audit({ token, targets }); },
    };
    const planner = { async planMappings(context) {
      contexts.push(context);
      const mappings = [], unresolved = [];
      for (const field of context.page.fields) {
        const prefix = field.entryIndex < 2 ? "awards." + field.entryIndex : "competitions." + (field.entryIndex - 2);
        const key = ({ 奖项名称: "name", 获奖级别: "scope", 获奖等次: "rank", 详细信息: "description" })[field.label];
        const path = prefix + "." + key;
        if (ledger.hasPath(path)) mappings.push({ fieldId: field.id, sourcePath: path });
        else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
      }
      return { snapshotId: context.snapshotId, groupMappings: [{ groupId: context.page.groups[0].id, sectionKeys: ["awards"] }],
        fieldMappings: mappings, unresolved };
    } };
    const run = await runRealForm({ environment, ledger, planner, onEvent: (event) => events.push(event) });
    assert.equal(run.status, "partial");
    assert.equal(run.result.agentAddedCards, 2);
    assert.equal(run.result.agentWrittenFields, 11);
    assert.equal(run.result.unresolvedCount, 0);
    assert.equal(run.result.skippedCount, 1);
    assert.equal(submitted, 0);
    const cards = [...document.querySelectorAll("[data-agent-entry]")];
    assert.deepEqual(cards.map((card) => card.querySelector("input").value), ["虚构荣誉甲", "虚构荣誉乙", "虚构竞赛甲"]);
    assert.deepEqual(cards.map((card) => card.querySelectorAll("select")[0].value), ["choice-0", "", "choice-1"]);
    assert.deepEqual(cards.map((card) => card.querySelectorAll("select")[1].value), ["choice-0", "choice-1", "choice-2"]);
    assert.deepEqual(cards.map((card) => card.querySelector("textarea").value), ["虚构获奖详情甲", "虚构获奖详情乙", "虚构竞赛详情甲"]);
    assert.deepEqual(run.plan.sections[0].sectionKeys, ["awards", "competitions"]);
    for (const value of ["虚构荣誉甲", "虚构荣誉乙", "虚构竞赛甲", "虚构获奖详情甲", "虚构竞赛详情甲"]) assert.equal(JSON.stringify({ events, contexts, outcomes: run.outcomes }).includes(value), false);
  } finally { dom.window.close(); }
});

test("name and description cannot be swapped by model proposals or direct executor calls", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry>'
    + '<label>奖项名称<input></label><label>详细信息<textarea></textarea></label></div></section>');
  try {
    const runtime = dom.window.__resumeAgentRuntime, ledger = privateLedger(), scan = runtime.scan(url);
    const context = await createPlanContext(scan.report, ledger);
    for (const [index, path] of [[0, "awards.0.description"], [1, "awards.0.name"]]) {
      await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: [{ fieldId: context.page.fields[index].id, sourcePath: path }] }),
      (error) => error.code === "PLAN_SEMANTIC_MISMATCH");
      const refused = await runtime.fill({ token: scan.token, fieldId: context.page.fields[index].id,
        sourcePath: path, value: ledger.getValue(path) });
      assert.equal(refused.code, "AWARD_MAPPING_MISMATCH");
    }
    assert.equal(dom.window.document.querySelector("input").value, "");
    assert.equal(dom.window.document.querySelector("textarea").value, "");
  } finally { dom.window.close(); }
});

test("level semantics gate rejects raw names, swapped axes and payload-to-text; partial repair preserves an independent name", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry><label>奖项名称<input></label>'
    + select("获奖级别", ["国家级", "省级"]) + select("获奖等次", ["一等奖", "二等奖"])
    + select("获奖等级", ["国家级", "省级"]) + '<label>获奖等级<input></label></div></section>');
  try {
    const runtime = dom.window.__resumeAgentRuntime, ledger = privateLedger();
    const scan = runtime.scan(url);
    const context = await createPlanContext(scan.report, ledger);
    const fields = context.page.fields;
    for (const [index, path] of [[1, "awards.0.name"], [1, "awards.0.rank"], [2, "awards.0.scope"], [3, "awards.0.scope"], [4, "awards.0.level"]]) {
      const proposal = { snapshotId: context.snapshotId, groupMappings: [], unresolved: [], fieldMappings: [
        { fieldId: fields[0].id, sourcePath: "awards.0.name" }, { fieldId: fields[index].id, sourcePath: path },
      ] };
      await assert.rejects(buildFillPlan(context, proposal), (error) => error.code === "PLAN_SEMANTIC_MISMATCH");
      const partial = await createPartialProposal(context, proposal);
      assert.equal(partial.proposal.fieldMappings.length, 1);
      assert.equal(partial.proposal.fieldMappings[0].fieldId, fields[0].id);
    }
    const refused = await runtime.fill({ token: scan.token, fieldId: fields[4].id, sourcePath: "awards.0.level", value: ledger.getValue("awards.0.level") });
    assert.equal(refused.code, "AWARD_MAPPING_MISMATCH");
    assert.equal(dom.window.document.querySelectorAll("input")[1].value, "");
  } finally { dom.window.close(); }
});

test("model tool contract excludes missing scope and uses the merged competition record's actual paths", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2>' + Array.from({ length: 3 }, () =>
    '<div data-agent-entry><label>奖项名称<input></label>' + select("获奖级别", ["国家级", "省级"])
    + select("获奖等次", ["一等奖", "二等奖"]) + select("获奖等级", ["国家级", "省级"]) + '</div>').join("") + '</section>');
  try {
    const context = await createPlanContext(dom.window.__resumeAgentRuntime.scan(url).report, privateLedger());
    let request;
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://api.example.test", apiKey: "fictional-key", model: "fixture",
      fetchImpl: async (_url, init) => {
        request = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: {
          name: "propose_form_mapping", arguments: JSON.stringify({ snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [], unresolved: [] }),
        } }] } }] }));
      } });
    await planner.planMappings(context);
    const branches = request.tools[0].function.parameters.properties.fieldMappings.items.anyOf;
    const allowed = (index) => branches.filter((branch) => branch.properties.fieldId.enum.includes(context.page.fields[index].id))
      .flatMap((branch) => branch.properties.sourcePath.enum);
    assert.deepEqual(allowed(1), ["awards.0.scope"]);
    assert.deepEqual(allowed(2), ["awards.0.rank"]);
    assert.deepEqual(allowed(3), ["awards.0.level"]);
    assert.deepEqual(allowed(5), [], "second award has no confirmed scope");
    assert.deepEqual(allowed(8), ["competitions.0.name"]);
    assert.deepEqual(allowed(9), ["competitions.0.scope"]);
    assert.equal(JSON.stringify(request).includes("虚构荣誉甲"), false);
  } finally { dom.window.close(); }
});

test("ambiguous level label resolves against lazy custom options, closes popup, and keeps missing scope blank", async () => {
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry><div class="el-form-item"><label>获奖等级</label>'
    + '<div class="el-select"><input id="grade" readonly aria-controls="choices" aria-expanded="false"></div></div></div>'
    + '<ul id="choices" role="listbox" hidden></ul></section>');
  try {
    const document = dom.window.document, input = document.getElementById("grade"), list = document.getElementById("choices");
    let labels = ["一等", "二等", "三等"], clicked = 0;
    input.addEventListener("click", () => {
      input.setAttribute("aria-expanded", "true");
      // Create options only after opening, matching a common site lifecycle.
      dom.window.setTimeout(() => {
        list.replaceChildren();
        for (const label of labels) {
          const option = document.createElement("li"); option.setAttribute("role", "option"); option.textContent = label;
          option.addEventListener("click", () => { clicked += 1; input.value = label; list.hidden = true; input.setAttribute("aria-expanded", "false"); });
          list.append(option);
        }
        list.hidden = false;
      }, 220);
    });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { list.hidden = true; input.setAttribute("aria-expanded", "false"); } });
    const runtime = dom.window.__resumeAgentRuntime, ledger = privateLedger();
    let scan = runtime.scan(url);
    const rank = await runtime.fill({ token: scan.token, fieldId: scan.report.fields[0].id, sourcePath: "awards.1.level", value: ledger.getValue("awards.1.level") });
    assert.equal(rank.code, "VERIFIED"); assert.equal(rank.diagnostic.awardAxis, "rank");
    assert.equal(input.value, "二等"); assert.equal(list.hidden, true); assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(runtime.audit({ token: scan.token, targets: [{ fieldId: scan.report.fields[0].id, sourcePath: "awards.1.level" }] })[0].verified, true);
    input.value = ""; list.replaceChildren(); labels = ["国家", "省", "市"];
    scan = runtime.scan(url);
    const missing = await runtime.fill({ token: scan.token, fieldId: scan.report.fields[0].id, sourcePath: "awards.1.level", value: ledger.getValue("awards.1.level") });
    assert.equal(missing.code, "AWARD_SCOPE_MISSING"); assert.equal(missing.diagnostic.awardAxis, "scope");
    assert.equal(input.value, ""); assert.equal(list.hidden, true); assert.equal(clicked, 1);
    list.replaceChildren(); scan = runtime.scan(url);
    const scope = await runtime.fill({ token: scan.token, fieldId: scan.report.fields[0].id, sourcePath: "awards.0.level", value: ledger.getValue("awards.0.level") });
    assert.equal(scope.code, "VERIFIED"); assert.equal(scope.diagnostic.awardAxis, "scope");
    assert.equal(input.value, "国家"); assert.equal(list.hidden, true);
    assert.equal(JSON.stringify([rank, missing, scope]).includes('"kind":"award_level"'), false);
  } finally { dom.window.close(); }
});

test("mixed axes, duplicate aliases and gold-to-first-prize guesses are refused before a native selection", async () => {
  const ledger = privateLedger();
  for (const [label, choices, path, value, expected] of [
    ["获奖等级", ["国家级", "一等奖"], "awards.0.level", ledger.getValue("awards.0.level"), "AWARD_LEVEL_AMBIGUOUS"],
    ["获奖等级", ["国家", "全国", "省"], "awards.0.level", ledger.getValue("awards.0.level"), "AWARD_OPTION_AMBIGUOUS"],
    ["获奖等次", ["一等奖", "二等奖"], "awards.0.rank", "金奖", "AWARD_OPTION_UNAVAILABLE"],
    ["获奖级别", ["一等奖", "二等奖"], "awards.0.scope", "国家级", "AWARD_AXIS_MISMATCH"],
  ]) {
    const dom = fixture('<section data-agent-group><h2>获奖经历</h2><div data-agent-entry>' + select(label, choices) + '</div></section>');
    try {
      const runtime = dom.window.__resumeAgentRuntime, scan = runtime.scan(url);
      let changes = 0; dom.window.document.querySelector("select").addEventListener("change", () => changes += 1);
      const outcome = await runtime.fill({ token: scan.token, fieldId: scan.report.fields[0].id, sourcePath: path, value });
      assert.equal(outcome.code, expected); assert.equal(outcome.verified, false);
      assert.equal(dom.window.document.querySelector("select").value, ""); assert.equal(changes, 0);
    } finally { dom.window.close(); }
  }
});

test("award diagnostics whitelist axis/code and runner explains missing scope without exposing the private payload", async () => {
  const safe = ChromeFormEnvironment.prototype.safeOutcome({ code: "AWARD_SCOPE_MISSING", verified: false,
    diagnostic: { phase: "select", adapter: "award_choice", awardAxis: "scope", value: "PRIVATE_SENTINEL" } });
  assert.equal(safe.diagnostic.awardAxis, "scope"); assert.equal(JSON.stringify(safe).includes("PRIVATE_SENTINEL"), false);
  const ledger = privateLedger();
  const events = [];
  const dom = fixture('<section data-agent-group><h2>获奖经历</h2>'
    + '<div data-agent-entry>' + select("获奖等级", ["国家级", "省级"]) + '</div>'
    + '<div data-agent-entry>' + select("获奖等级", ["国家级", "省级"]) + '</div>'
    + '<div data-agent-entry>' + select("获奖等级", ["国家级", "省级"]) + '</div></section>');
  try {
    const runtime = dom.window.__resumeAgentRuntime; let token;
    const run = await runRealForm({ ledger,
      environment: {
        async observe() { const scan = runtime.scan(url); token = scan.token; return scan.report; },
        async fill(item) { return runtime.fill({ token, ...item, value: ledger.getValue(item.sourcePath) }); },
        async audit(targets) { return runtime.audit({ token, targets }); },
      },
      planner: { async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: context.page.fields.map((field) => ({ fieldId: field.id, sourcePath: field.entryIndex < 2
          ? 'awards.' + field.entryIndex + '.level' : 'competitions.0.level' })) }; } }, onEvent: (event) => events.push(event),
    });
    assert.equal(run.result.agentWrittenFields, 2);
    assert.equal(run.outcomes.find((outcome) => outcome.sourcePath === "awards.1.level").code, "AWARD_SCOPE_MISSING");
    assert.ok(events.some((event) => event.summary?.includes("该控件要求获奖级别，资料尚未确认")));
    assert.equal(JSON.stringify(events).includes('"kind":"award_level"'), false);
  } finally { dom.window.close(); }
});
