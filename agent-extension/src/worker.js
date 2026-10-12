import { runAgent } from "../../src/core/runner.js";
import { createSyntheticCatalog } from "../../src/fixtures/synthetic-form.js";
import { ChromeDemoEnvironment, isDemoUrl } from "./demo-tab.js";
import { LocalModelSocket } from "./model-socket.js";
import { isScannableUrl, isAuthenticationUrl, scanCurrentTab } from "./page-scan.js";
import { generateReadOnlyPlan } from "../../src/core/fill-plan.js";
import { createSyntheticLedger } from "../../src/fixtures/synthetic-ledger.js";
import { ledgerFromProfile, profileSummary, PRIVATE_PROFILE_KEY } from "../../src/core/profile-import.js";
import { createProfileStore, isProfileEditorSender } from "./profile-store.js";
import { ChromeFormEnvironment, bindFormDocument } from "./real-tab.js";
import { runRealForm } from "../../src/core/real-runner.js";
import { cleanupLegacyInterception } from "./legacy-page-cleanup.js";
import { planResponseDiagnosticSchema } from "../../src/core/plan-response-diagnostics.js";
import { modelHttpDiagnosticSchema, modelHttpHint } from "../../src/core/model-http-diagnostics.js";
import { safePageDiagnostic } from "../../src/core/page-lifecycle-diagnostics.js";

const IDLE = { status: "idle", progress: null, result: null, error: null, events: [] };
const PLAN_IDLE = { status: "idle", plan: null, error: null, events: [] };
const TASK_PREFIX = "agentTabTask:";
// Every asynchronous callback owns a task slot. Focus never selects a running job.
const tasks = new Map();
let persistence = Promise.resolve();
let settingsWriting = false;

function newTask(selection) {
  return { selection: { tabId: selection.tabId, url: selection.url }, state: { ...IDLE }, planState: { ...PLAN_IDLE },
    lastScan: null, activeRun: null, activePlanning: null, scanning: false, starting: false,
    stopRequested: false, stopCode: "USER_STOPPED", stopDiagnostic: null, socket: null, documentId: null, waits: new Set(), navigationCleanup: null, closed: false };
}
function taskBusy(task) {
  return Boolean(task && (task.activeRun || task.activePlanning || task.scanning || task.starting
    || task.state.status === "running" || task.planState.status === "running" || task.navigationCleanup));
}
function anyTaskBusy() { return [...tasks.values()].some(taskBusy); }
function taskForAction(selection) {
  if (!Number.isInteger(selection?.tabId) || typeof selection.url !== "string") throw new Error("当前标签页无效，请重新打开工具栏面板");
  let task = tasks.get(selection.tabId);
  if (task && task.selection.url !== selection.url) {
    if (taskBusy(task)) throw new Error("此标签页的原页面任务正在结束，请稍后重试");
    task = null;
  }
  if (!task) { task = newTask(selection); tasks.set(selection.tabId, task); }
  return task;
}
function persistTask(task) {
  if (task.closed) return;
  const key = TASK_PREFIX + task.selection.tabId;
  const snapshot = structuredClone({ selection: task.selection, state: task.state, planState: task.planState, lastScan: task.lastScan });
  persistence = persistence.then(() => chrome.storage.session.set({ [key]: snapshot })).catch(() => {});
}
function publish(task, next) { task.state = next; persistTask(task); }
function publishPlan(task, next) { task.planState = next; persistTask(task); }
function checkStopped(task) {
  if (task.stopRequested) throw Object.assign(new Error(task.stopCode), { code: task.stopCode });
}
async function boundTab(task) {
  checkStopped(task);
  let tab;
  try { tab = await chrome.tabs.get(task.selection.tabId); } catch { throw Object.assign(new Error("REAL_PAGE_CHANGED"), { code: "REAL_PAGE_CHANGED" }); }
  checkStopped(task);
  if (tab.url !== task.selection.url) throw Object.assign(new Error("REAL_PAGE_CHANGED"), { code: "REAL_PAGE_CHANGED" });
  return tab;
}

