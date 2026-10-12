import { createPlanContext, buildFillPlan, createPartialProposal, validatePartialProposal, planFailureFeedbackSchema, validatePlanFailureFeedback } from "./fill-plan.js";
import { awardPlanningDiagnostic } from "./award-planning-diagnostics.js";
import { formDiagnostic } from "./form-diagnostics.js";
import { modelHttpDiagnosticSchema, modelHttpHint } from "./model-http-diagnostics.js";
import { fillTargetIdentity, matchWrittenTargets, sameFillTargets, formStructureDifference } from "./form-structure-identity.js";
import { resolveFillMode, fillModeLabel } from "./fill-mode.js";
import { safePageDiagnostic } from "./page-lifecycle-diagnostics.js";

const executableStatuses = new Set(["mapped", "needs_control_adapter", "needs_review"]);
const fatalCodes = new Set(["REAL_PAGE_CHANGED", "REAL_FORM_STRUCTURE_CHANGED", "NETWORK_GUARD_UNVERIFIED", "REAL_FRAME_UNSUPPORTED"]);

/** Observe → model mapping → validated tools → readback → fresh observation. Partial results are explicit. */
export async function runRealForm({ environment, planner, ledger, onEvent = () => {}, shouldStop = () => false,
  maxAdds = 20, maxWrites = 200, maxStructureRecoveries = 3, datePolicy = { monthStartDay: false }, fillMode = "overwrite", previousRun }) {
  fillMode = resolveFillMode(fillMode);
  let step = 0, added = 0, written = 0, modelCalls = 0;
  const outcomes = [], unavailableAdds = new Set(), writesByTarget = new Map(), sectionMemory = new Map();
  const attemptsByTarget = new Map(), exhaustedTargets = new Set();
  let lastObservation, writeAttempts = 0, structureRecoveries = 0, writeLimitReached = false;
  const planContext = (page) => createPlanContext(page, ledger, { fillMode, verifiedMappings: outcomes.filter((item) => item.tool === "fill_field" && item.verified)
    .map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath })) });
  const emit = (phase, tool, summary, extra = {}) => onEvent({ step: ++step, phase, tool, summary, ...extra,
    progress: { agentAddedCards: added, agentWrittenFields: written, step, modelCalls } });
  const checkStop = () => { if (shouldStop()) throw Object.assign(new Error("USER_STOPPED"), { code: "USER_STOPPED" }); };
  const observe = async () => {
    checkStop();
    const fresh = await environment.observe();
    if (lastObservation) {
      const pairs = new Map(matchWrittenTargets(lastObservation, fresh,
        outcomes.filter((item) => item.tool === "fill_field" && item.verified).map((item) => item.fieldId))
        .map((pair) => [pair.beforeId, pair]));
      for (const outcome of outcomes.filter((item) => item.tool === "fill_field")) {
        const pair = pairs.get(outcome.fieldId);
        if (pair) {
          outcome.fieldId = pair.afterId;
          if (pair.auditOnly && outcome.verified) emit("复核", "audit", "网页锁定了已填写字段；仅保留原凭据供回读，不允许再次写入",
            { code: "WRITE_RECEIPT_LOCKED", fieldId: outcome.fieldId, sourcePath: outcome.sourcePath });
        }
        else if (outcome.verified) {
          outcome.verified = false; outcome.code = "WRITE_TARGET_RETIRED"; written -= 1;
          emit("复核", "audit", "网页已移除或改变先前填写目标，撤回成功计数；新结构需重新规划",
            { code: outcome.code, fieldId: outcome.fieldId, sourcePath: outcome.sourcePath });
        }
      }
    }
    lastObservation = fresh;
    return fresh;
  };
  const writeKey = (item) => {
    const identity = fillTargetIdentity(lastObservation, lastObservation?.fields.find((field) => field.id === item.fieldId));
    return identity && lastObservation.fields.filter((field) => fillTargetIdentity(lastObservation, field) === identity).length === 1
      ? identity + "|" + item.sourcePath : null;
  };
  const rememberWrite = (item, outcome, detail) => {
    const key = writeKey(item), old = key && writesByTarget.get(key);
    const record = { tool: "fill_field", fieldId: item.fieldId, sourcePath: item.sourcePath, ...detail, verified: outcome.verified };
    if (old) {
      const recoveredFrom = old.code;
      Object.assign(old, record, outcome.verified && recoveredFrom !== "VERIFIED" ? { recoveredFrom } : {});
    } else {
      outcomes.push(record);
      if (key) writesByTarget.set(key, record);
    }
  };
  const auditWritten = async () => {
    if (!environment.audit) return;
    const writtenTargets = outcomes.filter((item) => item.tool === "fill_field" && item.verified)
      .map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath }));
    const audited = await environment.audit(writtenTargets);
    for (const final of audited) {
      const original = outcomes.find((item) => item.fieldId === final.fieldId && item.sourcePath === final.sourcePath);
      original.finalVerified = final.verified;
      if (!final.verified) {
        original.verified = false;
        original.code = final.code;
        written -= 1;
        emit("复核", "audit", `${final.sourcePath}：整页完成后内容发生变化，留待人工核对`, { code: final.code, fieldId: final.fieldId, sourcePath: final.sourcePath,
          ...(final.diagnostic ? { diagnostic: final.diagnostic } : {}) });
      }
    }
  };
  emit("规则", "fill_mode", `本轮填写模式：${fillModeLabel(fillMode)}；只写有可靠资料的可编辑字段，缺少资料不清空，声明和提交由用户操作`, { code: fillMode === "overwrite" ? "FILL_MODE_OVERWRITE" : "FILL_MODE_EMPTY" });
  if (environment.repairPreviousWrites) emit("观察", "prior_write_audit", "检查现有内容的语义疑点和本页旧写入凭据；不将已有内容计为本轮成功");
  const repairs = environment.repairPreviousWrites ? await environment.repairPreviousWrites(previousRun, ledger) : [];
  for (const repair of repairs) {
    outcomes.push(repair);
    emit("恢复", "semantic_repair", `${repair.label}：${repair.verified ? "已根据上一轮本页写入凭据撤回语义不符的值" : repair.code === "EXISTING_SEMANTIC_REVIEW"
      ? "现有内容与不同含义的资料相同，写入凭据不足；已保留，需核对" : "无法证明仍是上一轮写入，保留现有内容并标记待核对"}`,
      { fieldId: repair.fieldId, sourcePath: repair.sourcePath, code: repair.code });
  }
  if (datePolicy.monthStartDay === true) emit("规则", "date_policy", "用户已确认：缺少日的经历日期按当月 1 日补全；每次补全单独记录，资料原文不变", { code: "USER_CONFIRMED_MONTH_START_DAY" });
  let report = await observe();
  if (!report.fields.length && !report.controls.some((control) => control.intent === "add-candidate") && environment.waitForForm) {
    emit("观察", "form_wait", "页面尚未出现表单，等待当前文档的控件加载；尚未调用模型或填写", { code: "FORM_WAIT_STARTED" });
    const available = await environment.waitForForm({ shouldStop, timeoutMs: 10_000 });
    checkStop();
    report = await observe();
    if (!available || !report.fields.length && !report.controls.some((control) => control.intent === "add-candidate")) {
      throw Object.assign(new Error("FORM_NOT_READY"), { code: "FORM_NOT_READY" });
    }
    emit("观察", "form_wait", "当前文档的表单已出现，开始正常观察与规划", { code: "FORM_READY" });
  }
  emit("观察", "scan", `发现 ${report.summary.fieldCount} 个字段，${report.summary.groupCount} 个分组`);

  const sectionShape = (page, groupId) => JSON.stringify(page.fields.filter((field) => field.groupId === groupId && field.entryIndex === 0)
    .map((field) => [field.label, field.kind, field.datePart ?? null, field.dateRole ?? null, field.required, field.readOnly, field.optionLabel ?? null]).sort());
  function retainSectionDeclarations(context, proposal) {
    if (!Array.isArray(proposal?.groupMappings)) return proposal;
    const groupMappings = [...proposal.groupMappings];
    for (const group of context.page.groups) {
      const memory = sectionMemory.get(group.label);
      if (!memory || groupMappings.some((item) => item.groupId === group.id)
        || context.page.groups.filter((item) => item.label === group.label).length !== 1
        || memory.source !== group.source || memory.shape !== sectionShape(context.page, group.id)) continue;
      groupMappings.push({ groupId: group.id, sectionKeys: memory.sectionKeys });
    }
    return { ...proposal, groupMappings };
  }
  function changedPlanError(before, after) {
    // Presence-only changes can be user edits during model generation. They
    // still stop; automatic recovery is limited to observed topology changes.
    const code = sameFillTargets(before, after) ? "REAL_PAGE_CHANGED" : "REAL_FORM_STRUCTURE_CHANGED";
    return Object.assign(new Error(code), { code, structureDiagnostic: formStructureDifference(before, after) });
  }

  async function planFor(observation) {
    checkStop();
    const context = await planContext(observation);
    emit("观察", "form_structure", "结构诊断：记录全部字段的分组依据、卡片索引、标签来源和日期单位；不含字段值", { formDiagnostic: formDiagnostic(context) });
    let plan, feedback;
    const failures = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      checkStop();
      modelCalls += 1;
      emit("计划", "model", feedback ? `根据上轮校验错误重新规划（第 ${attempt + 1}/3 次）`
        : `资料库有 ${context.profileCatalog.length} 个路径，为当前待填写字段规划映射`);
      let proposal;
      try {
        proposal = await planner.planMappings(context, feedback, { onProgress: (progress) => {
          const group = context.page.groups.find((group) => group.id === progress.groupId);
          if (group) emit("计划", "model_region", `${group.label}：${progress.phase === "started" ? "正在匹配" : "已获得建议"}（${progress.completedRegions}/${progress.totalRegions} 个区块）；合并校验通过后执行`,
            { code: progress.phase === "started" ? "REGION_PLAN_STARTED" : "REGION_PLAN_COMPLETED", groupId: progress.groupId,
              completedRegions: progress.completedRegions, totalRegions: progress.totalRegions });
        } });
        checkStop();
        proposal = retainSectionDeclarations(context, proposal);
        plan = await buildFillPlan(context, proposal);
        break;
      } catch (error) {
        const code = error?.code;
        const httpDiagnostic = modelHttpDiagnosticSchema.safeParse(error?.httpDiagnostic);
        if (httpDiagnostic.success) emit("核验", "model_http", modelHttpHint(httpDiagnostic.data),
          { code, httpDiagnostic: httpDiagnostic.data });
        if (!planFailureFeedbackSchema.safeParse({ code }).success) throw error;
        let failure;
        try { failure = validatePlanFailureFeedback(context, { code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          ...(error.responseDiagnostic ? { responseDiagnostic: error.responseDiagnostic } : {}) }); }
        catch { failure = { code }; }
        const references = (failure.diagnostic?.fieldIds || []).map((fieldId) => `${context.page.fields.find((field) => field.id === fieldId)?.label}（${fieldId}）`).join("、");
        const failedAwards = awardPlanningDiagnostic(context, { proposal, failures: [failure] });
        const responseStages = { tool_call_missing: "未返回规划工具调用", tool_call_count: "规划工具调用数量不符合契约",
          tool_call_invalid: "规划工具类型或名称不符合契约", output_truncated: "模型输出被截断",
          arguments_json: "工具参数不是完整 JSON", arguments_schema: "工具参数字段格式不符合契约" };
        const responseReason = responseStages[failure.responseDiagnostic?.stage];
        emit("核验", "plan", `${code}：${failure.diagnostic?.violation || responseReason || "建议格式未通过"}${references ? `；${references}` : ""}；尚未操作表单`,
          { ...failure, ...(failedAwards ? { awardPlanning: failedAwards } : {}) });
        let isolated;
        try {
          const partial = error.partial || (proposal ? await createPartialProposal(context, proposal) : null);
          if (partial) isolated = await validatePartialProposal(context, partial);
        } catch { /* An unverifiable fallback never becomes executable or feedback. */ }
        if (attempt === 2) {
          if (!isolated) throw error;
          const validated = isolated;
          plan = validated.plan;
          plan.mappingExclusions = validated.partial.exclusions;
          plan.summary.discardedMappingCount = validated.partial.discardedFieldIds.length;
          const partialAwards = awardPlanningDiagnostic(context, { proposal, failures: validated.partial.exclusions,
            discardedFieldIds: validated.partial.discardedFieldIds, plan });
          if (partialAwards) emit("核验", "award_plan", "获奖来源诊断：记录字段类型、识别角色、可用来源和排除结果；不含资料值",
            { awardPlanning: partialAwards });
          for (const exclusion of validated.partial.exclusions) {
            const labels = (exclusion.diagnostic?.fieldIds || []).map((fieldId) => `${context.page.fields.find((field) => field.id === fieldId)?.label}（${fieldId}）`).join("、");
            emit("核验", "quarantine", `${exclusion.diagnostic.violation}${labels ? `；${labels}` : ""}：已排除冲突引用，交给人工处理`, exclusion);
          }
          emit("计划", "partial_plan", `三次规划后仍有问题，${validated.partial.discardedFieldIds.length} 个字段留待核对；其余映射重新通过完整校验`);
          break;
        }
        for (const related of isolated?.partial.exclusions || [failure]) {
          if (!failures.some((item) => JSON.stringify(item) === JSON.stringify(related))) failures.push(related);
        }
        const previousFailures = failures.filter((item) => JSON.stringify(item) !== JSON.stringify(failure)).slice(-24);
        feedback = { ...failure, ...(previousFailures.length ? { previousFailures } : {}) };
        const changed = await planContext(await observe());
        if (context.snapshotId !== changed.snapshotId) throw changedPlanError(context.page, changed.page);
      }
    }
    const fresh = await observe();
    const current = await planContext(fresh);
    if (context.snapshotId !== current.snapshotId) throw changedPlanError(context.page, current.page);
    for (const section of plan.sections) {
      const group = context.page.groups.find((item) => item.id === section.groupId);
      if (section.sectionKeys.some((key) => context.profileCatalog.some((fact) => fact.sectionKey === key && /^\d+$/.test(fact.path.split(".")[1])))
        && group && context.page.groups.filter((item) => item.label === group.label).length === 1) {
        sectionMemory.set(group.label, { sectionKeys: section.sectionKeys, source: group.source, shape: sectionShape(context.page, group.id) });
      }
    }
    const counts = plan.summary.counts;
    emit("核验", "plan", `共 ${plan.items.length} 个字段：关联 ${plan.items.filter((item) => item.sourcePath).length} 个；标签缺失 ${counts.label_missing || 0} 个；资料缺失 ${counts.missing_profile || 0} 个；有歧义 ${counts.ambiguous_mapping || 0} 个；未映射 ${counts.unmapped || 0} 个；保护或人工处理 ${(counts.protected || 0) + (counts.manual_only || 0)} 个；缺少 ${plan.summary.additionalEntries} 组经历`,
      { formDiagnostic: formDiagnostic(context, plan) });
    for (const section of plan.sections.filter((section) => section.additionPolicy === "section_boundary_unresolved")) {
      emit("核验", "section_boundary", `${section.label} 包含多种经历；现有记录分别按各自索引校验，新增卡片需先确认各自区块边界`,
        { code: "SECTION_BOUNDARY_UNRESOLVED", groupId: section.groupId, unresolvedEntries: section.unresolvedEntries });
    }
    return { report: fresh, plan };
  }

  let plan, candidates = [], completedGraph = false;
  // Populate existing records before expansion. Each expansion or unexpected
  // same-document change receives a new validated plan, including late sections.
  for (let cycle = 0; cycle < maxAdds + maxStructureRecoveries + 3; cycle += 1) {
    try {
      const planned = await planFor(report);
      report = planned.report; plan = planned.plan;
      candidates = plan.items.filter((item) => item.sourcePath && executableStatuses.has(item.status));
      // Independent writes: a failure in one unsupported control must not cancel the entire form.
      for (const item of candidates) {
        checkStop();
        const key = writeKey(item);
        const previousAttempt = writesByTarget.get(key);
        if (previousAttempt?.verified || previousAttempt?.code === "PROTECTED") continue;
        // Adding an unrelated record does not make the same unsupported widget
        // a new target. Permit one later recovery attempt, then leave it pending
        // while giving all remaining records their first attempt.
        if (key && (attemptsByTarget.get(key) || 0) >= 2) {
          if (!exhaustedTargets.has(key)) {
            exhaustedTargets.add(key);
            emit("核验", "retry_policy", `${item.label}：同一目标已尝试两次，保留失败原因，继续其他字段和经历`,
              { code: "CONTROL_RETRY_LIMIT", fieldId: item.fieldId, sourcePath: item.sourcePath, counts: { attempts: 2 } });
          }
          continue;
        }
        if (writeAttempts >= maxWrites) { writeLimitReached = true; break; }
        writeAttempts += 1;
        if (key) attemptsByTarget.set(key, (attemptsByTarget.get(key) || 0) + 1);
        const pickerHint = ["formAnswers.ethnicity", "formAnswers.hometown"].includes(item.sourcePath)
          ? "；等待词典候选（最多 45 秒），选择后局部确认并回读"
          : /^(awards|competitions)\.\d+\.level$/.test(item.sourcePath) ? "；打开等级选项，区分获奖级别与等次后选择并回读" : "";
        emit("执行", "fill_field", `${item.label} ← ${item.sourceLabel}；第 ${item.entryIndex + 1} 组${pickerHint}`,
          { fieldId: item.fieldId, sourcePath: item.sourcePath });
        let outcome;
        try { outcome = await environment.fill(item, ledger); }
        catch (error) {
          const code = /^(REAL_|NETWORK_|PAGE_)[A-Z_]+$/.test(error?.code || "") ? error.code : "REAL_WRITE_FAILED";
          const pageDiagnostic = safePageDiagnostic(error?.pageDiagnostic);
          if (fatalCodes.has(code)) {
            emit("核验", "fill_field", `${item.label}：${code}，已停止本次操作`, { code, fieldId: item.fieldId, sourcePath: item.sourcePath,
              ...(error.structureDiagnostic ? { structureDiagnostic: error.structureDiagnostic } : {}) });
            throw error;
          }
          outcome = { code, verified: false, ...(pageDiagnostic ? { pageDiagnostic } : {}) };
        }
        if (fatalCodes.has(outcome.code)) {
          const identityLabels = { connected: "节点连接", labelStable: "字段标签", kindStable: "控件类型",
            groupStable: "所属区块", recordStable: "所属经历" };
          const identityDetail = outcome.diagnostic?.adapter === "field_identity"
            ? `；${Object.entries(identityLabels).filter(([key]) => typeof outcome.diagnostic[key] === "boolean")
              .map(([key, label]) => `${label}${outcome.diagnostic[key] ? "一致" : "变化"}`).join("、")}` : "";
          emit("核验", "fill_field", `${item.label}：${outcome.code}，已停止本次操作${identityDetail}`,
            { code: outcome.code, fieldId: item.fieldId, sourcePath: item.sourcePath,
              ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}) });
          throw Object.assign(new Error(outcome.code), { code: outcome.code });
        }
        if (outcome.verified) written += 1;
        const detail = { code: outcome.code, ...(outcome.optionCount !== undefined ? { optionCount: outcome.optionCount } : {}),
          ...(outcome.pausedPageRequests !== undefined ? { pausedPageRequests: outcome.pausedPageRequests, requestMethods: outcome.requestMethods } : {}),
          ...(outcome.dictionaryReads ? { dictionaryReads: outcome.dictionaryReads } : {}),
          ...(outcome.structureDiagnostic ? { structureDiagnostic: outcome.structureDiagnostic } : {}),
          ...(outcome.pageDiagnostic ? { pageDiagnostic: outcome.pageDiagnostic } : {}),
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}), ...(outcome.completedDay ? { completedDay: true } : {}) };
        rememberWrite(item, outcome, detail);
        const diagnostics = outcome.diagnostic ? `；阶段 ${outcome.diagnostic.phase} / ${outcome.diagnostic.adapter}` : "";
        const bindingDetail = outcome.diagnostic?.bindingRefreshed ? "；控件节点已替换，重新扫描确认字段与经历结构一致后恢复" : "";
        const dateDefaultDetail = outcome.diagnostic?.replacedDateDefault ? "；已用资料纠正本轮操作触发的网页日期默认值"
          : outcome.diagnostic?.inducedDateDefaultCount ? `；网页联动产生 ${outcome.diagnostic.inducedDateDefaultCount} 个日期默认值，后续按资料核对填写` : "";
        const options = outcome.optionCount !== undefined ? `；可见候选 ${outcome.optionCount} 个` : "";
        const dictionary = outcome.dictionaryReads && Object.values(outcome.dictionaryReads).some(Boolean)
          ? `；公共候选读取（民族 ${outcome.dictionaryReads.nation || 0} / 地区 ${outcome.dictionaryReads.areas || 0} / 学校 ${outcome.dictionaryReads.school || 0} / 专业 ${outcome.dictionaryReads.major || 0}；成功 ${outcome.dictionaryReads.succeeded || 0} / 失败 ${outcome.dictionaryReads.failed || 0}）` : "";
        const pickerDetail = outcome.diagnostic?.adapter?.startsWith("beisen_")
          ? `；耗时 ${(outcome.diagnostic.waitedMs / 1000).toFixed(1)} 秒 / 已选 ${outcome.diagnostic.selectedCount} / 确认控件 ${outcome.diagnostic.confirmCount}` : "";
        const awardReasons = { AWARD_SCOPE_MISSING: "该控件要求获奖级别，资料尚未确认，请在资料页补充",
          AWARD_RANK_MISSING: "该控件要求获奖等次，资料尚未填写，请在资料页补充",
          AWARD_LEVEL_AMBIGUOUS: "等级选项无法明确区分级别与等次", AWARD_LEVEL_UNOBSERVED: "没有观察到可判断含义的等级选项",
          AWARD_AXIS_MISMATCH: "网页选项与映射的级别或等次含义不一致", AWARD_MAPPING_MISMATCH: "获奖字段与资料来源含义不一致",
          AWARD_OPTION_AMBIGUOUS: "存在多个等价等级选项，无法唯一选择", AWARD_OPTION_UNAVAILABLE: "没有与已确认资料相符的等级选项",
          AWARD_SOURCE_INVALID: "等级资料投影格式不完整" };
        const awardDetail = awardReasons[outcome.code] ? `；${awardReasons[outcome.code]}`
          : outcome.diagnostic?.awardAxis ? `；选项表示${outcome.diagnostic.awardAxis === "scope" ? "获奖级别" : "获奖等次"}` : "";
        const successDetail = outcome.diagnostic?.pageStateObserved ? "输入框与输入组件状态一致；网站预览仍需核对"
          : outcome.diagnostic?.adapter === "page_input" ? "输入事件已触发，输入框回读一致；网页状态无法直接读取" : "控件选择或回读一致";
        emit("核验", "fill_field", `${item.label}：${outcome.verified ? successDetail : outcome.code === "PROTECTED" ? "受保护或按只填空白模式保留" : `${outcome.code}，留待人工处理`}`,
          { fieldId: item.fieldId, sourcePath: item.sourcePath, ...detail,
            summary: `${item.label}：${outcome.verified ? successDetail : outcome.code === "PROTECTED" ? "受保护或按只填空白模式保留" : `${outcome.code}，留待人工处理`}${diagnostics}${bindingDetail}${dateDefaultDetail}${options}${pickerDetail}${awardDetail}${dictionary}${outcome.verified && outcome.completedDay ? "；按用户确认规则将年/月补全为当月 1 日" : ""}${outcome.pausedPageRequests ? `；该操作期间暂停 ${outcome.pausedPageRequests} 次网页请求（GET ${outcome.requestMethods.GET} / POST ${outcome.requestMethods.POST}）` : ""}` });
        // Record the first observed loss and the action preceding that observation.
        // This establishes timing, without asserting that the action caused it.
        if (environment.audit) {
          const previous = outcomes.filter((entry) => entry.tool === "fill_field" && entry.verified && entry.fieldId !== item.fieldId);
          const audited = previous.length ? await environment.audit(previous.map(({ fieldId, sourcePath }) => ({ fieldId, sourcePath }))) : [];
          for (const audit of audited.filter((entry) => !entry.verified)) {
            const original = previous.find((entry) => entry.fieldId === audit.fieldId && entry.sourcePath === audit.sourcePath);
            original.verified = false; original.code = "LATER_READBACK_MISMATCH"; original.afterFieldId = item.fieldId;
            original.diagnostic = audit.diagnostic; written -= 1;
            emit("复核", "audit", `${item.label} 操作后的回读发现 ${original.sourcePath} 已变化，撤回成功计数并留待核对`,
              { code: "LATER_READBACK_MISMATCH", fieldId: original.fieldId, sourcePath: original.sourcePath,
                afterFieldId: item.fieldId, ...(audit.diagnostic ? { diagnostic: audit.diagnostic } : {}) });
          }
        }
      }
      const current = await observe();
      if (!sameFillTargets(report, current)) throw Object.assign(new Error("REAL_FORM_STRUCTURE_CHANGED"), {
        code: "REAL_FORM_STRUCTURE_CHANGED", structureDiagnostic: formStructureDifference(report, current) });
      report = current;
      await auditWritten();
      const section = plan.sections.find((item) => item.additionalEntries > 0 && !unavailableAdds.has(item.groupId));
      if (!section || added >= maxAdds || writeLimitReached) { completedGraph = true; break; }
      checkStop();
      emit("执行", "add_entry", `${section.label}：网页少 ${section.additionalEntries} 组，添加一组后重新观察和规划`);
      const before = report.groups.find((group) => group.id === section.groupId)?.entryCount;
      const outcome = await environment.add(section.groupId);
      if (!outcome || typeof outcome.verified !== "boolean") throw Object.assign(new Error("REAL_RESULT_INVALID"), { code: "REAL_RESULT_INVALID" });
      if (fatalCodes.has(outcome.code)) throw Object.assign(new Error(outcome.code), { code: outcome.code });
      report = await observe();
      const after = report.groups.find((group) => group.id === section.groupId && group.label === section.label)?.entryCount;
      const verified = outcome.verified && after === before + 1;
      if (verified) added += 1;
      else unavailableAdds.add(section.groupId);
      outcomes.push({ tool: "add_entry", groupId: section.groupId, ...outcome, code: verified ? "VERIFIED" : outcome.code, verified });
      emit("核验", "add_entry", `${section.label}：${verified ? "已观察到新增一组经历，重新规划后填写" : `添加未完成（${outcome.code}），继续其他字段`}`,
        { groupId: section.groupId, code: outcome.code, ...(outcome.candidateCount !== undefined ? { candidateCount: outcome.candidateCount } : {}) });
      if (!verified && !plan.sections.some((item) => item.additionalEntries > 0 && !unavailableAdds.has(item.groupId))) {
        completedGraph = true; break;
      }
    } catch (error) {
      if (error?.code !== "REAL_FORM_STRUCTURE_CHANGED") throw error;
      if (structureRecoveries >= maxStructureRecoveries) throw Object.assign(new Error("REAL_RECOVERY_LIMIT"), {
        code: "REAL_RECOVERY_LIMIT", ...(error.structureDiagnostic ? { structureDiagnostic: error.structureDiagnostic } : {}) });
      structureRecoveries += 1;
      emit("恢复", "replan", `同一文档的字段或经历已变化，作废旧计划，重新观察并完整校验（第 ${structureRecoveries}/${maxStructureRecoveries} 次）`,
        { code: error.code, ...(error.structureDiagnostic ? { structureDiagnostic: error.structureDiagnostic } : {}) });
      report = await observe();
      unavailableAdds.clear();
    }
  }
  if (!completedGraph) throw Object.assign(new Error("REAL_RECOVERY_LIMIT"), { code: "REAL_RECOVERY_LIMIT" });
  if (environment.retryFill) {
    for (const original of outcomes.filter((entry) => entry.tool === "fill_field"
      && entry.sourcePath === "identityAndAuthorization.personalIdNumber" && ["READBACK_MISMATCH", "LATER_READBACK_MISMATCH"].includes(entry.code))) {
      checkStop();
      const item = candidates.find((candidate) => candidate.fieldId === original.fieldId && candidate.sourcePath === original.sourcePath);
      if (!item) continue;
      emit("执行", "retry_fill", `${item.label}：初次写入未保持，尝试一次原生编辑与失焦复核`, { fieldId: item.fieldId, sourcePath: item.sourcePath });
      let outcome;
      try { outcome = await environment.retryFill(item, ledger); }
      catch (error) {
        const code = /^(REAL_|NETWORK_|PAGE_)[A-Z_]+$/.test(error?.code || "") ? error.code : "NATIVE_EDIT_UNAVAILABLE";
        if (fatalCodes.has(code)) throw error;
        const pageDiagnostic = safePageDiagnostic(error?.pageDiagnostic);
        outcome = { code, verified: false, ...(pageDiagnostic ? { pageDiagnostic } : {}) };
      }
      if (fatalCodes.has(outcome.code)) throw Object.assign(new Error(outcome.code), { code: outcome.code });
      original.recovery = { ...outcome };
      if (outcome.verified) { original.recoveredFrom = original.code; original.verified = true; original.code = "VERIFIED"; written += 1; }
      emit("核验", "retry_fill", `${item.label}：${outcome.verified ? "原生编辑后失焦回读一致" : `${outcome.code}，恢复未完成，留待人工处理`}`,
        { fieldId: item.fieldId, sourcePath: item.sourcePath, code: outcome.code, ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
          ...(outcome.pageDiagnostic ? { pageDiagnostic: outcome.pageDiagnostic } : {}) });
    }
  }
  await auditWritten();
  if (environment.audit) emit("复核", "audit", `整页复扫后，${written} 个字段仍保持本轮写入结果`);
  const ownVerifiedFields = new Set(outcomes.filter((item) => item.tool === "fill_field" && item.verified).map((item) => item.fieldId));
  const skipped = plan.items.filter((item) => (!item.sourcePath || !executableStatuses.has(item.status)) && !ownVerifiedFields.has(item.fieldId));
  const unresolved = outcomes.filter((item) => item.tool === "fill_field" && !item.verified && item.code !== "PROTECTED");
  const unplannedCount = plan.items.filter((item) => ["missing_profile", "ambiguous_mapping", "unmapped", "label_missing", "source_conflict", "source_unverified"].includes(item.status)).length;
  const remainingBlankFields = report.fields.filter((field) => field.hasValue === false && !field.disabled
    && !["checkbox", "radio", "file", "signature", "credential"].includes(field.kind)).length;
  const pendingEntries = Math.max(0, plan.summary.additionalEntries + (plan.summary.unresolvedEntries || 0));
  emit("完成", "review", `本轮核验新增 ${written} 个字段、添加 ${added} 组经历；当前仍有 ${remainingBlankFields} 个可见空字段，${unplannedCount} 个字段尚无可靠映射${pendingEntries ? `，还有 ${pendingEntries} 组经历待添加` : ""}${unresolved.length ? `，${unresolved.length} 次填写未通过` : ""}${structureRecoveries ? `；完成 ${structureRecoveries} 次结构恢复` : ""}；整页仍待核对`);
  return { status: written > 0 ? "partial" : "needs_review", report, plan,
    result: { realSite: true, fillMode, agentAddedCards: added, agentWrittenFields: written,
      verificationCounts: { inputStateVerified: outcomes.filter((item) => item.verified && item.diagnostic?.pageStateMatched === true).length,
        controlReadbackOnly: outcomes.filter((item) => item.tool === "fill_field" && item.verified && item.diagnostic?.pageStateMatched !== true).length,
        inputStateMismatch: outcomes.filter((item) => !item.verified && item.diagnostic?.pageStateObserved === true && item.diagnostic.pageStateMatched === false).length },
      observedFields: plan.items.length, planningCounts: plan.summary.counts,
      correctFields: written, expectedFields: writeAttempts, modelCalls, structureRecoveries,
      unresolvedCount: unresolved.length, skippedCount: skipped.length,
      unplannedCount, remainingBlankFields, preservedExistingCount: outcomes.filter((item) => item.code === "PROTECTED").length,
      repairedFields: repairs.filter((item) => item.verified).length, repairsNeedingReview: repairs.filter((item) => !item.verified).length,
      discardedMappingCount: plan.summary.discardedMappingCount || 0,
      pendingEntries,
      writeLimitReached, code: written > 0 ? "PARTIAL_FILL_VERIFIED" : "NO_NEW_FIELDS_WRITTEN" },
    outcomes };
}
