import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan, sourceClaimCompatible } from "../src/core/fill-plan.js";
import { resolveAwardChoice } from "../src/core/award-levels.js";
import { fieldMappingCompatible } from "../src/core/field-semantics.js";
import { runRealForm } from "../src/core/real-runner.js";
import { executionDiagnostic } from "../src/core/execution-diagnostics.js";
import { monthlySalaryChoice } from "../src/core/salary-choices.js";

test("ethnicity never uses the ambiguous legacy nationality path and keeps explicit ethnicity sources", () => {
  for (const label of ["民族", "族别", "Ethnic group"]) {
    assert.equal(fieldMappingCompatible({ label }, { path: "personal.nationality" }), false);
    assert.equal(fieldMappingCompatible({ label }, { path: "formAnswers.ethnicity" }), true);
    assert.equal(fieldMappingCompatible({ label }, { path: "personal.ethnicity" }), true);
  }
});

test("complete Phoenix calendars keep full date semantics even when their input placeholder says year", async () => {
  const dom = new JSDOM(`<section><h2>教育经历</h2><div class="ux-standard-form">
    <div class="form-item--phoenix"><label>开始时间</label><div class="phoenix-select"><input placeholder="年"></div></div></div></section>
    <section><h2>获奖经历</h2><div class="ux-standard-form">
    <div class="form-item--phoenix"><label>奖项</label><input></div>
    <div class="form-item--phoenix"><label>获奖时间</label><div class="phoenix-select"><input placeholder="年"></div></div></div></section>
    <section><h2>基本信息</h2><div class="ux-standard-form"><div class="form-item--phoenix"><label>毕业时间（年）</label><div class="phoenix-select"><input placeholder="年"></div></div></div></section>`,
    { url: "https://another-employer.example.test/form", runScripts: "outside-only" });
  try {
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
    dom.window.crypto.randomUUID = randomUUID;
    const report = dom.window.eval(`(${readFormStructure.toString()})(location.href)`);
    for (const label of ["开始时间", "获奖时间"]) {
      const field = report.fields.find((item) => item.label === label);
      assert.equal(field.kind, "date"); assert.equal(field.datePart, undefined);
    }
    assert.equal(report.fields.find((field) => field.label.includes("毕业时间")).datePart, "year");
    const ledger = ledgerFromProfile(importProfile({ profile: { educations: [{ startDate: "2020-09" }],
      awardRecords: { version: 1, awards: [{ name: "虚构奖项", date: "2023-06", scope: "国家级" }], competitions: [] } } }).stored);
    const context = await createPlanContext(report, ledger);
    const start = report.fields.find((field) => field.label === "开始时间"), date = report.fields.find((field) => field.label === "获奖时间");
    for (const [field, sourcePath] of [[start, "educations.0.startDateYear"], [date, "awards.0.level"]]) {
      await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [],
        fieldMappings: [{ fieldId: field.id, sourcePath }], unresolved: [] }), { code: "PLAN_SEMANTIC_MISMATCH" });
    }
    const plan = await buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [],
      fieldMappings: [{ fieldId: date.id, sourcePath: "awards.0.date", semanticRole: "date" },
        { fieldId: report.fields.find((field) => field.label === "奖项").id, sourcePath: "awards.0.name", semanticRole: "name" }], unresolved: [] });
    assert.equal(plan.items.filter((item) => item.sourcePath).length, 2);
  } finally { dom.window.close(); }
});

test("observed combined award tiers contain precise profile scopes without changing the source or guessing rank", () => {
  const el = { disabled: false, getAttribute: () => null, matches: () => false };
  const options = ["院校级", "县市级", "省区级", "国家级", "国际级", "公司级"].map((text) => ({ text, el }));
  for (const [scope, target] of [["校级", "院校级"], ["院级", "院校级"], ["省级", "省区级"], ["市级", "县市级"], ["国家级", "国家级"]]) {
    assert.equal(resolveAwardChoice(options, "awards.0.scope", scope).picked.text, target);
  }
  const specific = [...options, { text: "校级", el }];
  assert.equal(resolveAwardChoice(specific, "awards.0.scope", "校级").picked.text, "校级");
  assert.equal(resolveAwardChoice([...options, { text: "院校级", el }], "awards.0.scope", "校级").code, "AWARD_OPTION_AMBIGUOUS");
  assert.equal(resolveAwardChoice(options, "awards.0.rank", "一等奖").code, "AWARD_OPTION_UNAVAILABLE");
});