async function waitForPage(message, sender) {
  const task = tasks.get(sender?.tab?.id);
  if (Object.keys(message).some((key) => !["type", "ms"].includes(key))
    || !Number.isInteger(message.ms) || message.ms < 1 || message.ms > 1000
    || !chrome.runtime.id || sender?.id !== chrome.runtime.id || sender.frameId !== 0
    || !task?.documentId || sender.documentId !== task.documentId || sender.url !== task.selection.url
    || task.state.status !== "running" || task.closed) throw new Error("PAGE_WAIT_DENIED");
  checkStopped(task);
  await new Promise((resolve, reject) => {
    const wait = { timer: null, finish(error) {
      clearTimeout(wait.timer); task.waits.delete(wait);
      if (error) reject(error); else resolve();
    } };
    wait.timer = setTimeout(() => wait.finish(), message.ms);
    task.waits.add(wait);
  });
  checkStopped(task);
  if (tasks.get(task.selection.tabId) !== task || task.documentId !== sender.documentId) throw new Error("PAGE_WAIT_DENIED");
  return { waited: true };
}
const profiles = createProfileStore({
  storage: chrome.storage.local,
  isBusy: () => anyTaskBusy() || settingsWriting,
  onChanged: async () => { for (const task of tasks.values()) publishPlan(task, PLAN_IDLE); await persistence; },
});

chrome.storage.local?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
const stateReady = chrome.storage.session.get(null).then(async (stored) => {
  try {
    const migration = await cleanupLegacyInterception(stored.realProtection);
    if (migration.removedRuleCount || migration.cleanup.some((item) => item.released)) console.info("旧版拦截已解除", JSON.stringify(migration));
    await chrome.storage.session.remove("realProtection");
  } catch { console.error("旧版拦截清理", JSON.stringify({ code: "LEGACY_CLEANUP_FAILED" })); }
  for (const [key, snapshot] of Object.entries(stored)) {
    if (!key.startsWith(TASK_PREFIX) || !Number.isInteger(snapshot?.selection?.tabId)
      || key !== TASK_PREFIX + snapshot.selection.tabId || typeof snapshot.selection.url !== "string") continue;
    tasks.set(snapshot.selection.tabId, { ...newTask(snapshot.selection), state: snapshot.state || { ...IDLE },
      planState: snapshot.planState || { ...PLAN_IDLE }, lastScan: snapshot.lastScan || null });
  }
  // Migrate the previous single-job format once, preserving its page-specific history.
  for (const [name, property] of [["agentState", "state"], ["planState", "planState"], ["formScan", "lastScan"]]) {
    const previous = stored[name];
    if (!Number.isInteger(previous?.selectedTabId) || typeof previous.selectedUrl !== "string") continue;
    const task = tasks.get(previous.selectedTabId) || newTask({ tabId: previous.selectedTabId, url: previous.selectedUrl });
    if (!stored[TASK_PREFIX + previous.selectedTabId]) task[property] = previous;
    tasks.set(previous.selectedTabId, task);
  }
  for (const [tabId, task] of tasks) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { tasks.delete(tabId); await chrome.storage.session.remove(TASK_PREFIX + tabId); continue; }
    const { protectionActive: obsoleteProtection, ...previous } = task.state;
    task.state = previous.status === "running" ? { ...previous, status: "failed", error: "扩展后台已中断；请检查页面并重新启动",
      pageDiagnostic: { stage: "lifecycle", trigger: "worker_restarted" } } : previous;
    if (task.planState.status === "running") task.planState = { ...task.planState, status: "failed", plan: null, error: "后台已中断，请重新生成计划" };
    if (tab.url !== task.selection.url) { task.state = { ...task.state, pageChanged: true }; task.planState = { ...PLAN_IDLE }; task.lastScan = null; }
    persistTask(task);
  }
  await persistence;
  for (const key of ["agentState", "formScan", "planState"]) await chrome.storage.session.remove(key);
}).catch(() => { console.error("任务恢复", JSON.stringify({ code: "TASK_STATE_RESTORE_FAILED" })); });

async function loadUserLedger() {
  const stored = (await chrome.storage.local?.get(PRIVATE_PROFILE_KEY))?.[PRIVATE_PROFILE_KEY];
  return stored ? ledgerFromProfile(stored) : null;
}

async function datePolicy() {
  const stored = (await chrome.storage.local.get("agentDatePolicy")).agentDatePolicy;
  return { monthStartDay: stored?.monthStartDay === true };
}

