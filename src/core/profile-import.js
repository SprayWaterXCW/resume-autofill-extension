import { ResumeSchema } from "../vendor/formfill/resume-schema.js";
import { createProfileLedger } from "./profile-ledger.js";
import { withFormAnswers } from "./form-answers.js";
import { withDateParts } from "./date-parts.js";
import { withLatestRecordAnswers } from "./latest-record-answers.js";
import { normalizeAgentProfile, hasAnyFilledAgentProfile, withAwardLevels, withAwardSummaries } from "./award-details.js";

export const PRIVATE_PROFILE_KEY = "agentPrivateProfile";

/** Accept the existing plugin's single-profile export, template bank, or structured profile. */
export function importProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PROFILE_IMPORT_FORMAT");
  if (JSON.stringify(input).length > 2_000_000) throw new Error("PROFILE_IMPORT_TOO_LARGE");
  let source = input.profile || input.template?.profile;
  if (!source && Array.isArray(input.templates)) {
    const active = input.templates.find((template) => template.id === input.activeTemplateId);
    if (!active) throw new Error("PROFILE_IMPORT_CHOOSE_TEMPLATE");
    source = active.profile;
  }
  if (!source && (Object.hasOwn(input, "awardRecords")
    || ResumeSchema.sections.some((section) => Object.hasOwn(input, section.key)))) source = input;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("PROFILE_IMPORT_FORMAT");
  const profile = normalizeAgentProfile(source);
  if (!hasAnyFilledAgentProfile(profile)) throw new Error("PROFILE_IMPORT_EMPTY");
  // Drop raw resume text, filenames, template names and all unknown export properties.
  const stored = { schemaVersion: 1, profile, importedAt: new Date().toISOString(),
    purpose: input.agentProfilePurpose === "synthetic_evaluation" ? "synthetic_evaluation" : "personal_use" };
  const ledger = ledgerFromProfile(stored);
  return { stored, summary: profileSummary(ledger, stored.importedAt) };
}

export function ledgerFromProfile(stored) {
  if (!stored?.profile) throw new Error("PROFILE_REQUIRED");
  const profile = normalizeAgentProfile(stored.profile);
  const facts = ResumeSchema.getCatalogWithValues(profile).filter((field) => field.hasValue
    && (!field.path.startsWith("customAnswers.") || field.path.endsWith(".answer") && profile.customAnswers[field.slotIndex]?.question?.trim())).map((field) => ({
    path: field.sectionKey === "customAnswers" ? `formAnswers.customAnswer${field.slotIndex}` : field.path,
    label: field.sectionKey === "customAnswers" ? profile.customAnswers[field.slotIndex].question.trim().slice(0, 180) : field.label,
    sectionKey: field.sectionKey === "customAnswers" ? "formAnswers" : field.sectionKey,
    entryIndex: field.sectionKey === "customAnswers" ? 0 : field.slotIndex ?? 0,
    candidates: [{ sourceId: "userImport", value: String(field.value), status: "user_confirmed" }],
  }));
  // Each editable property is an independent private fact. Bulk text and migration archives
  // are excluded so names and descriptions cannot accidentally share the same source.
  for (const sectionKey of ["awards", "competitions"]) {
    for (const [entryIndex, detail] of profile.awardRecords[sectionKey].entries()) {
      for (const [key, label] of [["name", sectionKey === "awards" ? "奖项名称" : "竞赛名称"],
        ["scope", "获奖级别（国家级、省级等）"], ["rank", "获奖等次（一等奖、二等奖等）"], ["date", "获奖时间（日期）"], ["description", "详细信息（描述）"]]) {
        if (detail[key]) facts.push({ path: `${sectionKey}.${entryIndex}.${key}`, sectionKey, entryIndex,
          label: `${sectionKey === "awards" ? "获奖" : "竞赛"}经历 ${entryIndex + 1} / ${label}`,
          candidates: [{ sourceId: "userImport", value: detail[key], status: "user_confirmed" }] });
      }
    }
  }
  const ledger = createProfileLedger({ schemaVersion: 1,
    sources: [{ id: "userImport", kind: "user_confirmation" }], facts });
  return withDateParts(withLatestRecordAnswers(withFormAnswers(withAwardLevels(withAwardSummaries(Object.freeze({ ...ledger, profileKind: stored.purpose === "synthetic_evaluation" ? "synthetic" : "user_import" }))))));
}

export function profileSummary(ledger, importedAt) {
  return { available: true, importedAt, purpose: ledger.profileKind === "synthetic" ? "synthetic_evaluation" : "personal_use", factCount: ledger.publicFacts.length,
    derivedFactCount: ledger.publicFacts.filter((fact) => fact.derivedFrom).length,
    sections: [...ResumeSchema.sections, { key: "awards", label: "获奖经历", type: "list" },
      { key: "competitions", label: "竞赛经历", type: "list" }].map((section) => {
      const facts = ledger.publicFacts.filter((fact) => fact.sectionKey === section.key);
      return { key: section.key, label: section.label, fieldCount: facts.length,
        recordCount: section.type === "list" ? new Set(facts.map((fact) => fact.entryIndex)).size : 0 };
    }).filter((section) => section.fieldCount > 0) };
}
