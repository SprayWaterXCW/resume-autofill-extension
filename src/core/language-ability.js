// A proficiency dimension and an exam result answer different questions. Keep
// this constraint shared by model candidates and independent plan validation.
// No applicant values or recruiting-company identifiers are needed.
export function languageFieldRole(field, groupLabel = "") {
  const text = String(field?.label || "").trim();
  const languageContext = /语言|外语|英语|language|english/i.test(groupLabel + " " + text);
  if (!languageContext) return null;
  if (/^(?:听说|听力(?:和|与|及|\/)口语)(?:能力|水平|程度|熟练程度|等级)?$|listening\s*(?:and|&|\/)\s*speaking/i.test(text)) return "listeningSpeaking";
  if (/^(?:读写|阅读(?:和|与|及|\/)写作)(?:能力|水平|程度|熟练程度|等级)?$|reading\s*(?:and|&|\/)\s*writing/i.test(text)) return "readingWriting";
  // Mixed free-form prompts such as "其他语言能力及等级/分数" remain model
  // questions; they cannot authorize a score/proficiency conversion here.
  if (/^(?:英语|外语|语言)?(?:熟练程度|掌握程度|熟练度|掌握水平|能力水平)$|^(?:language )?proficiency$/i.test(text)) return "proficiency";
  return null;
}

export function languageMappingCompatible(field, groupLabel, fact) {
  const role = languageFieldRole(field, groupLabel);
  if (!role) return true;
  return new RegExp(`^languages\\.\\d+\\.${role}$`).test(fact.path);
}
