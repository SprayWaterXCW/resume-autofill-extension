import test from "node:test";
import assert from "node:assert/strict";
import { formStructureDifference, sameFormStructure, sameFillTargets, matchFillTargets } from "../src/core/form-structure-identity.js";
import { executionDiagnostic, executionEventSchema } from "../src/core/execution-diagnostics.js";
import { safePageDiagnostic, scriptFailureCause } from "../src/core/page-lifecycle-diagnostics.js";

test("structure errors identify property changes without exposing values or captions", () => {
  const before = { url: "https://fictional.example/form", groups: [{ id: "group-1", label: "教育经历", entryCount: 1 }],
    fields: [{ id: "field-1", label: "就读时间 / 开始 / 年", datePart: "year", value: "private" }], controls: [] };
  const after = structuredClone(before);
  after.fields[0].label = "就读时间"; delete after.fields[0].datePart;
  after.fields[0].value = "different private";
  const difference = formStructureDifference(before, after);
  assert.equal(sameFormStructure(before, after), false);
  assert.deepEqual(difference.changes, [{ area: "fields", index: 0, id: "field-1", properties: ["label", "datePart"] }]);
  const logged = executionDiagnostic({ phase: "失败", tool: "execution", code: "REAL_FORM_STRUCTURE_CHANGED", structureDiagnostic: difference,
    summary: "private", value: "private", report: after });
  assert.ok(logged);
  assert.equal(/private|就读|fictional/.test(JSON.stringify(logged)), false);
  assert.equal(executionEventSchema.safeParse({ ...logged, value: "private" }).success, false);
});

test("page lifecycle diagnostics distinguish background script failure from navigation without private error text", () => {
  const privateMessage = 'Cannot access contents of url https://private.example/form?credential=SECRET';
  const pageDiagnostic = safePageDiagnostic({ stage: 'input', trigger: 'script_failed', cause: scriptFailureCause(new Error(privateMessage)),
    tabActive: false, tabDiscarded: false, tabLoading: false, urlMatched: true, url: privateMessage, value: 'PRIVATE' });
  assert.equal(pageDiagnostic.cause, 'access_denied');
  const record = executionDiagnostic({ phase: '失败', tool: 'execution', code: 'PAGE_INPUT_EXECUTION_FAILED', pageDiagnostic, summary: privateMessage });
  assert.deepEqual(record.pageDiagnostic, pageDiagnostic);
  assert.equal(/private|SECRET|PRIVATE|https/.test(JSON.stringify(record)), false);
  assert.equal(scriptFailureCause(new Error('No document with id fictional-document')), 'document_unavailable');
  assert.equal(scriptFailureCause(new Error('Extension context invalidated')), 'context_invalidated');
  assert.equal(scriptFailureCause(new Error('unexpected private application error')), 'script_error');
  assert.equal(safePageDiagnostic({ stage: 'private-stage', trigger: 'script_failed' }), undefined);
  assert.equal(executionEventSchema.safeParse({ ...record, pageDiagnostic: { ...pageDiagnostic, url: privateMessage } }).success, false);
});

test("audit references follow uniquely identified fields when earlier cards shift IDs", () => {
  const before = { url: "https://fictional.example/form", groups: [{ id: "group-1", label: "教育经历" }, { id: "group-2", label: "获奖经历" }],
    fields: [{ id: "field-1", groupId: "group-1", entryIndex: 0, label: "学校名称", kind: "text" },
      { id: "field-2", groupId: "group-2", entryIndex: 0, label: "奖项名称", kind: "text" }] };
  const after = structuredClone(before);
  after.fields[1].id = "field-3";
  after.fields.splice(1, 0, { ...after.fields[0], id: "field-2", entryIndex: 1 });
  assert.deepEqual(matchFillTargets(before, after), [{ beforeId: "field-1", afterId: "field-1" }, { beforeId: "field-2", afterId: "field-3" }]);
  const duplicate = structuredClone(after); duplicate.fields.push({ ...duplicate.fields[2], id: "field-4" });
  assert.equal(matchFillTargets(before, duplicate).some((pair) => pair.beforeId === "field-2"), false);
  const changed = structuredClone(after); changed.fields[2].label = "个人职责";
  assert.equal(matchFillTargets(before, changed).some((pair) => pair.beforeId === "field-2"), false);
  assert.deepEqual(matchFillTargets(before, { ...after, url: "https://fictional.example/other" }), []);
});

test("ordinary value and presence changes do not invalidate a field mapping", () => {
  const before = { groups: [], fields: [{ id: "field-1", hasValue: false, value: "" }], controls: [] };
  const after = structuredClone(before); after.fields[0].hasValue = true; after.fields[0].value = "private";
  assert.equal(sameFormStructure(before, after), true);
});

test("fill identity ignores only controls and empty groups, still checks dates, records and permissions", () => {
  const before = { groups: [{ id: "group-1", label: "教育经历", entryCount: 1, fieldCount: 1 }],
    fields: [{ id: "field-1", groupId: "group-1", entryIndex: 0, label: "就读时间 / 开始 / 年", datePart: "year", disabled: false }], controls: [] };
  const after = structuredClone(before);
  after.groups.push({ id: "group-2", label: "更新说明", entryCount: 0, fieldCount: 0 });
  after.controls.push({ id: "control-1", groupId: "group-2", label: "保存中", intent: "other" });
  assert.equal(sameFormStructure(before, after), false);
  assert.equal(sameFillTargets(before, after), true);
  for (const [key, value] of [["datePart", "month"], ["groupId", "group-2"], ["entryIndex", 1], ["disabled", true]]) {
    const changed = structuredClone(after); changed.fields[0][key] = value;
    assert.equal(sameFillTargets(before, changed), false, key);
  }
});
