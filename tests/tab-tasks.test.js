import test from "node:test";
import assert from "node:assert/strict";
import { importProfile, PRIVATE_PROFILE_KEY } from "../src/core/profile-import.js";

// The production worker, socket and runner execute against two fictional Chrome
// documents. Model replies are held/reordered to expose asynchronous cross-talk.
const url = "https://jobs.example.test/form";
const selections = [42, 43].map((tabId) => ({ tabId, url }));
const key = (tabId) => `agentTabTask:${tabId}`;
const report = (tabId) => ({ mode: "read-only", origin: new URL(url).origin,
  summary: { fieldCount: 1, groupCount: 1, truncated: false },
  groups: [{ id: "group-1", label: "个人信息", entryCount: 1 }], controls: [],
  fields: [{ id: `field-${tabId}`, groupId: "group-1", entryIndex: 0, label: "姓名", labelSource: "label", kind: "text",
    required: true, disabled: false, readOnly: false, hasValue: false, valueExcluded: false }],
});
async function until(check) {
  // Crypto and worker promises depend on the host scheduler. Counting event
  // loop turns can exhaust 150 polls before an otherwise healthy reply runs.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Fixture task did not reach its expected phase");
}

async function fixture(name, saved = {}) {
  const previous = { chrome: globalThis.chrome, WebSocket: globalThis.WebSocket };
  const stored = structuredClone(saved), writes = [], targets = [], model = new Map(), sockets = [], settings = {};
  const documents = new Map(selections.map(({ tabId }) => [tabId, `document-${tabId}`]));
  let active = 42, listener, updated, removed, startupGate;
  const profile = importProfile({ profile: { personal: { fullName: "虚构求职者" } } }).stored;
  class FixtureSocket {
    static OPEN = 1; static CLOSED = 3;
    constructor() { this.readyState = 1; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (["ping", "execution_event"].includes(message.type)) return;
      const tabId = Number(message.context.page.fields[0].id.slice("field-".length));
      model.set(tabId, { socket: this, context: message.context, reply: () => this.onmessage?.({ data: JSON.stringify({ type: "mapping", id: message.id,
        proposal: { snapshotId: message.context.snapshotId, groupMappings: [{ groupId: "group-1", sectionKeys: ["personal"] }],
          fieldMappings: [{ fieldId: `field-${tabId}`, sourcePath: "personal.fullName" }], unresolved: [] } }) }) });
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FixtureSocket;
  globalThis.chrome = {
    runtime: { id: "fixture-extension", onMessage: { addListener(value) { listener = value; } } },
    storage: { local: { async get() { return { ...settings, [PRIVATE_PROFILE_KEY]: profile }; }, async set(values) {
      assert.deepEqual(Object.keys(values), ["agentFillMode"], "preferences never modify the private profile"); Object.assign(settings, values);
    } },
      session: { async get() { return structuredClone(stored); }, async set(values) { Object.assign(stored, structuredClone(values)); },
        async remove(keys) { for (const item of Array.isArray(keys) ? keys : [keys]) delete stored[item]; } } },
    tabs: { async get(tabId) { if (!documents.has(tabId)) throw new Error("No such tab"); return { id: tabId, url }; },
      async query() { return [{ id: active, url }]; }, onUpdated: { addListener(value) { updated = value; } },
      onRemoved: { addListener(value) { removed = value; } } },
    scripting: { async executeScript(options) {
      const tabId = options.target.tabId, documentId = documents.get(tabId);
      targets.push(structuredClone(options.target));
      if (!documentId || (options.target.documentIds && options.target.documentIds[0] !== documentId)) throw new Error("No such document");
      if (options.files) return [];
      let result;
      const method = options.args?.[0];
      if (options.func?.name === "releaseLegacyPageHooks") {
        if (startupGate && tabId === startupGate.tabId) { startupGate.entered = true; await startupGate.promise; }
        result = { code: "LEGACY_PAGE_CLEANED", released: false };
      }
      else if (options.func?.name === "readFormDocument") result = { matched: true };
      else if (options.func?.name === "readFormStructure") result = report(tabId);
      else if (method === "scan") result = { token: `token-${tabId}`, report: report(tabId) };
      else if (method === "fill") {
        assert.equal(options.args[1].token, `token-${tabId}`);
        assert.equal(options.args[1].fieldId, `field-${tabId}`, "A task may only write its own field reference");
        writes.push({ tabId, documentId }); result = { code: "VERIFIED", verified: true };
      } else if (method === "audit") result = options.args[1].targets.map((item) => ({ ...item, code: "VERIFIED", verified: true }));
      else if (method === "prepareCommitAudit") result = [];
      return [{ frameId: 0, documentId, result }];
    } },
  };
  await import(`../agent-extension/src/worker.js?tab-tasks=${name}`);
  const send = (type, tabId = active, extra = {}) => new Promise((resolve) => listener({ type,
    selection: { tabId, url }, ...extra }, {}, resolve));
  return { stored, writes, targets, model, sockets, send,
    holdStartup(tabId) {
      let release;
      startupGate = { tabId, entered: false, promise: new Promise(resolve => { release = resolve; }) };
      return { entered: () => startupGate.entered, release };
    },
    pageWait(tabId, ms, senderExtra = {}, messageExtra = {}) { return new Promise((resolve) => listener({ type: "page-delay", ms, ...messageExtra },
      { id: "fixture-extension", tab: { id: tabId }, frameId: 0, documentId: documents.get(tabId), url, ...senderExtra }, resolve)); },
    active(tabId) { active = tabId; },
    async startBoth() {
      assert.equal((await send("start", 42)).ok, true); await until(() => model.has(42));
      active = 43; assert.equal((await send("start", 43)).ok, true); await until(() => model.has(43));
    },
    async finish(tabId) { model.get(tabId).reply(); return until(async () => {
      const state = (await send("status", tabId)).value;
      return state.status !== "running" && stored[key(tabId)]?.state?.status !== "running" && state;
    }); },
    async navigate(tabId, close = false) {
      if (close) { documents.delete(tabId); await removed(tabId); }
      else { documents.set(tabId, "replacement-document"); await updated(tabId, { status: "loading" }); }
    },
    restore() { for (const socket of sockets) socket.close(); globalThis.chrome = previous.chrome; globalThis.WebSocket = previous.WebSocket; },
  };
}

test("two same-URL tabs run independently; switching focus neither interrupts nor redirects tools", async () => {
  const f = await fixture("concurrent");
  try {
    await f.startBoth();
    const a = (await f.send("status", 42)).value, b = (await f.send("status", 43)).value;
    assert.equal(a.status, "running"); assert.equal(b.status, "running"); assert.notEqual(a.runId, b.runId);
    assert.equal((await f.send("tasks-status", 43)).value.otherTaskCount, 1);
    assert.equal((await f.send("start", 43)).ok, false, "same-tab duplicate run is rejected");
    assert.equal((await f.send("date-policy-set", 43, { monthStartDay: true })).ok, false);
    const finishedA = await f.finish(42); // A writes while B has focus and a pending model call.
    assert.equal(finishedA.result.agentWrittenFields, 1);
    assert.equal((await f.send("status", 43)).value.status, "running");
    f.active(100); // Neither task needs to be active after admission.
    const finishedB = await f.finish(43);
    assert.equal(finishedB.result.agentWrittenFields, 1);
    assert.deepEqual(f.writes.map(({ tabId }) => tabId), [42, 43]);
    for (const tabId of [42, 43]) {
      const state = f.stored[key(tabId)].state;
      assert.equal(state.selectedTabId, tabId);
      assert.ok(state.events.some((event) => event.fieldId === `field-${tabId}`));
      assert.ok(!state.events.some((event) => event.fieldId === `field-${tabId === 42 ? 43 : 42}`));
    }
    assert.ok(!JSON.stringify(f.stored).includes("虚构求职者"), "task persistence excludes actual profile values");
    assert.equal((await f.send("tasks-status")).value.activeTaskCount, 0);
  } finally { f.restore(); }
});

test("switching tabs immediately after an admitted start does not cancel startup", async () => {
  const f = await fixture("startup-focus-race");
  try {
    const gate = f.holdStartup(42);
    const startingA = f.send("start", 42);
    await until(gate.entered);
    f.active(43);
    gate.release();
    const admitted = await startingA;
    assert.equal(admitted.ok, true, "the user's admitted start must stay bound to A after switching to B");
    await until(() => f.model.has(42));
    assert.equal((await f.send("start", 43)).ok, true);
    await until(() => f.model.has(43));
    f.active(100);
    await f.finish(42); await f.finish(43);
    assert.deepEqual(f.writes.map(({ tabId }) => tabId), [42, 43]);
  } finally { f.restore(); }
});

test("refreshing the admitted tab during startup still cancels it without affecting another tab", async () => {
  const f = await fixture("startup-navigation");
  try {
    const gate = f.holdStartup(42);
    const startingA = f.send("start", 42);
    await until(gate.entered);
    await f.navigate(42);
    gate.release();
    assert.equal((await startingA).ok, false);
    const a = (await f.send("status", 42)).value;
    assert.equal(a.status, "failed");
    assert.equal(a.pageDiagnostic.trigger, "tab_loading");
    assert.equal(f.model.has(42), false);
    f.active(43);
    assert.equal((await f.send("start", 43)).ok, true);
    await until(() => f.model.has(43)); await f.finish(43);
    assert.deepEqual(f.writes.map(({ tabId }) => tabId), [43]);
  } finally { f.restore(); }
});

test("overwrite is the saved preference default and each tab freezes its starting mode independently", async () => {
  const f = await fixture("fill-preferences");
  try {
    assert.equal((await f.send("fill-preference")).value.fillMode, "overwrite");
    assert.equal((await f.send("fill-preference-set", 42, { fillMode: "invalid" })).ok, false);
    assert.equal((await f.send("fill-preference-set", 42, { fillMode: "empty" })).value.fillMode, "empty");
    assert.equal((await f.send("start", 42)).ok, true); await until(() => f.model.has(42));
    assert.equal(f.model.get(42).context.fillMode, "empty");
    assert.equal((await f.send("fill-preference-set", 42, { fillMode: "overwrite" })).ok, true);
    f.active(43); assert.equal((await f.send("start", 43)).ok, true); await until(() => f.model.has(43));
    assert.equal(f.model.get(43).context.fillMode, "overwrite");
    assert.equal((await f.send("status", 42)).value.fillMode, "empty");
    assert.equal((await f.send("status", 43)).value.fillMode, "overwrite");
    await f.finish(42); await f.finish(43);
    assert.equal(f.stored[key(42)].state.fillMode, "empty");
    assert.equal(f.stored[key(43)].state.fillMode, "overwrite");
    assert.equal(f.stored[key(42)].state.events[0].code, "FILL_MODE_EMPTY");
    assert.equal(f.stored[key(43)].state.events[0].code, "FILL_MODE_OVERWRITE");
  } finally { f.restore(); }
});

for (const action of ["stop", "reload", "close"]) {
  test(`${action} of tab A leaves tab B's socket, document, progress and result independent`, async () => {
    const f = await fixture(action);
    try {
      await f.startBoth();
      if (action === "stop") {
        assert.equal((await f.send("stop", 42)).ok, true);
        await until(async () => (await f.send("status", 42)).value.status === "stopped");
      } else await f.navigate(42, action === "close");
      assert.equal(f.model.get(42).socket.readyState, 3);
      assert.equal(f.model.get(43).socket.readyState, 1);
      assert.equal((await f.send("status", 43)).value.status, "running");
      f.model.get(42).reply(); // A late reply cannot restart an abandoned job or write to the new document.
      const finishedB = await f.finish(43);
      assert.equal(finishedB.result.agentWrittenFields, 1);
      assert.deepEqual(f.writes, [{ tabId: 43, documentId: "document-43" }]);
      if (action === "close") { assert.equal(f.stored[key(42)], undefined); assert.equal((await f.send("status", 42)).value.status, "idle"); }
      else {
        const a = (await f.send("status", 42)).value;
        assert.equal(a.status, "stopped"); assert.match(a.error, new RegExp(action === "stop" ? "USER_STOPPED" : "REAL_PAGE_CHANGED"));
        assert.equal(a.pageChanged === true, action === "reload");
        if (action === "reload") assert.equal(a.pageDiagnostic.trigger, "tab_loading");
      }
    } finally { f.restore(); }
  });
}

test("worker restart recovers each tab separately and marks only interrupted jobs failed", async () => {
  const saved = Object.fromEntries(selections.map((selection, i) => [key(selection.tabId), { selection,
    state: { status: i === 0 ? "running" : "partial", selectedTabId: selection.tabId, selectedUrl: url,
      events: [], result: { agentWrittenFields: i + 1 } }, planState: { status: "idle", events: [] }, lastScan: null }]));
  const f = await fixture("restart", saved);
  try {
    assert.equal((await f.send("status", 42)).value.status, "failed");
    assert.equal((await f.send("status", 43)).value.status, "partial");
    assert.equal((await f.send("status", 43)).value.result.agentWrittenFields, 2);
    assert.equal(f.sockets.length, 0, "restart never replays previous writes");
  } finally { f.restore(); }
});


test("background wait bridge authenticates the job/document and cancels one tab's pending waits independently", async () => {
  const f = await fixture("wait-bridge");
  try {
    await f.startBoth();
    assert.deepEqual(await f.pageWait(42, 5), { ok: true, value: { waited: true } });
    for (const [ms, sender, message] of [[0, {}, {}], [1001, {}, {}], [5, { id: "other-extension" }, {}],
      [5, { documentId: "document-43" }, {}], [5, { frameId: 1 }, {}], [5, { url: url + "/other" }, {}], [5, {}, { value: "forbidden-payload" }]]) {
      assert.equal((await f.pageWait(42, ms, sender, message)).ok, false);
    }
    const pendingA = f.pageWait(42, 1000), pendingB = f.pageWait(43, 10);
    assert.equal((await f.send("stop", 42)).ok, true);
    assert.deepEqual(await pendingA, { ok: false, error: "USER_STOPPED" });
    assert.deepEqual(await pendingB, { ok: true, value: { waited: true } });
    await f.finish(43);
    assert.equal((await f.pageWait(43, 5)).ok, false, "finished jobs cannot request page timers");
  } finally { f.restore(); }
});