async function fillPreference() {
  const stored = (await chrome.storage.local.get("agentFillMode")).agentFillMode;
  return { fillMode: stored === "empty" ? "empty" : "overwrite" };
}

async function userProfileStatus() {
  const stored = (await chrome.storage.local?.get(PRIVATE_PROFILE_KEY))?.[PRIVATE_PROFILE_KEY];
  return stored ? profileSummary(ledgerFromProfile(stored), stored.importedAt) : { available: false, sections: [] };
}

async function selectedTab(selection) {
  if (!Number.isInteger(selection?.tabId) || typeof selection?.url !== "string") {
    throw new Error("当前标签页无效，请重新打开工具栏面板");
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== selection.tabId || active.url !== selection.url) {
    throw new Error("当前标签页已变化，请重新打开工具栏面板");
  }
  return active;
}

async function preview(selection, { assertSelection = () => selectedTab(selection) } = {}) {
  await assertSelection();
  if (isScannableUrl(selection.url)) {
    await cleanupLegacyInterception(selection);
    await assertSelection();
  }
  if (!isDemoUrl(selection.url)) {
    const scannable = isScannableUrl(selection.url);
    if (isAuthenticationUrl(selection.url)) return { supported: false, scannable, realSite: true,
      reason: "这是登录或注册页；请手工完成登录并进入简历编辑表单后，再启动填写" };
    const profile = await userProfileStatus();
    const fixtureAllowed = profile.purpose !== "synthetic_evaluation" || ["127.0.0.1", "localhost"].includes(new URL(selection.url).hostname);
    return { supported: scannable && profile.available && fixtureAllowed, scannable, realSite: true,
      reason: !fixtureAllowed ? "当前是虚构验收资料；请导入你自己的简历后再填写真实招聘网站"
        : profile.available ? "使用已保存资料填写当前表单；按所选模式处理已有内容，复杂控件失败会记录原因"
        : "请先打开“编辑资料”，填写并保存你的简历，再开始填写真实网页" };
  }
  return { supported: true, scannable: true, reason: "本地虚构测试页，可启动 Agent，也可扫描页面结构" };
}

const planPhases = {
  observe: "读取当前字段与记录数量",
  model: "模型根据标签和资料目录提出映射",
  validate: "校验资料来源、字段引用和记录索引",
  reobserve: "再次扫描，核对模型等待期间页面是否变化",
};

async function executePlan(task, selection) {
  const socket = new LocalModelSocket();
  task.socket = socket;
  try {
    await socket.connect();
    checkStopped(task);
    const { report, plan } = await generateReadOnlyPlan({
      ...(await fillPreference()),
      ledger: (await loadUserLedger()) || createSyntheticLedger(), planner: socket,
      scan: async () => { await boundTab(task); const report = await scanCurrentTab(selection); await boundTab(task); return report; },
      assertSelection: () => boundTab(task),
      onPhase: (phase) => publishPlan(task, { ...task.planState,
        events: [...task.planState.events, { phase, summary: planPhases[phase] }],
      }),
    });
    checkStopped(task);
    task.lastScan = { selectedTabId: selection.tabId, selectedUrl: selection.url, report };
    persistTask(task);
    publishPlan(task, { ...task.planState, status: "ready", plan, error: null });
  } catch (error) {
    const rawCode = error?.code || error?.message;
    const code = task.stopRequested ? task.stopCode : /^(PLAN_|MODEL_|SCAN_|REAL_)[A-Z_]+$/.test(rawCode || "") ? rawCode : "PLAN_LOCAL_CONNECTION_FAILED";
    const hint = code === "MODEL_CONFIG_MISSING" ? "请配置本机模型服务后重新生成"
      : code === "PLAN_LOCAL_CONNECTION_FAILED" ? "请启动 npm run demo:service:start，并确认原网页仍然打开"
      : ["PLAN_PAGE_CHANGED", "SCAN_PAGE_CHANGED", "REAL_PAGE_CHANGED", "PLAN_RECORD_MISMATCH"].includes(code) ? "请重新扫描并生成；本次建议已作废"
      : "请查看错误码，修正后重新生成";
    const responseDiagnostic = planResponseDiagnosticSchema.safeParse(error?.responseDiagnostic);
    if (responseDiagnostic.success) publishPlan(task, { ...task.planState,
      events: [...task.planState.events, { phase: "validate", tool: "model_response", code,
        responseDiagnostic: responseDiagnostic.data, summary: "模型返回格式未通过校验：" + responseDiagnostic.data.stage }] });
    const httpDiagnostic = modelHttpDiagnosticSchema.safeParse(error?.httpDiagnostic);
    if (httpDiagnostic.success) publishPlan(task, { ...task.planState,
      events: [...task.planState.events, { phase: "validate", tool: "model_http", code,
        httpDiagnostic: httpDiagnostic.data, summary: modelHttpHint(httpDiagnostic.data) }] });
    publishPlan(task, { ...task.planState, status: "failed", plan: null, error: `计划未生成（${code}）：${hint}` });
    task.lastScan = null;
    persistTask(task);
  } finally {
    socket.close(); if (task.socket === socket) task.socket = null;
    task.activePlanning = null;
    await persistence;
  }
}

