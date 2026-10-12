import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { WebSocket } from "ws";
import { z } from "zod";
import { ChromeDemoEnvironment, DEMO_URL, DEMO_PROBE_URL, isDemoUrl } from "../agent-extension/src/demo-tab.js";
import { ChromeFormEnvironment, bindFormDocument } from "../agent-extension/src/real-tab.js";
import { attachAgentSocket, EXTENSION_ORIGIN } from "../web-demo/agent-socket.js";
import { createSyntheticCatalog } from "../src/fixtures/synthetic-form.js";

test("ordinary Chrome extension has tab-scoped actions without network interception and a stable localhost origin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../agent-extension/manifest.json", import.meta.url)));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage"]);
  assert.ok(!manifest.permissions.includes("debugger"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  const id = [...digest].map((hex) => String.fromCharCode(97 + parseInt(hex, 16))).join("");
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${id}`);
});

test("document binding only reads the selected main frame and requires a verified document ID", async () => {
  const selection = { tabId: 42, url: "https://jobs.example.test/form" };
  let outputs = [{ frameId: 0, documentId: "original-document", result: { matched: true } }], active = selection;
  const injections = [];
  const deps = { tabs: { async get(tabId) { return { id: tabId, url: active.url }; } },
    scripting: { async executeScript(options) { injections.push(options); return outputs; } } };
  assert.equal(await bindFormDocument(selection, deps), "original-document");
  assert.equal(injections[0].world, "ISOLATED");
  assert.deepEqual(injections[0].target, { tabId: 42, frameIds: [0] });
  outputs = [{ frameId: 0, result: { matched: true } }];
  await assert.rejects(bindFormDocument(selection, deps), { code: "REAL_DOCUMENT_UNVERIFIED" });
  outputs = [{ frameId: 0, documentId: "new", result: { matched: false } }];
  await assert.rejects(bindFormDocument(selection, deps), { code: "REAL_DOCUMENT_UNVERIFIED" });
  active = { ...selection, url: "https://jobs.example.test/other" };
  const before = injections.length;
  await assert.rejects(bindFormDocument(selection, deps), { code: "REAL_PAGE_CHANGED" });
  assert.equal(injections.length, before);
});

test("background form tools retain the original tab without querying the foreground tab", async () => {
  const selection = { tabId: 42, url: "https://jobs.example.test/form" };
  const targets = [];
  const tabs = { async get(tabId) { assert.equal(tabId, 42); return { id: tabId, url: selection.url }; },
    async query() { throw new Error("Execution must not depend on foreground selection"); } };
  const scripting = { async executeScript(options) {
    targets.push(options.target);
    const result = options.func?.name === "readFormDocument" ? { matched: true }
      : options.args?.[0] === "scan" ? { token: "fictional-token", report: { mode: "read-only", fields: [] } }
      : { code: "VERIFIED", verified: true };
    return [{ frameId: 0, documentId: "original-document", result }];
  } };
  const documentId = await bindFormDocument(selection, { tabs, scripting });
  const environment = new ChromeFormEnvironment(selection, { tabs, scripting, documentId });
  await environment.observe();
  assert.equal((await environment.fill({ fieldId: "field-1", sourcePath: "personal.fullName" },
    { hasPath() { return true; }, getValue() { return "虚构姓名"; } })).verified, true);
  assert.ok(targets.every((target) => target.tabId === 42));
  assert.ok(targets.slice(1).every((target) => target.documentIds[0] === "original-document"));
});

test("same-URL reload cannot redirect an old form tool into the replacement document", async () => {
  const selection = { tabId: 42, url: "https://jobs.example.test/form" };
  let currentDocument = "old-document", writes = 0;
  const targets = [];
  const environment = new ChromeFormEnvironment(selection, { documentId: currentDocument,
    tabs: { async get() { return { id: selection.tabId, url: selection.url }; }, async query() { return [{ id: selection.tabId, url: selection.url }]; } },
    scripting: { async executeScript(options) {
      targets.push(options.target);
      if (options.target.documentIds?.[0] !== currentDocument) throw new Error("No such document");
      if (options.files) return [];
      if (options.args[0] === "fill") writes += 1;
      return [{ frameId: 0, documentId: currentDocument, result: { token: "fictional-token", report: { mode: "read-only", fields: [] } } }];
    } },
  });
  await environment.observe();
  currentDocument = "new-document";
  await assert.rejects(environment.fill({ fieldId: "field-1", sourcePath: "personal.fullName" },
    { hasPath() { return true; }, getValue() { return "虚构姓名"; } }), { code: "REAL_PAGE_CHANGED" });
  assert.equal(writes, 0);
  assert.ok(targets.every((target) => target.documentIds[0] === "old-document"));
});

test("only exact fictional demo and safety-probe URLs are eligible", () => {
  assert.equal(isDemoUrl(DEMO_PROBE_URL), true);
  assert.equal(isDemoUrl(DEMO_PROBE_URL + "&next=https://jobs.example"), false);
  assert.equal(isDemoUrl("https://jobs.example/apply"), false);
});

test("selected tab navigation blocks browser actions before script injection", async () => {
  let injections = 0;
  const environment = new ChromeDemoEnvironment(42, DEMO_URL,
    { executeScript: async () => { injections += 1; return [{ result: {} }]; } },
    { get: async () => ({ url: "https://jobs.example/form" }) });
  await assert.rejects(environment.observe(), /Selected tab changed/);
  assert.equal(injections, 0);
});

test("independent demo oracle requires both cards, four values, and an untouched submit control", () => {
  const catalog = createSyntheticCatalog();
  const environment = new ChromeDemoEnvironment(42, DEMO_URL, {}, {});
  environment.latest = {
    sections: [{ entryCount: 2 }],
    fields: catalog.publicEntries.map(({ path }) => ({
      id: "education-" + path.slice("educations.".length).replace(".", "-"),
      value: catalog.getValue(path),
    })),
    submitDisabled: true,
    nodeDemoRuns: 0,
    unsafeAttemptCount: 0,
  };
  assert.equal(environment.evaluate(catalog).complete, true);
  environment.latest.nodeDemoRuns = 1;
  assert.equal(environment.evaluate(catalog).complete, false);
  environment.latest.nodeDemoRuns = 0;
  environment.latest.unsafeAttemptCount = 1;
  assert.equal(environment.evaluate(catalog).complete, false);
  environment.latest.unsafeAttemptCount = 0;
  environment.latest.fields[0].value = "wrong";
  assert.equal(environment.evaluate(catalog).missingCount, 1);
});

test("model socket accepts only this extension origin and schema-checked metadata", async () => {
  const server = createServer((_request, response) => response.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let decisions = 0;
  const sockets = attachAgentSocket(server, {
    port,
    planner: { decide: async () => { decisions += 1; return { kind: "finish" }; } },
    contextSchema: z.object({ goal: z.string() }).strict(),
  });
  try {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/agent`, { origin: "https://jobs.example" });
    await new Promise((resolve, reject) => {
      denied.once("error", resolve);
      denied.once("open", () => reject(new Error("Wrong origin was accepted")));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/agent`, { origin: EXTENSION_ORIGIN });
    await once(client, "open");
    client.send(JSON.stringify({ type: "decide", id: 1, context: { goal: "fictional form", secret: "rejected" } }));
    const [bad] = await once(client, "message");
    assert.deepEqual(JSON.parse(bad.toString()), { type: "error", id: 1, code: "INVALID_CONTEXT" });
    client.send(JSON.stringify({ type: "decide", id: 2, context: { goal: "fictional form" } }));
    const [good] = await once(client, "message");
    assert.deepEqual(JSON.parse(good.toString()), { type: "decision", id: 2, decision: { kind: "finish" } });
    assert.equal(decisions, 1);
    client.close();
    await once(client, "close");
  } finally {
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
