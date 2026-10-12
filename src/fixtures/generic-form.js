// Entirely fictional cross-layout fixture. No copied company HTML/selectors.
export function genericFormHtml(layout = "plain") {
  const english = layout === "aria";
  const names = english ? ["Personal information", "Education", "Internships", "Projects", "Languages", "Awards"]
    : ["个人资料", "学习经历", "实习经历", "项目经历", "语言能力", "获奖经历"];
  const labels = english ? { school: "Graduation school", major: "Major", start: "Start date", company: "Company name",
    title: "Job title", project: "Project name", description: "Project description", language: "Language", proficiency: "Proficiency", award: "Award name" }
    : { school: "就读学校", major: "专业名称", start: "开始时间", company: "公司名称", title: "职位名称", project: "项目名称",
      description: "项目说明", language: "语言类型", proficiency: "掌握程度", award: "奖项名称" };
  const row = (caption, control) => `<div class="random-field-x"><span>${caption}</span><div>${control}</div></div>`;
  const input = (name, caption) => row(caption, `<input data-fixture-target="${name}">`);
  const parts = (name) => row(labels.start, `<input placeholder="${english ? "Year" : "年"}" data-fixture-target="${name}Year"><input placeholder="${english ? "Month" : "月"}" data-fixture-target="${name}Month">`);
  const education = (index) => `<div class="generated-${index + 23}">${input(`educations.${index}.school`, labels.school)}${input(`educations.${index}.major`, labels.major)}${parts(`educations.${index}.startDate`)}</div>`;
  const internship = (index) => `<div class="opaque-${index + 82}">${input(`internships.${index}.company`, labels.company)}${input(`internships.${index}.title`, labels.title)}${parts(`internships.${index}.startDate`)}</div>`;
  const blocks = [
    input("personal.email", english ? "Email" : "邮箱") + input("formAnswers.internshipsLatestCompany", english ? "Most recent company" : "最近公司"),
    `<div id="fixture-education">${education(0)}</div><button id="fixture-add" type="button">${english ? "Add education" : "添加经历"}</button>`,
    `<div>${internship(0)}${internship(1)}</div>`,
    `<div>${input("projects.0.name", labels.project)}${row(labels.description, '<textarea data-fixture-target="projects.0.description"></textarea>')}</div>`,
    input("languages.0.name", labels.language) + row(labels.proficiency, '<select data-fixture-target="languages.0.proficiency"><option value="">请选择</option><option>一般</option><option>良好</option><option>熟练</option></select>'),
    `<div id="fixture-awards">${input("awards.0.name", labels.award)}</div><button type="button" id="fixture-add-award">${english ? "Add award" : "添加奖项"}</button>`,
  ];
  const section = (body, i) => layout === "flat" ? `<h2>${names[i]}</h2>${body}`
    : layout === "aria" ? `<div role="region" aria-labelledby="fixture-heading-${i}"><div id="fixture-heading-${i}" role="heading" aria-level="2">${names[i]}</div>${body}</div>`
    : `<div class="unrelated-${i}"><div>${names[i]}</div>${body}</div>`;
  return { html: `<form>${blocks.map(section).join("")}<label><span class="ant-select-selection-item">+86</span><input id="fixture-code" readonly></label><button type="submit">提交简历</button></form>`,
    education, award: (index) => input(`awards.${index}.name`, labels.award), names };
}

export function genericProfile() {
  return { agentProfilePurpose: "synthetic_evaluation", profile: {
    personal: { email: "fictional-generic@example.test" },
    educations: [{ school: "虚构大学甲", major: "虚构专业甲", startDate: "2023-09", endDate: "2026-06" },
      { school: "虚构大学乙", major: "虚构专业乙", startDate: "2019-09", endDate: "2023-06" }],
    internships: [{ company: "虚构公司甲", title: "虚构职位甲", startDate: "2025-03", endDate: "2025-06" },
      { company: "虚构公司乙", title: "虚构职位乙", startDate: "2024-05", endDate: "2024-08" }],
    projects: [{ name: "虚构项目甲", description: "虚构项目说明甲" }],
    languages: [{ name: "英语", proficiency: "熟练" }],
    awardRecords: { version: 1, awards: [{ id: "fictional-award-a", name: "虚构奖甲" }, { id: "fictional-award-b", name: "虚构奖乙" }], competitions: [] },
  } };
}
