import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";
import { decoratedFormHtml, decoratedProfile, installDecoratedControls } from "../src/fixtures/decorated-form.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { runRealForm } from "../src/core/real-runner.js";
import { matchFillTargets, matchWrittenTargets, sameFillTargets } from "../src/core/form-structure-identity.js";

const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const url = "https://fictional-rerender.example.test/form";
function harness(html, fillMode = "overwrite") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  const calls = [];
  const environment = new ChromeFormEnvironment({ tabId: 42, url }, { documentId: "fictional-document", fillMode,
    tabs: { async get() { return { id: 42, url }; }, async query() { return [{ id: 42, url }]; } },
     scripting: { async executeScript(options) {
      assert.equal(options.target.documentIds[0], "fictional-document");
      if (options.files) { dom.window.eval(bundle.outputFiles[0].text); return []; }
      if (options.world === "MAIN") {
        calls.push("page_input");
        const result = await dom.window.eval(`(${options.func.toString()})`)(...options.args);
        return [{ frameId: 0, documentId: "fictional-document", result }];
      }
      if (["provePreviousAgentWrites", "readPreviousAgentReport", "readFormStructure"].includes(options.func.name)) {
        calls.push("prove_previous");
        const result = await dom.window.eval(`(${options.func.toString()})`)(...options.args);
        return [{ frameId: 0, documentId: "fictional-document", result }];
      }
      const [method, args] = options.args; calls.push(method);
      const result = await dom.window.__resumeAgentRuntime[method](args);
      return [{ frameId: 0, documentId: "fictional-document", result }];
    } } });
  return { dom, environment, calls };
}

test("dependent locking keeps only proven readback receipts, never write permission or a changed value", async () => {
  for (const edited of [false, true]) {
    const { dom, environment, calls } = harness('<section><h2>个人信息</h2><label>学历<input id="degree"></label><label>邮箱<input id="email"></label></section>');
    try {
      const document = dom.window.document, events = [];
      const ledger = ledgerFromProfile(importProfile({ profile: { personal: { highestEducationLevel: "硕士", email: "fictional@example.test" } } }).stored);
      let original;
      document.querySelector('#email').addEventListener('change', () => {
        original = document.querySelector('#degree');
        const replacement = original.cloneNode(true);
        replacement.disabled = true; replacement.readOnly = true;
        if (edited) replacement.value = "虚构人工修改";
        original.replaceWith(replacement);
      }, { once: true });
      const before = await environment.observe();
      const run = await runRealForm({ environment, ledger, onEvent: (event) => events.push(event), planner: {
        async planMappings(context) {
          return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [],
            fieldMappings: context.page.fields.filter((field) => !field.hasValue).map((field) => ({ fieldId: field.id,
              sourcePath: field.label === "学历" ? "personal.highestEducationLevel" : "personal.email" })) };
        }
      } });
      assert.equal(run.result.agentWrittenFields, edited ? 1 : 2, JSON.stringify(run.outcomes));
      assert.equal(run.result.unresolvedCount, edited ? 1 : 0);
      assert.equal(calls.filter((method) => method === 'fill').length, 2);
      assert.ok(events.some((event) => event.code === 'WRITE_RECEIPT_LOCKED'));
      assert.equal(events.some((event) => event.code === 'WRITE_TARGET_RETIRED'), false);
      const after = await environment.observe(), degree = after.fields.find((field) => field.label === "学历");
      assert.equal(sameFillTargets(before, after), false);
      assert.equal(matchFillTargets(before, after).some((pair) => pair.afterId === degree.id), false);
      assert.equal(matchWrittenTargets(before, after, [before.fields[0].id]).some((pair) => pair.afterId === degree.id && pair.auditOnly), true);
      assert.equal((await environment.fill({ fieldId: degree.id, sourcePath: 'personal.highestEducationLevel' }, ledger)).code, 'PROTECTED');
      assert.equal(document.querySelector('#degree').value, edited ? "虚构人工修改" : "硕士");
      // A new question or an empty locked field cannot acquire a receipt.
      assert.equal(matchWrittenTargets(before, { ...after, fields: after.fields.map((field) => field.id === degree.id ? { ...field, hasValue: false } : field) }, [before.fields[0].id])
        .some((pair) => pair.afterId === degree.id), false);
    } finally { dom.window.close(); }
  }
});

