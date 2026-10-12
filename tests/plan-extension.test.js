import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { createSyntheticLedger } from "../src/fixtures/synthetic-ledger.js";

const selection = { tabId: 42, url: "https://jobs.example.test/application", title: "虚构招聘表单" };
function scanReport() {
  return { mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: [{ id: "group-1", label: "教育经历", entryCount: 1 }],
    fields: ["毕业学校", "所学专业"].map((label, index) => ({
      id: `field-${index + 1}`, groupId: "group-1", entryIndex: 0, label, labelSource: "label", kind: "text",
      required: true, disabled: false, readOnly: false, hasValue: false, valueExcluded: false,
    })), controls: [],
  };
}
function proposal(context) {
  return { snapshotId: context.snapshotId, groupMappings: [{ groupId: "group-1", sectionKeys: ["educations"] }],
    fieldMappings: [{ fieldId: "field-1", sourcePath: "educations.0.school" }, { fieldId: "field-2", sourcePath: "educations.0.major" }], unresolved: [] };
}

test("background planning survives focus changes, serializes same-tab work and scopes results to the original page", async () => {
  const previousChrome = globalThis.chrome;
  const previousSocket = globalThis.WebSocket;
  let listener;
  let scans = 0;
  let resolveModel;
  let active = selection;
  const stored = { planState: { status: "running", selectedTabId: selection.tabId, selectedUrl: selection.url, events: [] } };
  const requests = [];
  class FixtureSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === "ping") return;
      requests.push(message);
      resolveModel = () => this.onmessage?.({ data: JSON.stringify({ type: "mapping", id: message.id, proposal: proposal(message.context) }) });
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FixtureSocket;
  globalThis.chrome = {
    runtime: { onMessage: { addListener(value) { listener = value; } } },
    storage: { local: { async get() { return {}; } }, session: {
      async get() { return structuredClone(stored); },
      async set(update) { Object.assign(stored, structuredClone(update)); },
      async remove(key) { delete stored[key]; },
    } },
    tabs: { async query() { return [{ id: active.tabId, url: active.url }]; }, async get() { return { url: selection.url }; } },
    scripting: { async executeScript(options) {
      assert.equal(options.func.name, "readFormStructure");
      assert.equal(options.world, "ISOLATED");
      scans += 1;
      return [{ frameId: 0, result: scanReport() }];
    } },
  };
  const send = (type, selected = selection) => new Promise((resolve) => listener({ type, selection: selected }, {}, resolve));
  try {
    await import(`../agent-extension/src/worker.js?test=planning`);
    const recovered = await send("plan-status");
    assert.equal(recovered.value.status, "failed");
    assert.match(recovered.value.error, /后台已中断/);
    assert.equal((await send("plan-start")).value.status, "running");
    for (let attempt = 0; !resolveModel && attempt < 30; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "plan");
    assert.equal((await send("scan")).ok, false);
    assert.equal((await send("start")).ok, false);
    assert.equal((await send("plan-start")).ok, false);
    assert.equal((await send("plan-status", { ...selection, tabId: 43 })).value.status, "idle");
    active = { ...selection, tabId: 43 };
    resolveModel();
    let ready;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      ready = (await send("plan-status")).value;
      if (ready.status !== "running") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(ready.status, "ready");
    assert.equal(ready.plan.summary.additionalEntries, 1);
    assert.equal(ready.plan.executable, false);
    assert.equal(scans, 2);
    assert.equal(ready.events.length, 4);
    active = selection;
    assert.equal((await send("scan")).ok, true);
    assert.equal((await send("plan-status")).value.status, "idle");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.WebSocket = previousSocket;
  }
});

