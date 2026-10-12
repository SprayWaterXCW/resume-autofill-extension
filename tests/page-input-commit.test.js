import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { ChromeFormEnvironment } from "../agent-extension/src/real-tab.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";
import { createPlanContext, buildFillPlan, validatePlanContext } from "../src/core/fill-plan.js";
import { commitPageInput } from "../agent-extension/src/page-input-commit.js";
import { safeControlDiagnostic } from "../src/core/control-diagnostics.js";
import { runRealForm } from "../src/core/real-runner.js";

const url = "https://another-employer.example.test/form";
const runtimeBundle = (await build({ entryPoints: ["agent-extension/src/real-page-entry.js"], bundle: true,
  platform: "browser", format: "iife", write: false, logLevel: "silent" })).outputFiles[0].text;
const reactBundle = (await build({ stdin: { resolveDir: process.cwd(), contents: `
  import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
  window.previewData = {}; window.stateSetters = {}; window.blurCommitCounts = {};
  function Field({ id, label, tag = 'input', initial = '', rejected = false, commitOnBlur = false }) {
    const [value, setValue] = useState(initial);
    if (!commitOnBlur) window.previewData[id] = value;
    else if (!(id in window.previewData)) window.previewData[id] = '';
    window.stateSetters[id] = v => flushSync(() => setValue(v));
    return React.createElement('label', null, label, React.createElement(tag, { id, value,
      onChange: e => { if (!rejected) setValue(e.target.value); },
      onBlur: commitOnBlur ? e => { window.previewData[id] = e.target.value;
        window.blurCommitCounts[id] = (window.blurCommitCounts[id] || 0) + 1; } : undefined }));
  }
  const root = createRoot(document.getElementById('root'));
  flushSync(() => root.render(React.createElement(React.Fragment, null,
    React.createElement('section', null, React.createElement('h2', null, '基本信息'),
      React.createElement(Field, { id: 'email', label: '邮箱' }),
      React.createElement(Field, { id: 'name', label: '姓名', initial: '虚构旧姓名' })),
    React.createElement('section', null, React.createElement('h2', null, '实习经历'),
      React.createElement(Field, { id: 'company', label: '公司名称' }),
      React.createElement(Field, { id: 'internship', label: '职责描述', tag: 'textarea' })),
    React.createElement('section', null, React.createElement('h2', null, '校园经历'),
      React.createElement(Field, { id: 'campus', label: '工作描述', tag: 'textarea' })),
    React.createElement('section', null, React.createElement('h2', null, '其他信息'),
      React.createElement(Field, { id: 'rejected', label: '补充说明', rejected: true }),
      React.createElement(Field, { id: 'blur-input', label: '暂存备注', commitOnBlur: true }),
      React.createElement(Field, { id: 'blur-textarea', label: '活动说明', tag: 'textarea', commitOnBlur: true })),
    React.createElement('section', null, React.createElement('h2', null, '有关声明'),
      React.createElement(Field, { id: 'legal', label: '签名' })),
    React.createElement('button', { id: 'submit', type: 'button', onClick: () => window.submitCalls++ }, '提交'))));
  window.submitCalls = 0;
` }, bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" })).outputFiles[0].text;

function fixture(fillMode = "overwrite") {
  const dom = new JSDOM('<div id="root"></div>', { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.crypto.randomUUID = randomUUID;
  window.eval(reactBundle);
  const calls = [];
  const scripting = { async executeScript(options) {
    calls.push({ world: options.world, method: options.args?.[0], target: options.target });
    if (options.files) { window.eval(runtimeBundle); return []; }
    const fn = window.eval(`(${options.func.toString()})`);
    const result = await fn(...options.args);
    return [{ documentId: "fictional-document", frameId: 0, result: structuredClone(result) }];
  } };
  const environment = new ChromeFormEnvironment({ tabId: 17, url }, { scripting, fillMode, documentId: "fictional-document",
    tabs: { async get() { return { url }; } } });
  const ledger = ledgerFromProfile(importProfile({ profile: { personal: { fullName: "虚构新姓名", email: "fictional@example.test" },
    internships: [{ company: "虚构公司", description: "虚构实习职责\n与第二行描述" }],
    campusExperiences: [{ description: "虚构校园职责\n与第二行描述" }], customAnswers: [{ question: "补充说明", answer: "虚构附加信息" }] } }).stored);
  return { dom, window, environment, ledger, calls };
}

test("real React ignores a DOM-only filled value; MAIN input commit updates the data used by preview for basic, internship and campus fields", async () => {
  const f = fixture();
  try {
    const report = await f.environment.observe();
    for (const [id, sourcePath] of [['email', 'personal.email'], ['company', 'internships.0.company'],
      ['internship', 'internships.0.description'], ['campus', 'campusExperiences.0.description']]) {
      const input = f.window.document.getElementById(id), value = f.ledger.getValue(sourcePath);
      input.value = value; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
      assert.equal(input.value, value); assert.equal(f.window.previewData[id], '', 'DOM visibility must not be mistaken for preview data');
      const field = report.fields.find(item => item.label === ({ email: '邮箱', company: '公司名称', internship: '职责描述', campus: '工作描述' })[id]);
      const outcome = await f.environment.fill({ fieldId: field.id, sourcePath }, f.ledger);
      assert.equal(outcome.verified, true); assert.equal(outcome.diagnostic.pageStateObserved, true);
      assert.equal(outcome.diagnostic.pageStateDomMatchedBefore, false);
      assert.equal(outcome.diagnostic.pageStateMatched, true);
      assert.equal(f.window.previewData[id], value);
      const audited = await f.environment.audit([{ fieldId: field.id, sourcePath }]);
      assert.equal(audited[0].verified, true); assert.equal(audited[0].diagnostic.pageStateMatched, true);
      assert.equal(input.hasAttribute('data-resume-agent-commit'), false);
      assert.equal(JSON.stringify(outcome).includes(value), false);
    }
    assert.equal(f.window.submitCalls, 0);
    assert.ok(f.calls.every(call => call.target.documentIds[0] === 'fictional-document'));
  } finally { f.dom.window.close(); }
});

test("controlled state rejection and later loss cannot pass even when a DOM value is visible; audits are read only", async () => {
  const f = fixture();
  try {
    const report = await f.environment.observe();
    const rejected = report.fields.find(field => field.label === '补充说明');
    const no = await f.environment.fill({ fieldId: rejected.id, sourcePath: 'formAnswers.customAnswer0' }, f.ledger);
    assert.equal(no.verified, false); assert.equal(no.diagnostic.pageStateMatched, false);
    const email = report.fields.find(field => field.label === '邮箱');
    assert.equal((await f.environment.fill({ fieldId: email.id, sourcePath: 'personal.email' }, f.ledger)).verified, true);
    f.window.stateSetters.email('');
    f.window.document.getElementById('email').value = f.ledger.getValue('personal.email');
    const final = await f.environment.audit([{ fieldId: email.id, sourcePath: 'personal.email' }]);
    assert.equal(final[0].verified, false); assert.equal(final[0].code, 'FINAL_PAGE_STATE_MISMATCH');
    assert.equal(f.window.previewData.email, ''); assert.equal(f.window.submitCalls, 0);
  } finally { f.dom.window.close(); }
});

test("overwrite is default in planning and execution; empty mode preserves content and all modes protect legal or locked fields", async () => {
  for (const fillMode of ['overwrite', 'empty']) {
    const f = fixture(fillMode);
    try {
      f.window.stateSetters.company('虚构旧公司');
      const report = await f.environment.observe(), context = await createPlanContext(report, f.ledger, { fillMode });
      const field = report.fields.find(item => item.label === '姓名');
      const company = report.fields.find(item => item.label === '公司名称');
      const proposal = { snapshotId: context.snapshotId, groupMappings: [{ groupId: company.groupId, sectionKeys: ['internships'] }], unresolved: [],
        fieldMappings: [{ fieldId: company.id, sourcePath: 'internships.0.company' }] };
      assert.equal((await buildFillPlan(context, proposal)).items.find(item => item.fieldId === company.id).status, fillMode === 'empty' ? 'protected' : 'mapped');
      const outcome = await f.environment.fill({ fieldId: field.id, sourcePath: 'personal.fullName' }, f.ledger);
      assert.equal(outcome.verified, fillMode === 'overwrite');
      assert.equal(f.window.previewData.name, fillMode === 'overwrite' ? '虚构新姓名' : '虚构旧姓名');
      const legal = report.fields.find(item => item.label === '签名');
      assert.equal((await f.environment.fill({ fieldId: legal.id, sourcePath: 'personal.fullName' }, f.ledger)).verified, false);
      const email = report.fields.find(item => item.label === '邮箱'); f.window.document.getElementById('email').disabled = true;
      assert.equal((await f.environment.fill({ fieldId: email.id, sourcePath: 'personal.email' }, f.ledger)).verified, false);
      assert.equal(f.window.previewData.email, '');
      const other = await createPlanContext(report, f.ledger, { fillMode: fillMode === 'empty' ? 'overwrite' : 'empty' });
      assert.notEqual(context.snapshotId, other.snapshotId);
      await assert.rejects(validatePlanContext({ ...context, fillMode: other.fillMode }), { code: 'PLAN_SNAPSHOT_INVALID' });
    } finally { f.dom.window.close(); }
  }
});

test("commit tickets cannot target buttons, credentials, multiple nodes or another URL; diagnostics discard values", async () => {
  const f = fixture();
  try {
    const fn = f.window.eval(`(${commitPageInput.toString()})`), ticket = randomUUID();
    const button = f.window.document.getElementById('submit'); button.setAttribute('data-resume-agent-commit', ticket);
    assert.deepEqual(structuredClone(await fn({ ticket, value: '虚构值' }, url)), { targetMatched: false });
    assert.deepEqual(structuredClone(await fn({ ticket, value: '虚构值' }, url + '/changed')), { targetMatched: false });
    assert.equal(f.window.submitCalls, 0);
    const safe = safeControlDiagnostic({ pageStateObserved: true, pageStateMatched: false, value: 'PRIVATE_VALUE', props: { value: 'PRIVATE_STATE' } });
    assert.deepEqual(safe, { pageStateObserved: true, pageStateMatched: false });
  } finally { f.dom.window.close(); }
});

test("empty mode checks for user edits again at the write boundary, and default context is overwrite", async () => {
  const f = fixture('empty');
  try {
    const report = await f.environment.observe(), email = report.fields.find(field => field.label === '邮箱');
    assert.equal((await createPlanContext(report, f.ledger)).fillMode, 'overwrite');
    const prepared = await f.environment.invoke('fill', { token: f.environment.token, fieldId: email.id, sourcePath: 'personal.email',
      value: f.ledger.getValue('personal.email'), fillMode: 'empty', requirePageCommit: true });
    assert.equal(prepared.code, 'PAGE_COMMIT_PENDING');
    f.window.stateSetters.email('user-edit@example.test');
    assert.equal((await f.environment.completeInputCommit(prepared)).code, 'PROTECTED');
    assert.equal(f.window.previewData.email, 'user-edit@example.test');
    assert.equal(f.window.document.getElementById('email').hasAttribute('data-resume-agent-commit'), false);
  } finally { f.dom.window.close(); }
});

test("blur-only form models commit input and textarea even without native focusout, and native blur is not repeated", async () => {
  for (const suppressNativeBlur of [true, false]) {
    const f = fixture();
    try {
      const fn = f.window.eval(`(${commitPageInput.toString()})`);
      for (const id of ['blur-input', 'blur-textarea']) {
        const input = f.window.document.getElementById(id), ticket = randomUUID();
        const prototype = id === 'blur-input' ? f.window.HTMLInputElement.prototype : f.window.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, '虚构旧组件值');
        input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
        const key = Object.getOwnPropertyNames(input).find(key => key.startsWith('__reactProps$'));
        assert.equal(input[key].value, '虚构旧组件值', 'inner controlled state may update before the form model');
        assert.equal(f.window.previewData[id], '', 'inner component state does not prove the form received a value');
        if (suppressNativeBlur) input.blur = () => {};
        input.setAttribute('data-resume-agent-commit', ticket);
        const expected = id === 'blur-input' ? '虚构已提交的控件值' : '虚构已提交的控件值\n第二行';
        const outcome = await fn({ ticket, value: expected, fillMode: 'overwrite' }, url);
        assert.equal(outcome.valueMatched, true);
        assert.equal(f.window.previewData[id], expected);
        assert.equal(outcome.blurEventObserved, true);
        assert.equal(outcome.focusOutEventObserved, true);
        assert.equal(outcome.syntheticBlurUsed, suppressNativeBlur);
        assert.equal(f.window.blurCommitCounts[id], 1);
      }
      assert.equal(f.window.submitCalls, 0);
    } finally { f.dom.window.close(); }
  }
});

test("background input commit and controlled-state audit work without a page timer or native focus", async () => {
  const f = fixture();
  try {
    const report = await f.environment.observe();
    f.window.document.hasFocus = () => false;
    let timerCalls = 0;
    f.window.setTimeout = () => { timerCalls++; throw new Error('Hidden page timers are suspended'); };
    for (const [label, sourcePath] of [['邮箱', 'personal.email'], ['职责描述', 'internships.0.description'], ['工作描述', 'campusExperiences.0.description']]) {
      const field = report.fields.find(item => item.label === label);
      const outcome = await f.environment.fill({ fieldId: field.id, sourcePath }, f.ledger);
      assert.equal(outcome.verified, true);
      assert.equal(outcome.diagnostic.documentFocused, false);
      assert.equal(outcome.diagnostic.pageStateMatched, true);
      assert.equal((await f.environment.audit([{ fieldId: field.id, sourcePath }]))[0].verified, true);
    }
    assert.equal(timerCalls, 0);
    assert.equal(f.window.submitCalls, 0);
  } finally { f.dom.window.close(); }
});

test("post-write settlement is read only and still rejects a lost controlled value or witness", async () => {
  for (const change of ['value', 'witness']) {
    const f = fixture();
    try {
      const report = await f.environment.observe(), field = report.fields.find(item => item.label === '邮箱');
      const run = f.environment.scripting.executeScript.bind(f.environment.scripting);
      let writes = 0, readbacks = 0;
      f.environment.scripting.executeScript = async options => {
        const result = await run(options);
        if (options.world === 'MAIN') {
          if (options.args[0].readOnly === true) readbacks++;
          else {
            writes++;
            if (change === 'value') f.window.stateSetters.email('');
            else {
              const input = f.window.document.getElementById('email');
              const propsKey = Object.getOwnPropertyNames(input).find(key => key.startsWith('__reactProps$'));
              delete input[propsKey];
            }
          }
        }
        return result;
      };
      const outcome = await f.environment.fill({ fieldId: field.id, sourcePath: 'personal.email' }, f.ledger);
      assert.equal(outcome.verified, false);
      assert.equal(outcome.diagnostic.pageStateMatched, false);
      assert.equal(writes, 1, 'settlement never repeats editing events');
      assert.equal(readbacks, 1);
      assert.equal(f.window.submitCalls, 0);
    } finally { f.dom.window.close(); }
  }
});

test("the same URL with a replacement document cannot accept a pending input receipt", async () => {
  const f = fixture();
  try {
    const report = await f.environment.observe(), field = report.fields.find(item => item.label === '邮箱');
    const run = f.environment.scripting.executeScript.bind(f.environment.scripting);
    f.environment.scripting.executeScript = async options => {
      const result = await run(options);
      if (options.world === 'MAIN' && options.args[0].readOnly === true) result[0].documentId = 'replacement-document';
      return result;
    };
    await assert.rejects(f.environment.fill({ fieldId: field.id, sourcePath: 'personal.email' }, f.ledger), error => {
      assert.equal(error.code, 'REAL_PAGE_CHANGED');
      assert.equal(error.pageDiagnostic.trigger, 'document_mismatch');
      assert.equal(error.pageDiagnostic.stage, 'input');
      return true;
    });
    assert.equal(f.window.submitCalls, 0);
  } finally { f.dom.window.close(); }
});

test("the production runner retains a background input failure's specific code and private-free lifecycle evidence", async () => {
  const f = fixture();
  try {
    const run = f.environment.scripting.executeScript.bind(f.environment.scripting), events = [];
    f.environment.tabs.get = async () => ({ url, active: false, discarded: false, status: 'complete' });
    f.environment.scripting.executeScript = async options => {
      if (options.world === 'MAIN') throw new Error('Cannot access contents of url https://private.example/form?credential=SECRET');
      return run(options);
    };
    const result = await runRealForm({ environment: f.environment, ledger: f.ledger, onEvent: event => events.push(event), planner: {
      async planMappings(context) {
        return { snapshotId: context.snapshotId, groupMappings: [], unresolved: [], fieldMappings: context.page.fields
          .filter(field => field.label === '邮箱').map(field => ({ fieldId: field.id, sourcePath: 'personal.email' })) };
      }
    } });
    const failed = result.outcomes.find(outcome => outcome.sourcePath === 'personal.email');
    assert.equal(failed.verified, false);
    assert.equal(failed.code, 'PAGE_INPUT_EXECUTION_FAILED');
    assert.deepEqual(failed.pageDiagnostic, { stage: 'input', trigger: 'script_failed', cause: 'access_denied',
      tabActive: false, tabDiscarded: false, tabLoading: false, urlMatched: true });
    assert.ok(events.some(event => event.pageDiagnostic?.cause === 'access_denied'));
    assert.equal(/private\.example|SECRET|credential/.test(JSON.stringify({ events, outcomes: result.outcomes })), false);
    assert.equal(f.window.submitCalls, 0);
  } finally { f.dom.window.close(); }
});
