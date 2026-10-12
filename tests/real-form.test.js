import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { runRealForm } from "../src/core/real-runner.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";

const fictional = JSON.parse(readFileSync(new URL("../src/fixtures/real-profile.json", import.meta.url), "utf8"));
const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const runtimeScript = bundle.outputFiles[0].text;
const url = "https://jobs.example.test/application";

function fixture(html = readFileSync(new URL("../web-demo/real-form.html", import.meta.url), "utf8")) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{ width: 200, height: 30 }]; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  dom.window.eval(runtimeScript);
  return dom;
}

function mapping(context) {
  const groupMappings = [], fieldMappings = [], unresolved = [];
  for (const group of context.page.groups) {
    const sectionKeys = group.label === "基本信息" ? ["personal", "contactAndLocation"]
      : group.label === "教育经历" ? ["educations"] : group.label === "语言能力" ? ["languages"]
      : group.label === "获奖经历" ? ["awards", "competitions"] : group.label === "其他信息" ? ["jobPreferences"] : null;
    if (sectionKeys) groupMappings.push({ groupId: group.id, sectionKeys });
    let genderMapped = false;
    for (const field of context.page.fields.filter((field) => field.groupId === group.id)) {
      let sourcePath = null;
      if (group.label === "基本信息") {
        sourcePath = ({ 姓名: "personal.fullName", 手机号码: "personal.phoneNumber", 邮箱: "personal.email",
          "身高（cm）": "personal.heightCm", 籍贯: "contactAndLocation.hometownCity" })[field.label];
        if (field.label === "性别" && !genderMapped) { sourcePath = "personal.gender"; genderMapped = true; }
      } else if (group.label === "教育经历") {
        const key = ({ 毕业学校: "school", 所学专业: "major", 学历: "degree", 开始时间: "startDate", 毕业时间: "endDate" })[field.label];
        if (key) sourcePath = `educations.${field.entryIndex}.${key}`;
      } else if (group.label === "语言能力") sourcePath = `languages.0.${field.label === "语言" ? "name" : "proficiency"}`;
      else if (group.label === "获奖经历") sourcePath = field.entryIndex < 5 ? `awards.${field.entryIndex}.name` : `competitions.${field.entryIndex - 5}.name`;
      else if (group.label === "其他信息") sourcePath = "jobPreferences.discoveryChannel";
      if (sourcePath) fieldMappings.push({ fieldId: field.id, sourcePath });
      else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
    }
  }
  return { snapshotId: context.snapshotId, groupMappings, fieldMappings, unresolved };
}

test("monthly salary from a direct profile field or projection selects the exact numeric interval and never a nearby range", async () => {
  for (const sourcePath of ["jobPreferences.expectedMonthlySalary", "formAnswers.expectedMonthlySalary"]) {
    for (const range of ["10k～15k", "12k～16k"]) {
      const dom = fixture('<section><h2>求职偏好</h2><label>期望税前月薪<select><option value="">请选择</option><option value="a">10,000–15,000</option><option value="b">15,000–20,000</option></select></label></section>');
      try {
        const runtime = dom.window.__resumeAgentRuntime, scan = runtime.scan(url);
        const outcome = await runtime.fill({ token: scan.token, fieldId: scan.report.fields[0].id, sourcePath, value: range });
        assert.equal(outcome.verified, range === "10k～15k");
        assert.equal(dom.window.document.querySelector('select').value, range === "10k～15k" ? 'a' : '');
        if (outcome.verified) assert.equal(runtime.audit({ token: scan.token, targets: [{ fieldId: scan.report.fields[0].id, sourcePath }] })[0].verified, true);
      } finally { dom.window.close(); }
    }
  }
});

test("old plugin exports become private facts, preserving all five awards and two competitions", () => {
  const { stored, summary } = importProfile({ ...fictional, rawText: "PRIVATE_IMPORT_TEXT", apiKey: "PRIVATE_IMPORT_KEY" });
  const ledger = ledgerFromProfile(stored);
  assert.equal(ledger.profileKind, "synthetic");
  assert.equal(summary.sections.find((section) => section.key === "awards").recordCount, 5);
  assert.equal(summary.sections.find((section) => section.key === "competitions").recordCount, 2);
  assert.equal(ledger.getValue("personal.phoneNumber"), "13900000000");
  assert.equal(ledger.getValue("awards.4.name"), "虚构奖项戊");
  assert.equal(JSON.stringify(stored).includes("PRIVATE_IMPORT"), false);
  for (const value of ["13900000000", "fictional@example.test", "虚构大学甲", "虚构奖项戊"]) assert.equal(JSON.stringify(summary).includes(value), false);
  const bank = { activeTemplateId: "active", templates: [{ id: "other", profile: { personal: { fullName: "错误模板" } } }, { id: "active", profile: fictional.profile }] };
  assert.equal(ledgerFromProfile(importProfile(bank).stored).getValue("personal.fullName"), "虚构求职者");
  assert.throws(() => importProfile({ apiKey: "never store this" }), /PROFILE_IMPORT_FORMAT/);
});

