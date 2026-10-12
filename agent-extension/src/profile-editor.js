import { ResumeSchema as schema } from "../../src/vendor/formfill/resume-schema.js";
import { importProfile, PRIVATE_PROFILE_KEY } from "../../src/core/profile-import.js";
import { AWARD_SECTIONS, AWARD_RECORD_LIMIT, AWARD_PROPERTIES, createAwardRecord,
  hasAwardRecordValue, normalizeAgentProfile } from "../../src/core/award-details.js";
import { AWARD_SCOPES } from "../../src/core/award-levels.js";

const explanations = {
  personal: "填写你的基本信息。身高以厘米填写，体重以公斤填写。",
  contactAndLocation: "籍贯和户口所在地可以分别填写；请保留你确定的省份和城市。",
  educations: "每段教育经历分别填写，可以点击下方按钮继续添加。",
  internships: "每段实习分别填写。只知道年月的经历日期可以保留到月。",
  workExperiences: "每段工作经历分别填写，没有工作经历可以留空。",
  projects: "填写项目名称、职责和成果，可以添加多个项目。",
  campusExperiences: "填写学生组织、社团等在校经历，可以添加多条。",
  familyMembers: "按招聘网站的需要填写家庭成员，暂时不需要的项目可以留空。",
  additional: "获奖和竞赛都按条填写名称、级别、等次和详细信息。可以添加或删除记录；不确定的内容请留空。",
  jobPreferences: "填写求职偏好。“了解到公司的渠道”可填写学校就业网。",
  customAnswers: "填写网页的问题原文和你确认的答案。问题原文只填题目，不要填姓名、证件号码等答案。遇到新公司独有的问题可以在这里添加，答案不会发送给模型。",
  papers: "每篇论文或专著分别填写。没有发表记录可以留空；不要把“无”添加为一篇论文。",
};
const labels = { "personal.heightCm": "身高（厘米）", "personal.weightKg": "体重（公斤）" };
const hints = {
  "personal.heightCm": "只填数值，例如 175。",
  "personal.weightKg": "只填数值，例如 65。",
  "personal.birthDate": "填写真实的完整出生日期，例如 2000-01-15。",
  "jobPreferences.discoveryChannel": "例如：学校就业网、校园招聘会。",
  "jobPreferences.expectedSalary": "请注明金额和周期，如 18000 元/月或 20 万元/年。年薪可换算成月薪，未注明周期的数字不会换算。",
  "jobPreferences.expectedSalaryPeriod": "金额没有注明 /月或 /年时，需要选择周期；选年薪时按 12 个月计算月薪。",
  "jobPreferences.expectedMonthlySalary": "可填具体金额或区间，单位元/月。网页只有区间时，按明确区间匹配；这个答案优先于年薪换算。",
  "personal.colorVision": "按你的实际情况填写，不确定时留空。",
};
const messages = {
  PROFILE_EDITOR_BUSY: "Agent 正在执行任务，请等待结束后再保存资料。",
  PROFILE_EDITOR_CONFLICT: "资料已在其他页面更新。本页修改仍保留，请先导出备份，再刷新页面核对最新资料。",
  PROFILE_IMPORT_EMPTY: "请至少填写一项资料，例如姓名或教育经历，然后保存。",
  PROFILE_IMPORT_TOO_LARGE: "资料超过 2 MB，请减少内容或导入单份简历备份。",
  PROFILE_IMPORT_FORMAT: "备份格式无法识别，请使用原插件或本页导出的简历备份。",
  PROFILE_IMPORT_CHOOSE_TEMPLATE: "备份没有选中的简历模板，请在原插件中导出当前简历。",
  PROFILE_EDITOR_ACCESS_DENIED: "请通过 Resume Agent 插件重新打开编辑页面。",
};