test("production environment reacquires replaced education nodes and preserves verified receipts through later rerenders", async () => {
  const form = decoratedFormHtml(), { dom, environment } = harness(form.html);
  try {
    const document = dom.window.document, ledger = ledgerFromProfile(importProfile(decoratedProfile()).stored);
    const options = { coupledDateDefaults: true };
    installDecoratedControls(document, form, options);
    let replacedEducation = false, replacedEmail = false, submits = 0;
    const email = document.querySelector('[data-fixture-target="personal.email"]');
    email.addEventListener("change", () => {
      const root = document.querySelector("#fixture-education"), replacement = root.cloneNode(true);
      root.replaceWith(replacement); installDecoratedControls(document, form, options, replacement);
      replacedEducation = true;
    });
    document.querySelector('[data-fixture-target="languages.0.name"]').addEventListener("change", () => {
      email.replaceWith(email.cloneNode(true)); replacedEmail = true;
    });
    document.querySelector("#fixture-submit").addEventListener("click", () => submits++);
    const events = [];
    const run = await runRealForm({ environment, ledger, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) {
        const fieldMappings = [], unresolved = [];
        for (const field of context.page.fields) {
          if (field.kind === "checkbox") continue;
          const path = dom.window.__resumeAgentBindings.fields.get(field.id).element.getAttribute("data-fixture-target");
          if (ledger.hasPath(path)) fieldMappings.push({ fieldId: field.id, sourcePath: path });
          else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
        }
        return { snapshotId: context.snapshotId, groupMappings: [], fieldMappings, unresolved };
      }
    } });
    assert.equal(replacedEducation, true); assert.equal(replacedEmail, true);
    assert.equal(run.result.agentAddedCards, 3);
    assert.equal(run.result.agentWrittenFields, 35, JSON.stringify(run.outcomes.filter((outcome) => !outcome.verified)));
    assert.equal(run.result.unresolvedCount, 0); assert.equal(submits, 0);
    assert.equal(run.outcomes.filter((outcome) => outcome.verified).every((outcome) => outcome.tool === "add_entry" || outcome.finalVerified), true);
    assert.equal(run.outcomes.some((outcome) => outcome.diagnostic?.bindingRefreshed && outcome.diagnostic.structureMatched), true);
    assert.equal(events.some((event) => event.summary.includes("重新扫描确认")), true);
    for (const input of document.querySelectorAll('[data-fixture-target$="DateMonth"]')) {
      const path = input.getAttribute("data-fixture-target");
      if (ledger.hasPath(path)) assert.equal(input.closest(".widget-select-container").querySelector(".widget-display-value").textContent, ledger.getValue(path) + "月");
    }
  } finally { dom.window.close(); }
});

