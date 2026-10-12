const HALT_LABELS = {
  ambiguous_mapping: "字段对应关系不明确",
  unsafe_page: "页面存在安全疑点",
  unsupported_control: "页面控件暂不支持",
  missing_profile: "资料库缺少所需信息",
};

const ERROR_LABELS = {
  MODEL_TIMEOUT: "模型请求超时",
  MODEL_HTTP_ERROR: "模型服务返回错误",
  MODEL_NETWORK_ERROR: "模型网络连接失败",
  MODEL_RESPONSE_INVALID: "模型响应格式不符合要求",
  MODEL_ARGUMENTS_INVALID: "模型参数无法解析",
  MODEL_CONTEXT_TOO_LARGE: "发送给模型的上下文过长",
  INVALID_DECISION: "模型没有给出有效决策",
  UNKNOWN_TOOL: "工具不在允许列表中",
  INVALID_ARGUMENTS: "工具参数不符合要求",
  UNSAFE_ADD_CONTROL: "添加按钮未通过安全检查",
  FIELD_NOT_WRITABLE: "目标字段不可写",
  UNKNOWN_PROFILE_PATH: "资料库中没有该字段路径",
  WOULD_OVERWRITE_EXISTING_VALUE: "页面已有不同内容，禁止覆盖",
};

function expectedEntries(catalog) {
  const indexes = catalog.map(({ path }) => /^educations\.(\d+)\./.exec(path)?.[1]).filter((index) => index !== undefined);
  return new Set(indexes).size;
}

export function summarizeObservation(page, catalog) {
  const count = page.sections.find((section) => section.key === "educations")?.entryCount ?? 0;
  const unfilled = page.fields.filter((field) => !field.filled).length;
  return `页面现有 ${count} 段教育经历、${page.fields.length} 个可见字段，其中 ${unfilled} 个为空；资料库列出 ${expectedEntries(catalog)} 段。`;
}

export function describeProposal(decision, page, catalog, mode) {
  if (decision.kind === "finish") return {
    title: "请求结束任务",
    reason: "决策器认为任务已经完成；程序会独立核对，不能仅凭这个声明结束。",
    plan: "本轮不修改页面，先检查所有预期字段。",
  };
  if (decision.kind === "halt") return {
    title: "决定停止并交给用户",
    reason: HALT_LABELS[decision.reason] || "无法确定下一步。",
    plan: "本轮不执行页面动作。",
  };

  const source = catalog.find((item) => item.path === decision.args?.sourcePath);
  const field = page.fields.find((item) => item.id === decision.args?.fieldId);
  let title;
  let plan;
  if (decision.tool === "add_entry") {
    const count = page.sections.find((item) => item.key === decision.args?.sectionKey)?.entryCount ?? 0;
    title = "添加一段教育经历";
    plan = `准备点击已观察到的「添加教育经历」按钮；预期卡片数从 ${count} 增至 ${count + 1}。`;
  } else if (decision.tool === "fill_field" && field && source) {
    title = `填写第 ${field.entryIndex + 1} 段的${field.label}`;
    plan = `准备把资料库「${source.label}」（${source.path}）对应到页面第 ${field.entryIndex + 1} 段的「${field.label}」；预期回读值与资料库一致。`;
  } else {
    title = "检查模型提出的动作";
    plan = `模型提出 ${decision.tool}；程序将先检查工具和目标，未通过则不会操作页面。`;
  }

  const origin = mode === "model" ? "模型给出的决策摘要" : "脚本规则说明";
  const fallback = mode === "model" ? "模型未提供文字理由；可查看上面的观察和下面的目标对应关系。" : "脚本按预设规则选择下一步。";
  const extra = decision.discardedProposals > 0
    ? ` 模型还提出 ${decision.discardedProposals} 个动作建议；本轮只采用首项，其余丢弃，执行后重新观察。`
    : "";
  return {
    title,
    reason: `${decision.rationale ? `${origin}：${decision.rationale}` : fallback}${extra}`,
    plan,
  };
}

