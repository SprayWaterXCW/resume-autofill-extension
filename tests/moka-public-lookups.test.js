import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";

const page = "https://app.mokahr.com/social-recruitment/fictional/123#/job/fictional/apply";
const schoolUrl = "https://app.mokahr.com/api/schools/searchV2?searchKey=" + encodeURIComponent("虚构海湾大学") + "&source=locales";
const majorUrl = "https://app.mokahr.com/api/majors/search?searchKey=" + encodeURIComponent("虚构计算科学") + "&source=locales";

const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });

test("production dropdown execution waits for closing fetched menus and refuses receipts for a menu that stays open", async () => {
  const html = '<section><h2>教育经历</h2>' + ["school", "major"].map((key) =>
    `<div class="field-shell"><div class="title-decoration">${key === "school" ? "学校名称" : "专业名称"}</div><label class="widget-select-container"><span class="widget-display-value"></span><input id="${key}" placeholder="请输入${key === "school" ? "学校" : "专业"}名称"></label></div>`).join("")
    + '</section><button type="submit" id="final">预览并提交</button>';
  for (const closeDelayMs of [650, null]) {
    const dom = new JSDOM(html, { url: page, runScripts: "outside-only" });
    try {
      const { document } = dom.window, names = { school: "虚构海湾大学", major: "虚构计算科学" };
      let forwarded = 0, clicks = 0, submitClicks = 0;
      dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      dom.window.crypto.randomUUID = randomUUID;
      dom.window.fetch = async () => { forwarded++; return { ok: true, async json() { return []; } }; };
      dom.window.eval(bundle.outputFiles[0].text);
      let panel, closing = false;
      document.body.addEventListener("mousedown", () => { if (!closing) { panel?.remove(); panel = null; } });
      document.querySelector("#final").addEventListener("click", (event) => { event.preventDefault(); submitClicks++; });
      for (const key of ["school", "major"]) {
        const input = document.getElementById(key);
        input.addEventListener("input", async () => {
          if (!input.value) return;
          const response = await dom.window.fetch(key === "school" ? schoolUrl : majorUrl);
          if (!response.ok) return;
          panel?.remove(); panel = document.createElement("div"); panel.className = "dropdown-menu";
          for (const name of [names[key] + "第二学院", names[key]]) {
            const option = document.createElement("span"); option.className = "option-item"; option.textContent = name;
            option.addEventListener("click", () => {
              input.closest("label").querySelector(".widget-display-value").textContent = name;
              input.value = ""; clicks++; closing = true;
              if (closeDelayMs !== null) dom.window.setTimeout(() => { panel.remove(); panel = null; closing = false; }, closeDelayMs);
            }); panel.append(option);
          }
          document.body.append(panel);
        });
      }
      const environment = new ChromeFormEnvironment({ tabId: 42, url: page }, { documentId: "fictional-document",
        tabs: { async get() { return { id: 42, url: page }; }, async query() { return [{ id: 42, url: page }]; } },
        scripting: { async executeScript(options) {
          if (options.files) return [];
          const result = await dom.window.__resumeAgentRuntime[options.args[0]](options.args[1]);
          return [{ frameId: 0, documentId: "fictional-document", result }];
        } } });
      const report = await environment.observe(); assert.equal(report.fields.length, 2);
      const items = [], ledger = { hasPath() { return true; }, getValue(path) { return names[path.split(".").at(-1)]; } };
      for (const [index, key] of (closeDelayMs === null ? ["school"] : ["school", "major"]).entries()) {
        const item = { fieldId: report.fields[index].id, sourcePath: `educations.0.${key}` };
        items.push(item); const outcome = await environment.fill(item, ledger);
        assert.equal(outcome.code, closeDelayMs === null ? "OPTION_NOT_COMMITTED" : "VERIFIED", JSON.stringify(outcome));
        assert.equal(outcome.verified, closeDelayMs !== null);
        assert.equal(outcome.diagnostic.expanded, closeDelayMs === null);
        assert.equal(outcome.diagnostic.valueMatched, true);
        assert.ok(outcome.diagnostic.waitedMs >= 450);
      }
      assert.equal(forwarded, closeDelayMs === null ? 1 : 2); assert.equal(clicks, closeDelayMs === null ? 1 : 2); assert.equal(submitClicks, 0);
      assert.equal(Boolean(document.querySelector(".dropdown-menu")), closeDelayMs === null);
      assert.equal((await environment.audit(items)).every((outcome) => outcome.verified), closeDelayMs !== null);
      assert.equal(dom.window.__resumeAgentSubmitGuard, undefined);
      assert.equal(document.querySelector("#final").disabled, false);
      document.querySelector("#final").click();
      assert.equal(submitClicks, 1, "user's submit click reaches the page without an Agent interceptor");
    } finally { dom.window.close(); }
  }
});