test("popup presents a source-backed plan as a suggestion and keeps real-site execution disabled", async () => {
  const context = await createPlanContext(scanReport(), createSyntheticLedger());
  const plan = await buildFillPlan(context, proposal(context));
  // Untrusted labels must remain text, including in the new plan view.
  plan.items[0].label = "<img src=x onerror=alert(1)>";
  const state = { status: "ready", plan, events: [{ phase: "validate", summary: "资料来源与引用已校验" }] };
  const html = readFileSync(new URL("../agent-extension/popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../agent-extension/popup.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.chrome = { tabs: { async query() { return [{ id: selection.tabId, url: selection.url, title: selection.title }]; } },
    runtime: { async sendMessage(message) {
      const value = message.type === "preview" ? { supported: false, scannable: true, reason: "虚构网页可规划" }
        : message.type === "date-policy" ? { monthStartDay: false }
        : message.type === "fill-preference" ? { fillMode: "overwrite" }
        : message.type === "status" ? { status: "idle", events: [] }
        : message.type === "plan-status" ? state : null;
      return { ok: true, value };
    } },
  };
  try {
    dom.window.eval(js);
    for (let attempt = 0; dom.window.document.getElementById("plan-card").hidden && attempt < 10; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document;
    assert.equal(document.getElementById("plan-card").hidden, false);
    assert.equal(document.getElementById("run").disabled, true);
    assert.equal(document.getElementById("plan").disabled, false);
    assert.match(document.getElementById("plan-summary").textContent, /还需 1 组记录/);
    assert.match(document.getElementById("plan-groups").textContent, /educations\.0\.school/);
    assert.equal(document.querySelector("#plan-groups img"), null);
    const details = document.querySelector("#plan-groups details");
    details.open = true;
    await dom.window.eval("refreshStatus()");
    assert.equal(document.querySelector("#plan-groups details").open, true);
    assert.match(document.getElementById("plan-boundary").textContent, /没有执行填写、添加、保存或提交/);
  } finally { dom.window.close(); }
});

test("internal Chrome pages still show saved profile and date policy while page actions stay disabled", async () => {
  const html = readFileSync(new URL("../agent-extension/popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../agent-extension/popup.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const requested = [];
  const opened = [];
  dom.window.chrome = { tabs: {
      async query() { return [{ id: 42, url: "chrome://extensions/", title: "扩展程序" }]; },
      async create(options) { opened.push(options.url); },
    },
    runtime: { getURL(path) { return "chrome-extension://fixture/" + path; }, async sendMessage(message) {
      requested.push(message.type);
      const value = message.type === "profile-status" ? { available: true, purpose: "personal_use", factCount: 5, derivedFactCount: 2,
        sections: [{ label: "虚构教育经历", recordCount: 2 }] }
        : message.type === "date-policy" ? { monthStartDay: true }
        : message.type === "fill-preference" ? { fillMode: "empty" }
        : message.type === "status" ? { status: "idle", events: [] }
        : message.type === "plan-status" ? { status: "idle", events: [] }
        : null;
      return { ok: true, value };
    } },
  };
  try {
    dom.window.eval(js);
    const document = dom.window.document;
    for (let attempt = 0; document.getElementById("scope").textContent !== "不可用" && attempt < 10; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.getElementById("profile-state").textContent, "已配置");
    assert.match(document.getElementById("profile-summary").textContent, /3 个原始资料项，2 个有来源的派生项/);
    assert.equal(document.getElementById("month-start-day").checked, true);
    assert.equal(document.getElementById("fill-mode").value, "empty");
    assert.match(document.getElementById("fill-mode-note").textContent, /只填写空白字段/);
    for (const id of ["run", "scan", "plan"]) assert.equal(document.getElementById(id).disabled, true);
    assert.equal(document.getElementById("scope").textContent, "不可用");
    assert.equal(requested.includes("preview"), false);
    assert.ok(requested.includes("profile-status") && requested.includes("date-policy"));
    document.getElementById("profile-edit").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ["chrome-extension://fixture/profile-editor.html"]);
  } finally { dom.window.close(); }
});

test("popup permits this tab to start while another tab is running and stops only its own task", async () => {
  const html = readFileSync(new URL("../agent-extension/popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../agent-extension/popup.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const own = { ...selection, tabId: 43 }, messages = [];
  let state = { status: "idle", events: [] };
  dom.window.chrome = { tabs: { async query() { return [{ id: own.tabId, url: own.url, title: own.title }]; } },
    runtime: { async sendMessage(message) {
      messages.push(message);
      let value = null;
      if (message.type === "preview") value = { supported: true, scannable: true, realSite: true };
      if (message.type === "profile-status") value = { available: true, factCount: 1, sections: [] };
      if (message.type === "date-policy") value = { monthStartDay: false };
      if (message.type === "fill-preference") value = { fillMode: "overwrite" };
      if (message.type === "tasks-status") value = { activeTaskCount: state.status === "running" ? 2 : 1, otherTaskCount: 1 };
      if (message.type === "plan-status") value = { status: "idle", events: [] };
      if (message.type === "status") value = state;
      if (message.type === "start") value = state = { status: "running", realSite: true, selectedTabId: 43, selectedUrl: own.url, runId: "own-run", events: [] };
      if (message.type === "stop") value = { requested: true };
      return { ok: true, value };
    } } };
  try {
    dom.window.eval(js);
    const document = dom.window.document;
    for (let i = 0; !document.getElementById("background-note").textContent.includes("另有 1") && i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.match(document.getElementById("background-note").textContent, /另有 1/);
    assert.equal(document.getElementById("run").disabled, false);
    assert.equal(document.getElementById("profile-import").disabled, true);
    assert.equal(document.getElementById("month-start-day").disabled, true);
    document.getElementById("run").click();
    for (let i = 0; document.getElementById("stop").hidden && i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.getElementById("stop").hidden, false);
    assert.match(document.getElementById("run-note").textContent, /切换标签页/);
    document.getElementById("stop").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages.filter((message) => ["start", "stop"].includes(message.type)).map((message) =>
      ({ type: message.type, tabId: message.selection.tabId })), [{ type: "start", tabId: 43 }, { type: "stop", tabId: 43 }]);
  } finally { dom.window.close(); }
});