export function describeVerification(event, beforePage, page, assessment) {
  if (event.kind === "planner") {
    const reason = ERROR_LABELS[event.code] || "模型决策失败";
    return {
      state: "已停止", tone: "error", execution: "未执行任何页面动作。",
      verification: `${reason}${event.httpStatus ? `（HTTP ${event.httpStatus}）` : ""}；还有 ${assessment.missingCount} 项待核对。`,
    };
  }
  if (event.kind === "halt") return {
    state: "已停止", tone: "error", execution: "模型主动停止；未执行页面动作。",
    verification: `${HALT_LABELS[event.reason] || "需要用户处理"}；还有 ${assessment.missingCount} 项待核对。`,
  };
  if (event.kind === "finish") return {
    state: "继续核对", tone: "warning", execution: "未执行页面动作。",
    verification: `完成声明未通过独立核对：还有 ${assessment.missingCount} 项未满足，下一轮继续观察。`,
  };
  if (!event.allowed) return {
    state: "已阻断", tone: "error", execution: `安全检查阻断：${ERROR_LABELS[event.code] || event.code}；未执行页面动作。`,
    verification: "此动作未获准执行，页面状态不计为成功。",
  };
  if (event.code === "TOOL_ERROR") return {
    state: "需重试", tone: "warning", execution: "执行页面动作时发生错误，已重新观察页面。",
    verification: `无法确认动作生效；还有 ${assessment.missingCount} 项待核对。`,
  };
  if (!event.verified) return {
    state: "需重试", tone: "warning", execution: "已尝试执行页面动作。",
    verification: `页面回读未满足预期，不能视为成功；还有 ${assessment.missingCount} 项待核对。`,
  };
  if (event.tool === "add_entry") {
    const before = beforePage.sections.find((section) => section.key === event.target?.sectionKey)?.entryCount ?? 0;
    const after = page.sections.find((section) => section.key === event.target?.sectionKey)?.entryCount ?? 0;
    return {
      state: "已核对", tone: "success", execution: "已点击页面上的「添加教育经历」按钮。",
      verification: `重新观察到卡片数 ${before} → ${after}，字段数 ${beforePage.fields.length} → ${page.fields.length}；还有 ${assessment.missingCount} 项待核对。`,
    };
  }
  const field = page.fields.find((item) => item.id === event.target?.fieldId);
  return {
    state: "已核对", tone: "success", execution: "已向目标输入框写入本地资料，并触发页面输入事件；记录中不保存资料值。",
    verification: `重新读取到「${field?.label || "目标字段"}」与所选资料路径的值一致；整体任务还有 ${assessment.missingCount} 项待核对。`,
  };
}

const PHASES = [
  ["observation", "观察 · 程序事实"],
  ["decision", "判断 · 决策摘要"],
  ["plan", "准备 · 预期结果"],
  ["execution", "执行 · 程序事实"],
  ["verification", "核验 · 页面回读"],
];

/** Renders one expandable, live-updating card per Agent step. It receives metadata only. */
export class StepLog {
  constructor(list, catalog) {
    this.list = list;
    this.catalog = catalog;
    this.cards = new Map();
    this.mode = "script";
  }

  reset(mode = "script", message = "点击上方按钮后，这里会逐步显示 Agent 的观察、判断、执行与核验。") {
    this.mode = mode;
    this.cards.clear();
    const item = this.list.ownerDocument.createElement("li");
    item.className = "activity-empty";
    item.textContent = message;
    this.list.replaceChildren(item);
  }

