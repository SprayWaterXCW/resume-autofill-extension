import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { isScannableUrl, isAuthenticationUrl, readFormStructure, scanCurrentTab } from "../agent-extension/src/page-scan.js";

const pageUrl = "https://myjob.hzbank.com.cn/hzzp-apply-web/static/index.html#/createResume?type=school";

test("observed login and registration routes are excluded from resume execution", () => {
  assert.equal(isAuthenticationUrl("https://career.boe.com/login?goto=custom%2Fxzxq"), true);
  assert.equal(isAuthenticationUrl("https://jobs.example.test/index.html#/register"), true);
  assert.equal(isAuthenticationUrl(pageUrl), false);
});

function fixture(html, url = pageUrl) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  // jsdom provides DOM semantics, not visual layout. Supply rendered rectangles for this fixture.
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 200, height: 30 }];
  };
  for (const method of ["click", "focus", "blur", "dispatchEvent"]) {
    dom.window.HTMLElement.prototype[method] = () => { throw new Error(`Scanner attempted ${method}`); };
  }
  dom.window.fetch = () => { throw new Error("Scanner attempted a network request"); };
  return dom;
}

const bankFixture = `
  <div id="basic" class="resume-form-container">
    <p class="resume-form-title">基本信息</p>
    <form class="el-form">
      <div class="el-form-item"><label>姓名：</label><input id="name" value="虚构姓名甲"></div>
      <div class="el-form-item"><label>证件号码：</label><input id="identity" disabled value="FICTIONAL_ID_123"></div>
      <div class="el-form-item"><label>手机号码：</label><input id="phone" value="FICTIONAL_PHONE_456"></div>
    </form>
  </div>
  <div id="edu" class="resume-form-container">
    <p class="resume-form-title">教育经历（请以从高至低顺序填写）</p>
    <div class="resume-form-wrap">
      <form class="el-form">
        <div class="el-form-item is-required"><label>教育类型：</label><div class="el-select"><input readonly placeholder="请选择"></div></div>
        <div class="el-form-item is-required"><label>毕业院校：</label><div role="combobox" class="el-autocomplete"><input value="虚构学院乙"></div></div>
        <div class="el-form-item"><label>专业：</label><input value="虚构专业丙"></div>
        <div class="el-form-item"><label>开始时间：</label><div class="el-date-editor"><input readonly></div></div>
        <button type="button">保存</button>
      </form>
      <form class="el-form"><div class="el-form-item"><label>毕业院校：</label><input></div></form>
      <button type="button">继续添加</button>
    </div>
  </div>
  <div class="resume-form-container"><p class="resume-form-title">有关声明</p><div id="statementForm"><form>
    <label>是否患有疾病？<input id="medical" type="radio" checked value="FICTIONAL_MEDICAL_789"></label>
    <textarea id="statement">虚构声明文本丁</textarea><canvas></canvas><button type="button">保存签名</button>
  </form></div></div>
  <div class="resume-form-container"><p class="resume-form-title">有关声明</p></div>
  <form hidden><label>隐藏个人资料<textarea>虚构隐藏内容戊</textarea></label></form>
  <input type="password" id="password" aria-label="Password" value="FICTIONAL_SECRET_012">
  <button type="submit">提交简历</button><iframe></iframe>
`;

test("real-page scan keeps education entries and the add button in their observed section", () => {
  const dom = fixture(bankFixture);
  try {
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(pageUrl)})`);
    const education = report.groups.find((group) => group.label.startsWith("教育经历"));
    assert.equal(education.entryCount, 2);
    assert.equal(education.fieldCount, 5); // combobox wrapper does not double-count its input.
    const educationFields = report.fields.filter((field) => field.groupId === education.id);
    assert.deepEqual(Array.from(educationFields, (field) => field.kind), ["custom-select", "autocomplete", "text", "date", "text"]);
    assert.equal(educationFields[0].label, "教育类型：");
    assert.equal(educationFields[0].required, true);
    assert.equal(report.controls.find((control) => control.label === "继续添加").groupId, education.id);
    assert.equal(report.controls.find((control) => control.label === "继续添加").intent, "add-candidate");
    assert.equal(report.controls.find((control) => control.label === "提交简历").intent, "submit");
    assert.ok(report.controls.every((control) => control.executable === false));
    assert.equal(report.summary.frameCount, 1);
    assert.equal(report.groups.filter((group) => group.label === "有关声明").length, 1);
  } finally { dom.window.close(); }
});

test("scan leaves DOM untouched and never reads sensitive values or exports ordinary values", () => {
  const dom = fixture(bankFixture);
  try {
    const document = dom.window.document;
    for (const id of ["name", "identity", "phone", "medical", "statement", "password"]) {
      Object.defineProperty(document.getElementById(id), "value", {
        get() { throw new Error(`Sensitive value was read: ${id}`); },
      });
    }
    const before = document.documentElement.outerHTML;
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(pageUrl)})`);
    assert.equal(document.documentElement.outerHTML, before);
    const serialized = JSON.stringify(report);
    for (const value of ["虚构姓名甲", "FICTIONAL_ID_123", "FICTIONAL_PHONE_456", "虚构学院乙", "虚构专业丙", "FICTIONAL_MEDICAL_789", "虚构声明文本丁", "虚构隐藏内容戊", "FICTIONAL_SECRET_012"]) {
      assert.equal(serialized.includes(value), false, `Value appeared in scan: ${value}`);
    }
    assert.ok(report.fields.every((field) => !Object.hasOwn(field, "value")));
    assert.ok(report.summary.knownExistingFields > 0);
    assert.ok(report.summary.excludedValueFields > 0);
  } finally { dom.window.close(); }
});