test("new profile fields roundtrip, award dates project only known units, and custom answers stay private and question-specific", () => {
  const profile = { personal: { colorVision: "无色盲色弱", overseasGraduation: "否" },
    jobPreferences: { expectedSalary: "24万元/年", secondChoiceCity: "虚构市乙", interviewLocations: "虚构市甲" },
    projects: [{ name: "虚构项目", responsibilities: "PRIVATE_FICTIONAL_CONTRIBUTION" }],
    papers: [{ title: "虚构论文", publicationDate: "2025-02", journal: "虚构期刊" }],
    customAnswers: [{ question: "请问你曾听说过哪些公司的校招活动？", answer: "PRIVATE_FICTIONAL_ANSWER" }, { question: "", answer: "UNBOUND_ANSWER" }],
    awardRecords: { version: 1, awards: [{ name: "虚构奖项", date: "2023-06" }], competitions: [] } };
  const stored = importProfile({ profile }).stored, ledger = ledgerFromProfile(stored);
  assert.equal(ledger.getValue("awards.0.date"), "2023-06");
  assert.equal(ledger.getValue("awards.0.dateYear"), "2023");
  assert.equal(ledger.getValue("awards.0.dateMonth"), "6");
  assert.equal(ledger.hasPath("awards.0.dateDay"), false);
  assert.equal(ledger.getValue("formAnswers.expectedMonthlySalary"), "20000");
  assert.equal(ledger.getValue("papers.0.publicationDateMonth"), "2");
  assert.equal(ledger.getValue("projects.0.responsibilities"), "PRIVATE_FICTIONAL_CONTRIBUTION");
  const answer = ledger.publicFacts.find((fact) => fact.path === "formAnswers.customAnswer0");
  assert.equal(ledger.getValue(answer.path), "PRIVATE_FICTIONAL_ANSWER");
  assert.equal(ledger.hasPath("formAnswers.customAnswer1"), false);
  assert.equal(fieldMappingCompatible({ label: profile.customAnswers[0].question }, answer), true);
  assert.equal(fieldMappingCompatible({ label: "请问你曾参加过哪些公司的校招活动？" }, answer), false);
  assert.equal(JSON.stringify(ledger.publicFacts).includes("PRIVATE_FICTIONAL"), false);
  assert.equal(JSON.stringify(importProfile({ profile: stored.profile }).stored.profile), JSON.stringify(stored.profile));
  assert.equal(ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "20000" } } }).stored).hasPath("formAnswers.expectedMonthlySalary"), false);
  assert.equal(ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "20w" } } }).stored).hasPath("formAnswers.expectedMonthlySalary"), false);
  assert.equal(ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "20w", expectedSalaryPeriod: "年薪" } } }).stored).getValue("formAnswers.expectedMonthlySalary"), "16666.67");
  assert.equal(ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "18k/月" } } }).stored).getValue("formAnswers.expectedMonthlySalary"), "18000");
  assert.equal(ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "24万元/年", expectedMonthlySalary: "15k～20k" } } }).stored).getValue("formAnswers.expectedMonthlySalary"), "15k～20k");
  const monthlyOnly = importProfile({ profile: { jobPreferences: { expectedMonthlySalary: "15k～20k" } } }).stored.profile;
  assert.equal(monthlyOnly.jobPreferences.expectedSalary, "");
  assert.equal(monthlyOnly.jobPreferences.expectedMonthlySalary, "15k～20k");
  assert.equal(fieldMappingCompatible({ label: "第二志愿城市" }, { path: "jobPreferences.expectedCity" }), false);
  assert.equal(fieldMappingCompatible({ label: "生源地" }, { path: "formAnswers.hometown" }), false);
  assert.equal(fieldMappingCompatible({ label: "籍贯" }, { path: "contactAndLocation.hukouLocation" }), false);
  assert.equal(fieldMappingCompatible({ label: "籍贯" }, { path: "formAnswers.hometown" }), true);
  assert.equal(fieldMappingCompatible({ label: "籍贯", kind: "text" }, { path: "contactAndLocation.hometownCity" }), true);
  assert.equal(fieldMappingCompatible({ label: "籍贯", kind: "custom-select" }, { path: "contactAndLocation.hometownCity" }), false);
  for (const label of ["工作经验", "工作年限", "Years of work experience"]) {
    assert.equal(fieldMappingCompatible({ label, kind: "custom-select" }, { path: "formAnswers.internshipsLatestEndDate" }), false);
    assert.equal(fieldMappingCompatible({ label, kind: "custom-select" }, { path: "personal.yearsOfExperience" }), true);
  }
});

