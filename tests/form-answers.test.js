import test from "node:test";
import assert from "node:assert/strict";
import { createProfileLedger } from "../src/core/profile-ledger.js";
import { withFormAnswers } from "../src/core/form-answers.js";
import { createPlanContext, buildFillPlan, createPartialProposal } from "../src/core/fill-plan.js";

function ledger(values) {
  return withFormAnswers(createProfileLedger({ schemaVersion: 1,
    sources: [{ id: "confirmed", kind: "user_confirmation" }],
    facts: Object.entries(values).map(([path, value]) => ({ path, label: path,
      sectionKey: path.split(".")[0], entryIndex: /^\d+$/.test(path.split(".")[1]) ? Number(path.split(".")[1]) : 0,
      candidates: [{ sourceId: "confirmed", value, status: "user_confirmed" }] })) }));
}

test("hometown projection includes every explicit hierarchy source and preserves province-only precision", () => {
  const three = ledger({ "contactAndLocation.hometownProvince": "虚构省", "contactAndLocation.hometownCity": "虚构市",
    "contactAndLocation.hometownDistrict": "虚构区" });
  assert.equal(three.getValue("formAnswers.hometown"), "虚构省/虚构市/虚构区");
  assert.deepEqual(three.publicFacts.find((fact) => fact.path === "formAnswers.hometown").derivedFrom,
    ["contactAndLocation.hometownProvince", "contactAndLocation.hometownCity", "contactAndLocation.hometownDistrict"]);
  const one = ledger({ "contactAndLocation.hometownProvince": "虚构省" });
  assert.equal(one.getValue("formAnswers.hometown"), "虚构省");
  assert.deepEqual(one.publicFacts.find((fact) => fact.path === "formAnswers.hometown").derivedFrom, ["contactAndLocation.hometownProvince"]);
});

test("basic education and exam projections preserve exact sources while private values stay outside the model catalog", async () => {
  const profile = ledger({ "educations.0.school": "虚构研究生院校", "educations.0.major": "虚构专业",
    "educations.0.degree": "硕士", "educations.0.endDate": "2027-06", "educations.1.school": "虚构本科院校",
    "educations.1.degree": "本科", "educations.1.endDate": "2024-06", "languages.0.name": "英语",
    "languages.0.testScore": "CET6：567", "contactAndLocation.hometownProvince": "虚构省",
    "contactAndLocation.hometownCity": "虚构市", "personal.nationality": "汉族" });
  assert.equal(profile.getValue("formAnswers.currentSchool"), "虚构研究生院校");
  assert.equal(profile.getValue("formAnswers.bachelorSchool"), "虚构本科院校");
  assert.equal(profile.getValue("formAnswers.graduationYear"), "2027");
  assert.equal(profile.getValue("formAnswers.graduationMonth"), "6");
  assert.equal(profile.getValue("formAnswers.englishLevel"), "英语六级");
  assert.equal(profile.getValue("formAnswers.englishScore"), "567");
  assert.equal(profile.getValue("formAnswers.hometown"), "虚构省/虚构市");
  assert.equal(profile.getValue("formAnswers.ethnicity"), "汉族");
  const derived = profile.publicFacts.find((fact) => fact.path === "formAnswers.currentSchool");
  assert.deepEqual(derived.derivedFrom, ["educations.0.endDate", "educations.1.endDate", "educations.0.school"]);
  const report = { mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "basic", label: "基本信息", entryCount: 1 }, { id: "education", label: "教育经历", entryCount: 1 }],
    fields: ["basic", "education"].map((groupId, i) => ({ id: `field-${i}`, groupId, entryIndex: 0,
      label: i ? "学校名称" : "本科毕业院校", labelSource: "label", kind: "text", required: true,
      disabled: false, readOnly: false, hasValue: false, valueExcluded: false })) };
  const context = await createPlanContext(report, profile);
  assert.equal(JSON.stringify(context).includes("虚构本科院校"), false);
  assert.equal(JSON.stringify(context.profileCatalog).includes("567"), false);
  const plan = await buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
    fieldMappings: [{ fieldId: "field-0", sourcePath: "formAnswers.bachelorSchool" },
      { fieldId: "field-1", sourcePath: "educations.0.school" }] });
  assert.equal(plan.items.every((item) => item.sourcePath), true);
  assert.equal(plan.sections.find((section) => section.groupId === "education").additionalEntries, 1);
});

