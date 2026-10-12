import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createProfileStore, isProfileEditorSender } from "../agent-extension/src/profile-store.js";
import { mountProfileEditor } from "../agent-extension/src/profile-editor.js";
import { ResumeSchema as schema } from "../src/vendor/formfill/resume-schema.js";
import { importProfile, ledgerFromProfile, PRIVATE_PROFILE_KEY } from "../src/core/profile-import.js";

const html = readFileSync(new URL("../agent-extension/profile-editor.html", import.meta.url), "utf8");
function fictionalProfile() {
  return {
    personal: { fullName: "虚构测试人", phoneNumber: "13000000000", birthDate: "2000-01-15" },
    contactAndLocation: { hometownProvince: "虚构省", hometownCity: "虚构市" },
    educations: [{ school: "虚构大学甲", startDate: "2018-09", endDate: "2022-06" }, { school: "虚构大学乙", startDate: "2022-09" }],
    internships: [{ company: "虚构公司", description: "虚构实习内容" }],
    languages: [{ name: "英语", proficiency: "流利" }],
    additional: { awards: "- 虚构奖项甲\n- 虚构奖项乙", competitions: "- 虚构竞赛甲" },
  };
}

function memoryStore(initial, options = {}) {
  const data = initial ? { [PRIVATE_PROFILE_KEY]: structuredClone(initial) } : {};
  const listeners = new Set();
  const writes = [];
  const storage = {
    async get() { return structuredClone(data); },
    async set(update) {
      writes.push(structuredClone(update));
      const changes = {};
      for (const [key, value] of Object.entries(update)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = structuredClone(value);
      }
      for (const listener of listeners) listener(changes, "local");
    },
  };
  const store = createProfileStore({ storage, ...options });
  return { data, listeners, writes, store, storage };
}