test("one unsupported control cannot consume the write budget while five award records are added and filled", async () => {
  const ledger = ledgerFromProfile(importProfile({ profile: { personal: { currentCity: "虚构市" },
    awardRecords: { version: 1, awards: Array.from({ length: 5 }, (_, i) => ({ name: `虚构奖项${i}` })), competitions: [] } } }).stored);
  let records = 1, failedAttempts = 0;
  const written = new Set(), events = [];
  const observe = () => ({ schemaVersion: 1, mode: "read-only", url: "https://fictional.example.test/form", origin: "https://fictional.example.test",
    summary: { fieldCount: records + 1, groupCount: 2, truncated: false }, controls: [{ id: "control-1", groupId: "group-2", intent: "add-candidate" }],
    groups: [{ id: "group-1", label: "基本信息", source: "semantic", entryCount: 1 }, { id: "group-2", label: "获奖经历", source: "semantic", entryCount: records }],
    fields: [{ id: "field-1", groupId: "group-1", entryIndex: 0, label: "所在地", kind: "select" },
      ...Array.from({ length: records }, (_, i) => ({ id: `field-${i + 2}`, groupId: "group-2", entryIndex: i, label: "奖项名称", kind: "text" }))]
      .map((field) => ({ ...field, labelSource: "label", required: false, disabled: false, readOnly: false, valueExcluded: false, hasValue: written.has(field.id) })) });
  const result = await runRealForm({ ledger, maxWrites: 7, onEvent: (event) => events.push(event), environment: {
    async observe() { return observe(); }, async add() { records += 1; return { code: "VERIFIED", verified: true }; },
    async fill(item) { if (item.fieldId === "field-1") { failedAttempts++; return { code: "OPTION_UNAVAILABLE", verified: false }; }
      written.add(item.fieldId); return { code: "VERIFIED", verified: true }; },
  }, planner: { async planMappings(context) { return { snapshotId: context.snapshotId,
    groupMappings: [{ groupId: "group-1", sectionKeys: ["personal"] }, { groupId: "group-2", sectionKeys: ["awards"] }],
    fieldMappings: context.page.fields.filter((field) => !field.hasValue).map((field) => ({ fieldId: field.id,
      sourcePath: field.id === "field-1" ? "personal.currentCity" : `awards.${field.entryIndex}.name` })), unresolved: [] }; } } });
  assert.equal(failedAttempts, 2); assert.equal(records, 5);
  assert.equal(result.result.agentWrittenFields, 5); assert.equal(result.result.pendingEntries, 0);
  assert.equal(result.result.writeLimitReached, false); assert.equal(result.result.unresolvedCount, 1);
  assert.equal(events.filter((event) => event.code === "CONTROL_RETRY_LIMIT").length, 1);
});

test("local execution diagnostics preserve actionable control states and discard raw values, option labels and extra attributes", () => {
  const event = executionDiagnostic({ phase: "核验", tool: "fill_field", code: "PICKER_NOT_COMMITTED", fieldId: "field-3",
    diagnostic: { adapter: "beisen_area_picker", phase: "commit", panelClosed: true, valueMatched: false, selectedCount: 1,
      actualValue: "PRIVATE_FICTIONAL_VALUE", options: ["PRIVATE_OPTION"], arbitrary: "PRIVATE" } });
  assert.equal(event.diagnostic.panelClosed, true); assert.equal(event.diagnostic.selectedCount, 1);
  assert.equal(JSON.stringify(event).includes("PRIVATE"), false);
});