test("ambiguous education dates, exam scores, and nationality never invent singleton answers", () => {
  const profile = ledger({ "educations.0.school": "虚构甲", "educations.0.degree": "本科", "educations.0.endDate": "2024-06",
    "educations.1.school": "虚构乙", "educations.1.degree": "本科", "educations.1.endDate": "2024-06",
    "languages.0.name": "英语", "languages.0.testScore": "英语流利", "personal.nationality": "中国" });
  for (const key of ["currentSchool", "bachelorSchool", "graduationYear", "englishLevel", "englishScore", "ethnicity"]) {
    assert.equal(profile.hasPath(`formAnswers.${key}`), false);
  }
});

test("discovery channel cannot masquerade as an Other remarks answer, and repair quarantines the bad mapping", async () => {
  const profile = ledger({ "jobPreferences.discoveryChannel": "学校就业网" });
  const context = await createPlanContext({ mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "questions", label: "附加问题", entryCount: 1 }], fields: [{ id: "other", groupId: "questions", entryIndex: 0,
      label: "其他渠道请备注", labelSource: "label", kind: "text", required: false, disabled: false, readOnly: false,
      hasValue: false, valueExcluded: false }] }, profile);
  const proposal = { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
    fieldMappings: [{ fieldId: "other", sourcePath: "jobPreferences.discoveryChannel" }] };
  await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_SEMANTIC_MISMATCH" });
  const repaired = await createPartialProposal(context, proposal);
  assert.equal(repaired.proposal.fieldMappings.length, 0);
  assert.deepEqual(repaired.discardedFieldIds, ["other"]);
});

test("an award-only form includes competitions even when the model omits that group declaration", async () => {
  const profile = ledger({ "awards.0.name": "虚构奖项", "competitions.0.name": "虚构竞赛" });
  const context = await createPlanContext({ mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "awards", label: "获奖情况", entryCount: 1 }], fields: [{ id: "name", groupId: "awards", entryIndex: 0,
      label: "奖项", labelSource: "label", kind: "text", required: false, disabled: false, readOnly: false,
      hasValue: false, valueExcluded: false }] }, profile);
  const plan = await buildFillPlan(context, { snapshotId: context.snapshotId,
    groupMappings: [{ groupId: "awards", sectionKeys: ["awards"] }], unresolved: [],
    fieldMappings: [{ fieldId: "name", sourcePath: "awards.0.name" }] });
  assert.deepEqual(plan.sections[0].sectionKeys, ["awards", "competitions"]);
  assert.equal(plan.sections[0].profileEntries, 2); assert.equal(plan.sections[0].additionalEntries, 1);
});

test("a personal summary never becomes hobbies even if the model explicitly maps it", async () => {
  const profile = ledger({ "personal.summary": "虚构个人简介" });
  const context = await createPlanContext({ mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "extra", label: "附加信息", entryCount: 1 }], fields: [{ id: "hobby", groupId: "extra", entryIndex: 0,
      label: "兴趣爱好", labelSource: "label", kind: "textarea", required: false, disabled: false, readOnly: false,
      hasValue: false, valueExcluded: false }] }, profile);
  await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
    fieldMappings: [{ fieldId: "hobby", sourcePath: "personal.summary" }] }), { code: "PLAN_SEMANTIC_MISMATCH" });
});

test("separate award and competition groups remain separate even when the model omits a section or attempts merging", async () => {
  const profile = ledger({ "awards.0.name": "虚构奖项", "competitions.0.name": "虚构竞赛" });
  const context = await createPlanContext({ mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "awards", label: "获奖情况", entryCount: 1 }, { id: "competitions", label: "竞赛经历", entryCount: 1 }],
    fields: ["awards", "competitions"].map((groupId) => ({ id: `${groupId}-name`, groupId, entryIndex: 0,
      label: "名称", labelSource: "label", kind: "text", required: false, disabled: false, readOnly: false,
      hasValue: false, valueExcluded: false })) }, profile);
  const proposal = { snapshotId: context.snapshotId, groupMappings: [{ groupId: "awards", sectionKeys: ["awards", "competitions"] }],
    unresolved: [], fieldMappings: [{ fieldId: "awards-name", sourcePath: "awards.0.name" }] };
  const plan = await buildFillPlan(context, proposal);
  assert.deepEqual(plan.sections.find((section) => section.groupId === "awards").sectionKeys, ["awards"]);
  assert.deepEqual(plan.sections.find((section) => section.groupId === "competitions").sectionKeys, ["competitions"]);
  proposal.fieldMappings[0].sourcePath = "competitions.0.name";
  await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_SEMANTIC_MISMATCH" });
});
