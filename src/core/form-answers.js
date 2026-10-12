/** Deterministic projections from verified private facts; no model-provided values. */
export function withFormAnswers(ledger) {
  const additions = [], values = new Map();
  const add = (key, label, parents, value, derivation = "copy") => {
    parents = [...new Set(parents)];
    if (!value || !parents.length || parents.some((path) => !ledger.hasPath(path))) return;
    const sources = parents.map((path) => ledger.publicFacts.find((fact) => fact.path === path));
    if (sources.some((source) => !source || !["verified", "user_confirmed"].includes(source.status))) return;
    const path = `formAnswers.${key}`;
    values.set(path, String(value));
    additions.push(Object.freeze({ path, label, sectionKey: "formAnswers", entryIndex: 0,
      status: sources.every((source) => source.status === "user_confirmed") ? "user_confirmed" : "verified",
      evidenceCount: Math.min(...sources.map((source) => source.evidenceCount)), derivedFrom: parents, derivation }));
  };
  const records = [...new Set(ledger.publicFacts.filter((fact) => fact.sectionKey === "educations").map((fact) => fact.entryIndex))];
  const dateNumber = (value) => /^\d{4}-\d{2}(?:-\d{2})?$/.test(value || "") ? Number(value.slice(0, 7).replace("-", "")) : null;
  let current, selectionSources = [];
  for (const dateKey of ["endDate", "startDate"]) {
    const candidates = records.map((i) => ({ i, path: `educations.${i}.${dateKey}`, date: dateNumber(ledger.getValue(`educations.${i}.${dateKey}`)) }));
    if (!candidates.length || candidates.some((candidate) => candidate.date === null)) continue;
    const latest = Math.max(...candidates.map((candidate) => candidate.date));
    const winners = candidates.filter((candidate) => candidate.date === latest);
    if (winners.length === 1) { current = winners[0].i; selectionSources = candidates.map((candidate) => candidate.path); break; }
  }
  if (current === undefined && records.length === 1) current = records[0];
  if (current !== undefined) {
    const prefix = `educations.${current}`;
    for (const [key, suffix, label] of [["currentDegree", "degree", "基本信息 / 在读或最新学历"],
      ["currentMajor", "major", "基本信息 / 当前所学专业"], ["currentSchool", "school", "基本信息 / 在读或最新毕业院校"]]) {
      add(key, label, [...selectionSources, `${prefix}.${suffix}`], ledger.getValue(`${prefix}.${suffix}`), "latest_education");
    }
    const end = ledger.getValue(`${prefix}.endDate`);
    if (dateNumber(end) !== null) {
      add("graduationYear", "基本信息 / 毕业时间（年）", [...selectionSources, `${prefix}.endDate`], end.slice(0, 4), "date_year");
      add("graduationMonth", "基本信息 / 毕业时间（月）", [...selectionSources, `${prefix}.endDate`], String(Number(end.slice(5, 7))), "date_month");
    }
  }
  const bachelors = records.filter((i) => /本科|学士/.test(ledger.getValue(`educations.${i}.degree`) || ""));
  if (bachelors.length === 1) {
    const prefix = `educations.${bachelors[0]}`;
    add("bachelorSchool", "基本信息 / 本科毕业院校", [`${prefix}.degree`, `${prefix}.school`], ledger.getValue(`${prefix}.school`), "bachelor_education");
  }
  const english = ledger.publicFacts.filter((fact) => /^languages\.\d+\.name$/.test(fact.path)
    && /^(英语|english)$/i.test(ledger.getValue(fact.path) || ""));
  if (english.length === 1) {
    const namePath = english[0].path, scorePath = namePath.replace(/name$/, "testScore");
    const score = ledger.getValue(scorePath) || "";
    const match = score.match(/^(?:CET[\s-]*([46])|(?:大学英语|英语)?([四六])级)\s*[:：,，/（( -]*\s*(\d{3})\s*(?:分)?\s*[）)]?$/i);
    if (match) {
      const level = match[1] || (match[2] === "六" ? "6" : "4");
      add("englishLevel", "英语等级 / 已填写考试的等级", [namePath, scorePath], `英语${level === "6" ? "六" : "四"}级`, "exam_level");
      add("englishScore", "英语等级成绩 / 已填写考试的分数", [namePath, scorePath], match[3], "exam_score");
    }
  }
  for (const [prefix, key, label] of [["hometown", "hometown", "籍贯 / 已明确填写的地区层级"],
    ["studentOrigin", "studentOrigin", "生源地 / 已明确填写的地区层级"]]) {
    const paths = ["Province", "City", "District"].map((part) => `contactAndLocation.${prefix}${part}`).filter((path) => ledger.hasPath(path));
    const parts = paths.map((path) => ledger.getValue(path)).filter(Boolean);
    add(key, label, paths, parts.join("/"), "region_join");
  }
  const ethnicPath = ledger.hasPath("personal.ethnicity") ? "personal.ethnicity" : "personal.nationality";
  const ethnicity = ledger.getValue(ethnicPath) || "";
  if (/^[\u4e00-\u9fff]{1,8}族$/.test(ethnicity)) add("ethnicity", "民族 / 明确填写的族别", [ethnicPath], ethnicity);
  const salaryPath = "jobPreferences.expectedSalary", periodPath = "jobPreferences.expectedSalaryPeriod";
  const salary = (ledger.getValue(salaryPath) || "").normalize("NFKC").replace(/[\s,]/g, "");
  const statedPeriod = /月薪|\/月|每月/.test(salary) ? "月薪" : /年薪|\/年|每年/.test(salary) ? "年薪" : null;
  const configuredPeriod = ledger.getValue(periodPath) || null;
  const period = configuredPeriod || statedPeriod;
  const amount = salary.replace(/^(?:税前)?(?:月薪|年薪)/, "").replace(/(?:\/(?:年|月)|每(?:年|月)|年薪|月薪)$/, "")
    .match(/^(\d+(?:\.\d+)?)([wW万kK千]?)(?:元)?$/);
  const monthlyPath = "jobPreferences.expectedMonthlySalary", confirmedMonthly = ledger.getValue(monthlyPath) || "";
  if (confirmedMonthly) add("expectedMonthlySalary", "期望税前月薪（用户独立填写的金额或区间）", [monthlyPath], confirmedMonthly, "salary_monthly");
  else if (amount && ["月薪", "年薪"].includes(period) && (!statedPeriod || !configuredPeriod || statedPeriod === configuredPeriod)
    && !(/月/.test(salary) && /年/.test(salary))) {
    const unit = /[wW万]/.test(amount[2]) ? 10000 : /[kK千]/.test(amount[2]) ? 1000 : 1;
    add("expectedMonthlySalary", period === "年薪" ? "期望税前月薪（已确认年薪按 12 个月换算）" : "期望税前月薪（已确认月薪金额）",
      [salaryPath, ...(configuredPeriod ? [periodPath] : [])], String(Number((Number(amount[1]) * unit / (period === "年薪" ? 12 : 1)).toFixed(2))), "salary_monthly");
  }
  const educationMajor = current !== undefined ? `educations.${current}.majorCategory` : null;
  if (educationMajor) add("currentMajorCategory", "在读专业类别 / 最新教育经历的已确认类别", [...selectionSources, educationMajor], ledger.getValue(educationMajor), "latest_education");
  const otherLanguageNames = ledger.publicFacts.filter((fact) => /^languages\.\d+\.name$/.test(fact.path)
    && !/^(?:英语|english)$/i.test((ledger.getValue(fact.path) || "").trim()));
  const languageSources = [], languageRows = [];
  for (const fact of otherLanguageNames) {
    const prefix = fact.path.replace(/\.name$/, "");
    const row = [["name", ""], ["proficiency", "掌握程度"], ["testScore", "成绩"]].flatMap(([key, label]) => {
      const path = `${prefix}.${key}`, value = ledger.getValue(path);
      if (!value) return []; languageSources.push(path); return [label ? `${label}：${value}` : value];
    });
    if (row.length) languageRows.push(row.join("；"));
  }
  if (languageRows.length) add("otherLanguages", "其他语言（不含英语）的已确认能力与成绩", languageSources, languageRows.join("\n"), "language_summary");
  return Object.freeze({ ...ledger, publicFacts: Object.freeze([...ledger.publicFacts, ...additions]),
    publicEntries: Object.freeze([...ledger.publicEntries, ...additions.map(({ path, label }) => ({ path, label }))]),
    hasPath: (path) => values.has(path) || ledger.hasPath(path),
    getValue: (path) => values.has(path) ? values.get(path) : ledger.getValue(path) });
}