test("real runtime fills 23 fields and seven cards without submitting, while manual submission stays usable", async () => {
  const dom = fixture();
  try {
    dom.window.eval(readFileSync(new URL("../web-demo/real-form.js", import.meta.url), "utf8"));
    const runtime = dom.window.__resumeAgentRuntime;
    const ledger = ledgerFromProfile(importProfile(fictional).stored);
    let token;
    const contexts = [], records = [];
    const environment = {
      async observe() { const value = runtime.scan(url); token = value.token; return value.report; },
      async add(groupId) { return runtime.add({ token, groupId }); },
      async fill(item, privateLedger) { return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: privateLedger.getValue(item.sourcePath), fillMode: "empty" }); },
      async audit(targets) { return runtime.audit({ token, targets }); },
    };
    const run = await runRealForm({ environment, ledger, fillMode: "empty", planner: { async planMappings(context) { contexts.push(context); return mapping(context); } }, onEvent: (event) => records.push(event) });
    assert.equal(run.status, "partial");
    assert.equal(run.result.agentAddedCards, 7);
    assert.equal(run.result.agentWrittenFields, 23);
    assert.equal(run.result.unresolvedCount, 2);
    assert.ok(contexts.length > 2, "newly added records need fresh validated observations");
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("#education [data-agent-entry]").length, 2);
    assert.equal(document.querySelectorAll("#awards [data-agent-entry]").length, 7);
    assert.deepEqual(Array.from(document.querySelectorAll("#awards input"), (input) => input.value),
      ["虚构奖项甲", "虚构奖项乙", "虚构奖项丙", "虚构奖项丁", "虚构奖项戊", "虚构竞赛甲", "虚构竞赛乙"]);
    assert.equal(document.getElementById("existing-name").value, "用户原有虚构姓名");
    assert.equal(document.querySelector('input[type=tel]').value, "13900000000");
    assert.equal(document.getElementById("proficiency").value, "良好");
    assert.equal(document.getElementById("proficiency-options").hidden, true);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);
    assert.match(document.getElementById("verification").textContent, /提交动作 0 次/);
    for (const value of ["13900000000", "fictional@example.test", "虚构大学甲", "虚构竞赛乙", "用户原有虚构姓名"]) {
      assert.equal(JSON.stringify(contexts).includes(value), false);
      assert.equal(JSON.stringify({ records, run: { result: run.result, outcomes: run.outcomes } }).includes(value), false);
    }
    assert.equal(dom.window.__resumeAgentSubmitGuard, undefined);
    runtime.clear();
    const submit = document.querySelector("#declaration button[type=submit]");
    assert.equal(submit.disabled, false);
    submit.click();
    assert.match(document.getElementById("verification").textContent, /提交动作 1 次/);
    document.querySelector("#declaration").requestSubmit(submit);
    assert.match(document.getElementById("verification").textContent, /提交动作 2 次/);
    document.querySelector("#deceptive").click();
    assert.match(document.getElementById("verification").textContent, /提交动作 3 次/);
  } finally { dom.window.close(); }
});

test("replaced DOM nodes, legal fields, default-submit add buttons and deceptive add/submit labels cannot be written or clicked", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><form data-agent-entry><label>毕业学校<input id="school"></label><button id="implicit">添加教育</button><button id="deceptive" type="button">添加并提交</button></form></section><section data-agent-group><h2>有关声明</h2><label>同意声明<input id="legal"></label></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    let observation = runtime.scan(url);
    const school = observation.report.fields.find((field) => field.label.includes("毕业学校"));
    const group = observation.report.groups.find((group) => group.label === "教育经历");
    let clicks = 0;
    for (const button of dom.window.document.querySelectorAll("button")) button.addEventListener("click", () => { clicks += 1; });
    assert.equal((await runtime.add({ token: observation.token, groupId: group.id })).code, "ADD_CONTROL_UNAVAILABLE");
    assert.equal(clicks, 0);
    dom.window.document.getElementById("school").replaceWith(dom.window.document.createElement("input"));
    assert.equal((await runtime.fill({ token: observation.token, fieldId: school.id, value: "虚构院校" })).code, "REAL_FIELD_BINDING_STALE");
    observation = runtime.scan(url);
    const legal = observation.report.fields.find((field) => field.label.includes("同意"));
    assert.equal((await runtime.fill({ token: observation.token, fieldId: legal.id, value: "是" })).code, "MANUAL_ONLY");
    assert.equal(dom.window.document.getElementById("legal").value, "");
  } finally { dom.window.close(); }
});