test("salary intervals normalize public option typography and units, while overlaps require review", () => {
  const choices = (labels) => labels.map((text) => ({ text, el: { disabled: false, getAttribute: () => null } }));
  const observed = choices(["5000－10000", "10000－15000", "15000－20000", "20000－25000", "25000－30000", "30000以上"]);
  assert.equal(monthlySalaryChoice(observed, "18000").picked.text, "15000－20000");
  assert.equal(monthlySalaryChoice(observed, "32000").picked.text, "30000以上");
  assert.equal(monthlySalaryChoice(observed, "20000").ambiguous, true);
  assert.equal(monthlySalaryChoice(choices(["１０～１５Ｋ元/月", "15至20千元/月"]), "18000").picked.text, "15至20千元/月");
  assert.equal(monthlySalaryChoice(choices(["面议", "高薪"]), "18000").picked, null);
  assert.equal(monthlySalaryChoice(observed, "18k").picked.text, "15000－20000");
  assert.equal(monthlySalaryChoice(observed, "15k～20k").picked.text, "15000－20000");
  assert.equal(monthlySalaryChoice(observed, "12k～18k").picked, null);
});

test("degree level and individual publication properties reject unrelated available facts", () => {
  const fact = (path) => ({ path });
  assert.equal(fieldMappingCompatible({ label: "学历" }, fact("educations.0.educationType")), false);
  assert.equal(fieldMappingCompatible({ label: "学历" }, fact("educations.0.degree")), true);
  assert.equal(fieldMappingCompatible({ label: "最高学历" }, fact("personal.highestEducationLevel")), true);
  assert.equal(fieldMappingCompatible({ label: "学习形式" }, fact("educations.0.degree")), false);
  assert.equal(fieldMappingCompatible({ label: "学习形式" }, fact("educations.0.studyMode")), true);
  assert.equal(fieldMappingCompatible({ label: "学习形式" }, fact("educations.0.educationType")), false);
  for (const bad of ["additional.publications", "formAnswers.graduationYear", "awards.0.name"]) {
    assert.equal(fieldMappingCompatible({ label: "名称" }, fact(bad), "论文/专著"), false);
  }
  assert.equal(fieldMappingCompatible({ label: "名称" }, fact("papers.0.title"), "论文/专著"), true);
  assert.equal(fieldMappingCompatible({ label: "发布时间", kind: "date" }, fact("papers.0.publicationDate"), "论文/专著"), true);
  assert.equal(fieldMappingCompatible({ label: "研究方向或课题描述" }, fact("educations.0.school")), false);
  assert.equal(fieldMappingCompatible({ label: "研究方向或课题描述" }, fact("educations.0.researchDirection")), true);
  assert.equal(fieldMappingCompatible({ label: "其他语言能力及等级/分数" }, fact("languages.0.testScore")), false);
  assert.equal(fieldMappingCompatible({ label: "其他语言能力及等级/分数" }, fact("formAnswers.otherLanguages")), true);
  const languages = ledgerFromProfile(importProfile({ profile: { languages: [{ name: "英语", proficiency: "流利" }, { name: "法语", proficiency: "基础" }] } }).stored);
  assert.equal(languages.getValue("formAnswers.otherLanguages"), "法语；掌握程度：基础");
  assert.equal(ledgerFromProfile(importProfile({ profile: { languages: [{ name: "英语", proficiency: "良好" }] } }).stored).hasPath("formAnswers.otherLanguages"), false);
});