async function openEditor(memory, hash = "") {
  const dom = new JSDOM(html, { url: "https://editor.example.test/profile-editor.html" + hash });
  const requests = [];
  dom.window.confirm = () => true;
  const chrome = {
    runtime: { async sendMessage(message) {
      requests.push(message.type);
      try {
        return { ok: true, value: message.type === "profile-editor-load" ? await memory.store.read()
          : message.type === "profile-editor-save" ? await memory.store.save(message) : null };
      } catch (error) { return { ok: false, error: error.message }; }
    } },
    storage: { onChanged: {
      addListener(listener) { memory.listeners.add(listener); },
      removeListener(listener) { memory.listeners.delete(listener); },
    } },
  };
  await mountProfileEditor({ document: dom.window.document, window: dom.window, chrome }).ready;
  const document = dom.window.document;
  const fill = (path, value) => {
    const control = document.querySelector('[data-profile-path="' + path + '"]');
    assert.ok(control, path);
    control.value = value;
    control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  return { dom, document, requests, fill };
}

async function settle() {
  for (let attempt = 0; attempt < 15; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("language dimension fields edit/save/reopen independently without changing overall proficiency or exam score", async () => {
  const source = fictionalProfile(); source.languages[0].testScore = "FICTIONAL_EXAM_SCORE";
  const memory = memoryStore(importProfile({ profile: source }).stored);
  const editor = await openEditor(memory, "#languages");
  try {
    editor.fill("languages.0.listeningSpeaking", "良好"); editor.fill("languages.0.readingWriting", "熟练");
    editor.document.getElementById("save-profile").click(); await settle();
    const stored = memory.data[PRIVATE_PROFILE_KEY];
    assert.equal(stored.profile.languages[0].proficiency, "流利");
    assert.equal(stored.profile.languages[0].testScore, "FICTIONAL_EXAM_SCORE");
    const reopened = await openEditor(memory, "#languages");
    try {
      assert.equal(reopened.document.querySelector('[data-profile-path="languages.0.listeningSpeaking"]').value, "良好");
      assert.equal(reopened.document.querySelector('[data-profile-path="languages.0.readingWriting"]').value, "熟练");
    } finally { reopened.dom.window.close(); }
  } finally { editor.dom.window.close(); }
});

test("award and competition cards edit structured properties, add/delete, save/reopen/export and retain unrelated drafts", async () => {
  const memory = memoryStore(importProfile({ profile: fictionalProfile() }).stored);
  const { dom, document, fill } = await openEditor(memory, "#additional");
  const setAward = (section, index, key, value) => {
    const control = document.querySelector('[data-award-section="' + section + '"][data-award-index="' + index + '"][data-award-property="' + key + '"]');
    assert.ok(control);
    assert.equal(control.hasAttribute("readonly"), false, "record properties are editable");
    assert.equal(control.disabled, false);
    control.value = value;
    control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const originalId = memory.data[PRIVATE_PROFILE_KEY].profile.awardRecords.awards[0].id;
  try {
    assert.equal(document.querySelectorAll('[data-award-record="awards"]').length, 2);
    assert.equal(document.querySelector('[data-profile-path="additional.awards"]'), null);
    assert.equal(document.querySelector('[data-profile-path="additional.competitions"]'), null);
    assert.equal(document.querySelectorAll('[data-award-property]').length, 15);
    assert.match(document.querySelector('[data-award-summary="awards"]').textContent, /2 条级别未确认/);
    setAward("awards", 0, "name", "修改后的虚构奖项甲");
    setAward("awards", 0, "scope", "国家级");
    setAward("awards", 0, "rank", "一等奖");
    setAward("awards", 0, "description", "虚构独立获奖说明");
    setAward("awards", 0, "date", "2023-06");
    fill("personal.heightCm", "176");
    document.querySelector('[data-add-award="awards"]').click();
    setAward("awards", 2, "name", "新增虚构奖项");
    setAward("awards", 2, "scope", "院级");
    setAward("awards", 2, "rank", "优秀奖");
    setAward("awards", 2, "description", "新增虚构奖项详情");
    document.querySelectorAll('[data-award-record="awards"]')[1].querySelector('[data-remove-award]').click();
    assert.equal(document.querySelector('[data-profile-path="personal.heightCm"]').value, "176");
    setAward("competitions", 0, "scope", "省级");
    setAward("competitions", 0, "description", "虚构原竞赛详情");
    document.querySelector('[data-add-award="competitions"]').click();
    setAward("competitions", 1, "name", "新增虚构竞赛");
    setAward("competitions", 1, "scope", "市级");
    setAward("competitions", 1, "rank", "二等奖");
    setAward("competitions", 1, "description", "新增虚构竞赛详情");
    document.getElementById("save-profile").click();
    await settle();
    const stored = memory.data[PRIVATE_PROFILE_KEY];
    assert.equal(stored.profile.awardRecords.awards.length, 2);
    assert.equal(stored.profile.awardRecords.competitions.length, 2);
    assert.equal(stored.profile.awardRecords.awards[0].id, originalId);
    assert.equal(stored.profile.awardRecords.awards[0].name, "修改后的虚构奖项甲");
    assert.equal(stored.profile.awardRecords.awards[1].name, "新增虚构奖项");
    assert.equal(ledgerFromProfile(stored).getValue("awards.0.description"), "虚构独立获奖说明");
    assert.equal(ledgerFromProfile(stored).getValue("awards.0.dateYear"), "2023");
    let exported;
    dom.window.Blob = class { constructor(parts) { exported = JSON.parse(parts.join("")); } };
    dom.window.URL.createObjectURL = () => "blob:fictional-awards";
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = () => {};
    document.getElementById("export-profile").click();
    assert.deepEqual(importProfile(exported).stored.profile.awardRecords, stored.profile.awardRecords);
    const reopened = await openEditor(memory, "#additional");
    try {
      assert.equal(reopened.document.querySelector('[data-award-section="awards"][data-award-index="0"][data-award-property="name"]').value, "修改后的虚构奖项甲");
      assert.equal(reopened.document.querySelector('[data-award-section="awards"][data-award-index="1"][data-award-property="description"]').value, "新增虚构奖项详情");
      assert.equal(reopened.document.querySelector('[data-award-section="competitions"][data-award-index="1"][data-award-property="rank"]').value, "二等奖");
      reopened.document.querySelector('[data-remove-award="awards"]').click();
      reopened.document.querySelector('[data-remove-award="awards"]').click();
      assert.equal(reopened.document.querySelectorAll('[data-award-record="awards"]').length, 0);
      assert.match(reopened.document.querySelector('[data-award-summary="awards"]').textContent, /暂无获奖/);
      reopened.document.getElementById("save-profile").click();
      await settle();
      assert.deepEqual(memory.data[PRIVATE_PROFILE_KEY].profile.awardRecords.awards, []);
      assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.awardRecords.competitions.length, 2);
    } finally { reopened.dom.window.close(); }
  } finally { dom.window.close(); }
});

test("a fresh profile starts with no fixed awards and can save a single newly added structured record", async () => {
  const memory = memoryStore();
  const { dom, document } = await openEditor(memory, "#additional");
  try {
    assert.equal(document.querySelectorAll('[data-award-record]').length, 0);
    document.querySelector('[data-add-award="competitions"]').click();
    const name = document.querySelector('[data-award-property="name"]');
    assert.equal(name.value, "");
    assert.equal(document.activeElement, name);
    name.value = "完全自定义的虚构竞赛";
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.getElementById("save-profile").click();
    await settle();
    assert.equal(document.getElementById("page-status").dataset.kind, "success");
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.awardRecords.competitions[0].name, "完全自定义的虚构竞赛");
    assert.equal(ledgerFromProfile(memory.data[PRIVATE_PROFILE_KEY]).getValue("competitions.0.name"), "完全自定义的虚构竞赛");
  } finally { dom.window.close(); }
});

test("editing imported data retains every untouched fact, month precision and award records across reopen", async () => {
  const initial = importProfile({ profile: fictionalProfile() }).stored;
  const originalFacts = schema.getCatalogWithValues(initial.profile).filter((item) => item.hasValue);
  const memory = memoryStore(initial);
  const { dom, document, fill } = await openEditor(memory);
  try {
    assert.equal(document.querySelector('[data-profile-path="personal.phoneNumber"]').value, "13000000000");
    const phone = document.querySelector('[data-profile-path="personal.phoneNumber"]');
    assert.equal(document.querySelector('label[for="' + phone.id + '"]').textContent, "手机号码");
    fill("personal.heightCm", "175");
    fill("personal.weightKg", "65");
    document.querySelector('[data-nav-section="familyMembers"]').click();
    fill("familyMembers.0.name", "虚构家庭成员甲");
    fill("familyMembers.0.relationship", "父亲");
    document.querySelector('[data-add-section="familyMembers"]').click();
    fill("familyMembers.1.name", "虚构家庭成员乙");
    fill("familyMembers.1.relationship", "母亲");
    document.getElementById("save-profile").click();
    await settle();
    assert.equal(document.getElementById("page-status").dataset.kind, "success");
    assert.equal(document.getElementById("save-profile").disabled, true);
    const stored = memory.data[PRIVATE_PROFILE_KEY];
    for (const fact of originalFacts) assert.equal(schema.getValueByPath(stored.profile, fact.path), fact.value, fact.path);
    assert.equal(stored.profile.personal.heightCm, "175");
    assert.equal(stored.profile.familyMembers.length, 2);
    assert.equal(stored.importedAt, initial.importedAt);
    const ledger = ledgerFromProfile(stored);
    assert.equal(ledger.getValue("familyMembers.1.name"), "虚构家庭成员乙");
    assert.equal(ledger.publicFacts.filter((entry) => entry.sectionKey === "awards" && !entry.derivedFrom).length, 2);
    assert.equal(JSON.stringify(ledger).includes("虚构测试人"), false);
    const reopened = await openEditor(memory);
    try {
      assert.equal(reopened.document.querySelector('[data-profile-path="personal.weightKg"]').value, "65");
      assert.equal(reopened.document.querySelector('[data-profile-path="educations.0.startDate"]').value, "2018-09");
      assert.equal(reopened.document.querySelector('[data-profile-path="familyMembers.1.relationship"]').value, "母亲");
    } finally { reopened.dom.window.close(); }
  } finally { dom.window.close(); }
});

test("blank profile can be configured without a model and list add/delete retains other unsaved sections", async () => {
  const memory = memoryStore();
  const { dom, document, requests, fill } = await openEditor(memory);
  try {
    fill("personal.fullName", "虚构新用户");
    document.querySelector('[data-nav-section="educations"]').click();
    fill("educations.0.school", "虚构新大学甲");
    document.querySelector('[data-add-section="educations"]').click();
    fill("educations.1.school", "虚构新大学乙");
    document.querySelector('[data-add-section="educations"]').click();
    document.querySelector('[data-remove-section="educations"][data-record-index="2"]').click();
    assert.equal(document.querySelector('[data-profile-path="personal.fullName"]').value, "虚构新用户");
    document.getElementById("save-profile").click();
    await settle();
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.educations.length, 2);
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.educations[1].school, "虚构新大学乙");
    assert.deepEqual(requests, ["profile-editor-load", "profile-editor-save"]);
  } finally { dom.window.close(); }
});

