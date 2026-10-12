import { ResumeSchema } from "../vendor/formfill/resume-schema.js";
import { WriteFixes } from "../vendor/formfill/write-fixes.js";
import { AWARD_SCOPES, explicitAwardDetails } from "./award-levels.js";

export const AWARD_SECTIONS = Object.freeze(["awards", "competitions"]);
export const AWARD_RECORD_LIMIT = 100;
export const AWARD_PROPERTIES = Object.freeze(["name", "scope", "rank", "date", "description"]);
const canonical = (text) => WriteFixes.oneLineAwardEntry(text);
const source = (value) => ["original_text", "user_confirmed"].includes(value) ? value : "user_confirmed";
const textValue = (value) => typeof value === "string" ? value.trim() : "";
const validId = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function createAwardRecord() {
  return { id: globalThis.crypto.randomUUID(), name: "", scope: "", rank: "", date: "", description: "",
    scopeSource: "unconfirmed", rankSource: "unconfirmed" };
}

export function hasAwardRecordValue(record) {
  return AWARD_PROPERTIES.some((key) => textValue(record?.[key]));
}

export function hasAnyFilledAgentProfile(profile) {
  return ResumeSchema.hasAnyFilledField(profile)
    || AWARD_SECTIONS.some((section) => profile.awardRecords?.[section]?.some(hasAwardRecordValue));
}

function normalizeRecord(item, ids) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("PROFILE_IMPORT_FORMAT");
  const record = { id: validId(item.id) && !ids.has(item.id) ? item.id : globalThis.crypto.randomUUID(),
    name: textValue(item.name), scope: AWARD_SCOPES.includes(item.scope) ? item.scope : "",
    rank: textValue(item.rank), date: textValue(item.date), description: textValue(item.description) };
  ids.add(record.id);
  if (record.name.length > 20_000 || record.description.length > 50_000 || record.rank.length > 80 || record.date.length > 40) {
    throw new Error("PROFILE_IMPORT_TOO_LARGE");
  }
  record.scopeSource = record.scope ? source(item.scopeSource) : "unconfirmed";
  record.rankSource = record.rank ? source(item.rankSource) : "unconfirmed";
  // This archive is private migration evidence, never a planner or executor source.
  if (typeof item.legacyText === "string" && item.legacyText) record.legacyText = item.legacyText;
  return record;
}