test("verified sources remain reserved across plan rounds, while an ordinary repeated question in another group remains legal", async () => {
  const ledger = ledgerFromProfile(importProfile({ profile: { educations: [{ school: "虚构大学", degree: "本科" }], jobPreferences: { expectedCity: "虚构市" } } }).stored);
  const field = (id, groupId, label, hasValue = false) => ({ id, groupId, entryIndex: 0, label, labelSource: "label", kind: "text",
    required: false, disabled: false, readOnly: false, hasValue, valueExcluded: false });
  const report = { mode: "read-only", origin: "https://fictional.example.test", summary: { truncated: false }, controls: [],
    groups: [{ id: "group-1", label: "教育经历", entryCount: 1 }, { id: "group-2", label: "申请意向", entryCount: 1 }, { id: "group-3", label: "附加问题", entryCount: 1 }],
    fields: [field("field-1", "group-1", "学校名称", true), field("field-2", "group-1", "补充条目"),
      field("field-3", "group-2", "期望城市", true), field("field-4", "group-3", "期望城市")] };
  const context = await createPlanContext(report, ledger, { verifiedMappings: [{ fieldId: "field-1", sourcePath: "educations.0.school" }, { fieldId: "field-3", sourcePath: "jobPreferences.expectedCity" }] });
  const school = context.profileCatalog.find((fact) => fact.path === "educations.0.school");
  assert.equal(sourceClaimCompatible(context, context.page.fields[1], school), false);
  await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
    fieldMappings: [{ fieldId: "field-2", sourcePath: "educations.0.school" }] }), { code: "PLAN_DUPLICATE_REFERENCE" });
  const plan = await buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
    fieldMappings: [{ fieldId: "field-4", sourcePath: "jobPreferences.expectedCity" }] });
  assert.equal(plan.items.find((item) => item.fieldId === "field-4").sourcePath, "jobPreferences.expectedCity");
  assert.equal(JSON.stringify(context).includes("虚构大学"), false);
  const masked = await createPlanContext({ ...report, fields: report.fields.map((item) => item.id === "field-1"
    ? { ...item, hasValue: null, valueExcluded: true } : item) }, ledger,
    { verifiedMappings: [{ fieldId: "field-1", sourcePath: "educations.0.school" }] });
  const maskedPlan = await buildFillPlan(masked, { snapshotId: masked.snapshotId, groupMappings: [], fieldMappings: [], unresolved: [] });
  assert.equal(maskedPlan.items.find((item) => item.fieldId === "field-1").status, "protected");
});

test("a cold page waits for form appearance before planning, and an empty page never reports a successful no-op", async () => {
  const ledger = ledgerFromProfile(importProfile({ profile: { personal: { email: "fictional@example.test" } } }).stored);
  let ready = false, waits = 0, calls = 0;
  const events = [];
  const report = () => ({ mode: "read-only", url: "https://fictional.example.test/form", origin: "https://fictional.example.test",
    summary: { fieldCount: ready ? 1 : 0, groupCount: ready ? 1 : 0, truncated: false }, controls: [],
    groups: ready ? [{ id: "group-1", label: "基本信息", entryCount: 1 }] : [],
    fields: ready ? [{ id: "field-1", groupId: "group-1", entryIndex: 0, label: "邮箱", labelSource: "label", kind: "text",
      required: false, disabled: false, readOnly: false, valueExcluded: false, hasValue: false }] : [] });
  const planner = { async planMappings(context) { calls++; assert.equal(ready, true);
    return { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [{ fieldId: "field-1", sourcePath: "personal.email" }], unresolved: [] }; } };
  const environment = { async observe() { return report(); }, async waitForForm({ timeoutMs, shouldStop }) {
    assert.equal(calls, 0); assert.equal(timeoutMs, 10_000); assert.equal(shouldStop(), false); waits++; ready = true; return true;
  }, async fill() { return { code: "VERIFIED", verified: true }; } };
  const run = await runRealForm({ environment, planner, ledger, onEvent: (event) => events.push(event) });
  assert.equal(waits, 1); assert.equal(run.result.agentWrittenFields, 1);
  assert.deepEqual(events.filter((event) => event.tool === "form_wait").map((event) => event.code), ["FORM_WAIT_STARTED", "FORM_READY"]);
  ready = false; calls = 0;
  environment.waitForForm = async () => false;
  await assert.rejects(runRealForm({ environment, planner, ledger }), { code: "FORM_NOT_READY" });
  assert.equal(calls, 0);
});