  begin(step, page) {
    for (const card of this.cards.values()) card.details.open = false;
    this.list.querySelector(".activity-empty")?.remove();
    const doc = this.list.ownerDocument;
    const item = doc.createElement("li");
    item.className = "step-item";
    const details = doc.createElement("details");
    details.className = "step-card";
    details.open = true;
    const summary = doc.createElement("summary");
    summary.className = "step-summary";
    const number = doc.createElement("span");
    number.className = "step-number";
    number.textContent = `第 ${step} 步`;
    const title = doc.createElement("strong");
    title.textContent = "观察页面并判断下一步";
    const state = doc.createElement("span");
    state.className = "step-state is-working";
    state.textContent = "判断中";
    summary.append(number, title, state);
    const body = doc.createElement("div");
    body.className = "step-body";
    const phases = new Map();
    for (const [key, label] of PHASES) {
      const row = doc.createElement("div");
      row.className = "step-phase";
      const heading = doc.createElement("span");
      heading.className = "phase-label";
      heading.textContent = label;
      const content = doc.createElement("p");
      content.textContent = "等待上一步完成…";
      row.append(heading, content);
      body.append(row);
      phases.set(key, content);
    }
    details.append(summary, body);
    item.append(details);
    this.list.prepend(item);
    const card = { details, title, state, phases };
    this.cards.set(step, card);
    phases.get("observation").textContent = summarizeObservation(page, this.catalog);
  }

  proposed(step, decision, page) {
    const card = this.cards.get(step);
    if (!card) return;
    const description = describeProposal(decision, page, this.catalog, this.mode);
    card.title.textContent = description.title;
    card.state.textContent = decision.kind === "act" ? "准备执行" : "正在核对";
    card.phases.get("decision").textContent = description.reason;
    card.phases.get("plan").textContent = description.plan;
    card.phases.get("execution").textContent = "正在进行执行前安全检查…";
    card.phases.get("verification").textContent = "等待页面回读。";
  }

  executing(step, action) {
    const card = this.cards.get(step);
    if (!card) return;
    card.state.textContent = "执行中";
    card.phases.get("execution").textContent = action.tool === "add_entry"
      ? "安全检查通过；正在点击已观察到的添加按钮。"
      : "安全检查通过；正在写入已观察到的输入框。";
  }

  finished(event, beforePage, page, assessment) {
    const card = this.cards.get(event.step);
    if (!card) return;
    if (event.kind === "planner") {
      card.title.textContent = "模型决策失败";
      card.phases.get("decision").textContent = "本轮没有得到可执行的结构化决策。";
      card.phases.get("plan").textContent = "停止本轮，不修改页面。";
    }
    const result = describeVerification(event, beforePage, page, assessment);
    card.details.classList.remove("is-success", "is-error", "is-warning");
    card.details.classList.add(`is-${result.tone}`);
    card.state.className = `step-state is-${result.tone}`;
    card.state.textContent = result.state;
    card.phases.get("execution").textContent = result.execution;
    card.phases.get("verification").textContent = result.verification;
  }

  completed(step) {
    const card = this.cards.get(step);
    if (!card) return;
    card.state.textContent = "任务完成";
    card.phases.get("verification").textContent += " 全部预期字段已经独立核对，页面没有提交。";
  }

  incomplete(step, missingCount) {
    const card = this.cards.get(step);
    if (!card) return;
    card.details.classList.remove("is-success", "is-error");
    card.details.classList.add("is-warning");
    card.state.className = "step-state is-warning";
    card.state.textContent = "步数用尽";
    card.phases.get("verification").textContent += ` 已达到步骤上限，仍有 ${missingCount} 项待核对。`;
  }

  interrupted() {
    const card = [...this.cards.values()].at(-1);
    if (!card) {
      this.reset(this.mode, "演示运行异常；请检查本地服务后重试。");
      return;
    }
    card.details.open = true;
    card.details.classList.remove("is-success", "is-warning");
    card.details.classList.add("is-error");
    card.state.className = "step-state is-error";
    card.state.textContent = "运行异常";
    card.phases.get("verification").textContent = "本地页面或服务发生异常，本轮没有可靠的核验结果。";
  }
}
