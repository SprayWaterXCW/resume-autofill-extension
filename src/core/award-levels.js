// Shared vocabulary for the private profile and observed award controls.
// Event names never determine an award's scope.
export const AWARD_SCOPES = Object.freeze(["国际级", "国家级", "省级", "市级", "区县级", "校级", "院级"]);
export const AWARD_FIELD_ROLES = Object.freeze(["name", "description", "scope", "rank", "level", "summary", "date"]);
const compact = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const scopeAliases = [
  ["国际级", ["国际级", "国际"]],
  ["国家级", ["国家级", "全国级", "国家", "全国"]],
  ["省级", ["省级", "省部级", "省/部级", "省级/部级", "省"]],
  ["市级", ["市级", "地市级", "市"]],
  ["区县级", ["区县级", "区县", "区级", "县级"]],
  ["校级", ["校级", "学校级", "学校", "校"]],
  ["院级", ["院级", "学院级", "院系级", "学院", "院"]],
];

export function normalizeAwardScope(value) {
  const text = compact(value);
  return scopeAliases.find(([, aliases]) => aliases.some((alias) => compact(alias) === text))?.[0] || "";
}

export function normalizeAwardRank(value) {
  const text = compact(value);
  const match = text.match(/^([一二三四五六七八九十特])等(?:奖)?$/u);
  return match ? match[1] + "等奖" : text;
}

export function explicitAwardDetails(text) {
  const scopes = [...String(text).matchAll(/国际级|国家级|全国级|省部级|省级|地市级|市级|区县级|县级|区级|学校级|校级|学院级|院系级|院级/gu)]
    .map((match) => normalizeAwardScope(match[0]));
  const ranks = [...String(text).matchAll(/特等奖|[一二三四五六七八九十]等奖|金奖|银奖|铜奖|优秀奖|优胜奖|参与奖|Honorable\s+Mention|Meritorious\s+Winner/giu)]
    .map((match) => match[0].replace(/\s+/gu, " "));
  const scopeSet = new Set(scopes.filter(Boolean));
  const rankSet = new Set(ranks.map(normalizeAwardRank));
  const uncertainScope = /省[、/／和及与]?市级|非|不属于|不是|未确认|待确认|不确定|待定/u.test(text);
  const uncertainRank = /[一二三四五]、[一二三四五]等奖|未获|没有获得|未确认|待确认|不确定|待定/u.test(text);
  return { scope: !uncertainScope && scopeSet.size === 1 ? [...scopeSet][0] : "",
    rank: !uncertainRank && rankSet.size === 1 ? ranks[0] : "" };
}

export function awardFieldAxis(label) {
  const text = String(label || "");
  const scope = /级别|范围|层级|\bscope\b|\btier\b/i.test(text);
  const rank = /等次|等第|奖等(?!级)|名次|奖项档次|\brank\b|\bprize\s+(?:rank|grade|place)\b/i.test(text);
  if (scope && rank) return "level";
  if (scope) return "scope";
  if (rank) return "rank";
  return /等级|\blevel\b|\bgrade\b/i.test(text) ? "level" : null;
}

export function awardSourceAxis(path) {
  return /^(awards|competitions)\.\d+\.(scope|rank|level)$/.exec(path || "")?.[2] || null;
}

export function awardSourceRole(path) {
  if (/^formAnswers\.(awardsSummary|competitionsSummary|awardsAndCompetitionsSummary)$/.test(path || "")) return "summary";
  if (/^(awards|competitions)\.\d+\.(date|awardDate|receivedDate)(Year|Month|Day)?$/.test(path || "")) return "date";
  const property = /^(awards|competitions)\.\d+\.(name|title|description|scope|rank|level|summary)$/.exec(path || "")?.[2];
  return property === "title" ? "name" : property || null;
}

/** Classify observed labels only; an unknown label stays unknown. */
export function awardFieldRole(field, proposedRole) {
  if (field.labelSource === "missing") return "unknown";
  if (/时间|日期|年月|\bdate\b|\bwhen\b/i.test(field.label)) return "date";
  const axis = awardFieldAxis(field.label);
  if (axis) return axis;
  if (/描述|详细|详情|说明|description|details?/i.test(field.label)) return "description";
  if (/名称|名字|\bname\b|\btitle\b/i.test(field.label)
    || /^(奖项|奖项名|荣誉|竞赛|比赛|award|prize|competition)$/i.test(field.label.replace(/^[*＊]\s*/, "").trim())) return "name";
  return AWARD_FIELD_ROLES.includes(proposedRole) ? proposedRole : "unknown";
}