test("generic scan uses semantic labels and reports unlabeled or hidden controls", () => {
  const url = "https://jobs.example.test/form";
  const dom = fixture(`<fieldset><legend>Education</legend><label for="school">Graduation school</label><input id="school"><label for="degree">Degree</label><select id="degree"><option value="">Choose</option><option>Example degree</option></select><input><input hidden value="FICTIONAL_HIDDEN"><button>Add education</button></fieldset>`, url);
  try {
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(url)})`);
    assert.equal(report.adapter, "generic-semantic-dom");
    assert.equal(report.summary.fieldCount, 3);
    assert.equal(report.summary.unlabeledFields, 1);
    assert.equal(report.summary.hiddenFieldCount, 1);
    assert.equal(report.fields[0].label, "Graduation school");
    assert.equal(report.fields[1].kind, "select");
    // A button without an explicit type in a form-like UI cannot be assumed safe to execute.
    assert.ok(report.controls.every((control) => !control.executable));
  } finally { dom.window.close(); }
});

test("observed Phoenix titles, nested labels and repeated record forms stay distinct without generated CSS names", () => {
  const url = "https://jobs.example.test/form";
  const input = (label, control) => `<div class="form-item form-item--phoenix"><div class="form-item__title"><a class="form-item__required">*</a><label class="form-item__text">${label}</label></div><div class="form-item__control">${control}</div></div>`;
  const record = (content) => `<div class="ux-standard-form"><div class="form-part"><div class="form-part-body">${"<div>".repeat(17)}${content}${"</div>".repeat(17)}</div></div></div>`;
  const dom = fixture(`<div><div id="basic-title">基本信息</div><div>${record(input("姓名", '<input id="private-name" value="FICTIONAL_NAME">') + input("在读学历", '<div class="phoenix-select"><ul class="phoenix-select__content"><li>虚构已选学历</li><li><input></li></ul></div>'))}</div></div>
    <div><div id="edu-title">教育经历</div><div>${record(input("学校名称", '<input placeholder="请输入">') + input("学历", '<div class="phoenix-select"><ul class="phoenix-select__content"><li><input></li></ul></div>'))}${record(input("学校名称", '<input>'))}<div><svg></svg><span>添加</span></div></div></div><button type="button">暂存</button>`, url);
  try {
    Object.defineProperty(dom.window.document.getElementById("private-name"), "value", { get() { throw new Error("Read sensitive value"); } });
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(url)})`);
    assert.equal(report.adapter, "phoenix-layout-observed");
    assert.equal(report.summary.unlabeledFields, 0);
    const education = report.groups.find((group) => group.label === "教育经历");
    assert.equal(education.entryCount, 2);
    assert.deepEqual(Array.from(report.fields.filter((field) => field.groupId === education.id), (field) => [field.label, field.entryIndex, field.kind]),
      [["学校名称", 0, "text"], ["学历", 0, "custom-select"], ["学校名称", 1, "text"]]);
    assert.ok(report.fields.every((field) => field.required));
    assert.equal(report.fields.find((field) => field.label === "在读学历").hasValue, true);
    assert.equal(report.controls.find((control) => control.label === "添加").groupId, education.id);
    assert.equal(report.controls.find((control) => control.label === "暂存").intent, "save-candidate");
    assert.equal(JSON.stringify(report).includes("虚构已选学历"), false);
    assert.equal(JSON.stringify(report).includes("FICTIONAL_NAME"), false);
  } finally { dom.window.close(); }
});

test("local demonstration cards retain distinct record indices in the current page template", () => {
  const url = "http://127.0.0.1:4174/?runner=browser-use";
  const html = readFileSync(new URL("../web-demo/index.html", import.meta.url), "utf8");
  const dom = fixture(html, url);
  try {
    const template = dom.window.document.getElementById("education-card-template");
    const entries = dom.window.document.getElementById("education-entries");
    for (let index = 0; index < 2; index += 1) entries.append(template.content.cloneNode(true));
    const report = dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(url)})`);
    const education = report.groups.find((group) => group.label === "教育经历");
    assert.equal(education.entryCount, 2);
    assert.equal(education.fieldCount, 4);
    assert.deepEqual(Array.from(report.fields, (field) => field.entryIndex), [0, 0, 1, 1]);
  } finally { dom.window.close(); }
});

test("scan validates the selected tab before and after isolated top-frame observation", async () => {
  let injections = 0;
  const selection = { tabId: 42, url: pageUrl };
  const report = { mode: "read-only" };
  const scripting = { async executeScript(request) {
    injections += 1;
    assert.equal(request.world, "ISOLATED");
    assert.deepEqual(request.target, { tabId: 42 });
    assert.deepEqual(request.args, [pageUrl]);
    return [{ frameId: 0, result: report }];
  } };
  await assert.rejects(scanCurrentTab(selection, scripting, { get: async () => ({ url: "https://jobs.example.test/other" }) }), /SCAN_PAGE_CHANGED/);
  assert.equal(injections, 0);
  assert.equal(await scanCurrentTab(selection, scripting, { get: async () => ({ url: pageUrl }) }), report);
  let reads = 0;
  await assert.rejects(scanCurrentTab(selection, scripting, { get: async () => ({ url: ++reads === 1 ? pageUrl : "https://jobs.example.test/other" }) }), /SCAN_PAGE_CHANGED/);
  assert.equal(isScannableUrl("chrome://extensions"), false);
  assert.equal(isScannableUrl("https://user:secret@jobs.example.test/"), false);
  assert.equal(isScannableUrl(pageUrl), true);
});
