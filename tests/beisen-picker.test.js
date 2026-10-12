import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
const page = "https://career.boe.com/form?fixture=synthetic";
const bundle = await build({ entryPoints: [new URL("../agent-extension/src/real-page-entry.js", import.meta.url).pathname],
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });

function fixture(kind = "nation", { delayed = false, duplicate = false, wrongPath = false, existing = false, replaceRow = false, contentHandler = false,
  url = page } = {}) {
  const area = kind === "areas", rootClass = area ? "area-selector-container" : "constant-main-selector-container";
  const footer = area ? "area-footer-button" : "selector-footer-button";
  const dom = new JSDOM(`<section data-agent-group><h2>基本信息</h2><div class="form-item--phoenix"><label>${area ? "籍贯" : "民族"}</label>
    <div class="phoenix-select"><input class="phoenix-select__input--unText" ${existing ? 'value="原有虚构内容"' : ""}>
    <span class="phoenix-select__content"></span><span class="phoenix-select__switchArrow"></span></div></div></section>
    <div class="${rootClass}"></div><div class="${rootClass}" id="popup" hidden><input class="phoenix-input__input" placeholder="搜索">
    <div class="left-container"><div id="items"></div></div><div class="right-container"><div class="select-data-container"></div></div>
    <div class="${footer}"><div class="phoenix-button" id="local-cancel"><span class="phoenix-button__content">取消</span></div>
    <div class="phoenix-button" id="local-confirm"><span class="phoenix-button__content">确定</span></div></div></div>
    <form><button type="submit" id="submit">预览并提交</button></form><button type="button" id="decoy">确定</button>`, { url, runScripts: "outside-only" });
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{ width: 200, height: 30 }]; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.crypto.randomUUID = randomUUID;
  let selected, confirms = 0, unsafe = 0, opened = 0, navigated = 0;
  const popup = document.getElementById("popup"), items = document.getElementById("items");
  const add = (text, child = false) => {
    const row = document.createElement("div"); row.className = area ? "area-item-container" : "list-item-container";
    row.innerHTML = area ? `<div class="area-item-name"><span class="icon-container visible"><svg class="area-icon-RadioUnchecked"></svg></span>
      <span class="area-text-label">${text}</span>${child ? '<span class="area-icon-right visible"></span>' : ""}</div>`
      : `<span class="icon-container"><svg class="RadioUnchecked"></svg></span><span class="item-text-label no-hover">${text}</span>`;
    row.querySelector("svg").addEventListener("click", () => {
      for (const checked of items.querySelectorAll(area ? ".area-icon-RadioChecked" : ".RadioChecked")) checked.setAttribute("class", area ? "area-icon-RadioUnchecked" : "RadioUnchecked");
      row.querySelector("svg").setAttribute("class", area ? "area-icon-RadioChecked" : "RadioChecked"); selected = text;
      if (area) popup.querySelector(".select-data-container").innerHTML = `<span class="select-area-text-label">${wrongPath ? "错误虚构省" : "虚构省"}${child ? "" : "/虚构市"}</span>`;
      if (replaceRow) row.replaceWith(row.cloneNode(true));
    });
    if (child) row.querySelector(".area-icon-right").addEventListener("mouseover", () => { if (!navigated) { navigated += 1; add("虚构市"); } });
    items.append(row);
  };
  const populate = () => { if (items.children.length) return; add(area ? "虚构省" : "虚构族", area); if (duplicate) add(area ? "虚构省" : "虚构族", area); };
  document.querySelector(".phoenix-select__switchArrow").addEventListener("click", () => {
    opened += 1; popup.hidden = false; if (delayed) dom.window.setTimeout(populate, 260); else populate();
  });
  const localControl = (id) => contentHandler ? document.getElementById(id).querySelector(".phoenix-button__content") : document.getElementById(id);
  localControl("local-cancel").addEventListener("click", () => { popup.hidden = true; selected = null; });
  localControl("local-confirm").addEventListener("click", () => {
    confirms += 1; document.querySelector(".phoenix-select__content").textContent = selected || ""; popup.hidden = true;
  });
  document.getElementById("submit").addEventListener("click", (event) => { unsafe += 1; event.preventDefault(); });
  document.getElementById("decoy").addEventListener("click", () => { unsafe += 1; });
  popup.querySelector("input").addEventListener("input", () => { unsafe += 1; }); // No remote-search fallback.
  dom.window.eval(bundle.outputFiles[0].text);
  const runtime = dom.window.__resumeAgentRuntime, observation = runtime.scan(url);
  const field = observation.report.fields.find((item) => item.label === (area ? "籍贯" : "民族"));
  return { dom, runtime, observation, field, stats: () => ({ confirms, unsafe, opened, navigated }),
    fill: (regionParts = [], fillMode = "overwrite") => runtime.fill({ token: observation.token, fieldId: field.id,
      sourcePath: area ? "formAnswers.hometown" : "formAnswers.ethnicity", value: area ? regionParts.join("/") : "虚构族", regionParts, fillMode }) };
}