test("invalid model record is repaired before the first real runtime write", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><form data-agent-entry><label>毕业学校<input id="school"></label></form></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    const ledger = ledgerFromProfile(importProfile(fictional).stored);
    let token, calls = 0;
    const records = [], feedbacks = [];
    const environment = {
      async observe() { const value = runtime.scan(url); token = value.token; return value.report; },
      async add(groupId) { return runtime.add({ token, groupId }); },
      async fill(item) {
        assert.equal(calls, 2, "no page write may happen before the repaired proposal passes validation");
        return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: ledger.getValue(item.sourcePath) });
      },
      async audit(targets) { return runtime.audit({ token, targets }); },
    };
    const run = await runRealForm({ environment, ledger, planner: { async planMappings(context, feedback) {
      calls += 1;
      feedbacks.push(feedback);
      assert.equal(dom.window.document.getElementById("school").value, "");
      const proposal = mapping(context);
      if (calls === 1) proposal.fieldMappings[0].sourcePath = "educations.1.school";
      return proposal;
    } }, onEvent: (event) => records.push(event) });
    assert.equal(calls, 2);
    assert.equal(run.result.modelCalls, 2);
    assert.equal(run.result.agentWrittenFields, 1);
    assert.equal(feedbacks[1].code, "PLAN_RECORD_MISMATCH");
    assert.deepEqual(feedbacks[1].diagnostic.expectedRecords, ["educations.0"]);
    assert.equal(dom.window.document.getElementById("school").value, ledger.getValue("educations.0.school"));
    assert.equal(JSON.stringify({ records, feedbacks }).includes(ledger.getValue("educations.0.school")), false);
  } finally { dom.window.close(); }
});

test("page edits during invalid planning stop repair retries before any action", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><form data-agent-entry><label>毕业学校<input id="school"></label></form></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    const ledger = ledgerFromProfile(importProfile(fictional).stored);
    let calls = 0, actions = 0;
    await assert.rejects(runRealForm({ ledger,
      environment: { async observe() { return runtime.scan(url).report; }, async add() { actions += 1; }, async fill() { actions += 1; } },
      planner: { async planMappings(context) {
        calls += 1;
        dom.window.document.getElementById("school").value = "虚构人工修改";
        const proposal = mapping(context);
        proposal.fieldMappings[0].sourcePath = "educations.1.school";
        return proposal;
      } },
    }), { code: "REAL_PAGE_CHANGED" });
    assert.equal(calls, 1);
    assert.equal(actions, 0);
  } finally { dom.window.close(); }
});

