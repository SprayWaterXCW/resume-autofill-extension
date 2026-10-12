const $ = (id) => document.getElementById(id);

let selection = null;
let supported = false;
let scannable = false;
let scanRunning = false;
let runRunning = false;
let planRunning = false;
let lastPlanRenderKey = null;
let startError = null;
let currentProfile = { available: false, sections: [] };
let realSite = false;
let currentStatus = { status: "idle", events: [] };
let lastStatusRenderKey = null;
let currentDatePolicy = { monthStartDay: false };
let currentFillMode = "overwrite";
let activeTaskCount = 0;

function setBadge(id, label, style) {
  const element = $(id);
  element.textContent = label;
  element.className = `badge ${style || ""}`;
}

async function send(type, selected = selection, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, selection: selected, ...extra });
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有响应");
  return response.value;
}

async function currentSelection() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error("请切换到网页标签页，再打开 Resume Agent 图标");
  }
  return { tabId: tab.id, url: tab.url, title: tab.title || tab.url };
}

function renderEvents(events) {
  const list = $("events");
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  const previousScroll = list.scrollTop;
  list.replaceChildren();
  for (const event of $("show-all-events").checked ? events || [] : (events || []).slice(-40)) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${event.step}. ${event.phase} · ${event.tool}`;
    const detail = document.createElement("span");
    detail.textContent = event.summary;
    item.append(label, detail);
    list.append(item);
  }
  $("event-card").hidden = list.childElementCount === 0;
  list.scrollTop = follow ? list.scrollHeight : previousScroll;
}

function showStatus(status) {
  currentStatus = status;
  runRunning = status.status === "running";
  if (status.status !== "idle") startError = null;
  const renderKey = JSON.stringify([status, supported, realSite, startError]);
  if (renderKey === lastStatusRenderKey) return;
  lastStatusRenderKey = renderKey;
  const labels = { idle: "等待", running: "执行中", passed: "已完成", partial: "整页仍待补全", needs_review: "需人工处理", stopped: "已停止", failed: "填写中断" };
  setBadge("run-state", labels[status.status] || "未知", status.status);
  const progress = status.result || status.progress;
  $("metrics").hidden = !progress;
  if (progress) {
    $("added").textContent = String(progress.agentAddedCards ?? 0);
    $("written").textContent = String(progress.agentWrittenFields ?? 0);
    $("node-label").textContent = realSite ? "模型规划轮次" : "页面内置演示运行";
    $("node-runs").textContent = String(realSite ? progress.modelCalls ?? 0 : progress.nodeDemoRuns ?? 0);
  }
  if (status.status === "running") {
    $("run-note").textContent = "Agent 正在填写此标签页。切换标签页或关闭面板后继续运行；回到此页打开面板可查看进度。";
  } else if (status.status === "passed") {
    $("run-note").textContent = `已核验 ${status.result.correctFields}/${status.result.expectedFields} 个字段。请在网页中检查结果。`;
  } else if (status.status === "partial" || status.status === "needs_review") {
    const counts = status.result.planningCounts;
    const coverage = counts ? `扫描 ${status.result.observedFields} 个字段：标签缺失 ${counts.label_missing || 0}；资料缺失 ${counts.missing_profile || 0}；有歧义 ${counts.ambiguous_mapping || 0}；未映射 ${counts.unmapped || 0}；保护或人工处理 ${(counts.protected || 0) + (counts.manual_only || 0)}。` : "";
    const blanks = Number.isInteger(status.result.remainingBlankFields) ? `当前仍有 ${status.result.remainingBlankFields} 个可见空字段。` : "";
    const failures = status.result.unresolvedCount > 0 ? `${status.result.unresolvedCount} 次填写未通过核验。` : "";
    const pending = status.result.pendingEntries > 0 ? `还有 ${status.result.pendingEntries} 组经历待添加。` : "";
    const repair = status.result.repairedFields ? `已撤回上一轮语义不符的 ${status.result.repairedFields} 处 Agent 写入。` : "";
    const repairReview = status.result.repairsNeedingReview ? `${status.result.repairsNeedingReview} 处现有内容存在语义疑点，已保留，请查看执行记录核对。` : "";
    const verification = status.result.verificationCounts;
    const verifiedScope = verification ? `其中 ${verification.inputStateVerified ?? verification.pageStateVerified ?? 0} 个已核对输入组件状态，${verification.controlReadbackOnly} 个只完成控件选择或回读。网站预览仍需核对。` : "";
    $("run-note").textContent = `整页仍待核对与补全。${blanks}${pending}本轮核验写入 ${status.result.agentWrittenFields} 个字段，添加 ${status.result.agentAddedCards} 组经历；${verifiedScope}${failures}${coverage}${repair}${repairReview}${status.result.discardedMappingCount ? `其中 ${status.result.discardedMappingCount} 个字段因规划引用冲突留待人工，详见执行记录。` : ""}保存结果尚未验证，未提交。`;
  } else if (status.status === "failed" || status.status === "stopped") {
    const progress = status.progress;
    const partial = Number.isInteger(progress?.agentWrittenFields) && Number.isInteger(progress?.agentAddedCards)
      ? ` 中断前逐项回读 ${progress.agentWrittenFields} 个字段、添加 ${progress.agentAddedCards} 组经历；这些字段没有完成整页最终复核，本轮填写未完成。` : "";
    $("run-note").textContent = (status.error || "独立核验未通过，请检查扩展后台日志。") + partial;
  } else {
    $("run-note").textContent = supported ? "点击开始后，Agent 将观察、规划、填写并回读核验。" : "请先编辑并保存资料；也可以扫描网页，查看识别结果。";
  }
  if (startError) {
    setBadge("run-state", "未启动", "failed");
    $("run-note").textContent = startError;
  }
  if (status.pageChanged) $("run-note").textContent = "页面已刷新或离开，旧任务已结束。以上计数是刷新前的结果；请重新扫描或开始填写。";
  updateControls();
  renderEvents(status.events);
  $("outcome-list").replaceChildren();
  for (const outcome of status.outcomes || []) {
    const row = document.createElement("li");
    row.textContent = JSON.stringify(outcome);
    $("outcome-list").append(row);
  }
}

function showProfile(profile) {
  currentProfile = profile || { available: false, sections: [] };
  setBadge("profile-state", currentProfile.available ? currentProfile.purpose === "synthetic_evaluation" ? "虚构验收资料" : "已配置" : "未配置", currentProfile.available ? "ready" : "");
  $("profile-summary").textContent = currentProfile.available
    ? `${currentProfile.factCount - (currentProfile.derivedFactCount || 0)} 个原始资料项${currentProfile.derivedFactCount ? `，${currentProfile.derivedFactCount} 个有来源的派生项` : ""}。${currentProfile.sections.filter((section) => section.recordCount).map((section) => `${section.label} ${section.recordCount} 组`).join("；")}`
    : "打开编辑页面，填写并保存你的简历资料。";
  $("plan-note").textContent = `将字段标签和${currentProfile.available ? "导入的" : "虚构的"}资料目录发给已配置的模型；不发送输入框值。`;
}

function updateControls() {
  const busy = runRunning || planRunning || scanRunning;
  $("run").disabled = !supported || busy || Boolean(startError);
  $("scan").disabled = !scannable || busy;
  $("plan").disabled = !scannable || busy;
  $("stop").hidden = !runRunning || !realSite;
  $("profile-import").disabled = busy || activeTaskCount > 0;
  $("month-start-day").disabled = busy || activeTaskCount > 0;
}

const planStatusNames = {
  mapped: "已关联资料，待执行适配", needs_control_adapter: "需控件适配与选中核验",
  protected: "保留已有内容或禁用字段", needs_review: "现有值未读取，需人工核实",
  manual_only: "需要人工处理", label_missing: "字段标签待核实",
  source_conflict: "资料来源冲突，暂停使用", source_unverified: "资料尚未确认",
  missing_profile: "目录没有对应资料", ambiguous_mapping: "对应关系有歧义",
  unmapped: "模型未提供映射，需核实",
};
const sectionNames = { educations: "教育经历", awards: "获奖经历", competitions: "竞赛经历" };

function showPlan(state) {
  planRunning = state.status === "running";
  updateControls();
  const key = JSON.stringify([state.status, state.plan?.snapshotId, state.plan?.generatedAt, state.events?.length, state.error]);
  if (key === lastPlanRenderKey) return;
  lastPlanRenderKey = key;
  $("plan-card").hidden = state.status === "idle";
  $("plan-groups").replaceChildren();
  $("plan-events").replaceChildren();
  $("plan-summary").textContent = "";
  $("plan-boundary").textContent = "";
  setBadge("plan-state", { idle: "等待", running: "生成中", ready: "计划已生成", failed: "未生成" }[state.status] || "未知", state.status === "ready" ? "ready" : state.status);
  for (const event of state.events || []) {
    const item = document.createElement("li");
    item.textContent = event.summary;
    $("plan-events").append(item);
  }
  if (state.status === "running") {
    $("plan-note").textContent = "正在生成计划。关闭面板后仍会继续；重新打开可看结果。";
    return;
  }
  if (state.status === "failed") {
    $("plan-note").textContent = state.error;
    return;
  }
  $("plan-note").textContent = `将字段标签和${currentProfile.available ? "导入的" : "虚构的"}资料目录发给已配置的模型；不发送输入框值。`;
  if (!state.plan) return;
  const plan = state.plan;
  const linked = plan.items.filter((item) => item.sourcePath).length;
  $("plan-summary").textContent = `${plan.profileKind === "user_import" ? "已导入资料" : "虚构资料"} · ${linked}/${plan.summary.fieldCount} 个字段关联了资料路径 · 还需 ${plan.summary.additionalEntries} 组记录。${plan.summary.discardedMappingCount ? `已隔离 ${plan.summary.discardedMappingCount} 个引用冲突字段。` : ""}`;
  for (const section of plan.sections.filter((item) => plan.items.some((field) => field.groupId === item.groupId))) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${section.label} · 网页 ${section.observedEntries} 组 / 资料 ${section.profileEntries} 组${section.additionalEntries ? ` · 需增加 ${section.additionalEntries} 组` : ""}`;
    details.append(summary);
    if (section.sectionKeys.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = `资料区块：${section.sectionKeys.map((name) => sectionNames[name] || name).join(" + ")}`;
      details.append(note);
    }
    const list = document.createElement("ul");
    for (const item of plan.items.filter((field) => field.groupId === section.groupId)) {
      const row = document.createElement("li");
      row.textContent = `${item.entryIndex + 1}. ${item.label}${item.sourcePath ? ` → ${item.sourceLabel} (${item.sourcePath})` : ""} · ${planStatusNames[item.status] || item.status}${item.evidenceCount ? ` · ${item.evidenceCount} 条已确认来源记录` : ""}`;
      list.append(row);
    }
    details.append(list);
    $("plan-groups").append(details);
  }
  $("plan-boundary").textContent = `${state.executed ? "这是本轮执行使用的计划；实际写入结果见执行记录。" : "这是生成时经复扫核对的建议，请检查语义对应。"}页面变化后重新扫描。${plan.unplacedSections.length ? `尚未找到页面分组的资料：${plan.unplacedSections.map((name) => sectionNames[name] || name).join("、")}。` : ""}${plan.summary.truncated ? "扫描不完整，需继续核实。" : ""}${state.executed ? "尚未保存或提交。" : "没有执行填写、添加、保存或提交。"}`;
  if (!state.executed) $("plan-card").scrollIntoView?.({ block: "start", behavior: "smooth" });
}