function publishRealEvent(task, event) {
  const { progress, ...record } = event;
  publish(task, { ...task.state, ...(progress !== undefined ? { progress } : {}), events: [...task.state.events, record].slice(-800) });
}

async function executeReal(task, selection, ledger, previousRun, fillMode) {
  const socket = new LocalModelSocket();
  const runId = crypto.randomUUID();
  const recordEvent = (event) => { socket.reportExecution(runId, event); publishRealEvent(task, event); };
  task.socket = socket;
  publish(task, { ...task.state, runId });
  let environment;
  try {
    await socket.connect();
    checkStopped(task);
    const documentId = await bindFormDocument(selection);
    checkStopped(task);
    task.documentId = documentId;
    const policy = await datePolicy();
    environment = new ChromeFormEnvironment(selection, { documentId, ...policy, fillMode });
    const run = await runRealForm({ environment, planner: socket, ledger,
      datePolicy: policy, fillMode,
      shouldStop: () => task.stopRequested, onEvent: recordEvent, previousRun });
    checkStopped(task);
    task.lastScan = { selectedTabId: selection.tabId, selectedUrl: selection.url, report: run.report };
    persistTask(task);
    publishPlan(task, { ...PLAN_IDLE, status: "ready", selectedTabId: selection.tabId, selectedUrl: selection.url,
      plan: run.plan, executed: true, events: [{ phase: "validate", summary: "本轮使用的资料映射；网页已执行填写，请重新扫描获取当前结构" }] });
    publish(task, { ...task.state, status: run.status, result: run.result, outcomes: run.outcomes, error: null });
    socket.reportExecution(runId, { phase: "完成", tool: "result", code: run.result.code, progress: task.state.progress,
      counts: { written: run.result.agentWrittenFields, unresolved: run.result.unresolvedCount, skipped: run.result.skippedCount, expected: run.result.expectedFields,
        unplanned: run.result.unplannedCount, blankFields: run.result.remainingBlankFields, repaired: run.result.repairedFields,
        semanticReview: run.result.repairsNeedingReview, pending: run.result.pendingEntries, recoveries: run.result.structureRecoveries,
        ...run.result.verificationCounts } });
  } catch (error) {
    const raw = error?.code || error?.message || "";
    const code = task.stopRequested ? task.stopCode : /^(REAL_|MODEL_|PLAN_|PAGE_|FORM_)[A-Z_]+$/.test(raw) ? raw : "REAL_EXECUTION_FAILED";
    const pageDiagnostic = safePageDiagnostic(task.stopDiagnostic || error?.pageDiagnostic);
    recordEvent({ step: (task.state.events.at(-1)?.step || 0) + 1, phase: "失败", tool: "execution", code,
      ...(error.structureDiagnostic ? { structureDiagnostic: error.structureDiagnostic } : {}),
      ...(pageDiagnostic ? { pageDiagnostic } : {}),
      summary: `${code}：本轮未完成整页填写`, progress: task.state.progress });
    const hint = code === "FORM_NOT_READY" ? "等待后仍未找到表单控件，请检查网站是否已加载出可编辑表单；本轮未填写"
      : code === "REAL_PAGE_CHANGED" ? "原页面已刷新、跳转或关闭，已停止此标签页任务；请检查已填写内容"
      : code === "REAL_FORM_STRUCTURE_CHANGED" ? "网页字段或经历结构发生变化，旧计划已停止；请重新扫描，已填写内容保留"
      : code === "REAL_RECOVERY_LIMIT" ? "网页结构持续变化，已达到本轮恢复上限并停止；已填写内容保留，变化位置见执行记录"
      : code.startsWith("MODEL_") ? "请检查本机模型服务；已填写内容保留"
      : code === "USER_STOPPED" ? "已按你的要求停止；已填写内容保留"
      : "请复制本次执行记录查看失败位置；已填写内容保留";
    if (error?.diagnostic) {
      const refs = [error.diagnostic.groupIds, error.diagnostic.fieldIds, error.diagnostic.sectionKeys, error.diagnostic.sourcePaths].flat().filter(Boolean).join("、");
      publish(task, { ...task.state, events: [...task.state.events, { step: (task.state.events.at(-1)?.step || 0) + 1,
        phase: "核验", tool: "plan", code, diagnostic: error.diagnostic,
        summary: `${code}：${error.diagnostic.violation}；引用 ${refs}` }].slice(-800) });
    }
    publish(task, { ...task.state, status: task.stopRequested ? "stopped" : "failed", error: `${code}：${hint}`,
      ...(pageDiagnostic ? { pageDiagnostic } : {}) });
  } finally {
    socket.close(); if (task.socket === socket) task.socket = null;
    // Release only our isolated runtime's bookkeeping and date listeners.
    // This never changes form values, page APIs or the user's buttons.
    await environment?.clear().catch(() => {});
    task.activeRun = null;
    await persistence;
  }
}