test("three failed model proposals keep the valid phone, leave conflicting language targets empty and retain feedback history", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><form data-agent-entry>
    <label>手机号码<input id="phone"></label><label>英语等级成绩<input id="score"></label>
    <label>其他语言能力及等级/分数<input id="other"></label><label>推荐人<input id="referrer"></label></form></section>`);
  try {
    const input = structuredClone(fictional);
    input.profile.languages[0].testScore = "FICTIONAL_SCORE";
    const ledger = ledgerFromProfile(importProfile(input).stored);
    const runtime = dom.window.__resumeAgentRuntime;
    let token, calls = 0;
    const feedbacks = [], records = [];
    const run = await runRealForm({ ledger, onEvent: (event) => records.push(event),
      environment: {
        async observe() { const observation = runtime.scan(url); token = observation.token; return observation.report; },
        async add() { throw new Error("No missing records"); },
        async fill(item) {
          assert.equal(calls, 3);
          assert.equal(item.sourcePath, "personal.phoneNumber");
          return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: ledger.getValue(item.sourcePath) });
        },
        async audit(targets) { return runtime.audit({ token, targets }); },
      },
      planner: { async planMappings(context, feedback) {
        calls += 1; feedbacks.push(feedback);
        assert.equal(dom.window.document.getElementById("phone").value, "");
        return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [], fieldMappings: context.page.fields.map((field, index) => ({
          fieldId: field.id, sourcePath: index === 0 ? "personal.phoneNumber" : index < 3 ? "languages.0.testScore" : "PRIVATE_UNKNOWN_PATH",
        })) };
      } },
    });
    assert.equal(calls, 3);
    assert.equal(run.status, "partial");
    assert.equal(run.result.agentWrittenFields, 1);
    assert.equal(run.result.discardedMappingCount, 3);
    assert.equal(dom.window.document.getElementById("phone").value, ledger.getValue("personal.phoneNumber"));
    for (const id of ["score", "other", "referrer"]) assert.equal(dom.window.document.getElementById(id).value, "");
    assert.equal(feedbacks[2].diagnostic.violation, "unknown_source");
    assert.ok(feedbacks[2].previousFailures.some((failure) => failure.diagnostic.violation === "source_in_multiple_fields"));
    assert.ok(records.some((event) => event.tool === "partial_plan"));
    assert.equal(JSON.stringify({ records, feedbacks, plan: run.plan }).includes("PRIVATE_UNKNOWN_PATH"), false);
    assert.equal(JSON.stringify({ records, feedbacks, plan: run.plan }).includes("FICTIONAL_SCORE"), false);
  } finally { dom.window.close(); }
});

test("a page change on the final failed proposal invalidates the partial plan before any write", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><form data-agent-entry><label>毕业学校<input id="school"></label></form></section>`);
  try {
    const ledger = ledgerFromProfile(importProfile(fictional).stored);
    const runtime = dom.window.__resumeAgentRuntime;
    let calls = 0, actions = 0;
    await assert.rejects(runRealForm({ ledger,
      environment: { async observe() { return runtime.scan(url).report; }, async add() { actions += 1; }, async fill() { actions += 1; } },
      planner: { async planMappings(context) {
        calls += 1;
        if (calls === 3) dom.window.document.getElementById("school").value = "虚构人工输入";
        const proposal = mapping(context);
        proposal.fieldMappings[0].sourcePath = "educations.1.school";
        return proposal;
      } },
    }), { code: "REAL_PAGE_CHANGED" });
    assert.equal(calls, 3);
    assert.equal(actions, 0);
  } finally { dom.window.close(); }
});

test("final audit withdraws success when a later control erases an earlier verified field", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><form><label>手机号码<input id="phone" type="tel"></label><label>邮箱<input id="email" type="email"></label></form></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    const first = runtime.scan(url);
    assert.equal((await runtime.fill({ token: first.token, fieldId: first.report.fields[0].id, sourcePath: "personal.phoneNumber", value: "13900000000" })).verified, true);
    dom.window.document.getElementById("email").addEventListener("input", () => { dom.window.document.getElementById("phone").value = ""; });
    assert.equal((await runtime.fill({ token: first.token, fieldId: first.report.fields[1].id, sourcePath: "personal.email", value: "fictional@example.test" })).verified, true);
    const after = runtime.scan(url);
    const audited = runtime.audit({ token: after.token, targets: [
      { fieldId: after.report.fields[0].id, sourcePath: "personal.phoneNumber" },
      { fieldId: after.report.fields[1].id, sourcePath: "personal.email" },
    ] });
    assert.equal(audited[0].verified, false);
    assert.equal(audited[0].code, "FINAL_READBACK_MISMATCH");
    assert.equal(audited[1].verified, true);
    assert.equal(JSON.stringify(audited).includes("13900000000"), false);
  } finally { dom.window.close(); }
});

test("autocomplete search text is restored when no option can be committed", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><form><div class="el-form-item"><label>毕业学校</label><div class="el-autocomplete"><input id="school" aria-controls="school-list"></div></div></form><ul id="school-list" role="listbox"><li role="option">不同的虚构学校</li></ul></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    const observation = runtime.scan(url);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id, value: "希望选择的虚构学校" });
    assert.equal(outcome.code, "OPTION_UNAVAILABLE");
    assert.equal(outcome.verified, false);
    assert.equal(dom.window.document.getElementById("school").value, "");
    assert.equal(Object.hasOwn(outcome, "value"), false);
  } finally { dom.window.close(); }
});

