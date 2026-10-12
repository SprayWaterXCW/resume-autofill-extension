import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { cleanupLegacyInterception, releaseLegacyPageHooks, LEGACY_RULE_IDS } from "../agent-extension/src/legacy-page-cleanup.js";
import { importProfile, PRIVATE_PROFILE_KEY } from "../src/core/profile-import.js";

const selection = { tabId: 42, url: "https://jobs.example.test/form" };
const rule = (id = 901001, tabId = 42) => ({ id, action: { type: "block" }, condition: { tabIds: [tabId] } });

function migrationFixture({ injectionFails = false, removeFails = false, navigated = false } = {}) {
  let rules = [rule(), rule(901002), rule(901013, 43), rule(1234, 9)];
  const calls = [];
  return { calls, rules: () => rules, api: {
    tabs: { async get(tabId) { return { id: tabId, url: navigated ? selection.url + "/new" : selection.url }; } },
    scripting: { async executeScript(options) {
      calls.push(options);
      if (injectionFails) throw new Error("Unscriptable Chrome error document");
      return [{ frameId: 0, documentId: "original-document", result: { code: "LEGACY_PAGE_CLEANED", released: true } }];
    } },
    dnr: { async getSessionRules() { return rules; }, async updateSessionRules(update) {
      calls.push(update);
      assert.equal(update.addRules, undefined, "migration never creates rules");
      if (!removeFails) rules = rules.filter((item) => !update.removeRuleIds.includes(item.id));
    } },
  } };
}

test("upgrade removes every owned legacy rule before injection, preserves unrelated rules, and needs no recovery button", async () => {
  const fixture = migrationFixture({ injectionFails: true });
  const result = await cleanupLegacyInterception(selection, fixture.api);
  assert.equal(result.removedRuleCount, 3);
  assert.deepEqual(fixture.calls[0], { removeRuleIds: [901001, 901002, 901013] });
  assert.deepEqual(fixture.rules().map(({ id }) => id), [1234]);
  assert.equal(result.cleanup.length, 2);
  assert.ok(result.cleanup.every(({ code }) => code === "LEGACY_PAGE_UNAVAILABLE"));
  assert.ok(fixture.calls.slice(1).every((options) => options.world === "MAIN"));
});

test("upgrade only targets an old document and skips a known navigation", async () => {
  const fixture = migrationFixture();
  await cleanupLegacyInterception({ ...selection, documentId: "original-document" }, fixture.api);
  assert.deepEqual(fixture.calls.find((call) => call.target?.tabId === 42).target.documentIds, ["original-document"]);
  const navigated = migrationFixture({ navigated: true });
  await cleanupLegacyInterception({ ...selection, documentId: "original-document" }, navigated.api);
  assert.equal(navigated.calls.some((call) => call.target?.tabId === 42), false);
  assert.deepEqual(navigated.rules().map(({ id }) => id), [1234]);
});

test("migration detects a failed legacy rule removal instead of claiming success", async () => {
  const fixture = migrationFixture({ removeFails: true });
  await assert.rejects(cleanupLegacyInterception(selection, fixture.api), { code: "LEGACY_RULE_CLEANUP_FAILED" });
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.rules().some(({ id }) => LEGACY_RULE_IDS.includes(id)));
});

test("legacy page cleanup works without the removed DNR permission and is idempotent", async () => {
  const fixture = migrationFixture();
  const api = { ...fixture.api, dnr: undefined };
  // An explicit null also prevents the default global API in this unit fixture.
  api.dnr = null;
  const result = await cleanupLegacyInterception(selection, api);
  assert.equal(result.removedRuleCount, 0);
  assert.equal(fixture.calls.length, 1);
  assert.equal(result.cleanup[0].released, true);
  assert.equal(fixture.calls[0].func, releaseLegacyPageHooks);
});