function progressEvent(task, event, counters) {
  const events = [...(task.state.events || [])];
  if (event.type === "proposed" && event.decision.kind === "act") {
    events.push({ step: event.step, phase: "计划", tool: event.decision.tool, summary: event.decision.rationale || "已选择下一步动作" });
  } else if (event.type === "executing") {
    events.push({ step: event.step, phase: "执行", tool: event.action.tool, summary: "正在操作已核对的页面控件" });
  } else if (event.type === "step") {
    const trace = event.event;
    if (trace.kind === "act" && trace.verified) {
      if (trace.tool === "add_entry") counters.added += 1;
      if (trace.tool === "fill_field") counters.paths.add(trace.target.sourcePath);
    }
    events.push({
      step: trace.step,
      phase: "核验",
      tool: trace.tool || trace.kind,
      summary: `${trace.code}；剩余 ${event.assessment.missingCount} 个字段`,
    });
  }
  publish(task, {
    ...task.state,
    progress: {
      agentAddedCards: counters.added,
      agentWrittenFields: counters.paths.size,
      nodeDemoRuns: event.assessment?.nodeDemoRuns ?? task.state.progress?.nodeDemoRuns ?? 0,
      step: event.step,
    },
    events: events.slice(-18),
  });
}

async function execute(task, selection) {
  const socket = new LocalModelSocket(new URL(selection.url).origin.replace("http:", "ws:") + "/agent");
  task.socket = socket;
  const counters = { added: 0, paths: new Set() };
  try {
    await socket.connect();
    checkStopped(task);
    const documentId = await bindFormDocument(selection);
    checkStopped(task);
    const catalog = createSyntheticCatalog();
    const environment = new ChromeDemoEnvironment(selection.tabId, selection.url, chrome.scripting, chrome.tabs, { documentId, checkStopped: () => checkStopped(task) });
    const run = await runAgent({
      goal: "在虚构本地页填写两段教育经历；毕业院校与毕业学校按语义对应；必要时添加第二张卡片；绝不提交。",
      environment,
      planner: socket,
      catalog,
      maxSteps: 12,
      onEvent: (event) => progressEvent(task, event, counters),
    });
    checkStopped(task);
    await environment.observe();
    const assessment = environment.evaluate(catalog);
    const passed = run.status === "completed" && assessment.complete && counters.added === 1 && counters.paths.size === 4;
    const lastCode = run.trace.at(-1)?.code || run.status;
    publish(task, {
      ...task.state,
      status: passed ? "passed" : "failed",
      result: {
        passed,
        steps: run.steps,
        correctFields: 4 - assessment.missingCount,
        expectedFields: 4,
        cardCount: assessment.entryCount,
        agentAddedCards: counters.added,
        agentWrittenFields: counters.paths.size,
        nodeDemoRuns: assessment.nodeDemoRuns,
        submitControlDisabled: assessment.submitControlDisabled,
        code: lastCode,
      },
      error: passed ? null : `Agent 已停止：${lastCode}；请查看最近执行记录`,
    });
  } catch (error) {
    publish(task, { ...task.state, status: task.stopRequested ? "stopped" : "failed", error: task.stopRequested ? task.stopCode + "：此标签页任务已停止；已填写内容保留" : error?.message || "Agent 运行失败，请查看扩展后台日志" });
  } finally {
    socket.close(); if (task.socket === socket) task.socket = null;
    task.activeRun = null;
    await persistence;
  }
}