test("a month-only source cannot invent a day for a full date field", async () => {
  const dom = fixture(`<section data-agent-group><h2>教育经历</h2><label>毕业日期<input type="date"></label></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime;
    const observation = runtime.scan(url);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id, value: "2026-06" });
    assert.equal(outcome.code, "DATE_FORMAT_UNSUPPORTED");
    assert.equal(dom.window.document.querySelector("input").value, "");
  } finally { dom.window.close(); }
});

test("confirmed experience precision is completed to day 1, without completing a birth date", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><label>出生日期<input type="date" id="birth"></label></section>
    <section data-agent-group><h2>教育经历</h2><label>毕业日期<input type="date" id="end"></label></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, observation = runtime.scan(url);
    const birth = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "personal.birthDate", value: "2001-06", monthStartDay: true });
    assert.equal(birth.code, "DATE_FORMAT_UNSUPPORTED");
    const end = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[1].id,
      sourcePath: "educations.0.endDate", value: "2026-06", monthStartDay: true });
    assert.equal(end.verified, true); assert.equal(end.completedDay, true);
    assert.equal(dom.window.document.getElementById("end").value, "2026-06-01");
    assert.equal(dom.window.document.getElementById("birth").value, "");
  } finally { dom.window.close(); }
});

test("observed Phoenix calendar commits through its local date input; popup fields are excluded and exact displayed dates are audited", async () => {
  const dom = fixture(`<div><div id="title">教育经历</div><div><div class="ux-standard-form">
    <div class="form-item--phoenix"><div class="form-item__title"><label>开始时间</label></div><div class="phoenix-select"><ul class="phoenix-select__content"><li id="display"></li><li><input id="primary"></li></ul></div></div>
    </div></div></div><div id="picker" class="phoenix-date-picker__wrap" hidden><div class="phoenix-calendar"><input class="phoenix-calendar-input"></div></div>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document;
    const picker = document.getElementById("picker"), input = picker.querySelector("input");
    document.getElementById("primary").addEventListener("click", () => { picker.hidden = false; });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { document.getElementById("display").textContent = input.value; picker.hidden = true; } });
    const observation = runtime.scan(url);
    assert.equal(observation.report.fields[0].kind, "date");
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "educations.0.startDate", value: "2022-09", monthStartDay: true });
    assert.equal(outcome.verified, true); assert.equal(outcome.completedDay, true);
    assert.equal(document.getElementById("display").textContent, "2022-09-01");
    picker.hidden = false;
    const after = runtime.scan(url);
    assert.equal(after.report.fields.length, 1);
    assert.equal(runtime.audit({ token: after.token, targets: [{ fieldId: after.report.fields[0].id, sourcePath: "educations.0.startDate" }] })[0].verified, true);
  } finally { dom.window.close(); }
});

test("observed Phoenix month calendar navigates the year, selects the exact month and preserves month precision", async () => {
  const dom = fixture(`<div><div id="title">在校职务</div><div class="ux-standard-form"><div class="form-item--phoenix"><div class="form-item__title"><label>开始时间</label></div>
    <div class="phoenix-select"><ul class="phoenix-select__content"><li id="display"></li><li><input id="primary"></li></ul></div></div></div></div>
    <div id="picker" class="phoenix-date-picker__wrap" hidden><div class="phoenix-calendar phoenix-calendar-month-calendar"><div class="phoenix-calendar-month-panel">
    <a class="phoenix-calendar-prev-year-btn"></a><a class="phoenix-calendar-year-select">2026年</a><a class="phoenix-calendar-next-year-btn"></a>
    <a class="phoenix-calendar-month-panel-year-select">选择年份</a>
    ${Array.from({ length: 12 }, (_, i) => `<a class="phoenix-calendar-month-panel-month">${i + 1}月</a>`).join("")}</div></div></div>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document, picker = document.getElementById("picker");
    const year = picker.querySelector(".phoenix-calendar-year-select");
    document.getElementById("primary").addEventListener("click", () => { picker.hidden = false; });
    picker.querySelector(".phoenix-calendar-prev-year-btn").addEventListener("click", () => { year.textContent = `${Number(year.textContent.replace("年", "")) - 1}年`; });
    picker.querySelector(".phoenix-calendar-next-year-btn").addEventListener("click", () => { year.textContent = `${Number(year.textContent.replace("年", "")) + 1}年`; });
    for (const month of picker.querySelectorAll(".phoenix-calendar-month-panel-month")) month.addEventListener("click", () => {
      document.getElementById("display").textContent = `${year.textContent.replace("年", "")}-${String(Number(month.textContent.replace("月", ""))).padStart(2, "0")}`;
      picker.hidden = true;
    });
    const observation = runtime.scan(url);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "campusExperiences.0.startDate", value: "2022-09", monthStartDay: true });
    assert.equal(outcome.verified, true); assert.equal(outcome.diagnostic.yearSteps, 4);
    assert.equal(outcome.diagnostic.targetPrecision, "month"); assert.equal(outcome.completedDay, undefined);
    assert.equal(document.getElementById("display").textContent, "2022-09");
    assert.equal(picker.hidden, true);
    assert.equal(runtime.audit({ token: observation.token, targets: [{ fieldId: observation.report.fields[0].id, sourcePath: "campusExperiences.0.startDate" }] })[0].verified, true);
  } finally { dom.window.close(); }
});

test("an observed non-native Phoenix add increases exactly one record, while non-observed and deceptive controls remain unavailable", async () => {
  const dom = fixture(`<div><div id="title">教育经历</div><div id="records"><div class="ux-standard-form"><div class="form-item--phoenix"><label>学校名称</label><input></div></div></div>
    <div id="add"><svg></svg><span>添加 教育经历</span></div><div id="bad"><svg></svg><span>添加并提交</span></div></div>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document;
    let badClicks = 0;
    document.getElementById("bad").addEventListener("click", () => { badClicks += 1; });
    document.getElementById("add").addEventListener("click", () => { document.getElementById("records").append(document.querySelector(".ux-standard-form").cloneNode(true)); });
    const observation = runtime.scan(url);
    const outcome = await runtime.add({ token: observation.token, groupId: observation.report.groups[0].id });
    assert.equal(outcome.verified, true); assert.equal(outcome.entryCount, 2);
    assert.equal(badClicks, 0);
  } finally { dom.window.close(); }
});

