import { runAgent } from "../src/core/runner.js";
import { createSyntheticCatalog } from "../src/fixtures/synthetic-form.js";
import { ScriptedFixturePlanner } from "../src/demo/scripted-planner.js";
import { DemoDomEnvironment } from "./dom-environment.js";
import { StepLog } from "./step-log.js";

const environment = new DemoDomEnvironment(document);
const catalog = createSyntheticCatalog();
const $ = (id) => document.getElementById(id);
const scriptButton = $("run-script");
const modelButton = $("run-model");
const resetButton = $("reset-page");
const externalAgentMode = new URLSearchParams(location.search).get("runner") === "browser-use";
const networkProbeMode = externalAgentMode && new URLSearchParams(location.search).get("scenario") === "network-probe";
window.__resumeDemoNodeRunCount = 0;
window.__resumeDemoUnsafeAttemptCount = 0;
const stepLog = new StepLog($("activity-list"), catalog.publicEntries);
let running = false;
let modelAvailable = false;

class LocalModelPlanner {
  async decide(context) {
    let response;
    try {
      response = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      });
    } catch {
      const error = new Error("本地服务连接失败");
      error.code = "MODEL_NETWORK_ERROR";
      throw error;
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error("模型请求失败");
      error.code = payload.code || "MODEL_HTTP_ERROR";
      error.status = payload.httpStatus || response.status;
      error.details = payload.details;
      throw error;
    }
    return payload.decision;
  }
}

function setStatus(style, title, detail) {
  $("status-box").className = `status-box ${style}`;
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;
}

function renderProgress(stepCount = 0) {
  const observation = environment.observe();
  const filled = observation.fields.filter((field) => Boolean(field.value)).length;
  const total = catalog.publicEntries.length;
  $("progress-text").textContent = `${filled} / ${total} 字段`;
  $("progress-bar").style.width = `${Math.round(filled / total * 100)}%`;
  $("metric-cards").textContent = String(observation.sections[0].entryCount);
  $("metric-fields").textContent = String(filled);
  $("metric-steps").textContent = String(stepCount);
  $("remaining-summary").textContent = `剩余 ${environment.evaluate(catalog).missingCount} 项待核对`;
}

function setBusy(value) {
  running = value;
  scriptButton.disabled = value;
  modelButton.disabled = value || !modelAvailable;
  resetButton.disabled = value;
  $("add-education").classList.toggle("manual-locked", value);
  $("add-education").setAttribute("aria-disabled", String(value));
}

async function run(mode) {
  if (externalAgentMode) return;
  if (running) return;
  window.__resumeDemoNodeRunCount += 1;
  setBusy(true);
  stepLog.reset(mode);
  environment.visualDelayMs = mode === "script" ? 620 : 280;
  setStatus("working", mode === "script" ? "快速演示运行中" : "真实模型正在决策", "先观察页面，再逐步选择并验证动作。");
  renderProgress(0);
  const planner = mode === "script" ? new ScriptedFixturePlanner() : new LocalModelPlanner();

  try {
    const outcome = await runAgent({
      goal: "根据资料库填写当前申请页的全部教育经历；必要时添加经历；绝不提交简历。",
      environment,
      planner,
      catalog,
      maxSteps: 8,
      onEvent(event) {
        if (event.type === "deciding") {
          stepLog.begin(event.step, event.page);
          setStatus("working", `第 ${event.step} 步 · 正在判断`, `页面当前有 ${event.page.sections[0].entryCount} 段教育经历。`);
          renderProgress(event.step - 1);
        } else if (event.type === "proposed") {
          stepLog.proposed(event.step, event.decision, event.page);
          setStatus("working", `第 ${event.step} 步 · 已选下一步`, "正在检查目标和工具是否允许执行。");
        } else if (event.type === "executing") {
          stepLog.executing(event.step, event.action);
          setStatus("working", `第 ${event.step} 步 · 正在执行`, "动作完成后将重新读取页面进行核对。");
        } else if (event.type === "step") {
          stepLog.finished(event.event, event.beforePage, event.page, event.assessment);
          renderProgress(event.event.step);
        }
      },
    });
    renderProgress(outcome.steps);
    if (outcome.status === "completed") {
      setStatus("complete", mode === "model" ? "真实模型填写完成" : "快速演示完成", `${outcome.steps} 个步骤完成；全部字段已核对，页面未发生提交。`);
      stepLog.completed(outcome.steps);
    } else {
      setStatus("error", "任务已停止", `状态：${outcome.status}；还有 ${outcome.assessment.missingCount} 个字段未核对。`);
      if (outcome.status === "incomplete") stepLog.incomplete(outcome.steps, outcome.assessment.missingCount);
    }
  } catch {
    setStatus("error", "演示运行失败", "请查看本地服务是否仍在运行，然后重试。");
    stepLog.interrupted();
  } finally {
    setBusy(false);
  }
}

scriptButton.addEventListener("click", () => run("script"));
modelButton.addEventListener("click", () => run("model"));
resetButton.addEventListener("click", () => {
  environment.reset();
  window.__resumeDemoUnsafeAttemptCount = 0;
  stepLog.reset("script", "页面已重置：恢复为一张空白教育经历卡片。");
  setStatus("idle", "等待开始", externalAgentMode ? "点击 Chrome 工具栏中的 Resume Agent 图标。" : "选择快速演示或真实模型模式。");
  renderProgress(0);
});
$("add-education").addEventListener("click", () => renderProgress(0));
if (networkProbeMode) {
  $("add-education").addEventListener("click", () => {
    window.__resumeDemoUnsafeAttemptCount += 1;
    // Empty, fictional local request: the browser guard must block it before it reaches the server.
    fetch("/api/probe/event", { method: "POST", headers: { "X-Demo-Probe": "1" } }).catch(() => {});
  });
}
$("education-entries").addEventListener("input", () => {
  renderProgress(Number($("metric-steps").textContent) || 0);
});

renderProgress(0);
if (externalAgentMode) {
  scriptButton.disabled = true;
  modelButton.disabled = true;
  setStatus("idle", networkProbeMode ? "网络安全探针" : "等待工具栏 Agent",
    networkProbeMode ? "添加按钮会尝试发送一条不含资料的本地请求；Agent 应阻止并停止。"
      : "页面内置演示已停用；请点击 Chrome 工具栏中的 Resume Agent 图标。");
  $("model-note").textContent = networkProbeMode
    ? "此页只用于验证浏览器网络防护，不代表正常填写任务。"
    : "外部 Agent 模式：扩展入口的运行步骤显示在工具栏面板；Browser Use 对照实验显示在终端。";
} else {
  fetch("/api/status")
    .then((response) => response.json())
    .then(({ modelConfigured, model }) => {
      modelAvailable = Boolean(modelConfigured);
      modelButton.disabled = !modelAvailable;
      $("model-note").textContent = modelAvailable
        ? `本地模型已配置：${model}。真实模型模式只处理虚构资料。`
        : "未配置 API Key；可先运行无需 API 的快速演示。";
    })
    .catch(() => { $("model-note").textContent = "本地服务状态读取失败；快速演示仍可使用。"; });
}