async function handleMessage(message, sender) {
  await stateReady;
  if (message?.type === "page-delay") return waitForPage(message, sender);
  if (["profile-editor-load", "profile-editor-save"].includes(message?.type)) {
    if (!isProfileEditorSender(sender, chrome.runtime)) throw new Error("PROFILE_EDITOR_ACCESS_DENIED");
    return message.type === "profile-editor-load" ? profiles.read() : profiles.save(message);
  }
  if (message?.type === "date-policy") return datePolicy();
  if (message?.type === "fill-preference") return fillPreference();
  if (message?.type === "fill-preference-set") {
    if (!["overwrite", "empty"].includes(message.fillMode)) throw new Error("填写模式格式无效");
    if (settingsWriting || profiles.isWriting) throw new Error("设置正在保存，请稍后重试");
    settingsWriting = true;
    try { await chrome.storage.local.set({ agentFillMode: message.fillMode }); return await fillPreference(); }
    finally { settingsWriting = false; }
  }
  if (message?.type === "date-policy-set") {
    if (anyTaskBusy() || settingsWriting || profiles.isWriting) throw new Error("请等待所有标签页任务结束后再修改日期规则");
    if (typeof message.monthStartDay !== "boolean") throw new Error("日期规则格式无效");
    settingsWriting = true;
    try { await chrome.storage.local.set({ agentDatePolicy: { monthStartDay: message.monthStartDay } }); return await datePolicy(); }
    finally { settingsWriting = false; }
  }
  if (message?.type === "profile-status") return userProfileStatus();
  if (message?.type === "profile-import") return profiles.import(message.data);
  if (message?.type === "tasks-status") {
    const busy = [...tasks.values()].filter(taskBusy);
    return { activeTaskCount: busy.length, otherTaskCount: busy.filter((task) => task.selection.tabId !== message.selection?.tabId).length };
  }
  const selection = message?.selection;
  const existing = tasks.get(selection?.tabId);
  const matching = existing?.selection.url === selection?.url ? existing : null;
  if (message?.type === "stop") {
    if (!matching || (!matching.activeRun && matching.state.status !== "running")) throw new Error("此标签页没有正在填写的任务");
    stopTask(matching, "USER_STOPPED");
    return { requested: true };
  }
  if (message?.type === "status") return matching?.state || IDLE;
  if (message?.type === "preview") return preview(selection);
  if (message?.type === "plan-status") return matching?.planState || PLAN_IDLE;
  if (message?.type === "scan-status") return matching?.lastScan?.report || null;
  if (!["start", "plan-start", "scan"].includes(message?.type)) throw new Error("未知扩展消息");
  const task = taskForAction(selection);
  if (taskBusy(task) || profiles.isWriting || settingsWriting) throw new Error("此标签页已有任务，或正在保存资料、更新页面，请稍后重试");
  task.starting = true;
  task.stopRequested = false;
  task.stopCode = "USER_STOPPED";
  task.stopDiagnostic = null;
  try {
    // Active-tab selection is checked only when the human starts an operation.
    // All subsequent tools keep the admitted tab/document, even after focus changes.
    await selectedTab(selection);
    if (message.type === "plan-start") {
      if (!isScannableUrl(selection.url)) throw new Error("当前页面不能生成计划");
      publishPlan(task, { ...PLAN_IDLE, status: "running", selectedTabId: selection.tabId, selectedUrl: selection.url });
      task.activePlanning = executePlan(task, selection);
      return task.planState;
    }
    if (message.type === "scan") {
      task.scanning = true;
      try {
        publishPlan(task, PLAN_IDLE);
        const report = await scanCurrentTab(selection);
        await boundTab(task);
        task.lastScan = { selectedTabId: selection.tabId, selectedUrl: selection.url, report };
        persistTask(task);
        return report;
      } catch (error) {
        const code = ["SCAN_INVALID_PAGE", "SCAN_PAGE_CHANGED", "SCAN_RESULT_INVALID", "REAL_PAGE_CHANGED"].includes(error?.message)
          ? error.message : "SCAN_INJECTION_FAILED";
        task.lastScan = null; persistTask(task);
        throw new Error(`页面扫描失败（${code}）：请确认原网页仍然打开，并重新扫描`);
      } finally { task.scanning = false; }
    }
    const choice = await preview(selection, { assertSelection: () => boundTab(task) });
    if (!choice.supported) throw new Error(choice.reason);
    const ledger = choice.realSite ? await loadUserLedger() : null;
    checkStopped(task);
    const previousRun = { selectedTabId: task.state.selectedTabId, selectedUrl: task.state.selectedUrl,
      outcomes: task.state.outcomes, items: task.planState.plan?.items };
    const { fillMode } = await fillPreference();
    publishPlan(task, PLAN_IDLE);
    publish(task, { ...IDLE, status: "running", realSite: choice.realSite === true,
      selectedTabId: selection.tabId, selectedUrl: selection.url, fillMode });
    task.activeRun = choice.realSite ? executeReal(task, selection, ledger, previousRun, fillMode) : execute(task, selection);
    return task.state;
  } catch (error) {
    if (message.type === "start") publish(task, { ...IDLE, status: "failed", selectedTabId: selection.tabId, selectedUrl: selection.url,
      error: "START_PREPARATION_FAILED：填写未启动，请查看面板提示并重新开始",
      pageDiagnostic: safePageDiagnostic(task.stopDiagnostic || error?.pageDiagnostic) || { stage: "startup", trigger: "start_failed" } });
    throw error;
  } finally { task.starting = false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: error?.message || "扩展后台处理失败" }),
  );
  return true;
});

