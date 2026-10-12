import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentProfile, createAwardRecord, withAwardSummaries } from "../src/core/award-details.js";
import { createProfileLedger } from "../src/core/profile-ledger.js";
import { explicitAwardDetails, awardFieldAxis } from "../src/core/award-levels.js";
import { importProfile, ledgerFromProfile } from "../src/core/profile-import.js";

const raw = { additional: { awards: "• 虚构奖项甲\n• 虚构奖项乙", competitions: "• 虚构全国竞赛甲：二等奖" } };

test("award extraction uses explicit scope/rank text and never infers scope from event names or ambiguous statements", () => {
  assert.deepEqual(explicitAwardDetails("虚构全国竞赛一等奖"), { scope: "", rank: "一等奖" });
  assert.deepEqual(explicitAwardDetails("虚构奖项，级别：省部级，等次：二等奖"), { scope: "省级", rank: "二等奖" });
  assert.deepEqual(explicitAwardDetails("虚构奖项：国家级一等奖、校级二等奖"), { scope: "", rank: "" });
  assert.deepEqual(explicitAwardDetails("虚构奖项，省市级，金奖"), { scope: "", rank: "金奖" });
  assert.deepEqual(explicitAwardDetails("虚构奖项，非国家级，未获一等奖"), { scope: "", rank: "" });
  assert.deepEqual(explicitAwardDetails("虚构竞赛，Honorable Mention"), { scope: "", rank: "Honorable Mention" });
  assert.equal(awardFieldAxis("获奖等级"), "level");
  assert.equal(awardFieldAxis("Prize name"), null);
  assert.equal(awardFieldAxis("Prize grade"), "rank");
});

test("legacy migration creates editable names/descriptions and preserves confirmed 0.7.1 metadata and original content", () => {
  const old = { additional: { awards: "• 虚构奖项甲\n补充描述\n• 虚构奖项乙", competitions: "- 虚构竞赛甲" },
    awardDetails: { version: 1, awards: [
      { text: "虚构奖项甲；补充描述", occurrence: 0, duplicateCount: 1, scope: "国家级", rank: "一等奖" },
      { text: "虚构奖项乙", occurrence: 0, duplicateCount: 1, scope: "校级", rank: "优秀奖" },
    ] } };
  const profile = normalizeAgentProfile(old);
  assert.equal(profile.awardRecords.awards[0].name, "虚构奖项甲");
  assert.equal(profile.awardRecords.awards[0].description, "补充描述");
  assert.equal(profile.awardRecords.awards[0].legacyText, "虚构奖项甲\n补充描述");
  assert.equal(profile.awardRecords.awards[0].scope, "国家级");
  assert.equal(profile.awardRecords.awards[1].rank, "优秀奖");
  assert.equal(profile.awardRecords.competitions[0].name, "虚构竞赛甲");
  assert.equal(profile.additional.awards, "");
  assert.equal(profile.additional.competitions, "");
  assert.equal(Object.hasOwn(profile, "awardDetails"), false);
  assert.deepEqual(normalizeAgentProfile(profile), profile, "canonical profile is idempotent");
});

test("stable IDs retain each record's details through renaming, reorder and deletion, including identical names", () => {
  const profile = normalizeAgentProfile({ additional: { awards: "• 虚构重复奖项\n• 虚构重复奖项" } });
  Object.assign(profile.awardRecords.awards[0], { scope: "国家级", rank: "一等奖", description: "虚构描述甲" });
  Object.assign(profile.awardRecords.awards[1], { scope: "校级", rank: "优秀奖", description: "虚构描述乙" });
  const id = profile.awardRecords.awards[0].id;
  profile.awardRecords.awards[0].name = "修改后的虚构奖项";
  profile.awardRecords.awards.reverse();
  const reordered = normalizeAgentProfile(profile);
  assert.equal(reordered.awardRecords.awards[1].id, id);
  assert.equal(reordered.awardRecords.awards[1].scope, "国家级");
  reordered.awardRecords.awards.splice(0, 1);
  assert.equal(normalizeAgentProfile(reordered).awardRecords.awards[0].description, "虚构描述甲");
  reordered.awardRecords.awards = [];
  reordered.additional.awards = raw.additional.awards;
  assert.deepEqual(normalizeAgentProfile(reordered).awardRecords.awards, [], "deletion never reimports legacy bulk text");
});