test("stale editor refuses to overwrite a newer profile and keeps its unsaved controls", async () => {
  const memory = memoryStore(importProfile({ profile: fictionalProfile() }).stored);
  const first = await openEditor(memory);
  const second = await openEditor(memory);
  try {
    first.fill("personal.fullName", "虚构窗口甲");
    second.fill("personal.fullName", "虚构窗口乙");
    first.document.getElementById("save-profile").click();
    await settle();
    second.document.getElementById("save-profile").click();
    await settle();
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.personal.fullName, "虚构窗口甲");
    assert.equal(second.document.getElementById("page-status").dataset.kind, "error");
    assert.match(second.document.getElementById("page-status").textContent, /其他页面更新/);
    assert.equal(second.document.querySelector('[data-profile-path="personal.fullName"]').value, "虚构窗口乙");
    assert.equal(second.document.getElementById("save-profile").disabled, false);
  } finally { first.dom.window.close(); second.dom.window.close(); }
});

test("simultaneous saves serialize revision checks; busy Agent and invalid import do not alter saved data", async () => {
  let busy = false;
  const memory = memoryStore(importProfile({ profile: fictionalProfile() }).stored, { isBusy: () => busy });
  const snapshot = await memory.store.read();
  const payload = { profile: snapshot.profile, baseRevision: snapshot.revision, purpose: snapshot.purpose };
  const pending = [memory.store.save(payload), memory.store.save(payload)];
  assert.equal(memory.store.isWriting, true);
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.message, "PROFILE_EDITOR_CONFLICT");
  assert.equal(memory.store.isWriting, false);
  const current = structuredClone(memory.data);
  busy = true;
  await assert.rejects(memory.store.import({ profile: fictionalProfile() }), /PROFILE_EDITOR_BUSY/);
  busy = false;
  await assert.rejects(memory.store.import({ unrelated: "rejected" }), /PROFILE_IMPORT_FORMAT/);
  assert.deepEqual(memory.data, current);
});