test("a transient empty group closing during planning does not stop one start, and empty add sections stay actionable", async () => {
  const { dom, environment } = harness(`<section data-agent-group><h2>基本信息</h2><label>邮箱<input id="email"></label></section>
    <section data-agent-group id="education"><h2>教育经历</h2><div id="records"></div><button type="button">添加教育经历</button></section>
    <section data-agent-group id="transient"><h2>临时提示</h2><button type="button">收起</button></section>
    <button type="submit" id="submit">提交简历</button>`);
  try {
    const document = dom.window.document, events = [];
    const ledger = ledgerFromProfile(importProfile({ profile: { personal: { email: "fictional@example.test" },
      educations: [{ school: "虚构学校" }] } }).stored);
    let modelCalls = 0, submits = 0;
    document.querySelector("#submit").addEventListener("click", () => submits++);
    document.querySelector("#education button").addEventListener("click", () => {
      document.querySelector("#records").insertAdjacentHTML("beforeend", '<div data-agent-entry><label>学校名称<input id="school"></label></div>');
    });
    const run = await runRealForm({ environment, ledger, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) {
        modelCalls++;
        assert.equal(context.page.groups.some((group) => group.label === "临时提示"), false);
        const education = context.page.groups.find((group) => group.label === "教育经历");
        assert.equal(education.hasAddCandidate, true);
        if (modelCalls === 1) {
          assert.equal(context.page.fields.filter((field) => field.groupId === education.id).length, 0);
          document.querySelector("#transient").remove();
        }
        return { snapshotId: context.snapshotId, groupMappings: [{ groupId: education.id, sectionKeys: ["educations"] }],
          fieldMappings: context.page.fields.map((field) => ({ fieldId: field.id,
            sourcePath: field.label === "邮箱" ? "personal.email" : "educations.0.school" })), unresolved: [] };
      }
    } });
    assert.equal(modelCalls, 2, JSON.stringify(events.filter((event) => event.code || event.tool === "add_entry")));
    assert.equal(run.result.structureRecoveries, 0);
    assert.equal(run.result.agentAddedCards, 1);
    assert.equal(run.result.agentWrittenFields, 2);
    assert.equal(run.result.pendingEntries, 0);
    assert.equal(document.querySelector("#email").value, "fictional@example.test");
    assert.equal(document.querySelector("#school").value, "虚构学校");
    assert.equal(submits, 0);
    assert.equal(events.some((event) => event.tool === "replan"), false);
  } finally { dom.window.close(); }
});

test("ignoring an empty group still stops a user edit during valid model planning before any write", async () => {
  const { dom, environment, calls } = harness(`<section data-agent-group><h2>教育经历</h2><label>学校名称<input id="school"></label></section>
    <section data-agent-group id="transient"><h2>临时提示</h2><button type="button">收起</button></section>`);
  try {
    const ledger = ledgerFromProfile(importProfile({ profile: { educations: [{ school: "虚构学校" }] } }).stored);
    await assert.rejects(runRealForm({ environment, ledger, planner: {
      async planMappings(context) {
        dom.window.document.querySelector("#transient").remove();
        dom.window.document.querySelector("#school").value = "虚构人工修改";
        return { snapshotId: context.snapshotId, groupMappings: [{ groupId: context.page.fields[0].groupId, sectionKeys: ["educations"] }], unresolved: [],
          fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "educations.0.school" }] };
      }
    } }), { code: "REAL_PAGE_CHANGED" });
    assert.equal(calls.includes("fill"), false);
    assert.equal(calls.includes("add"), false);
    assert.equal(dom.window.document.querySelector("#school").value, "虚构人工修改");
  } finally { dom.window.close(); }
});