test("explicitly cleared values stay blank, duplicate IDs are repaired, unknown properties are discarded, backups roundtrip", () => {
  const profile = normalizeAgentProfile({ additional: { awards: "虚构省级一等奖" } });
  Object.assign(profile.awardRecords.awards[0], { scope: "", rank: "", apiKey: "MUST_NOT_PERSIST" });
  profile.awardRecords.competitions.push({ ...profile.awardRecords.awards[0] });
  const stored = importProfile({ profile }).stored;
  assert.equal(stored.profile.awardRecords.awards[0].scope, "");
  assert.equal(stored.profile.awardRecords.awards[0].rank, "");
  assert.notEqual(stored.profile.awardRecords.competitions[0].id, stored.profile.awardRecords.awards[0].id);
  assert.equal(JSON.stringify(stored).includes("MUST_NOT_PERSIST"), false);
  stored.profile.awardRecords.awards[0].scope = "推测的级别";
  const cleaned = importProfile({ profile: stored.profile }).stored.profile;
  assert.equal(cleaned.awardRecords.awards[0].scope, "");
  assert.deepEqual(importProfile({ profile: cleaned }).stored.profile, cleaned);
});

test("structured-only profiles import; malformed records and oversized lists cannot silently lose entries", () => {
  const record = { ...createAwardRecord(), name: "虚构结构化奖项" };
  const input = { awardRecords: { version: 1, awards: [record], competitions: [] } };
  assert.equal(importProfile(input).summary.sections.find((section) => section.key === "awards").recordCount, 1);
  assert.throws(() => importProfile({ awardRecords: { version: 1, awards: [], competitions: [] } }), /PROFILE_IMPORT_EMPTY/);
  assert.throws(() => normalizeAgentProfile({ awardRecords: { version: 2, awards: [], competitions: [] } }), /PROFILE_IMPORT_FORMAT/);
  assert.throws(() => normalizeAgentProfile({ awardRecords: { version: 1, awards: [null], competitions: [] } }), /PROFILE_IMPORT_FORMAT/);
  assert.throws(() => normalizeAgentProfile({ awardRecords: { version: 1, awards: Array(101).fill(record), competitions: [] } }), /PROFILE_IMPORT_TOO_LARGE/);
});

test("name/description/scope/rank are independent private facts; level projections also support records without names", () => {
  const profile = normalizeAgentProfile(raw);
  Object.assign(profile.awardRecords.awards[0], { scope: "国家级", rank: "金奖", description: "虚构独立描述" });
  const { stored, summary } = importProfile({ profile, agentProfilePurpose: "synthetic_evaluation" });
  const ledger = ledgerFromProfile(stored);
  assert.equal(ledger.getValue("awards.0.name"), "虚构奖项甲");
  assert.equal(ledger.getValue("awards.0.description"), "虚构独立描述");
  assert.equal(ledger.getValue("awards.0.scope"), "国家级");
  assert.equal(ledger.getValue("awards.0.rank"), "金奖");
  assert.equal(ledger.hasPath("awards.1.scope"), false);
  assert.equal(ledger.hasPath("competitions.0.scope"), false);
  assert.equal(ledger.hasPath("additional.awards"), false);
  assert.equal(ledger.getValue("competitions.0.rank"), "二等奖");
  const projection = ledger.publicFacts.find((fact) => fact.path === "awards.0.level");
  assert.deepEqual(projection.derivedFrom, ["awards.0.scope", "awards.0.rank"]);
  assert.equal(projection.derivation, "award_level");
  assert.deepEqual(JSON.parse(ledger.getValue("awards.0.level")), { kind: "award_level", scope: "国家级", rank: "金奖" });
  assert.equal(summary.sections.find((section) => section.key === "awards").recordCount, 2);
  assert.equal(summary.sections.find((section) => section.key === "competitions").recordCount, 1);
  for (const value of ["虚构奖项甲", "虚构全国竞赛甲", "虚构独立描述", "金奖", profile.awardRecords.awards[0].id]) {
    assert.equal(JSON.stringify({ facts: ledger.publicFacts, entries: ledger.publicEntries, summary }).includes(value), false);
  }
  const unnamed = normalizeAgentProfile(profile);
  unnamed.awardRecords.awards[0].name = "";
  assert.equal(ledgerFromProfile({ profile: unnamed }).hasPath("awards.0.level"), true);
});