test("cleanup releases existing page closures, cached requests and manual submit events without changing form values", async () => {
  const dom = new JSDOM('<form><input value="虚构原有内容"><button type="submit">提交简历</button></form>',
    { url: selection.url, runScripts: "outside-only" });
  try {
    const page = dom.window;
    let released = false, requests = 0, submissions = 0;
    const originalFetch = async () => { requests++; return { ok: true }; };
    page.fetch = () => released ? originalFetch() : Promise.reject(new Error("legacy paused"));
    const cached = page.fetch;
    const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    page.document.addEventListener("submit", stop, true);
    page.__resumeAgentSubmitGuard = { release() {
      released = true; page.fetch = originalFetch;
      page.document.removeEventListener("submit", stop, true);
      delete page.__resumeAgentSubmitGuard;
    } };
    page.document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); submissions++; });
    const clean = () => page.eval(`(${releaseLegacyPageHooks.toString()})(${JSON.stringify(selection.url)})`);
    await assert.rejects(cached(), /paused/);
    assert.equal(clean().released, true);
    assert.equal(clean().released, false);
    assert.equal(page.__resumeAgentSubmitGuard, undefined);
    await cached(); await page.fetch();
    page.document.querySelector("button").click();
    assert.equal(requests, 2); assert.equal(submissions, 1);
    assert.equal(page.document.querySelector("input").value, "虚构原有内容");
  } finally { dom.window.close(); }
});

const report = { mode: "read-only", origin: "https://jobs.example.test",
  summary: { fieldCount: 1, groupCount: 1, truncated: false },
  groups: [{ id: "group-1", label: "个人信息", entryCount: 1 }], controls: [], fields: [{
    id: "field-1", groupId: "group-1", entryIndex: 0, label: "姓名", labelSource: "label", kind: "text",
    required: true, disabled: false, readOnly: false, hasValue: null, valueExcluded: true,
  }] };

test("worker planning failure, unverified writes, verified writes and refresh never install or retain page barriers", { timeout: 10_000 }, async () => {
  const previousChrome = globalThis.chrome, previousSocket = globalThis.WebSocket;
  try {
    for (const mode of ["plan-failure", "attempted-write", "verified-write", "refresh-during-plan"]) {
      let listener, updated, lateResponse, currentDocument = "original-document", signalModel;
      const modelStarted = new Promise((resolve) => { signalModel = resolve; });
      const stored = {}, methods = [], dnrCalls = [];
      const profile = importProfile({ profile: { personal: { fullName: "虚构求职者" } } }).stored;
      let complete;
      const finished = new Promise((resolve) => { complete = resolve; });
      class FixtureSocket {
        static OPEN = 1; static CLOSED = 3;
        constructor() { this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
        send(raw) {
          const message = JSON.parse(raw);
          if (["ping", "execution_event"].includes(message.type)) return;
          const response = mode === "plan-failure" ? { type: "error", id: message.id, code: "PLAN_DUPLICATE_REFERENCE" }
            : { type: "mapping", id: message.id, proposal: { snapshotId: message.context.snapshotId,
              groupMappings: [{ groupId: "group-1", sectionKeys: ["personal"] }],
              fieldMappings: [{ fieldId: "field-1", sourcePath: "personal.fullName" }], unresolved: [] } };
          if (mode === "refresh-during-plan") {
            lateResponse = () => this.onmessage?.({ data: JSON.stringify(response) }); signalModel();
          } else queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
        }
        close() { this.readyState = 3; this.onclose?.(); }
      }
      globalThis.WebSocket = FixtureSocket;
      globalThis.chrome = {
        runtime: { onMessage: { addListener(value) { listener = value; } } },
        storage: { local: { async get() { return { [PRIVATE_PROFILE_KEY]: profile }; } }, session: {
          async get() { return structuredClone(stored); }, async set(update) {
            Object.assign(stored, structuredClone(update));
            if (stored["agentTabTask:42"]?.state?.pageChanged) complete();
            if (methods.includes("clear") && stored["agentTabTask:42"]?.state?.status !== "running") complete();
          }, async remove(key) { delete stored[key]; },
        } },
        tabs: { async get() { return { id: 42, url: selection.url }; }, async query() { return [{ id: 42, url: selection.url }]; },
          onUpdated: { addListener(value) { updated = value; } } },
        declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules(update) { dnrCalls.push(update); } },
        scripting: { async executeScript(options) {
          if (options.target.documentIds?.[0] && options.target.documentIds[0] !== currentDocument) throw new Error("No such document");
          if (options.files) return [];
          if (options.func?.name === "releaseLegacyPageHooks") return [{ frameId: 0, documentId: currentDocument,
            result: { code: "LEGACY_PAGE_CLEANED", released: false } }];
          if (options.func?.name === "readFormDocument") return [{ frameId: 0, documentId: currentDocument, result: { matched: true } }];
          assert.equal(options.world, "ISOLATED", "new Agent actions never install MAIN-world interceptors");
          const method = options.args?.[0]; methods.push(method);
          let result;
          if (method === "scan") result = { token: "fictional-token", report };
          if (method === "fill") result = { code: mode === "verified-write" ? "VERIFIED" : "READBACK_MISMATCH", verified: mode === "verified-write" };
          if (method === "audit") result = options.args[1].targets.map((item) => ({ ...item, code: "VERIFIED", verified: true }));
          if (method === "prepareCommitAudit") result = [];
          if (method === "clear") setImmediate(complete);
          return [{ frameId: 0, documentId: currentDocument, result }];
        } },
      };
      await import(`../agent-extension/src/worker.js?no-barrier=${mode}`);
      const send = (type) => new Promise((resolve) => listener({ type, selection }, {}, resolve));
      assert.equal((await send("start")).ok, true);
      if (mode === "refresh-during-plan") {
        await modelStarted; currentDocument = "replacement-document";
        await updated(42, { status: "loading" }); lateResponse();
      }
      await finished;
      assert.equal(stored["agentTabTask:42"]?.state.status, mode === "plan-failure" ? "failed" : mode === "refresh-during-plan" ? "stopped"
        : mode === "verified-write" ? "partial" : "needs_review");
      assert.equal(stored["agentTabTask:42"]?.state.protectionActive, undefined);
      assert.equal(stored.realProtection, undefined);
      assert.deepEqual(dnrCalls, []);
      assert.equal(methods.includes("fill"), ["attempted-write", "verified-write"].includes(mode));
      if (mode === "verified-write") assert.equal(stored["agentTabTask:42"]?.state.result.agentWrittenFields, 1);
      assert.equal((await send("release-protection")).ok, false, "obsolete manual recovery endpoint is removed");
    }
  } finally { globalThis.chrome = previousChrome; globalThis.WebSocket = previousSocket; }
});