test("observed Phoenix radio selects and audits the school career website, preserves selected answers, and keeps consent manual", async () => {
  const question = "请问您是通过以下哪种渠道了解到此次招聘信息，并投递简历的？";
  const choices = (labels) => `<div class="phoenix-radio-group">${labels.map((label) => `<div class="phoenix-radio-group__radioItem"><div class="phoenix-radio"><div class="phoenix-radio__wrapper"><div class="phoenix-radio__circle-wrapper"></div><span class="phoenix-radio__radio-text">${label}</span></div></div></div>`).join("")}</div>`;
  const dom = fixture(`<div><div id="title">附加问题</div><div class="ux-standard-form">
    <div class="form-item--phoenix"><div class="form-item__title"><label>${question}</label></div>${choices(["BOE官网/BOE招聘官方微信公众号", "学校就业信息网/学校Career Center"])}</div>
    <div class="form-item--phoenix"><div class="form-item__title"><label>同意声明</label></div>${choices(["同意", "不同意"])}</div></div></div>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document;
    for (const wrapper of document.querySelectorAll(".phoenix-radio__wrapper")) wrapper.addEventListener("click", () => {
      for (const choice of wrapper.closest(".phoenix-radio-group").querySelectorAll(".phoenix-radio")) {
        choice.classList.toggle("phoenix-radio--checked", choice === wrapper.parentElement);
        choice.querySelector(".phoenix-radio__circle-wrapper").classList.toggle("phoenix-radio__circle-wrapper--checked", choice === wrapper.parentElement);
      }
    });
    const observation = runtime.scan(url);
    assert.equal(observation.report.fields.length, 2);
    assert.equal(observation.report.fields[0].label, question);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "jobPreferences.discoveryChannel", value: "学校就业网" });
    assert.equal(outcome.verified, true); assert.equal(outcome.optionCount, 2);
    assert.equal(document.querySelector(".phoenix-radio--checked .phoenix-radio__radio-text").textContent, "学校就业信息网/学校Career Center");
    assert.equal((await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "jobPreferences.discoveryChannel", value: "BOE官网", fillMode: "empty" })).code, "PROTECTED");
    assert.equal((await runtime.fill({ token: observation.token, fieldId: observation.report.fields[1].id, value: "同意" })).code, "MANUAL_ONLY");
    assert.equal(runtime.audit({ token: observation.token, targets: [{ fieldId: observation.report.fields[0].id, sourcePath: "jobPreferences.discoveryChannel" }] })[0].verified, true);
  } finally { dom.window.close(); }
});

test("Phoenix commits the displayed label, protects existing choices, and refuses unrecognized add and calendar controls", async () => {
  const dom = fixture(`<div><div id="edu-title">教育经历</div><div><div class="ux-standard-form">
    <div class="form-item--phoenix"><div class="form-item__title"><label class="form-item__text">学历</label></div><div class="form-item__control"><div class="phoenix-select"><ul class="phoenix-select__content"><li id="selection"></li><li><input id="degree"></li></ul></div></div></div>
    <div class="form-item--phoenix"><div class="form-item__title"><label>开始时间</label></div><div class="phoenix-date-picker"><input id="date"></div></div>
    </div><div id="add"><span>添加</span></div></div></div><div id="options" class="phoenix-selectList" hidden><li class="phoenix-selectList__listItem">硕士研究生</li></div>`);
  try {
    const document = dom.window.document, runtime = dom.window.__resumeAgentRuntime;
    const degree = document.getElementById("degree"), panel = document.getElementById("options");
    degree.addEventListener("click", () => { panel.hidden = false; });
    panel.querySelector("li").addEventListener("click", () => { document.getElementById("selection").textContent = "硕士研究生"; degree.value = ""; panel.hidden = true; });
    let nonNativeClicks = 0;
    document.getElementById("add").addEventListener("click", () => { nonNativeClicks += 1; });
    const observation = runtime.scan(url);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id, sourcePath: "educations.0.degree", value: "硕士" });
    assert.equal(outcome.verified, true);
    assert.equal(degree.value, "", "a query is not the committed label");
    assert.equal(panel.hidden, true);
    assert.equal((await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id, value: "本科", fillMode: "empty" })).code, "PROTECTED");
    assert.equal((await runtime.fill({ token: observation.token, fieldId: observation.report.fields[1].id, value: "2026-06-01" })).code, "CONTROL_UNSUPPORTED");
    assert.equal((await runtime.add({ token: observation.token, groupId: observation.report.groups[0].id })).code, "ADD_CONTROL_UNAVAILABLE");
    assert.equal(nonNativeClicks, 0);
    const after = runtime.scan(url);
    assert.equal(runtime.audit({ token: after.token, targets: [{ fieldId: after.report.fields[0].id, sourcePath: "educations.0.degree" }] })[0].verified, true);
  } finally { dom.window.close(); }
});

test("Agent observation, filling and cleanup leave page APIs and user requests unchanged", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><form><label>邮箱<input></label><button type="submit">提交简历</button></form></section>`);
  try {
    let submissions = 0, requests = 0, beacons = 0, xhrs = 0;
    const page = dom.window;
    page.fetch = async () => { requests += 1; return { ok: true }; };
    page.navigator.sendBeacon = () => { beacons++; return true; };
    page.XMLHttpRequest.prototype.open = () => {};
    page.XMLHttpRequest.prototype.send = () => { xhrs++; };
    page.document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); submissions++; });
    const apiNames = [() => page.fetch, () => page.open, () => page.navigator.sendBeacon,
      () => page.XMLHttpRequest.prototype.open, () => page.XMLHttpRequest.prototype.send,
      () => page.HTMLFormElement.prototype.submit, () => page.HTMLFormElement.prototype.requestSubmit];
    const originals = apiNames.map((get) => get());
    const runtime = page.__resumeAgentRuntime, observation = runtime.scan(url);
    assert.equal((await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "personal.email", value: "fictional@example.test" })).verified, true);
    assert.equal(submissions, 0, "Agent never clicked the real submit control");
    assert.deepEqual(apiNames.map((get) => get()), originals);
    page.document.querySelector("button").click();
    assert.equal(submissions, 1, "manual action is usable before runtime cleanup");
    await page.fetch("https://example.test/dictionary");
    await page.fetch("https://example.test/autosave", { method: "POST", body: "{}" });
    const xhr = new page.XMLHttpRequest(); xhr.open("POST", "https://example.test/user-action"); xhr.send("{}");
    assert.equal(page.navigator.sendBeacon("https://example.test/telemetry", "{}"), true);
    assert.equal(requests, 2); assert.equal(xhrs, 1); assert.equal(beacons, 1);
    runtime.clear();
    assert.deepEqual(apiNames.map((get) => get()), originals);
    assert.equal(page.document.querySelector("input").value, "fictional@example.test");
    page.document.querySelector("form").requestSubmit();
    assert.equal(submissions, 2);
  } finally { dom.window.close(); }
});