test("one start replans a cold-page reset and fills sections that appear later", async () => {
  const record = (section, i, caption) => `<div data-agent-entry><label>${caption}<input data-fixture-target="${section}.${i}.${section === "educations" ? "school" : "name"}"></label></div>`;
  const html = `<section><h2>个人信息</h2><label>邮箱<input data-fixture-target="personal.email"></label></section>`
    + `<section id="education"><h2>教育经历</h2><div id="records">${record("educations", 0, "学校名称")}</div><button type="button">添加</button></section>`
    + `<section id="awards"><h2>获奖经历</h2><div id="award-records">${record("awards", 0, "奖项名称")}</div><button type="button">添加</button></section>`
    + `<button type="submit" id="submit">提交简历</button>`;
  const { dom, environment } = harness(html);
  try {
    const document = dom.window.document, events = [];
    const ledger = ledgerFromProfile(importProfile({ profile: { personal: { email: "fictional@example.test" },
      educations: [{ school: "虚构学校甲" }, { school: "虚构学校乙" }],
      awardRecords: { version: 1, awards: [{ id: "fictional-a", name: "虚构奖项甲" }, { id: "fictional-b", name: "虚构奖项乙" }], competitions: [] } } }).stored);
    let submits = 0;
    document.querySelector("#submit").addEventListener("click", () => submits++);
    const awards = document.querySelector("#awards");
    document.querySelector('[data-fixture-target="personal.email"]').addEventListener("change", () => {
      const old = document.querySelector("#records"), next = old.cloneNode(true);
      old.replaceWith(next); awards.remove();
      next.querySelector("input").addEventListener("change", () => document.body.append(awards), { once: true });
    }, { once: true });
    for (const [id, section, caption] of [["education", "educations", "学校名称"], ["awards", "awards", "奖项名称"]]) {
      document.querySelector(`#${id} button`).addEventListener("click", () => {
        const root = document.querySelector(section === "educations" ? "#records" : "#award-records");
        root.insertAdjacentHTML("beforeend", record(section, root.children.length, caption));
      });
    }
    const run = await runRealForm({ environment, ledger, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) {
        const fieldMappings = [], unresolved = [];
        for (const field of context.page.fields) {
          if (field.hasValue) continue;
          const path = dom.window.__resumeAgentBindings.fields.get(field.id).element.getAttribute("data-fixture-target");
          if (ledger.hasPath(path)) fieldMappings.push({ fieldId: field.id, sourcePath: path });
          else unresolved.push({ fieldId: field.id, reason: "missing_profile" });
        }
        return { snapshotId: context.snapshotId, groupMappings: [], fieldMappings, unresolved };
      }
    } });
    assert.equal(submits, 0);
    assert.equal(run.result.agentAddedCards, 2, JSON.stringify({ result: run.result, sections: run.plan.sections, events: events.filter((event) => ["plan", "add_entry", "replan"].includes(event.tool)) }));
    assert.equal(run.result.agentWrittenFields, 5);
    assert.equal(run.result.pendingEntries, 0);
    assert.equal(run.result.remainingBlankFields, 0);
    assert.ok(events.some((event) => event.tool === "replan" && event.code === "REAL_FORM_STRUCTURE_CHANGED"));
    assert.ok(events.findIndex((event) => event.tool === "fill_field") < events.findIndex((event) => event.tool === "add_entry"));
    for (const input of document.querySelectorAll("input")) assert.equal(input.value, ledger.getValue(input.getAttribute("data-fixture-target")));
  } finally { dom.window.close(); }
});

test("continuous same-document topology changes exhaust recovery before any page write", async () => {
  const { dom, environment, calls } = harness('<section><h2>教育经历</h2><label>学校名称<input data-fixture-target="educations.0.school"></label></section>');
  try {
    const ledger = ledgerFromProfile(importProfile({ profile: { educations: [{ school: "虚构学校" }] } }).stored);
    const events = []; let requests = 0;
    await assert.rejects(runRealForm({ environment, ledger, maxStructureRecoveries: 2, onEvent: (event) => events.push(event), planner: {
      async planMappings(context) {
        requests += 1;
        dom.window.document.body.insertAdjacentHTML("beforeend", `<label>附加编号${requests}<input></label>`);
        return { snapshotId: context.snapshotId, groupMappings: [], fieldMappings: [{ fieldId: context.page.fields[0].id, sourcePath: "educations.0.school" }],
          unresolved: context.page.fields.slice(1).map((field) => ({ fieldId: field.id, reason: "missing_profile" })) };
      }
    } }), { code: "REAL_RECOVERY_LIMIT" });
    assert.equal(requests, 3);
    assert.equal(calls.filter((method) => ["fill", "add"].includes(method)).length, 0);
    assert.equal(events.filter((event) => event.tool === "replan").length, 2);
  } finally { dom.window.close(); }
});

test("a changed field topology prevents a stale validated mapping from writing the new layout", async () => {
  const { dom, environment, calls } = harness('<section><h2>教育经历</h2><label>学校名称<input id="school"></label></section>');
  try {
    const report = await environment.observe(), field = report.fields[0];
    const label = dom.window.document.querySelector("label"), replacement = label.cloneNode(true);
    replacement.firstChild.nodeValue = "专业名称"; label.replaceWith(replacement);
    const ledger = { hasPath() { return true; }, getValue() { return "虚构学校"; } };
    await assert.rejects(environment.fill({ fieldId: field.id, sourcePath: "educations.0.school" }, ledger), { code: "REAL_FORM_STRUCTURE_CHANGED" });
    assert.equal(dom.window.document.querySelector("input").value, "");
    assert.equal(calls.filter((method) => method === "fill").length, 1);
  } finally { dom.window.close(); }
});