test("worker automatically cleans interrupted and completed legacy sessions, even without a saved recovery handle", async () => {
  const previousChrome = globalThis.chrome;
  try {
    for (const mode of ["failed", "running", "partial", "missing-state"]) {
      let listener, rules = [rule(901001), rule(901002), rule(77, 9)];
      const stored = mode === "missing-state" ? {} : { realProtection: { ...selection, documentId: "old-document" },
        agentState: { status: mode, realSite: true, protectionActive: true, result: { agentWrittenFields: 2 },
          events: [], selectedTabId: 42, selectedUrl: selection.url } };
      globalThis.chrome = { runtime: { onMessage: { addListener(value) { listener = value; } } },
        storage: { session: { async get() { return structuredClone(stored); },
          async set(update) { Object.assign(stored, structuredClone(update)); }, async remove(key) { delete stored[key]; } } },
        tabs: { async get() { return { id: 42, url: selection.url }; } },
        scripting: { async executeScript() { return [{ frameId: 0, documentId: "old-document", result: { code: "LEGACY_PAGE_CLEANED", released: true } }]; } },
        declarativeNetRequest: { async getSessionRules() { return rules; }, async updateSessionRules(update) {
          assert.equal(update.addRules, undefined); rules = rules.filter(({ id }) => !update.removeRuleIds.includes(id));
        } },
      };
      await import(`../agent-extension/src/worker.js?legacy-migration=${mode}`);
      const result = await new Promise((resolve) => listener({ type: "status", selection }, {}, resolve));
      assert.equal(result.ok, true);
      assert.deepEqual(rules.map(({ id }) => id), [77]);
      assert.equal(stored.realProtection, undefined);
      assert.equal(result.value.protectionActive, undefined);
      if (mode !== "missing-state") assert.equal(result.value.result.agentWrittenFields, 2);
      if (mode === "running") assert.equal(result.value.status, "failed");
    }
  } finally { globalThis.chrome = previousChrome; }
});