test("one scoped native-edit recovery keeps a lost identity field and never overwrites a user's later edit", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><label>证件号码<input id="identity" type="text"></label><label>邮箱<input id="email"></label></section>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document, identity = document.getElementById("identity");
    let componentValue = "", nativeEdits = 0;
    identity.addEventListener("input", (event) => { if (event.inputType === "insertText") componentValue = identity.value; });
    document.getElementById("email").addEventListener("input", () => { identity.value = componentValue; });
    document.execCommand = (command, _ui, value) => {
      assert.equal(command, "insertText"); assert.equal(document.activeElement, identity);
      nativeEdits += 1; identity.value = value;
      identity.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return true;
    };
    const ledger = ledgerFromProfile(importProfile({ profile: { personal: { email: "fictional@example.test" },
      identityAndAuthorization: { personalIdNumber: "FICTIONAL_ID_A" } } }).stored);
    const events = []; let token;
    const environment = {
      async observe() { const observation = runtime.scan(url); token = observation.token; return observation.report; },
      async fill(item, profile) { return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: profile.getValue(item.sourcePath) }); },
      async retryFill(item, profile) { return runtime.fill({ token, fieldId: item.fieldId, sourcePath: item.sourcePath, value: profile.getValue(item.sourcePath), browserEditRetry: true }); },
      async audit(targets) { return runtime.audit({ token, targets }); },
    };
    const run = await runRealForm({ ledger, environment, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) { return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
        fieldMappings: [{ fieldId: "field-1", sourcePath: "identityAndAuthorization.personalIdNumber" }, { fieldId: "field-2", sourcePath: "personal.email" }] }; },
    } });
    assert.equal(nativeEdits, 1); assert.equal(run.result.agentWrittenFields, 2);
    assert.equal(run.outcomes[0].recoveredFrom, "LATER_READBACK_MISMATCH");
    assert.equal(identity.value, "FICTIONAL_ID_A");
    assert.ok(events.some((event) => event.code === "LATER_READBACK_MISMATCH"));
    assert.equal(JSON.stringify(events).includes("FICTIONAL_ID_A"), false);
    identity.value = "虚构用户后来修改";
    assert.equal((await runtime.fill({ token, fieldId: "field-1", sourcePath: "identityAndAuthorization.personalIdNumber", value: "FICTIONAL_ID_A", browserEditRetry: true, fillMode: "empty" })).code, "PROTECTED");
    assert.equal(nativeEdits, 1); assert.equal(identity.value, "虚构用户后来修改");
  } finally { dom.window.close(); }
});

