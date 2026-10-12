import { genericProfile } from "./generic-form.js";

// Fictional widget protocol and hierarchy. No site HTML, company selectors,
// generated class hashes, applicant values or network endpoints are copied.
export function decoratedFormHtml() {
  const row = (caption, control) => `<div class="field-shell"><div class="title-decoration"><span><span>${caption}</span></span></div><div class="control-shell">${control}</div></div>`;
  const text = (path, caption) => row(caption, `<input data-fixture-target="${path}">`);
  const select = (path, choices, unit = "请选择") => `<div class="tooltip-shell"><div class="dropdown-shell"><label class="widget-select-container"><span class="widget-display-value"></span><input placeholder="${unit}" data-fixture-target="${path}" data-fixture-options='${JSON.stringify(choices)}'><span class="select-addon">&#xe732;</span></label></div></div>`;
  const years = ["2019年", "2023年", "2024年", "2025年", "2026年"];
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  const period = (record, caption = "起止时间") => row(caption, `<div class="range-shell"><span>${select(record + ".startDateYear", years, "年")}${select(record + ".startDateMonth", months, "月")}</span><span>-</span><span>${select(record + ".endDateYear", years, "年")}${select(record + ".endDateMonth", months, "月")}</span><label><input type="checkbox">至今</label></div>`);
  const education = (i) => `<div class="record-shell">${period(`educations.${i}`, "就读时间")}${row("学校名称", select(`educations.${i}.school`, ["虚构大学甲", "虚构大学乙"]))}${row("专业名称", select(`educations.${i}.major`, ["虚构专业甲", "虚构专业乙"]))}${row("学历", select(`educations.${i}.degree`, ["本科", "硕士"]))}</div>`;
  const internship = (i) => `<div class="record-shell">${period(`internships.${i}`)}${text(`internships.${i}.company`, "公司名称")}${text(`internships.${i}.title`, "职位名称")}</div>`;
  const award = (i) => `<div class="record-shell">${row("获奖时间", select(`awards.${i}.dateYear`, years, "年") + select(`awards.${i}.dateMonth`, months, "月"))}${text(`awards.${i}.name`, "奖项名称")}</div>`;
  const section = (name, body, add) => `<div class="section-shell"><div class="section-header"><span>${name}</span>${add ? `<button type="button" data-fixture-add="${add}">添加</button>` : ""}</div><div ${add ? `id="fixture-${add}"` : ""}>${body}</div></div>`;
  const html = `<div><input placeholder="输入职位关键字" id="fixture-search"><button type="button">搜索</button></div><div class="application-shell">`
    + section("申请信息", row("意向工作城市", select("jobPreferences.expectedCity", ["虚构城市"])))
    + section("个人信息", text("personal.email", "邮箱"))
    + section("求职意向", text("jobPreferences.expectedCity", "期望城市"))
    + section("工作经历", period("workExperiences.0") + text("workExperiences.0.company", "公司名称"), "work")
    + section("教育背景", education(0), "education")
    + section("实习经历", internship(0), "internships")
    + section("项目经验", text("projects.0.name", "项目名称"), "projects")
    + section("语言能力", text("languages.0.name", "语言类型") + row("掌握程度", select("languages.0.proficiency", ["一般", "良好", "熟练", "精通"])), "languages")
    + section("自我描述", row("自我描述", '<textarea data-fixture-target="personal.summary"></textarea>'))
    + section("获奖经历", award(0), "awards")
    + `<button type="submit" id="fixture-submit">预览并提交</button></div>`;
  return { html, education, internship, award };
}

export function decoratedProfile() {
  const source = genericProfile();
  source.profile.jobPreferences = { expectedCity: "虚构城市" };
  source.profile.personal.summary = "虚构测试简介";
  source.profile.educations[0].degree = "硕士";
  source.profile.educations[1].degree = "本科";
  return source;
}

export function installDecoratedControls(document, form, { clearUnitPlaceholder = false, coupledDateDefaults = false } = {}, controlRoot = document) {
  let panel;
  document.body.addEventListener("mousedown", (event) => {
    if (!event.target.closest?.(".widget-select-container, .dropdown-menu") && panel) {
      panel.remove(); panel = null;
    }
  });
  const install = (root) => {
    for (const input of root.querySelectorAll("input[data-fixture-options]")) {
      const anchor = input.closest(".widget-select-container");
      const render = () => {
        panel?.remove();
        panel = document.createElement("div"); panel.className = "dropdown-menu";
        const choices = JSON.parse(input.getAttribute("data-fixture-options"));
        for (const value of choices.filter((value) => !input.value || value.includes(input.value))) {
          // Both wrapper and content match a supported option selector.
          const option = document.createElement("div"); option.className = "option-item";
          const content = document.createElement("span"); content.className = "option-item"; content.textContent = value;
          option.append(content); panel.append(option);
          option.addEventListener("click", () => {
            anchor.querySelector(".widget-display-value").textContent = value; input.value = "";
            if (coupledDateDefaults && /(?:startDate|endDate)(?:Year|Month)$/.test(input.getAttribute("data-fixture-target"))) {
              const path = input.getAttribute("data-fixture-target"), siblingPath = path.replace(/(Year|Month)$/, path.endsWith("Year") ? "Month" : "Year");
              const sibling = document.querySelector(`[data-fixture-target="${siblingPath}"]`), display = sibling?.closest(".widget-select-container")?.querySelector(".widget-display-value");
              if (display && !display.textContent) display.textContent = path.endsWith("Year") ? "1月" : "2026年";
            }
            if (clearUnitPlaceholder && /^(年|月|日)$/.test(input.placeholder)) input.placeholder = "";
            panel.remove(); panel = null;
          });
        }
        document.body.append(panel);
      };
      anchor.addEventListener("click", render); input.addEventListener("input", render);
    }
  };
  install(controlRoot);
  if (controlRoot !== document) return;
  for (const [key, create] of [["education", form.education], ["internships", form.internship], ["awards", form.award]]) {
    document.querySelector(`[data-fixture-add="${key}"]`).addEventListener("click", () => {
      const root = document.querySelector(`#fixture-${key}`), next = document.createElement("div");
      next.innerHTML = create(root.children.length); const record = next.firstElementChild;
      root.append(record); install(record);
    });
  }
}
