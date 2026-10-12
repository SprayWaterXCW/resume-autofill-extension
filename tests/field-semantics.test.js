import test from "node:test";
import assert from "node:assert/strict";
import { fieldMappingCompatible } from "../src/core/field-semantics.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";

test("salary expectations and previously earned salary have distinct meanings across languages", () => {
  const expected = { path: "jobPreferences.expectedSalary", label: "期望薪资", sectionKey: "jobPreferences" };
  const current = { path: "jobPreferences.currentSalary", label: "目前薪资", sectionKey: "jobPreferences" };
  for (const label of ["最近薪资", "现有工资", "Current compensation", "Previous salary"]) assert.equal(fieldMappingCompatible({ label }, expected), false, label);
  for (const label of ["希望工资", "期望年薪", "Desired salary"]) {
    assert.equal(fieldMappingCompatible({ label }, expected), true, label);
    assert.equal(fieldMappingCompatible({ label }, current), false, label);
  }
});

test("project overview, a role title and personal responsibilities do not substitute for one another", () => {
  const fact = (key) => ({ path: `projects.0.${key}`, label: key, sectionKey: "projects" });
  assert.equal(fieldMappingCompatible({ label: "项目中职责", kind: "textarea" }, fact("description")), false);
  assert.equal(fieldMappingCompatible({ label: "个人贡献", kind: "textarea" }, fact("responsibilities")), true);
  assert.equal(fieldMappingCompatible({ label: "职责", kind: "text" }, fact("role")), true);
  assert.equal(fieldMappingCompatible({ label: "项目描述", kind: "textarea" }, fact("role")), false);
  assert.equal(fieldMappingCompatible({ label: "Project overview", kind: "textarea" }, fact("description")), true);
});

test("a company referrer cannot be borrowed from an emergency contact, relative, or education advisor", () => {
  for (const path of ["personal.emergencyContactName", "contactAndLocation.emergencyContactName", "familyMembers.0.name", "educations.0.advisor"]) {
    assert.equal(fieldMappingCompatible({ label: "推荐人姓名" }, { path }), false);
  }
  assert.equal(fieldMappingCompatible({ label: "推荐人手机号码" }, { path: "personal.emergencyContactPhone" }), false);
  assert.equal(fieldMappingCompatible({ label: "推荐人姓名" }, { path: "jobPreferences.referrerName" }), true);
  assert.equal(fieldMappingCompatible({ label: "推荐人手机号码" }, { path: "jobPreferences.referrerPhone" }), true);
});

test("a model proposal that copies expected salary into current salary never becomes executable", async () => {
  const ledger = ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "虚构薪资" } } }).stored);
  const report = { mode: "read-only", origin: "https://fictional.example", summary: { truncated: false, fieldCount: 1, groupCount: 1 },
    groups: [{ id: "group-1", label: "求职意向", entryCount: 1 }], controls: [], fields: [{ id: "field-1", groupId: "group-1", entryIndex: 0,
      label: "最近薪资", labelSource: "label", kind: "text", required: false, disabled: false, readOnly: false, hasValue: false, valueExcluded: false }] };
  const context = await createPlanContext(report, ledger);
  await assert.rejects(buildFillPlan(context, { snapshotId: context.snapshotId, groupMappings: [],
    fieldMappings: [{ fieldId: "field-1", sourcePath: "jobPreferences.expectedSalary" }], unresolved: [] }), { code: "PLAN_SEMANTIC_MISMATCH" });
});