test("graduation month selects a numeric month label and ignores empty stale popup containers", async () => {
  const dom = fixture(`<section data-agent-group><h2>基本信息</h2><div class="el-form-item"><label>毕业时间（月）</label><div class="el-select"><input id="month"></div></div></section>
    <div role="listbox"></div><ul id="months" role="listbox" hidden>${Array.from({ length: 12 }, (_, i) => `<li role="option">${i + 1}月</li>`).join("")}</ul>`);
  try {
    const runtime = dom.window.__resumeAgentRuntime, document = dom.window.document;
    const input = document.getElementById("month"), panel = document.getElementById("months");
    input.addEventListener("click", () => { panel.hidden = false; });
    for (const option of panel.querySelectorAll("li")) option.addEventListener("click", () => { input.value = option.textContent; panel.hidden = true; });
    const observation = runtime.scan(url);
    const outcome = await runtime.fill({ token: observation.token, fieldId: observation.report.fields[0].id,
      sourcePath: "formAnswers.graduationMonth", value: "6" });
    assert.equal(outcome.verified, true); assert.equal(input.value, "6月"); assert.equal(panel.hidden, true);
  } finally { dom.window.close(); }
});

test("basic information from several source objects shares one page record and stop aborts before any write", async () => {
  const dom = fixture();
  try {
    const report = dom.window.__resumeAgentRuntime.scan(url).report;
    const ledger = ledgerFromProfile(importProfile(fictional).stored);
    const context = await createPlanContext(report, ledger);
    assert.equal(context.profileKind, "synthetic");
    const plan = await buildFillPlan(context, mapping(context));
    const basic = plan.sections.find((section) => section.label === "基本信息");
    assert.equal(basic.profileEntries, 1);
    assert.equal(basic.additionalEntries, 0);
    let stopped = false, writes = 0;
    await assert.rejects(runRealForm({ ledger,
      environment: { async observe() { return report; }, async fill() { writes += 1; } },
      planner: { async planMappings(value) { stopped = true; return mapping(value); } }, shouldStop: () => stopped,
    }), /USER_STOPPED/);
    assert.equal(writes, 0);
  } finally { dom.window.close(); }
});