function stopTask(task, code, pageDiagnostic) {
  // Synchronous cancellation + documentIds prevent same-URL refresh races.
  task.stopRequested = true;
  task.stopCode = code;
  if (pageDiagnostic) task.stopDiagnostic = safePageDiagnostic(pageDiagnostic);
  for (const wait of task.waits) wait.finish(Object.assign(new Error(code), { code }));
  task.socket?.close();
}
function cancelTask(task, diagnostic) { stopTask(task, "REAL_PAGE_CHANGED", diagnostic); }
function cancelForNavigation(tabId, removed = false, diagnostic) {
  const current = tasks.get(tabId);
  if (current) cancelTask(current, diagnostic);
  const previousCleanup = current?.navigationCleanup;
  const cleanup = (async () => {
    await stateReady;
    const task = tasks.get(tabId);
    if (!task) return;
    cancelTask(task, diagnostic);
    if (removed) task.closed = true;
    task.navigationCleanup = cleanup;
    if (previousCleanup) await previousCleanup;
    if (task.activeRun) await task.activeRun;
    if (task.activePlanning) await task.activePlanning;
    task.lastScan = null;
    publishPlan(task, PLAN_IDLE);
    publish(task, { ...task.state, pageChanged: true });
    await persistence;
    if (removed) { tasks.delete(tabId); await chrome.storage.session.remove(TASK_PREFIX + tabId); }
    if (task.navigationCleanup === cleanup) task.navigationCleanup = null;
  })();
  if (current) current.navigationCleanup = cleanup;
  cleanup.catch(() => {
    console.error("页面生命周期", JSON.stringify({ code: "DOCUMENT_CLEANUP_FAILED" }));
    if (current?.navigationCleanup === cleanup) current.navigationCleanup = null;
  });
  return cleanup;
}
chrome.tabs.onRemoved?.addListener((tabId) => cancelForNavigation(tabId, true, { stage: "lifecycle", trigger: "tab_closed" }));
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") return cancelForNavigation(tabId, false, { stage: "lifecycle", trigger: "tab_loading", tabLoading: true,
    ...(typeof tab?.active === "boolean" ? { tabActive: tab.active } : {}),
    ...(typeof tab?.discarded === "boolean" ? { tabDiscarded: tab.discarded } : {}) });
});