test("rerendering fields alongside unrelated buttons does not abort a validated fill", async () => {
  const { dom, environment } = harness('<section><h2>教育经历</h2><label>学校名称<input id="school"></label></section><aside><button>保存草稿</button></aside>');
  try {
    const report = await environment.observe(), field = report.fields[0];
    const old = dom.window.document.querySelector("label"); old.replaceWith(old.cloneNode(true));
    dom.window.document.querySelector("aside").innerHTML = '<h3>更新说明</h3><button>保存中</button><button>查看帮助</button>';
    const outcome = await environment.fill({ fieldId: field.id, sourcePath: "educations.0.school" },
      { hasPath() { return true; }, getValue() { return "虚构学校"; } });
    assert.equal(outcome.verified, true);
    assert.equal(outcome.diagnostic.bindingRefreshed, true);
    assert.ok(outcome.structureDiagnostic.changedCount > 0);
    assert.equal(outcome.structureDiagnostic.changes.some((change) => change.area === "fields"), false);
    assert.equal(dom.window.document.querySelector("input").value, "虚构学校");
  } finally { dom.window.close(); }
});

test("refresh preserves only receipts whose current values still match and never rewrites a user's replacement value", async () => {
  const { dom, environment } = harness('<section><h2>个人信息</h2><label>邮箱<input id="email"></label></section>', "empty");
  try {
    const report = await environment.observe(), field = report.fields[0];
    const item = { fieldId: field.id, sourcePath: "personal.email" };
    const ledger = { hasPath() { return true; }, getValue() { return "fictional@example.test"; } };
    assert.equal((await environment.fill(item, ledger)).verified, true);
    const old = dom.window.document.querySelector("input"), replacement = old.cloneNode(true);
    replacement.value = "user-edited@example.test"; old.replaceWith(replacement);
    const [audit] = await environment.audit([item]);
    assert.equal(audit.verified, false); assert.equal(audit.diagnostic.bindingRefreshed, true);
    assert.equal(audit.diagnostic.receiptPresent, false);
    assert.equal((await environment.fill(item, ledger)).code, "PROTECTED");
    assert.equal(replacement.value, "user-edited@example.test");
    assert.equal(JSON.stringify(audit).includes("example.test"), false);
  } finally { dom.window.close(); }
});

test("repair withdraws an incompatible old Agent write only with a live receipt and unchanged value", async () => {
  for (const edited of [false, true]) {
    const { dom, environment } = harness('<section><h2>求职意向</h2><label>最近薪资<input></label></section>');
    try {
      const report = await environment.observe(), field = report.fields[0];
      const ledger = ledgerFromProfile(importProfile({ profile: { jobPreferences: { expectedSalary: "虚构薪资" } } }).stored);
      const item = { fieldId: field.id, sourcePath: "jobPreferences.expectedSalary", groupId: field.groupId, entryIndex: 0, label: field.label, kind: field.kind };
      // Seed the receipt via the earlier page protocol, independently of the
      // current environment's semantic gate; no real browser or profile used.
      const written = await dom.window.__resumeAgentRuntime.fill({ token: environment.token, ...item, value: ledger.getValue(item.sourcePath) });
      assert.equal(written.verified, true);
      await environment.clear();
      if (edited) dom.window.document.querySelector("input").value = "用户的新内容";
      const repaired = await environment.repairPreviousWrites(edited ? { selectedTabId: 42, selectedUrl: url,
        items: [item], outcomes: [{ tool: "fill_field", ...item, verified: true, finalVerified: true }] } : undefined, ledger);
      assert.equal(repaired.length, 1);
      assert.equal(repaired[0].verified, !edited);
      assert.equal(dom.window.document.querySelector("input").value, edited ? "用户的新内容" : "");
      assert.equal(JSON.stringify(repaired).includes("虚构薪资"), false);
    } finally { dom.window.close(); }
  }
});