const kindNames = {
  text: "文本", textarea: "多行文本", number: "数值", date: "日期",
  select: "原生下拉", "custom-select": "自定义下拉", cascader: "级联选择",
  autocomplete: "自动补全", combobox: "组合框", radio: "单选", checkbox: "复选",
  credential: "凭据字段", file: "文件上传", signature: "签名区域",
};
const intentNames = { submit: "提交类按钮", "save-candidate": "保存候选，需验证", "add-candidate": "添加经历候选，需验证", signature: "签名控件", other: "其他按钮" };

function renderScan(report) {
  $("custom-choice-diagnostic").hidden = !report?.customQuestions?.length;
  $("custom-choice-structure").replaceChildren();
  $("add-diagnostic").hidden = !report?.addDiagnostics?.length;
  $("add-structure").replaceChildren();
  $("calendar-diagnostic").hidden = !report?.calendarDiagnostics?.length;
  $("calendar-structure").replaceChildren();
  const diagnosticRow = (list, text) => { const row = document.createElement("li"); row.textContent = text; $(list).append(row); };
  for (const question of report?.customQuestions || []) for (const choice of question.choices) {
    diagnosticRow("custom-choice-structure", choice.label);
    for (const ancestor of choice.ancestors) {
      diagnosticRow("custom-choice-structure", JSON.stringify({ ...ancestor, children: undefined }));
      for (const child of ancestor.children || []) diagnosticRow("custom-choice-structure", `child ${JSON.stringify(child)}`);
    }
  }
  for (const [i, control] of (report?.addDiagnostics || []).entries()) {
    diagnosticRow("add-structure", `添加候选 ${i + 1}`);
    for (const ancestor of control.ancestors) {
      diagnosticRow("add-structure", JSON.stringify({ ...ancestor, children: undefined }));
      for (const child of ancestor.children || []) diagnosticRow("add-structure", `child ${JSON.stringify(child)}`);
    }
  }
  for (const calendar of report?.calendarDiagnostics || []) for (const control of calendar.controls) diagnosticRow("calendar-structure", JSON.stringify(control));
  $("scan-card").hidden = !report;
  $("scan-groups").replaceChildren();
  $("scan-warnings").replaceChildren();
  if (!report) return;
  const counts = report.summary;
  $("scan-summary").textContent = `${counts.groupCount} 个字段分组 · ${counts.fieldCount} 个字段 · ${counts.controlCount} 个按钮。${counts.knownExistingFields} 个非敏感字段已有内容；${counts.excludedValueFields} 个字段仅描述结构；${counts.unlabeledFields} 个字段标签待核实。`;
  $("scan-types").textContent = Object.entries(counts.kindCounts).map(([kind, count]) => `${kindNames[kind] || kind} ${count}`).join(" · ");
  for (const group of report.groups) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${group.label} · ${group.entryCount} 组记录 · ${group.fieldCount} 个字段 · ${group.controlCount} 个按钮`;
    details.append(summary);
    const list = document.createElement("ul");
    for (const field of report.fields.filter((item) => item.groupId === group.id)) {
      const item = document.createElement("li");
      const flags = [kindNames[field.kind] || field.kind, field.required ? "必填" : null,
        field.optionLabel ? `选项：${field.optionLabel}` : null,
        field.disabled ? "禁用" : null, field.readOnly ? ["custom-select", "cascader", "combobox", "autocomplete"].includes(field.kind)
          ? "通过选项选择" : field.kind === "date" ? "通过日期选择器填写" : "只读输入" : null,
        field.hasValue === true ? "已有内容" : null, field.valueExcluded ? "值未读取" : null].filter(Boolean);
      item.textContent = `${field.entryIndex + 1}. ${field.label} [${field.id}] · ${flags.join(" / ")}`;
      list.append(item);
    }
    for (const control of report.controls.filter((item) => item.groupId === group.id)) {
      const item = document.createElement("li");
      item.textContent = `${control.label} · ${intentNames[control.intent] || control.intent} · 本次仅记录`;
      list.append(item);
    }
    details.append(list);
    $("scan-groups").append(details);
  }
  for (const warning of report.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    $("scan-warnings").append(item);
  }
}

async function refreshStatus() {
  try {
    const [status, plan, tasks] = await Promise.all([send("status"), send("plan-status"), send("tasks-status")]);
    activeTaskCount = tasks?.activeTaskCount || 0;
    $("background-note").textContent = tasks?.otherTaskCount > 0
      ? `另有 ${tasks.otherTaskCount} 个标签页任务在后台运行。此页可独立开始；停止按钮只停止此页。`
      : "切换标签页后继续填写原页面；每个标签页单独开始、查看记录和停止。";
    showStatus(status);
    const changed = plan.status === "ready" && plan.plan?.generatedAt
      && !lastPlanRenderKey?.includes(plan.plan.generatedAt);
    showPlan(plan);
    if (changed) renderScan(await send("scan-status"));
  } catch (error) {
    setBadge("run-state", "后台异常", "failed");
    $("run-note").textContent = error.message || "扩展后台未响应";
    $("run").disabled = true;
    $("scan").disabled = true;
    $("plan").disabled = true;
  }
}

async function initialize() {
  selection = null;
  supported = false;
  scannable = false;
  realSite = false;
  try {
    // Saved profile and user settings are independent of the selected page.
    // An internal Chrome page cannot be filled, but must still show these states.
    showProfile(await send("profile-status"));
    currentFillMode = (await send("fill-preference")).fillMode;
    $("fill-mode").value = currentFillMode;
    $("fill-mode-note").textContent = currentFillMode === "overwrite"
      ? "用资料库覆盖可编辑字段；缺少资料不清空。每个任务使用启动时的模式。"
      : "只填写空白字段，保留网页已有内容。每个任务使用启动时的模式。";
    currentDatePolicy = await send("date-policy");
    $("month-start-day").checked = currentDatePolicy.monthStartDay;
    $("date-policy-note").textContent = currentDatePolicy.monthStartDay
      ? "已确认：缺少日的经历日期按当月 1 日填写，每次补全均记录；出生日期不补全。"
      : "未启用日期补全；缺少日的完整日期字段留待你处理。";
    selection = await currentSelection();
    $("tab-title").textContent = selection.title;
    $("tab-url").textContent = selection.url;
    const preview = await send("preview");
    supported = preview.supported;
    scannable = preview.scannable;
    realSite = preview.realSite === true;
    setBadge("scope", realSite ? "真实表单" : supported ? "本地演示" : scannable ? "可扫描" : "不可用", supported || scannable ? "ready" : "blocked");
    $("selection-note").textContent = preview.reason;
    renderScan(await send("scan-status"));
    await refreshStatus();
  } catch (error) {
    setBadge("scope", "不可用", "blocked");
    $("tab-title").textContent = "无法启动此页面";
    $("selection-note").textContent = error.message || "选择标签页失败";
    $("run").disabled = true;
    $("scan").disabled = true;
    $("plan").disabled = true;
    await refreshStatus();
  }
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  try {
    const fresh = await currentSelection();
    if (!selection || fresh.tabId !== selection.tabId || fresh.url !== selection.url) {
      throw new Error("当前标签页已变化，请重新打开面板");
    }
    startError = null;
    showStatus(await send("start"));
  } catch (error) {
    startError = error.message || "启动失败，请重新打开面板";
    setBadge("run-state", "未启动", "failed");
    $("run-note").textContent = startError;
    $("run").disabled = true;
  }
});

$("profile-import").addEventListener("click", () => { $("profile-file").value = ""; $("profile-file").click(); });
$("profile-edit").addEventListener("click", async () => {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL("profile-editor.html") }); }
  catch { $("profile-note").textContent = "编辑页面未能打开，请重新点击或从扩展详情打开“扩展程序选项”。"; }
});
$("profile-file").addEventListener("change", async () => {
  const file = $("profile-file").files?.[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("JSON 文件超过 2 MB，请导出单份简历资料");
    const data = JSON.parse(await file.text());
    showProfile(await send("profile-import", selection, { data }));
    startError = null;
    $("profile-note").textContent = "已导入原有资料；填写时使用所选覆盖模式。";
    await initialize();
  } catch (error) {
    if (error.message === "PROFILE_EDITOR_BUSY") {
      $("profile-note").textContent = "Agent 正在执行任务，请等待结束后再导入资料。";
      return;
    }
    $("profile-note").textContent = /PROFILE_/.test(error.message) ? `导入失败（${error.message}）：请使用原插件导出的简历 JSON`
      : "导入失败：请检查是否选择了有效的简历 JSON 文件";
  }
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  try { await send("stop"); $("run-note").textContent = "已请求停止，正在结束当前操作；已填写内容保留。"; }
  catch (error) { $("run-note").textContent = error.message; }
  finally { $("stop").disabled = false; }
});

$("month-start-day").addEventListener("change", async () => {
  try {
    currentDatePolicy = await send("date-policy-set", selection, { monthStartDay: $("month-start-day").checked });
    $("date-policy-note").textContent = currentDatePolicy.monthStartDay
      ? "已确认：缺少日的经历日期按当月 1 日填写，每次补全均记录；出生日期不补全。"
      : "未启用日期补全；缺少日的完整日期字段留待你处理。";
  } catch (error) {
    $("month-start-day").checked = currentDatePolicy.monthStartDay;
    $("date-policy-note").textContent = error.message;
  }
});

$("fill-mode").addEventListener("change", async () => {
  $("fill-mode").disabled = true;
  try {
    currentFillMode = (await send("fill-preference-set", selection, { fillMode: $("fill-mode").value })).fillMode;
    $("fill-mode-note").textContent = currentFillMode === "overwrite"
      ? "用资料库覆盖可编辑字段；缺少资料不清空。已在运行的任务继续使用启动时的模式。"
      : "只填写空白，保留已有内容。已在运行的任务继续使用启动时的模式。";
  } catch (error) {
    $("fill-mode").value = currentFillMode;
    $("fill-mode-note").textContent = error.message;
  } finally { $("fill-mode").disabled = false; }
});

$("show-all-events").addEventListener("change", () => renderEvents(currentStatus.events));

$("copy-log").addEventListener("click", async () => {
  const log = JSON.stringify({ version: chrome.runtime.getManifest().version, submissionPolicy: "agent_actions_only", runId: currentStatus.runId || null,
    tabId: selection?.tabId ?? null, origin: selection ? new URL(selection.url).origin : null,
    status: currentStatus.status, profile: currentProfile, progress: currentStatus.progress, result: currentStatus.result,
    events: currentStatus.events, outcomes: currentStatus.outcomes, datePolicy: currentDatePolicy,
    fillMode: currentStatus.fillMode || null, nextRunFillMode: currentFillMode, error: currentStatus.error,
    pageDiagnostic: currentStatus.pageDiagnostic }, null, 2);
  try {
    try { await navigator.clipboard.writeText(log); }
    catch {
      const area = document.createElement("textarea"); area.value = log; document.body.append(area); area.select();
      const copied = document.execCommand("copy"); area.remove(); if (!copied) throw new Error("COPY_FAILED");
    }
    $("copy-note").textContent = "已复制执行记录；不含简历字段值和 API 密钥。";
  } catch { $("copy-note").textContent = "复制失败，请重新点击或在后台查看执行记录。"; }
});

$("scan").addEventListener("click", async () => {
  scanRunning = true;
  updateControls();
  $("scan-note").textContent = "正在读取页面字段与按钮结构…";
  try {
    const fresh = await currentSelection();
    if (!selection || fresh.tabId !== selection.tabId || fresh.url !== selection.url) {
      throw new Error("当前标签页已变化，请重新打开面板");
    }
    renderScan(await send("scan"));
    $("scan-note").textContent = "扫描完成。展开分组可查看字段与按钮；未填写或保存。";
  } catch (error) {
    renderScan(null);
    $("scan-note").textContent = error.message || "扫描失败，请重新打开面板";
  } finally {
    scanRunning = false;
    await refreshStatus();
  }
});

$("plan").addEventListener("click", async () => {
  planRunning = true;
  updateControls();
  try {
    const fresh = await currentSelection();
    if (!selection || fresh.tabId !== selection.tabId || fresh.url !== selection.url) {
      throw new Error("当前标签页已变化，请重新打开面板");
    }
    showPlan(await send("plan-start"));
  } catch (error) {
    showPlan({ status: "failed", error: error.message || "计划未启动，请重新打开面板", events: [] });
  }
});

initialize();
setInterval(refreshStatus, 1200);