test("record and whole-section summaries preserve every confirmed property and expose only provenance", () => {
  const profile = normalizeAgentProfile(raw);
  Object.assign(profile.awardRecords.awards[0], { scope: "国家级", rank: "金奖", description: "虚构汇总详情" });
  const ledger = ledgerFromProfile(importProfile({ profile }).stored);
  assert.equal(ledger.getValue("awards.0.summary"), "名称：虚构奖项甲\n级别：国家级\n等次：金奖\n详细信息：虚构汇总详情");
  assert.equal(ledger.getValue("awards.1.summary"), "名称：虚构奖项乙", "missing properties are not invented");
  const combined = ledger.getValue("formAnswers.awardsAndCompetitionsSummary");
  assert.equal(combined, ["awards.0.summary", "awards.1.summary", "competitions.0.summary"]
    .map((path, i) => (i + 1) + ". " + ledger.getValue(path)).join("\n\n"));
  const fact = ledger.publicFacts.find((item) => item.path === "formAnswers.awardsAndCompetitionsSummary");
  assert.deepEqual(fact.derivedFrom, ["awards.0.summary", "awards.1.summary", "competitions.0.summary"]);
  assert.equal(fact.derivation, "award_summary_join");
  assert.equal(ledger.getValue("formAnswers.awardsSummary").includes("虚构全国竞赛"), false);
  assert.equal(ledger.getValue("formAnswers.competitionsSummary").includes("虚构奖项甲"), false);
  for (const value of ["虚构奖项甲", "虚构汇总详情", "金奖"]) {
    assert.equal(JSON.stringify({ facts: ledger.publicFacts, entries: ledger.publicEntries }).includes(value), false);
  }
});

test("summaries cannot conceal unverified or conflicting properties or silently omit a record", () => {
  const candidate = (sourceId, value) => ({ sourceId, value, status: "verified" });
  const fact = (path, candidates) => ({ path, label: "虚构属性", sectionKey: path.split(".")[0],
    entryIndex: Number(path.split(".")[1]), candidates });
  const ledger = withAwardSummaries(createProfileLedger({ schemaVersion: 1,
    sources: [{ id: "user", kind: "user_confirmation" }, { id: "doc", kind: "document" }, { id: "model", kind: "model_suggestion" }],
    facts: [
      fact("awards.0.name", [candidate("user", "虚构有未知详情的奖项")]),
      fact("awards.0.description", [candidate("model", "未经确认的虚构详情")]),
      fact("awards.1.name", [candidate("user", "虚构来源甲"), candidate("doc", "虚构来源乙")]),
      fact("competitions.0.name", [candidate("doc", "虚构已确认竞赛")]),
    ] }));
  assert.equal(ledger.hasPath("awards.0.summary"), false);
  assert.equal(ledger.hasPath("awards.1.summary"), false);
  assert.equal(ledger.hasPath("formAnswers.awardsSummary"), false);
  assert.equal(ledger.hasPath("formAnswers.awardsAndCompetitionsSummary"), false);
  assert.equal(ledger.getValue("formAnswers.competitionsSummary"), "1. 名称：虚构已确认竞赛");
});