test("observed constant picker waits for candidates, selects one radio and confirms locally before receipt audit", async () => {
  const f = fixture("nation", { delayed: true });
  try {
    assert.equal(f.observation.report.fields.length, 1, "popup search must not become a resume field");
    const outcome = await f.fill();
    assert.equal(outcome.code, "VERIFIED"); assert.equal(outcome.diagnostic.adapter, "beisen_constant_picker");
    assert.ok(outcome.diagnostic.waitedMs >= 260); assert.equal(outcome.diagnostic.selectedCount, 1);
    assert.deepEqual(f.stats(), { confirms: 1, unsafe: 0, opened: 1, navigated: 0 });
    const audit = f.runtime.audit({ token: f.observation.token, targets: [{ fieldId: f.field.id, sourcePath: "formAnswers.ethnicity" }] });
    assert.equal(audit[0].verified, true);
    assert.equal(JSON.stringify(outcome).includes("虚构族"), false);
  } finally { f.dom.window.close(); }
});

test("replaced picker rows and content-only confirmation callbacks work on another employer's Phoenix form", async () => {
  for (const kind of ["nation", "areas"]) {
    const f = fixture(kind, { replaceRow: true, contentHandler: true, url: "https://new-employer.example.test/application" });
    try {
      const outcome = await f.fill(kind === "areas" ? ["虚构省"] : []);
      assert.equal(outcome.code, "VERIFIED"); assert.equal(outcome.diagnostic.selectionRowReplaced, true);
      assert.equal(outcome.diagnostic.panelClosed, true); assert.equal(f.stats().confirms, 1); assert.equal(f.stats().unsafe, 0);
    } finally { f.dom.window.close(); }
  }
});

test("duplicate candidates and prefilled fields never authorize a picker commit", async () => {
  for (const config of [{ duplicate: true }, { existing: true }]) {
    const f = fixture("nation", config);
    try {
      const outcome = await f.fill([], "empty"); assert.equal(outcome.code, config.existing ? "PROTECTED" : "PICKER_AMBIGUOUS");
      assert.equal(f.stats().confirms, 0); assert.equal(f.stats().unsafe, 0);
      if (config.existing) assert.equal(f.stats().opened, 0);
    } finally { f.dom.window.close(); }
  }
});

test("region picker collapses repeated explicit province and does not invent a city", async () => {
  const f = fixture("areas");
  try {
    const outcome = await f.fill(["虚构省", "虚构省"]);
    assert.equal(outcome.code, "VERIFIED"); assert.equal(outcome.diagnostic.levelCount, 1);
    assert.equal(outcome.diagnostic.pathMatched, true); assert.equal(f.stats().navigated, 0); assert.equal(f.stats().unsafe, 0);
  } finally { f.dom.window.close(); }
});

test("region navigation binds a child to its parent and requires the full selected path before commit", async () => {
  for (const wrongPath of [false, true]) {
    const f = fixture("areas", { wrongPath });
    try {
      const outcome = await f.fill(["中国", "虚构省", "虚构市"]);
      assert.equal(outcome.code, wrongPath ? "REGION_PATH_MISMATCH" : "VERIFIED");
      assert.equal(f.stats().navigated, 1); assert.equal(f.stats().confirms, wrongPath ? 0 : 1); assert.equal(f.stats().unsafe, 0);
      assert.equal(outcome.diagnostic.levelCount, 2);
      assert.equal(JSON.stringify(outcome).includes("虚构省"), false);
    } finally { f.dom.window.close(); }
  }
});