test("backup import stays an unsaved form until save, malformed backup retains data, and export roundtrips", async () => {
  const initial = importProfile({ profile: fictionalProfile() }).stored;
  const memory = memoryStore(initial);
  const { dom, document, fill } = await openEditor(memory);
  try {
    const file = document.getElementById("import-file");
    Object.defineProperty(file, "files", { configurable: true, value: [{ size: 10, async text() { return "{invalid"; } }] });
    file.dispatchEvent(new dom.window.Event("change"));
    await settle();
    assert.equal(memory.writes.length, 0);
    assert.equal(document.querySelector('[data-profile-path="personal.fullName"]').value, "虚构测试人");
    Object.defineProperty(file, "files", { configurable: true, value: [{
      size: 100, async text() { return JSON.stringify({ profile: { personal: { fullName: "虚构备份用户" } } }); },
    }] });
    file.dispatchEvent(new dom.window.Event("change"));
    await settle();
    assert.equal(memory.writes.length, 0);
    assert.equal(document.querySelector('[data-profile-path="personal.fullName"]').value, "虚构备份用户");
    fill("personal.heightCm", "176");
    let exported;
    let downloaded;
    dom.window.Blob = class { constructor(parts) { exported = JSON.parse(parts.join("")); } };
    dom.window.URL.createObjectURL = () => "blob:fictional";
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
    document.getElementById("export-profile").click();
    assert.match(downloaded, /^我的简历资料-.*\.json$/);
    assert.equal(importProfile(exported).stored.profile.personal.heightCm, "176");
    assert.equal(exported.profile.personal.fullName, "虚构备份用户");
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.personal.fullName, initial.profile.personal.fullName);
    const unload = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, true);
    document.getElementById("save-profile").click();
    await settle();
    assert.equal(memory.data[PRIVATE_PROFILE_KEY].profile.personal.fullName, "虚构备份用户");
  } finally { dom.window.close(); }
});

test("private editor API accepts only the extension's editor and rejects page/content-script senders", async () => {
  const runtime = { id: "fixture", getURL: (path) => "chrome-extension://fixture/" + path };
  assert.equal(isProfileEditorSender({ id: "fixture", url: runtime.getURL("profile-editor.html") }, runtime), true);
  assert.equal(isProfileEditorSender({ id: "fixture", url: runtime.getURL("profile-editor.html") + "#personal" }, runtime), true);
  for (const sender of [
    { id: "fixture", url: "https://jobs.example.test/form" },
    { id: "other", url: runtime.getURL("profile-editor.html") },
    { id: "fixture", url: runtime.getURL("profile-editor.html") + ".evil" }, {},
  ]) assert.equal(isProfileEditorSender(sender, runtime), false);

  const previousChrome = globalThis.chrome;
  let listener;
  const memory = memoryStore(importProfile({ profile: fictionalProfile() }).stored);
  globalThis.chrome = {
    runtime: { ...runtime, onMessage: { addListener(value) { listener = value; } } },
    storage: { local: memory.storage, session: { async get() { return {}; }, async set() {} } },
    tabs: {},
  };
  const send = (message, sender) => new Promise((resolve) => listener(message, sender, resolve));
  try {
    await import("../agent-extension/src/worker.js?test=profile-editor");
    const denied = await send({ type: "profile-editor-load" }, { id: "fixture", url: "https://jobs.example.test/form" });
    assert.deepEqual(denied, { ok: false, error: "PROFILE_EDITOR_ACCESS_DENIED" });
    const allowed = await send({ type: "profile-editor-load" }, { id: "fixture", url: runtime.getURL("profile-editor.html") });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.value.profile.personal.fullName, "虚构测试人");
  } finally { globalThis.chrome = previousChrome; }
});
