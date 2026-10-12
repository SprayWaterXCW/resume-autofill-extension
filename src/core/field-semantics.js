/** Semantic constraints supplement model matching. Unknown captions remain for
 * the model; known, different concepts cannot borrow one another's facts. */
function salaryRole(label, path = "") {
  const text = `${label || ""} ${path}`;
  if (!/薪|工资|收入|salary|compensation|pay\b/i.test(text)) return null;
  if (/期望|期待|希望|意向|expected|desired|preferred|expectation/i.test(text)) return "expected_salary";
  if (/目前|当前|现在|最近|上一|上家|现有|current|present|latest|previous|recent|last/i.test(text)) return "current_salary";
  return "salary_unspecified";
}
function projectFieldRole(field) {
  const text = field.label || "";
  if (/项目中.*职责|本人.*(?:职责|贡献)|个人.*(?:职责|贡献)|负责(?:内容|部分|模块)|承担.*职责|personal.*(?:contribution|responsibilit)|my.*(?:role|duties)/i.test(text)) return "responsibilities";
  if (/职责|角色|职位|role|responsibilit|duties|position/i.test(text)) return field.kind === "textarea" ? "responsibilities" : "role";
  if (/项目.*(?:描述|说明|介绍|内容)|project.*(?:description|overview|summary)/i.test(text)) return "description";
  return null;
}
function projectSourceRole(fact) {
  if (fact.sectionKey !== "projects") return null;
  const key = fact.path?.split(".").at(-1) || "";
  if (/^(?:responsibilities|duties|contributions?|personalContribution|roleDescription)$/i.test(key)) return "responsibilities";
  if (/^(?:role|position|title)$/i.test(key)) return "role";
  if (/^(?:description|summary|overview)$/i.test(key)) return "description";
  return null;
}
export function fieldMappingCompatible(field, fact, groupLabel = "") {
  const normalizeQuestion = (text) => String(text || "").normalize("NFKC").replace(/[\s\p{P}＊*]/gu, "").toLowerCase();
  if (/^formAnswers\.customAnswer\d+$/.test(fact.path || "")) return normalizeQuestion(field.label) === normalizeQuestion(fact.label);
  const text = field.label || "";
  // The legacy mixed "民族/国籍" value is ambiguous in the public catalog.
  // Only an explicit ethnicity or its locally checked projection may answer.
  if (/民族|族别|ethnicity|ethnic group/i.test(text) && !/国籍|nationality|citizenship/i.test(text)) {
    return fact.path === "formAnswers.ethnicity" || fact.path === "personal.ethnicity";
  }
  if (/^(?:籍贯|native place|native origin)$/i.test(text.trim())) {
    return fact.path === "formAnswers.hometown" || ["text", "textarea", "select"].includes(field.kind)
      && /^contactAndLocation\.hometown(?:Province|City|District)$/.test(fact.path);
  }
  if (/^(?:工作经验|工作年限|工作经历年限|从业年限|经验年限|years? (?:of )?(?:work )?experience)$/i.test(text.trim())
    && field.kind !== "textarea") return fact.path === "personal.yearsOfExperience";
  // Distinct preferences must have distinct answers, even when their labels
  // share the words "city" or "position".
  const preference = /第二志愿.*(?:城市|地点)/.test(text) ? "secondChoiceCity"
    : /第二志愿.*(?:岗位|职位)/.test(text) ? "secondChoiceRole"
    : /(?:可|期望).*面试.*(?:城市|地点)/.test(text) ? "interviewLocations" : null;
  if (preference) return fact.path === `jobPreferences.${preference}`;
  if (/推荐人.*(?:姓名|名字)|referr(?:er|al).*name/i.test(text)) return fact.path === "jobPreferences.referrerName";
  if (/推荐人.*(?:手机|电话|联系方式)|referrer.*(?:phone|contact)/i.test(text)) return fact.path === "jobPreferences.referrerPhone";
  if (/内推码|推荐码|referral code/i.test(text)) return fact.path === "jobPreferences.referralCode";
  if (/生源地/.test(text)) return /^(?:formAnswers\.studentOrigin|contactAndLocation\.studentOrigin(?:Province|City|District))$/.test(fact.path);
  if (/专业.*类别|学科.*类别/.test(text)) return /(?:\.majorCategory|\.currentMajorCategory)$/.test(fact.path);
  if (/色盲|色弱/.test(text)) return fact.path === "personal.colorVision";
  if (/海外院校毕业|是否.*(?:海外|境外).*毕业/.test(text)) return fact.path === "personal.overseasGraduation";
  if (/期望.*(?:月薪|月工资|薪.*月)|expected.*monthly|desired.*monthly/i.test(text)) {
    return fact.path === "formAnswers.expectedMonthlySalary" || fact.path === "jobPreferences.expectedMonthlySalary"
      || /月薪|月工资|monthly.*(?:salary|pay|compensation)|(?:salary|pay|compensation).*monthly/i.test(fact.label || "")
      && !/周期|period/i.test(fact.label || "");
  }
  // Degree level and the way a degree was obtained are different questions.
  if (/^(?:最高|在读|当前|目前|最新)?学历(?:层次|等级|水平)?(?:\s*[（(].*[）)])?$|^(?:highest |current )?(?:education level|degree level|degree)$/i.test(text.trim())) {
    return /^(?:educations\.\d+\.degree|formAnswers\.currentDegree|personal\.highestEducationLevel)$/.test(fact.path);
  }
  if (/学习形式|学习方式|培养方式|study mode|learning mode/i.test(text)) return /^educations\.\d+\.studyMode$/.test(fact.path);
  if (/^(?:导师|导师姓名|指导老师|advisor|supervisor)$/i.test(text.trim())) return /^educations\.\d+\.advisor$/.test(fact.path);
  if (/研究方向|课题描述|research (?:direction|topic)|thesis (?:topic|description)/i.test(text)) return /^educations\.\d+\.(?:researchDirection|researchTopic|researchDescription|thesisDescription)$/.test(fact.path);
  if (/其他.*语言|除英语|other.*languages?/i.test(text)) return fact.path === "formAnswers.otherLanguages";
  if (/学历类型|学历性质|教育类型|education type/i.test(text)) return /^educations\.\d+\.educationType$/.test(fact.path);
  if (/论文|专著|publication|paper/i.test(groupLabel)) {
    const property = /发布时间|发表时间|发表日期|publication date/i.test(text) ? "publicationDate"
      : /所属期刊|期刊|journal/i.test(text) ? "journal"
      : /作者顺序|author.*order/i.test(text) ? "authorOrder"
      : /年度期次|期次|issue/i.test(text) ? "issue"
      : /^(?:名称|论文名称|专著名称|标题|title|name)$/i.test(text.trim()) ? "title" : null;
    if (property) return new RegExp(`^papers\\.\\d+\\.${property}(?:Year|Month|Day)?$`).test(fact.path);
  }
  if (fact.path === "additional.publications" && /论文|专著|publication|paper/i.test(groupLabel)
    && !/说明|描述|情况|description|summary/i.test(text)) return false;
  const targetSalary = salaryRole(field.label), sourceSalary = salaryRole(fact.label, fact.path);
  if (targetSalary && !sourceSalary) return false;
  if (targetSalary && sourceSalary && targetSalary !== "salary_unspecified" && sourceSalary !== "salary_unspecified"
    && targetSalary !== sourceSalary) return false;
  const project = /项目|project/i.test(groupLabel) || fact.sectionKey === "projects";
  const targetRole = project ? projectFieldRole(field) : null;
  const sourceRole = projectSourceRole(fact);
  if (targetRole && fact.sectionKey === "projects" && targetRole !== sourceRole) return false;
  return true;
}