export function awardMappingCompatible(field, groupLabel, sourcePath, peers = [], proposedRole) {
  const sourceAxis = awardSourceAxis(sourcePath);
  const sourceRole = awardSourceRole(sourcePath);
  const awardTarget = /获奖|奖项|荣誉|竞赛|比赛|awards?|competitions?/i.test(groupLabel + " " + field.label);
  if (!awardTarget && !sourceRole) return !proposedRole;
  const observedRole = awardFieldRole(field);
  const proseSummary = proposedRole === "summary" && observedRole === "description" && field.kind === "textarea"
    && peers.filter((peer) => peer.groupId === field.groupId).length === 1;
  if (proposedRole && observedRole !== "unknown" && proposedRole !== observedRole && !proseSummary) return false;
  const role = proseSummary ? "summary" : awardFieldRole(field, proposedRole);
  const nameOwner = peers.some((peer) => peer.id !== field.id && peer.groupId === field.groupId && peer.entryIndex === field.entryIndex
    && !peer.disabled && awardFieldRole(peer, peer.semanticRole) === "name");
  const observedNameOwner = peers.some((peer) => peer.id !== field.id && peer.groupId === field.groupId && peer.entryIndex === field.entryIndex
    && !peer.disabled && awardFieldRole(peer) === "name");
  if (role !== "unknown") {
    if (sourceRole !== role) return false;
    if (role === "name" && observedRole === "unknown" && observedNameOwner) return false;
    if (role === "level") return ["select", "custom-select", "combobox", "autocomplete", "radio"].includes(field.kind);
    if (role === "summary") return ["text", "textarea"].includes(field.kind) && !nameOwner;
    return true;
  }
  if (sourceAxis || sourceRole === "summary") return false;
  // Reserve the name for a recognized/declared name field in the same card.
  if (sourceRole === "name" && nameOwner) return false;
  return true;
}

/** A single prose box without an observed add candidate represents all records. */
export function isAggregateAwardField(context, field) {
  const group = context.page.groups.find((item) => item.id === field.groupId);
  return !context.page.truncated && !group?.hasAddCandidate && group?.entryCount === 1
    && context.page.fields.filter((item) => item.groupId === field.groupId).length === 1
    && ["text", "textarea"].includes(field.kind);
}

function optionAxis(text) {
  if (normalizeAwardScope(text) || scopeOptionMembers(text).length) return "scope";
  const normalized = normalizeAwardRank(text);
  return /^(?:[一二三四五六七八九十特]等奖|[金银铜]奖|优秀奖|优胜奖|参与奖|[一二三四五六七八九十]名|第[一二三四五六七八九十1-9][十0-9]?名|honorablemention|meritoriouswinner)$/u.test(normalized) ? "rank" : null;
}

// A site may intentionally combine administrative tiers into one option. Keep
// the user's precise scope; only match it to an observed containing category.
function scopeOptionMembers(text) {
  const label = compact(text);
  return ({ "院校级": ["院级", "校级"], "县市级": ["区县级", "市级"], "省区级": ["省级"],
    "省市级": ["省级", "市级"] })[label] || [];
}

/** Only an observed, unique choice is executable. The level payload stays local. */
export function resolveAwardChoice(options, sourcePath, value) {
  const sourceAxis = awardSourceAxis(sourcePath);
  if (!sourceAxis) return null;
  const choices = options.filter((option) => option.text && !option.el.disabled
    && option.el.getAttribute("aria-disabled") !== "true" && !option.el.matches(".is-disabled, .disabled")
    && !/^(请选择|未选择|选择|select|please select)$/i.test(option.text.trim()));
  const observed = choices.filter((option) => !/^(其他|无|不限|other|none)$/i.test(option.text.trim()));
  const axes = new Set(observed.map((option) => optionAxis(option.text)));
  const observedAxis = axes.size === 1 && !axes.has(null) ? [...axes][0] : null;
  let axis = sourceAxis, desired = value;
  if (sourceAxis === "level") {
    if (!observed.length) return { code: "AWARD_LEVEL_UNOBSERVED" };
    if (!observedAxis) return { code: "AWARD_LEVEL_AMBIGUOUS" };
    let payload;
    try { payload = JSON.parse(value); } catch { return { code: "AWARD_SOURCE_INVALID" }; }
    if (!payload || payload.kind !== "award_level" || typeof payload.scope !== "string" || typeof payload.rank !== "string"
      || payload.scope && !AWARD_SCOPES.includes(payload.scope) || payload.rank.length > 80) return { code: "AWARD_SOURCE_INVALID" };
    axis = observedAxis;
    desired = payload[axis];
  } else if (observedAxis && observedAxis !== axis) return { code: "AWARD_AXIS_MISMATCH", axis };
  if (!desired) return { code: axis === "scope" ? "AWARD_SCOPE_MISSING" : "AWARD_RANK_MISSING", axis };
  const normalize = axis === "scope" ? normalizeAwardScope : normalizeAwardRank;
  const expected = normalize(desired);
  const exact = expected ? choices.filter((option) => normalize(option.text) === expected) : [];
  const matching = exact.length || axis !== "scope" ? exact
    : choices.filter((option) => scopeOptionMembers(option.text).includes(expected));
  return matching.length === 1 ? { picked: matching[0], axis }
    : { code: matching.length > 1 ? "AWARD_OPTION_AMBIGUOUS" : "AWARD_OPTION_UNAVAILABLE", axis };
}
