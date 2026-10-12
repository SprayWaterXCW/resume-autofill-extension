/** Known resume section meanings; no company or DOM selectors participate. */
export function observedRecordSections(label, groups = []) {
  const matches = [
    [/教育|学习经历|education|academic background/i, "educations"], [/实习|internship/i, "internships"],
    [/工作经历|职业经历|employment|work experience/i, "workExperiences"], [/项目(?:经历|经验)|projects?/i, "projects"],
    [/校园|在校|社会实践|campus/i, "campusExperiences"], [/语言(?:能力|技能)|languages?/i, "languages"],
    [/证书|认证|certificat/i, "certificates"], [/竞赛|比赛|competitions?/i, "competitions"],
    [/获奖|奖项|荣誉|awards?|honors?/i, "awards"],
  ].filter(([pattern]) => pattern.test(label)).map(([, key]) => key);
  if (matches.length === 2 && matches.every((key) => ["awards", "competitions"].includes(key))) return ["awards", "competitions"];
  if (matches.length !== 1) return null; // A mixed title supplies no unique boundary.
  if (matches[0] === "awards") return groups.some((group) => /竞赛|比赛|competitions?/i.test(group.label))
    ? ["awards"] : ["awards", "competitions"];
  if (matches[0] === "workExperiences" && !groups.some((group) => /实习|internship/i.test(group.label))) return ["workExperiences", "internships"];
  return matches;
}

/** Scalar latest/bachelor answers cannot replace indexed record fields. */
export function recordProjectionCompatible(context, field, fact) {
  const group = context.page.groups.find((group) => group.id === field.groupId);
  const repeated = group.entryCount > 1 || group.hasAddCandidate && group.source !== "fallback";
  const expected = observedRecordSections(group.label, context.page.groups);
  if (expected && group.source !== "fallback") {
    const aggregate = /^formAnswers\.(?:awards|competitions|awardsAndCompetitions)Summary$/.test(fact.path);
    if (!aggregate && (!expected.includes(fact.sectionKey) || !/^\d+$/.test(fact.path.split(".")[1]))) return false;
  }
  if (!repeated) return true;
  const facts = new Map(context.profileCatalog.map((fact) => [fact.path, fact]));
  const visited = new Set(), pending = [fact.path];
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = facts.get(path);
    if (["latest_record", "latest_education", "bachelor_education"].includes(source?.derivation)) return false;
    pending.push(...(source?.derivedFrom || []));
  }
  return true;
}