// Reuse the old plugin's schema-driven fields and repeatable records.
// Values remain in the extension's local profile, shared with the Agent.
export function mountProfileEditor({ document, window, chrome }) {
  const $ = (id) => document.getElementById(id);
  let profile = normalizeAgentProfile(schema.createEmptyResumeProfile());
  let revision = null;
  let purpose = "personal_use";
  let hasProfile = false;
  let dirty = false;
  let busy = true;
  let activeSection = schema.sections.some((item) => item.key === window.location.hash.slice(1))
    ? window.location.hash.slice(1) : "personal";

  function status(text, kind = "info") {
    $("page-status").textContent = text;
    $("page-status").dataset.kind = kind;
  }

  async function send(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw new Error(response?.error || "PROFILE_EDITOR_UNAVAILABLE");
    return response.value;
  }

  function reportError(error) {
    status(messages[error?.message] || "操作失败，资料没有保存。请重新打开编辑页面后重试。", "error");
  }

  function updateControls() {
    $("save-profile").disabled = busy || !dirty;
    $("save-profile-bottom").disabled = busy || !dirty;
    $("import-profile").disabled = busy;
    $("export-profile").disabled = busy;
    for (const control of $("profile-form").querySelectorAll("input, textarea, select, button")) control.disabled = busy;
  }

  function collect() {
    const next = schema.clone(profile);
    for (const control of $("profile-sections").querySelectorAll("[data-profile-path]")) {
      schema.setValueByPath(next, control.dataset.profilePath, control.value.trim());
    }
    for (const control of $("profile-sections").querySelectorAll("[data-award-property]")) {
      const detail = next.awardRecords?.[control.dataset.awardSection]?.find((item) => item.id === control.dataset.awardId);
      if (!detail) continue;
      const key = control.dataset.awardProperty;
      if (!AWARD_PROPERTIES.includes(key)) continue;
      const value = control.value.trim();
      if (detail[key] !== value) {
        detail[key] = value;
        if (key === "scope" || key === "rank") detail[key + "Source"] = value ? "user_confirmed" : "unconfirmed";
      }
    }
    return normalizeAgentProfile(next);
  }

  function sectionCount(section, current) {
    if (section.type === "list") {
      const count = current[section.key].filter((item) => section.fields.some((field) => String(item[field.key] || "").trim())).length;
      return count ? count + " 条" : "未填写";
    }
    const count = section.fields.filter((field) => String(current[section.key][field.key] || "").trim()).length
      + (section.key === "additional" ? AWARD_SECTIONS.reduce((sum, key) =>
        sum + current.awardRecords[key].filter(hasAwardRecordValue).length, 0) : 0);
    return count ? count + " 项" : "未填写";
  }

  function updateCounts() {
    const current = collect();
    for (const section of schema.sections) {
      document.querySelector('[data-count-section="' + section.key + '"]').textContent = sectionCount(section, current);
    }
    for (const section of AWARD_SECTIONS) {
      const summary = document.querySelector('[data-award-summary="' + section + '"]');
      if (summary) summary.textContent = awardSummary(section, current.awardRecords[section]);
    }
  }

  function markDirty() {
    dirty = true;
    status("有未保存的修改。填写完成后，点击右上角“保存资料”。", "warning");
    updateControls();
    updateCounts();
  }

  function chooseSection(key, focus = false) {
    if (!schema.getSectionDefinition(key)) return;
    activeSection = key;
    for (const item of document.querySelectorAll("[data-nav-section]")) {
      if (item.dataset.navSection === key) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    for (const item of document.querySelectorAll("[data-profile-section]")) item.hidden = item.dataset.profileSection !== key;
    const index = schema.sections.findIndex((section) => section.key === key);
    $("previous-section").disabled = index === 0;
    $("next-section").disabled = index === schema.sections.length - 1;
    window.history.replaceState(null, "", "#" + key);
    if (focus) document.getElementById("heading-" + key).focus();
  }

  function renderField(field, prefix) {
    const path = prefix + "." + field.key;
    const wrapper = document.createElement("div");
    wrapper.className = "field" + (field.input === "textarea" ? " wide" : "");
    const label = document.createElement("label");
    const control = document.createElement(field.input === "textarea" ? "textarea" : field.input === "select" ? "select" : "input");
    control.id = "field-" + path.replaceAll(".", "-");
    label.htmlFor = control.id;
    label.textContent = labels[path] || field.label;
    if (field.input === "select") {
      for (const value of field.options || []) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value || "请选择";
        control.append(option);
      }
    } else if (field.input !== "textarea") {
      // A native date input would erase YYYY-MM precision from old profiles.
      control.type = field.input === "date" ? "text" : field.input || "text";
      if (["age", "heightCm", "weightKg"].includes(field.key)) control.inputMode = "decimal";
    }
    control.dataset.profilePath = path;
    if (prefix.startsWith("customAnswers.")) control.maxLength = field.key === "question" ? 180 : 20_000;
    control.value = String(schema.getValueByPath(profile, path) || "");
    control.placeholder = field.input === "date"
      ? path === "personal.birthDate" ? "例如：2000-01-15" : "例如：2022-09 或 2022-09-01"
      : field.placeholder || "";
    wrapper.append(label, control);
    if (hints[path]) {
      const hint = document.createElement("p");
      hint.id = control.id + "-hint";
      hint.className = "field-hint";
      hint.textContent = hints[path];
      control.setAttribute("aria-describedby", hint.id);
      wrapper.append(hint);
    }
    return wrapper;
  }

  function fieldGrid(fields, prefix) {
    const grid = document.createElement("div");
    grid.className = "field-grid";
    for (const field of fields) {
      grid.append(renderField(field, prefix));
    }
    return grid;
  }

  function awardSummary(section, records) {
    if (!records.length) return "暂无" + (section === "awards" ? "获奖" : "竞赛") + "记录，点击下方按钮添加。";
    const unknown = records.filter((record) => !record.scope).length;
    return records.length + " 条" + (section === "awards" ? "获奖" : "竞赛")
      + (unknown ? "，其中 " + unknown + " 条级别未确认。" : "，级别均已填写。")
      + "级别填写国家级、省级等；等次填写一等奖、二等奖等。";
  }

  function renderAwardRecords(container, section) {
    container.replaceChildren();
    container.className = "award-records";
    container.dataset.awardSectionGroup = section;
    const records = profile.awardRecords[section];
    const title = document.createElement("h3");
    title.className = "award-section-title";
    title.textContent = section === "awards" ? "获奖经历" : "竞赛经历";
    const summary = document.createElement("p");
    summary.className = "award-summary";
    summary.dataset.awardSummary = section;
    summary.textContent = awardSummary(section, records);
    container.append(title, summary);
    for (const [index, detail] of records.entries()) {
      const card = document.createElement("div");
      card.className = "record award-detail";
      card.dataset.awardRecord = section;
      card.dataset.awardId = detail.id;
      const head = document.createElement("div");
      head.className = "record-header";
      const heading = document.createElement("h4");
      heading.textContent = (section === "awards" ? "获奖" : "竞赛") + " " + (index + 1);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-record";
      remove.textContent = "删除本条";
      remove.setAttribute("aria-label", "删除本条：" + heading.textContent);
      remove.dataset.removeAward = section;
      remove.dataset.awardId = detail.id;
      head.append(heading, remove);
      const grid = document.createElement("div");
      grid.className = "field-grid";
      for (const key of AWARD_PROPERTIES) {
        const wrapper = document.createElement("div");
        wrapper.className = "field" + (["name", "description"].includes(key) ? " wide" : "");
        const label = document.createElement("label");
        const control = document.createElement(key === "scope" ? "select" : key === "description" ? "textarea" : "input");
        control.id = "award-" + section + "-" + index + "-" + key;
        label.htmlFor = control.id;
        label.textContent = ({ name: section === "awards" ? "奖项名称" : "竞赛名称",
          scope: "获奖级别", rank: "等次（几等奖）", date: "获奖时间", description: "详细信息" })[key];
        control.dataset.awardSection = section;
        control.dataset.awardIndex = index;
        control.dataset.awardId = detail.id;
        control.dataset.awardProperty = key;
        if (key === "scope") {
          for (const value of ["", ...AWARD_SCOPES]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value || "未确认（暂不填写）";
            control.append(option);
          }
        } else {
          if (key !== "description") control.type = "text";
          control.maxLength = key === "rank" ? 80 : key === "date" ? 40 : key === "name" ? 20_000 : 50_000;
          control.placeholder = key === "rank" ? "如：一等奖、二等奖、优秀奖；没有则留空"
            : key === "date" ? "例如：2023-06 或 2023-06-15；不知道日期可留空"
            : key === "name" ? "填写你的" + (section === "awards" ? "奖项" : "竞赛") + "名称"
            : "可填写获奖时间、颁发单位、具体成果和相关说明";
        }
        control.value = detail[key];
        wrapper.append(label, control);
        if (key === "scope" || key === "rank") {
          const hint = document.createElement("p");
          hint.className = "field-hint";
          hint.id = control.id + "-hint";
          hint.textContent = detail[key + "Source"] === "original_text" ? "已从旧资料明确写出的文字提取，请核对。"
            : key === "scope" ? "按实际证书或通知填写获奖范围。"
            : "填写实际奖等，如一等奖、金奖或优秀奖。";
          control.setAttribute("aria-describedby", hint.id);
          wrapper.append(hint);
        }
        grid.append(wrapper);
      }
      const dateHint = document.createElement("p");
      dateHint.className = "field-hint";
      dateHint.textContent = "日期只填写你确认的获奖时间；竞赛名称中的年份不会自动当作获奖日期。";
      grid.append(dateHint);
      card.append(head, grid);
      container.append(card);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary add-record";
    add.textContent = "＋ 添加" + (section === "awards" ? "获奖" : "竞赛");
    add.dataset.addAward = section;
    add.hidden = records.length >= AWARD_RECORD_LIMIT;
    container.append(add);
    if (add.hidden) {
      const limit = document.createElement("p");
      limit.className = "field-hint";
      limit.textContent = "当前最多支持 " + AWARD_RECORD_LIMIT + " 条记录。";
      container.append(limit);
    }
  }

  function render() {
    $("profile-nav").replaceChildren();
    $("profile-sections").replaceChildren();
    for (const section of schema.sections) {
      const nav = document.createElement("button");
      nav.type = "button";
      nav.className = "nav-item";
      nav.dataset.navSection = section.key;
      nav.setAttribute("aria-controls", "section-" + section.key);
      const name = document.createElement("span");
      name.textContent = section.label;
      const count = document.createElement("span");
      count.className = "nav-count";
      count.dataset.countSection = section.key;
      count.textContent = sectionCount(section, profile);
      nav.append(name, count);
      $("profile-nav").append(nav);

      const panel = document.createElement("section");
      panel.className = "profile-section";
      panel.id = "section-" + section.key;
      panel.dataset.profileSection = section.key;
      panel.setAttribute("aria-labelledby", "heading-" + section.key);
      const heading = document.createElement("div");
      heading.className = "section-header";
      const copy = document.createElement("div");
      const title = document.createElement("h2");
      title.id = "heading-" + section.key;
      title.tabIndex = -1;
      title.textContent = section.label;
      const description = document.createElement("p");
      description.className = "section-description";
      description.textContent = explanations[section.key] || section.note || "按实际情况填写，暂时没有的内容可以留空。";
      copy.append(title, description);
      heading.append(copy);
      panel.append(heading);
      if (section.key === "additional") {
        for (const key of AWARD_SECTIONS) {
          const records = document.createElement("div");
          renderAwardRecords(records, key);
          panel.append(records);
        }
        panel.append(fieldGrid(section.fields.filter((field) => !AWARD_SECTIONS.includes(field.key)), section.key));
      } else if (section.type === "group") panel.append(fieldGrid(section.fields, section.key));
      else {
        for (const [index] of profile[section.key].entries()) {
          const record = document.createElement("div");
          record.className = "record";
          const head = document.createElement("div");
          head.className = "record-header";
          const title = document.createElement("h3");
          title.textContent = section.itemLabel + " " + (index + 1);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "remove-record";
          remove.textContent = profile[section.key].length === 1 ? "清空本条" : "删除本条";
          remove.setAttribute("aria-label", remove.textContent + "：" + title.textContent);
          remove.dataset.removeSection = section.key;
          remove.dataset.recordIndex = index;
          head.append(title, remove);
          record.append(head, fieldGrid(section.fields, section.key + "." + index));
          panel.append(record);
        }
        const add = document.createElement("button");
        add.type = "button";
        add.className = "secondary add-record";
        add.textContent = "＋ 添加" + section.itemLabel;
        add.dataset.addSection = section.key;
        if (profile[section.key].length >= section.slots) {
          add.hidden = true;
          const limit = document.createElement("p");
          limit.className = "field-hint";
          limit.textContent = "当前最多支持 " + section.slots + " 条" + section.label + "。";
          panel.append(limit);
        }
        panel.append(add);
      }
      $("profile-sections").append(panel);
    }
    chooseSection(activeSection);
    updateControls();
  }

  function applySnapshot(snapshot) {
    profile = normalizeAgentProfile(snapshot.profile);
    revision = snapshot.revision;
    purpose = snapshot.purpose;
    hasProfile = snapshot.hasProfile;
    dirty = false;
    $("saved-at").textContent = snapshot.savedAt
      ? "上次保存：" + new Date(snapshot.savedAt).toLocaleString("zh-CN")
      : "尚未保存资料";
    render();
  }

  async function load() {
    busy = true;
    updateControls();
    try {
      applySnapshot(await send("profile-editor-load"));
      busy = false;
      updateControls();
      status(hasProfile ? "已载入你保存的资料，可以直接修改。" : "从基本信息开始填写，完成后点击“保存资料”。");
    } catch (error) { reportError(error); }
  }

  async function save() {
    if (busy || !dirty) return;
    const next = collect();
    busy = true;
    updateControls();
    status("正在保存资料…");
    try {
      applySnapshot(await send("profile-editor-save", { profile: next, baseRevision: revision, purpose }));
      status("资料已保存。回到招聘网页后，Agent 会使用这份资料。", "success");
    } catch (error) { reportError(error); }
    finally { busy = false; updateControls(); }
  }

  $("profile-nav").addEventListener("click", (event) => {
    const item = event.target.closest("[data-nav-section]");
    if (item) chooseSection(item.dataset.navSection, true);
  });
  $("profile-form").addEventListener("submit", (event) => { event.preventDefault(); });
  for (const type of ["input", "change"]) $("profile-form").addEventListener(type, (event) => {
    if (event.target.matches("[data-profile-path], [data-award-property]")) markDirty();
  });
  $("profile-sections").addEventListener("click", (event) => {
    const awardAdd = event.target.closest("[data-add-award]");
    const awardRemove = event.target.closest("[data-remove-award]");
    if (!busy && (awardAdd || awardRemove)) {
      const key = awardAdd?.dataset.addAward || awardRemove.dataset.removeAward;
      if (!AWARD_SECTIONS.includes(key)) return;
      profile = collect();
      let focusId;
      if (awardAdd) {
        if (profile.awardRecords[key].length >= AWARD_RECORD_LIMIT) return;
        const record = createAwardRecord();
        profile.awardRecords[key].push(record);
        focusId = record.id;
      } else {
        const index = profile.awardRecords[key].findIndex((item) => item.id === awardRemove.dataset.awardId);
        if (index < 0) return;
        if (hasAwardRecordValue(profile.awardRecords[key][index]) && !window.confirm("删除这条" + (key === "awards" ? "获奖" : "竞赛") + "记录？")) return;
        profile.awardRecords[key].splice(index, 1);
      }
      render();
      markDirty();
      if (focusId) document.querySelector('[data-award-id="' + focusId + '"][data-award-property="name"]').focus();
      return;
    }
    const add = event.target.closest("[data-add-section]");
    const remove = event.target.closest("[data-remove-section]");
    if (busy || (!add && !remove)) return;
    const key = add?.dataset.addSection || remove.dataset.removeSection;
    const section = schema.getSectionDefinition(key);
    profile = collect();
    if (add) {
      if (profile[key].length >= section.slots) return;
      profile[key].push(schema.createEmptyListItem(key));
    } else {
      const index = Number(remove.dataset.recordIndex);
      if (!Number.isInteger(index) || !profile[key][index]) return;
      if (section.fields.some((field) => profile[key][index][field.key])
        && !window.confirm("要" + (profile[key].length === 1 ? "清空" : "删除") + "这条" + section.itemLabel + "吗？保存资料后生效。")) return;
      profile[key].splice(index, 1);
      if (!profile[key].length) profile[key].push(schema.createEmptyListItem(key));
    }
    render();
    markDirty();
    if (add) document.querySelector('[data-profile-path="' + key + "." + (profile[key].length - 1) + "." + section.fields[0].key + '"]').focus();
  });
  $("previous-section").addEventListener("click", () => {
    const index = schema.sections.findIndex((item) => item.key === activeSection);
    if (index > 0) chooseSection(schema.sections[index - 1].key, true);
  });
  $("next-section").addEventListener("click", () => {
    const index = schema.sections.findIndex((item) => item.key === activeSection);
    if (index < schema.sections.length - 1) chooseSection(schema.sections[index + 1].key, true);
  });
  $("save-profile").addEventListener("click", save);
  $("save-profile-bottom").addEventListener("click", save);
  $("import-profile").addEventListener("click", () => { $("import-file").value = ""; $("import-file").click(); });
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files?.[0];
    if (!file || busy) return;
    busy = true;
    updateControls();
    try {
      if (file.size > 2_000_000) throw new Error("PROFILE_IMPORT_TOO_LARGE");
      let input;
      try { input = JSON.parse(await file.text()); }
      catch { throw new Error("PROFILE_IMPORT_FORMAT"); }
      const { stored } = importProfile(input);
      if ((hasProfile || dirty) && !window.confirm("导入备份将替换本页资料。点击“保存资料”后生效，是否继续？")) return;
      profile = stored.profile;
      purpose = stored.purpose;
      render();
      dirty = true;
      status("备份已显示在表单中。请检查内容，点击“保存资料”后生效。", "warning");
    } catch (error) { reportError(error); }
    finally { busy = false; updateControls(); }
  });
  $("export-profile").addEventListener("click", () => {
    try {
      const backup = { app: "resume-agent", kind: "resume-profile", version: 1, schemaVersion: schema.version,
        exportedAt: new Date().toISOString(), profile: collect(), agentProfilePurpose: purpose };
      const blob = new window.Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "我的简历资料-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      status(dirty ? "已导出当前填写内容；本页修改还未保存，记得点击“保存资料”。" : "已导出资料备份，可用于换机或恢复。",
        dirty ? "warning" : "success");
    } catch (error) { reportError(error); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  const storageListener = (changes, area) => {
    if (area !== "local" || !changes[PRIVATE_PROFILE_KEY] || busy) return;
    if (dirty) status("资料已在其他页面更新。本页修改仍保留，请导出备份后刷新核对。", "warning");
    else load();
  };
  chrome.storage.onChanged.addListener(storageListener);
  window.addEventListener("unload", () => chrome.storage.onChanged.removeListener(storageListener));
  return { ready: load() };
}