function migrateSection(input, section) {
  const entries = WriteFixes.parseAwardEntries(input?.additional?.[section]);
  const counts = new Map(), occurrences = new Map();
  for (const entry of entries) {
    const text = canonical(entry);
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  const supplied = Array.isArray(input?.awardDetails?.[section]) ? input.awardDetails[section] : [];
  return entries.map((entry) => {
    const text = canonical(entry), occurrence = occurrences.get(text) || 0;
    occurrences.set(text, occurrence + 1);
    const matches = supplied.filter((item) => item && typeof item.text === "string" && canonical(item.text) === text
      && item.occurrence === occurrence && item.duplicateCount === counts.get(text));
    const previous = matches.length === 1 ? matches[0] : null;
    const explicit = explicitAwardDetails(text);
    const lines = entry.trim().split(/\r?\n/u);
    return { name: lines[0].replace(/^\s*(?:[•●▪◦]|[-–—])\s*/u, "").trim(),
      description: lines.slice(1).join("\n").trim(), legacyText: entry,
      scope: previous && Object.hasOwn(previous, "scope") ? previous.scope : explicit.scope,
      rank: previous && Object.hasOwn(previous, "rank") ? previous.rank : explicit.rank,
      scopeSource: previous ? previous.scopeSource : "original_text",
      rankSource: previous ? previous.rankSource : "original_text" };
  });
}

/** Structured records are authoritative, including deliberately emptied lists. */
export function normalizeAgentProfile(input) {
  const profile = ResumeSchema.normalizeResumeProfile(input);
  if (profile.customAnswers.some((item) => item.question.length > 180 || item.answer.length > 20_000)) throw new Error("PROFILE_IMPORT_TOO_LARGE");
  const structured = input && Object.hasOwn(input, "awardRecords");
  if (structured && (!input.awardRecords || input.awardRecords.version !== 1
    || AWARD_SECTIONS.some((section) => !Array.isArray(input.awardRecords[section])))) {
    throw new Error("PROFILE_IMPORT_FORMAT");
  }
  const records = { version: 1 }, ids = new Set();
  for (const section of AWARD_SECTIONS) {
    const entries = structured ? input.awardRecords[section] : migrateSection(input, section);
    if (entries.length > AWARD_RECORD_LIMIT) throw new Error("PROFILE_IMPORT_TOO_LARGE");
    records[section] = entries.map((entry) => normalizeRecord(entry, ids));
    // Old bulk fields are consumed once; an empty structured list cannot resurrect them.
    profile.additional[section] = "";
  }
  profile.awardRecords = records;
  return profile;
}

/** Format only confirmed properties, locally, for sites asking for a whole record. */
export function withAwardSummaries(ledger) {
  const additions = [], values = new Map(), records = new Map();
  for (const fact of ledger.publicFacts) {
    if (/^(awards|competitions)\.\d+\.(name|scope|rank|date|description)$/.test(fact.path)) {
      const prefix = fact.path.slice(0, fact.path.lastIndexOf("."));
      if (!records.has(prefix)) records.set(prefix, []);
      records.get(prefix).push(fact);
    }
  }
  const perSection = { awards: [], competitions: [] };
  const propertyLabels = { name: "名称", scope: "级别", rank: "等次", date: "获奖时间", description: "详细信息" };
  for (const [prefix, facts] of records) {
    const confirmed = facts.filter((fact) => ["verified", "user_confirmed"].includes(fact.status) && ledger.hasPath(fact.path));
    if (!confirmed.length || confirmed.length !== facts.length) continue;
    const path = prefix + ".summary", first = confirmed[0];
    values.set(path, ["name", "scope", "rank", "date", "description"].flatMap((property) => {
      const parent = confirmed.find((fact) => fact.path === prefix + "." + property);
      return parent ? [propertyLabels[property] + "：" + ledger.getValue(parent.path)] : [];
    }).join("\n"));
    additions.push(Object.freeze({ path, label: (first.sectionKey === "awards" ? "获奖" : "竞赛") + "经历 " + (first.entryIndex + 1)
      + " / 完整情况（合并已确认名称、级别、等次、详情）", sectionKey: first.sectionKey, entryIndex: first.entryIndex,
      status: "user_confirmed", evidenceCount: 1, derivedFrom: confirmed.map((fact) => fact.path), derivation: "award_summary" }));
    perSection[first.sectionKey].push(path);
  }
  for (const [key, sections, label] of [
    ["awardsSummary", ["awards"], "全部获奖情况（整段文字框）"],
    ["competitionsSummary", ["competitions"], "全部竞赛情况（整段文字框）"],
    ["awardsAndCompetitionsSummary", ["awards", "competitions"], "全部获奖与竞赛情况（网站仅有获奖整段文字框时合并）"],
  ]) {
    const parents = sections.flatMap((section) => perSection[section]);
    const complete = sections.every((section) => perSection[section].length === [...records.values()]
      .filter((facts) => facts[0].sectionKey === section).length);
    if (!parents.length || !complete) continue;
    const path = "formAnswers." + key;
    values.set(path, parents.map((parent, index) => (index + 1) + ". " + values.get(parent)).join("\n\n"));
    additions.push(Object.freeze({ path, label, sectionKey: "formAnswers", entryIndex: 0, status: "user_confirmed",
      evidenceCount: 1, derivedFrom: parents, derivation: "award_summary_join" }));
  }
  return Object.freeze({ ...ledger, publicFacts: Object.freeze([...ledger.publicFacts, ...additions]),
    publicEntries: Object.freeze([...ledger.publicEntries, ...additions.map(({ path, label }) => Object.freeze({ path, label }))]),
    hasPath: (path) => values.has(path) || ledger.hasPath(path),
    getValue: (path) => values.has(path) ? values.get(path) : ledger.getValue(path) });
}

/** A local projection resolves ambiguous dropdown labels using their actual options. */
export function withAwardLevels(ledger) {
  const additions = [], values = new Map(), records = new Map();
  for (const fact of ledger.publicFacts) {
    const match = /^(awards|competitions)\.\d+\.(?:name|scope|rank|description)$/.exec(fact.path);
    if (match) records.set(fact.path.slice(0, fact.path.lastIndexOf(".")), fact);
  }
  for (const [prefix, fact] of records) {
    const parents = [prefix + ".scope", prefix + ".rank"].filter((path) => ledger.hasPath(path));
    if (!parents.length) continue;
    const path = prefix + ".level";
    values.set(path, JSON.stringify({ kind: "award_level", scope: ledger.getValue(prefix + ".scope") || "", rank: ledger.getValue(prefix + ".rank") || "" }));
    additions.push(Object.freeze({ path, label: (fact.sectionKey === "awards" ? "获奖" : "竞赛") + "经历 " + (fact.entryIndex + 1)
      + " / 获奖等级（仅选项控件，按选项区分级别与等次）", sectionKey: fact.sectionKey, entryIndex: fact.entryIndex,
      status: "user_confirmed", evidenceCount: 1, derivedFrom: parents, derivation: "award_level" }));
  }
  return Object.freeze({ ...ledger, publicFacts: Object.freeze([...ledger.publicFacts, ...additions]),
    publicEntries: Object.freeze([...ledger.publicEntries, ...additions.map(({ path, label }) => Object.freeze({ path, label }))]),
    hasPath: (path) => values.has(path) || ledger.hasPath(path),
    getValue: (path) => values.has(path) ? values.get(path) : ledger.getValue(path) });
}
