import { z } from "zod";
import { AWARD_FIELD_ROLES, awardMappingCompatible, isAggregateAwardField } from "./award-levels.js";
import { planResponseDiagnosticSchema } from "./plan-response-diagnostics.js";
import { datePartCompatible } from "./date-parts.js";
import { recordProjectionCompatible } from "./record-projections.js";
import { languageMappingCompatible } from "./language-ability.js";
import { fieldMappingCompatible } from "./field-semantics.js";
import { resolveFillMode } from "./fill-mode.js";

const id = z.string().min(1).max(140);
const label = z.string().min(1).max(180);
const index = z.number().int().min(0).max(300);
const factSchema = z.object({
  path: id, label, sectionKey: id, entryIndex: index,
  status: z.enum(["verified", "user_confirmed", "conflicting", "unknown"]),
  evidenceCount: z.number().int().min(0).max(10),
  derivedFrom: z.array(id).min(1).max(200).optional(),
  derivation: z.enum(["copy", "latest_education", "latest_record", "bachelor_education", "date_year", "date_month", "date_day", "exam_level", "exam_score", "region_join", "award_level", "award_summary", "award_summary_join", "salary_monthly", "language_summary"]).optional(),
}).strict();
const pageSchema = z.object({
  origin: z.string().max(250), truncated: z.boolean(),
  groups: z.array(z.object({ id, label, entryCount: index, hasAddCandidate: z.boolean().optional(),
    source: z.enum(["explicit", "semantic", "heading-range", "fallback"]).optional() }).strict()).max(160),
  fields: z.array(z.object({
    id, groupId: id, entryIndex: index, label,
    labelSource: z.string().min(1).max(40),
    kind: z.enum(["text", "textarea", "number", "date", "select", "custom-select", "cascader",
      "autocomplete", "combobox", "radio", "checkbox", "credential", "file", "signature"]),
    required: z.boolean(), disabled: z.boolean(), readOnly: z.boolean(),
    hasValue: z.boolean().nullable(), valueExcluded: z.boolean(), optionLabel: label.nullable().optional(),
    entrySource: z.enum(["explicit", "repeated-siblings", "single"]).optional(),
    datePart: z.enum(["year", "month", "day"]).optional(),
    dateRole: z.enum(["start", "end"]).optional(),
    knownSourcePath: id.optional(),
  }).strict()).max(300),
}).strict();

export const planContextSchema = z.object({
  schemaVersion: z.literal(1), profileKind: z.enum(["synthetic", "user_import"]),
  fillMode: z.enum(["overwrite", "empty"]).default("overwrite"),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  page: pageSchema, profileCatalog: z.array(factSchema).max(1200),
}).strict();

export const mappingProposalSchema = z.object({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  groupMappings: z.array(z.object({ groupId: id, sectionKeys: z.array(id).min(1).max(10) }).strict()).max(160),
  fieldMappings: z.array(z.object({ fieldId: id, sourcePath: id,
    semanticRole: z.enum(AWARD_FIELD_ROLES).nullable().optional() }).strict()).max(300),
  unresolved: z.array(z.object({
    fieldId: id, reason: z.enum(["missing_profile", "ambiguous_mapping"]),
  }).strict()).max(300),
}).strict();

const planFailureSchema = z.object({
  code: z.enum(["PLAN_PROPOSAL_INVALID", "PLAN_UNKNOWN_REFERENCE", "PLAN_DUPLICATE_REFERENCE", "PLAN_RECORD_MISMATCH", "PLAN_MANUAL_TARGET", "PLAN_SEMANTIC_MISMATCH", "PLAN_MODEL_RESPONSE_INVALID"]),
  responseDiagnostic: planResponseDiagnosticSchema.optional(),
  diagnostic: z.object({
    violation: z.enum(["duplicate_group", "duplicate_field", "duplicate_unresolved", "section_in_multiple_groups", "field_both_mapped_and_unresolved", "source_in_multiple_fields", "field_section_unmapped", "record_out_of_order",
      "unknown_field", "unknown_source", "unknown_group", "unknown_section", "manual_target", "incompatible_semantics"]),
    groupIds: z.array(id).max(4).optional(), fieldIds: z.array(id).max(4).optional(),
    sourcePaths: z.array(id).max(4).optional(), sectionKeys: z.array(id).max(10).optional(),
    expectedRecords: z.array(id).max(4).optional(), proposedRecords: z.array(id).max(4).optional(),
    unknownReferenceCount: z.number().int().min(1).max(300).optional(),
  }).strict().optional(),
}).strict();
export const planFailureFeedbackSchema = planFailureSchema.extend({ previousFailures: z.array(planFailureSchema).max(24).optional() }).strict();
export const partialProposalSchema = z.object({
  proposal: mappingProposalSchema, exclusions: z.array(planFailureSchema).min(1).max(960),
  discardedFieldIds: z.array(id).max(300),
}).strict();

/** Error feedback contains only references already present in this observation. */
export function validatePlanFailureFeedback(context, input) {
  const parsed = planFailureFeedbackSchema.safeParse(input);
  if (!parsed.success) fail("PLAN_FEEDBACK_INVALID");
  const known = {
    groupIds: new Set(context.page.groups.map((group) => group.id)),
    fieldIds: new Set(context.page.fields.map((field) => field.id)),
    sourcePaths: new Set(context.profileCatalog.map((fact) => fact.path)),
    sectionKeys: new Set(context.profileCatalog.map((fact) => fact.sectionKey)),
    expectedRecords: new Set(context.profileCatalog.filter(isRepeatedFact).map(recordId)),
    proposedRecords: new Set(context.profileCatalog.filter(isRepeatedFact).map(recordId)),
  };
  for (const failure of [parsed.data, ...(parsed.data.previousFailures || [])]) {
    const d = failure.diagnostic;
    if (!d) continue;
    for (const [key, allowed] of Object.entries(known)) {
      if ((d[key] || []).some((reference) => !allowed.has(reference))) fail("PLAN_FEEDBACK_INVALID");
    }
  }
  return parsed.data;
}

export class FillPlanError extends Error {
  constructor(code, diagnostic) { super(code); this.name = "FillPlanError"; this.code = code; if (diagnostic) this.diagnostic = diagnostic; }
}
const fail = (code, diagnostic) => { throw new FillPlanError(code, diagnostic); };

async function fingerprint(page, profileCatalog, fillMode = "overwrite") {
  // Canonical schema order is shared by browser and service even when a new
  // optional observation property arrives in a different insertion order.
  const bytes = new TextEncoder().encode(JSON.stringify({ fillMode: resolveFillMode(fillMode), page: pageSchema.parse(page),
    profileCatalog: profileCatalog.map((fact) => factSchema.parse(fact)) }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uniqueMap(items, property) {
  const map = new Map(items.map((item) => [item[property], item]));
  if (map.size !== items.length) fail("PLAN_DUPLICATE_REFERENCE");
  return map;
}

export async function validatePlanContext(input) {
  const parsed = planContextSchema.safeParse(input);
  if (!parsed.success) fail("PLAN_CONTEXT_INVALID");
  const context = parsed.data;
  let origin;
  try { origin = new URL(context.page.origin); } catch { fail("PLAN_CONTEXT_INVALID"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== context.page.origin) fail("PLAN_CONTEXT_INVALID");
  const groups = uniqueMap(context.page.groups, "id");
  uniqueMap(context.page.fields, "id");
  uniqueMap(context.profileCatalog, "path");
  const catalogPaths = new Set(context.profileCatalog.map((fact) => fact.path));
  for (const fact of context.profileCatalog) if (fact.derivedFrom?.some((path) => path === fact.path || !catalogPaths.has(path))) fail("PLAN_CONTEXT_INVALID");
  for (const field of context.page.fields) {
    if (!groups.has(field.groupId) || field.entryIndex >= groups.get(field.groupId).entryCount) fail("PLAN_CONTEXT_INVALID");
    if (field.knownSourcePath && !catalogPaths.has(field.knownSourcePath)) fail("PLAN_CONTEXT_INVALID");
  }
  if (context.snapshotId !== await fingerprint(context.page, context.profileCatalog, context.fillMode)) fail("PLAN_SNAPSHOT_INVALID");
  return context;
}

/** Whitelist projection: no values, DOM selectors, filenames, URL paths or buttons. */
export async function createPlanContext(report, ledger, { verifiedMappings = [], fillMode = "overwrite" } = {}) {
  fillMode = resolveFillMode(fillMode);
  if (report?.mode !== "read-only") fail("PLAN_CONTEXT_INVALID");
  const fieldGroups = new Set(report.fields.map((field) => field.groupId));
  const addGroups = new Set((report.controls || []).filter((control) => control.intent === "add-candidate")
    .map((control) => control.groupId));
  const known = new Map(verifiedMappings.map(({ fieldId, sourcePath }) => [fieldId, sourcePath]));
  const page = {
    origin: report.origin, truncated: report.summary.truncated,
    // Temporary overlays and unrelated buttons can create empty scan groups.
    // They do not supply a fill target and must not invalidate model latency.
    // Keep empty record sections with an add control: they are actionable.
    groups: report.groups.filter((group) => fieldGroups.has(group.id) || addGroups.has(group.id))
      .map(({ id: groupId, label: groupLabel, entryCount, source }) => ({ id: groupId, label: groupLabel, entryCount,
      ...(source ? { source } : {}),
      hasAddCandidate: addGroups.has(groupId) })),
    fields: report.fields.map((field) => ({
      id: field.id, groupId: field.groupId, entryIndex: field.entryIndex, label: field.label,
      labelSource: field.labelSource, kind: field.kind, required: field.required,
      disabled: field.disabled, readOnly: field.readOnly, hasValue: field.hasValue, valueExcluded: field.valueExcluded,
      ...(field.optionLabel ? { optionLabel: field.optionLabel } : {}),
      ...(field.entrySource ? { entrySource: field.entrySource } : {}),
      ...(field.datePart ? { datePart: field.datePart } : {}),
      ...(field.dateRole ? { dateRole: field.dateRole } : {}),
      ...(known.has(field.id) ? { knownSourcePath: known.get(field.id) } : {}),
    })),
  };
  const profileCatalog = ledger.publicFacts.map((fact) => ({ ...fact }));
  return validatePlanContext({
    schemaVersion: 1, profileKind: ledger.profileKind || "synthetic", fillMode, page, profileCatalog,
    snapshotId: await fingerprint(page, profileCatalog, fillMode),
  });
}

const recordId = (fact) => `${fact.sectionKey}.${fact.entryIndex}`;
const isRepeatedFact = (fact) => /^\d+$/.test(fact.path.split(".")[1]);
function recordsFor(sectionKeys, facts) {
  return sectionKeys.flatMap((sectionKey) => [...new Set(facts.filter((fact) => fact.sectionKey === sectionKey && isRepeatedFact(fact))
    .map((fact) => fact.entryIndex))].sort((a, b) => a - b).map((entryIndex) => `${sectionKey}.${entryIndex}`));
}
function fieldPolicy(field, group, fillMode = "overwrite") {
  if (["credential", "signature", "file", "checkbox"].includes(field.kind)
    || manualGroup(group)) return "manual_only";
  if (field.knownSourcePath || field.disabled || fillMode === "empty" && field.hasValue === true || (field.readOnly && ["text", "textarea", "number"].includes(field.kind))) return "protected";
  if (field.labelSource === "missing") return "label_missing";
  return null;
}

function manualGroup(group) {
  return /有关声明|声明|签署|同意|declaration|consent|signature/i.test(group.label);
}

function scalarQuestion(label) {
  const value = String(label || "").replace(/[\s＊*（）()/:：]/gu, "").toLowerCase();
  const meanings = [
    [/期望.*城市|意向.*城市|希望.*城市|(?:preferred|desired|expected|intended).*(?:city|location)/i, "expected_city"],
    [/期望.*薪|希望.*薪|(?:expected|desired|salary).*(?:salary|expectation)/i, "expected_salary"],
    [/邮箱|电子邮件|e-?mail/i, "email"], [/手机(?:号码|号)?|手机号|mobile|phone/i, "phone"],
    [/了解到.*渠道|招聘.*渠道|信息.*来源|discovery.*channel/i, "discovery_channel"],
  ];
  return meanings.find(([pattern]) => pattern.test(value))?.[1] || value;
}

function reusableScalarQuestion(previous, field, fact) {
  const meaning = scalarQuestion(field.label);
  return previous.groupId !== field.groupId && meaning === scalarQuestion(previous.label)
    && meaning === scalarQuestion(fact.label);
}

export function sourceClaimCompatible(context, field, fact) {
  const reusable = !isRepeatedFact(fact) && fact.derivation !== "award_summary_join"
    && !/^formAnswers\.(?:awards|competitions|awardsAndCompetitions)Summary$/.test(fact.path);
  return context.page.fields.filter((other) => other.id !== field.id && other.knownSourcePath === fact.path)
    .every((other) => reusable && reusableScalarQuestion(other, field, fact));
}

/** Validate references and record order independently of the model; no executable actions. */
export async function buildFillPlan(input, rawProposal) {
  const context = await validatePlanContext(input);
  const parsed = mappingProposalSchema.safeParse(rawProposal);
  if (!parsed.success) fail("PLAN_PROPOSAL_INVALID");
  const proposal = parsed.data;
  if (proposal.snapshotId !== context.snapshotId) fail("PLAN_SNAPSHOT_INVALID");
  const groups = uniqueMap(context.page.groups, "id");
  const fields = uniqueMap(context.page.fields, "id");
  const facts = uniqueMap(context.profileCatalog, "path");
  for (const [items, key, known, violation] of [[proposal.groupMappings, "groupId", groups, "duplicate_group"],
    [proposal.fieldMappings, "fieldId", fields, "duplicate_field"], [proposal.unresolved, "fieldId", fields, "duplicate_unresolved"]]) {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item[key]) && known.has(item[key])) fail("PLAN_DUPLICATE_REFERENCE", {
        violation, [key === "groupId" ? "groupIds" : "fieldIds"]: [item[key]],
      });
      seen.add(item[key]);
    }
  }
  const groupMappings = uniqueMap(proposal.groupMappings, "groupId");
  const fieldMappings = uniqueMap(proposal.fieldMappings, "fieldId");
  const semanticFields = context.page.fields.map((field) => ({ ...field,
    ...(fieldMappings.get(field.id)?.semanticRole ? { semanticRole: fieldMappings.get(field.id).semanticRole } : {}) }));
  const unresolved = uniqueMap(proposal.unresolved, "fieldId");
  // Keep the original duplicate-reference gate before applying user routing.
  // Routing omitted sections must not hide an explicit conflicting proposal.
  const declaredSections = new Map();
  for (const mapping of proposal.groupMappings) {
    if (!groups.has(mapping.groupId)) continue;
    for (const sectionKey of mapping.sectionKeys) {
      if (!context.profileCatalog.some((fact) => fact.sectionKey === sectionKey)) continue;
      const previous = declaredSections.get(sectionKey);
      const repeated = context.profileCatalog.some((fact) => fact.sectionKey === sectionKey && isRepeatedFact(fact));
      if (previous && (repeated || previous === mapping.groupId)) fail("PLAN_DUPLICATE_REFERENCE", {
        violation: "section_in_multiple_groups", groupIds: [previous, mapping.groupId], sectionKeys: [sectionKey],
      });
      declaredSections.set(sectionKey, mapping.groupId);
    }
  }
  // User requirement: award-only forms receive the complete award + competition
  // record pool. Missing a group declaration must not silently discard records.
  const solelyAwardRecords = (group) => !(groupMappings.get(group.id)?.sectionKeys || []).some((key) =>
    !["awards", "competitions"].includes(key) && context.profileCatalog.some((fact) => fact.sectionKey === key && isRepeatedFact(fact)));
  const awardGroups = context.page.groups.filter((group) => (/获奖|奖项|荣誉|awards?/i.test(group.label)
    || solelyAwardRecords(group) && !/竞赛|比赛|competitions?/i.test(group.label) && groupMappings.get(group.id)?.sectionKeys.includes("awards"))
    && context.page.fields.some((field) => field.groupId === group.id && fieldPolicy(field, group, context.fillMode) !== "manual_only"));
  const competitionGroups = context.page.groups.filter((group) => (/竞赛|比赛|competitions?/i.test(group.label)
    || solelyAwardRecords(group) && groupMappings.get(group.id)?.sectionKeys.includes("competitions"))
    && !awardGroups.some((awardGroup) => awardGroup.id === group.id)
    && context.page.fields.some((field) => field.groupId === group.id && fieldPolicy(field, group, context.fillMode) !== "manual_only"));
  const splitAwardRouting = awardGroups.length === 1 && competitionGroups.length === 1
    && context.profileCatalog.some((fact) => fact.sectionKey === "awards") && context.profileCatalog.some((fact) => fact.sectionKey === "competitions");
  if (splitAwardRouting) {
    for (const [groupId, sectionKey] of [[awardGroups[0].id, "awards"], [competitionGroups[0].id, "competitions"]]) {
      groupMappings.set(groupId, { groupId, sectionKeys: [sectionKey,
        ...(groupMappings.get(groupId)?.sectionKeys || []).filter((key) => !["awards", "competitions"].includes(key))] });
    }
  }
  if (awardGroups.length === 1 && competitionGroups.length === 0
    && context.profileCatalog.some((fact) => fact.sectionKey === "awards")
    && context.profileCatalog.some((fact) => fact.sectionKey === "competitions")) {
    const groupId = awardGroups[0].id;
    const existing = groupMappings.get(groupId);
    groupMappings.set(groupId, { groupId, sectionKeys: ["awards", "competitions",
      ...(existing?.sectionKeys || []).filter((key) => !["awards", "competitions"].includes(key))] });
  }
  // A validated field reference already names its source section. Complete this
  // redundant declaration from known references, then validate the resulting
  // record pools normally. No field semantics or factual values are inferred.
  for (const mapping of fieldMappings.values()) {
    const field = fields.get(mapping.fieldId);
    const fact = facts.get(mapping.sourcePath);
    if (!field || !fact) fail("PLAN_UNKNOWN_REFERENCE", {
      violation: !field ? "unknown_field" : "unknown_source", unknownReferenceCount: 1,
      ...(field ? { fieldIds: [field.id] } : {}), ...(fact ? { sourcePaths: [fact.path] } : {}),
    });
    if (!datePartCompatible(field, fact) || !recordProjectionCompatible(context, field, fact)
      || !languageMappingCompatible(field, groups.get(field.groupId).label, fact)
      || !awardMappingCompatible(field, groups.get(field.groupId).label, fact.path, semanticFields, mapping.semanticRole)) fail("PLAN_SEMANTIC_MISMATCH", {
      violation: "incompatible_semantics", fieldIds: [field.id], sourcePaths: [fact.path],
    });
    if (splitAwardRouting && (fact.sectionKey === "competitions" && field.groupId === awardGroups[0].id
      || fact.sectionKey === "awards" && field.groupId === competitionGroups[0].id)) fail("PLAN_SEMANTIC_MISMATCH", {
      violation: "incompatible_semantics", fieldIds: [field.id], sourcePaths: [fact.path],
    });
    if (fact.path === "jobPreferences.discoveryChannel" && /其他.*(备注|说明)|备注.*其他/.test(field.label)) fail("PLAN_SEMANTIC_MISMATCH", {
      violation: "incompatible_semantics", fieldIds: [field.id], sourcePaths: [fact.path],
    });
    if (/兴趣|爱好|hobb(?:y|ies)/i.test(field.label) && fact.path === "personal.summary") fail("PLAN_SEMANTIC_MISMATCH", {
      violation: "incompatible_semantics", fieldIds: [field.id], sourcePaths: [fact.path],
    });
    const group = groupMappings.get(field.groupId);
    if (!group) groupMappings.set(field.groupId, { groupId: field.groupId, sectionKeys: [fact.sectionKey] });
    else if (!group.sectionKeys.includes(fact.sectionKey)) {
      if (group.sectionKeys.length >= 10) fail("PLAN_PROPOSAL_INVALID");
      group.sectionKeys.push(fact.sectionKey);
    }
  }
  const usedSections = new Map();
  const recordPools = new Map();
  const sectionPools = new Map();
  for (const mapping of groupMappings.values()) {
    if (!groups.has(mapping.groupId)) fail("PLAN_UNKNOWN_REFERENCE", { violation: "unknown_group", unknownReferenceCount: 1 });
    const group = groups.get(mapping.groupId), groupFields = context.page.fields.filter((field) => field.groupId === group.id);
    const emptyAddSection = groupFields.length === 0 && group.hasAddCandidate === true && !manualGroup(group);
    if (!emptyAddSection && !groupFields.some((field) => fieldPolicy(field, group, context.fillMode) !== "manual_only")) {
      fail("PLAN_MANUAL_TARGET", { violation: "manual_target", groupIds: [mapping.groupId] });
    }
    for (const sectionKey of mapping.sectionKeys) {
      if (!context.profileCatalog.some((fact) => fact.sectionKey === sectionKey)) fail("PLAN_UNKNOWN_REFERENCE", {
        violation: "unknown_section", groupIds: [mapping.groupId], unknownReferenceCount: 1,
      });
      const repeatedSection = context.profileCatalog.some((fact) => fact.sectionKey === sectionKey && isRepeatedFact(fact));
      if (usedSections.has(sectionKey) && (repeatedSection || usedSections.get(sectionKey) === mapping.groupId)) fail("PLAN_DUPLICATE_REFERENCE", { violation: "section_in_multiple_groups",
        groupIds: [usedSections.get(sectionKey), mapping.groupId], sectionKeys: [sectionKey] });
      usedSections.set(sectionKey, mapping.groupId);
    }
    const aggregated = [...fieldMappings.values()].filter((item) => fields.get(item.fieldId)?.groupId === mapping.groupId
      && /^formAnswers\.(awardsSummary|competitionsSummary|awardsAndCompetitionsSummary)$/.test(item.sourcePath));
    if (aggregated.length) {
      const path = aggregated[0].sourcePath;
      const isAwardGroup = awardGroups.some((group) => group.id === mapping.groupId);
      const isCompetitionGroup = competitionGroups.some((group) => group.id === mapping.groupId);
      const hasCompetitions = context.profileCatalog.some((fact) => fact.sectionKey === "competitions");
      if (aggregated.length !== 1 || !isAggregateAwardField(context, fields.get(aggregated[0].fieldId))
        || [...fieldMappings.values()].some((item) => fields.get(item.fieldId)?.groupId === mapping.groupId
        && /^(awards|competitions)\.\d+\./.test(item.sourcePath))
        || isCompetitionGroup && path !== "formAnswers.competitionsSummary"
        || isAwardGroup && path === "formAnswers.competitionsSummary"
        || isAwardGroup && competitionGroups.length && path === "formAnswers.awardsAndCompetitionsSummary"
        || isAwardGroup && !competitionGroups.length && hasCompetitions && path !== "formAnswers.awardsAndCompetitionsSummary") {
        fail("PLAN_SEMANTIC_MISMATCH", { violation: "incompatible_semantics",
          fieldIds: [aggregated[0].fieldId], sourcePaths: [path] });
      }
    }
    const repeated = aggregated.length ? [] : recordsFor(mapping.sectionKeys, context.profileCatalog);
    const repeatedKeys = mapping.sectionKeys.filter((key) => context.profileCatalog.some((fact) => fact.sectionKey === key && isRepeatedFact(fact)));
    const mergedAwards = repeatedKeys.length === 2 && repeatedKeys.every((key) => ["awards", "competitions"].includes(key))
      && awardGroups.some((group) => group.id === mapping.groupId);
    // Entry indices are local to each experience type. Unrelated experiences
    // in a coarse container must not be concatenated into one record pool.
    if (!aggregated.length && repeatedKeys.length > 1 && !mergedAwards) {
      sectionPools.set(mapping.groupId, new Map(repeatedKeys.map((key) => [key, recordsFor([key], context.profileCatalog)])));
      recordPools.set(mapping.groupId, null);
    } else recordPools.set(mapping.groupId, repeated.length ? repeated : null);
  }
  // Reservations come only from this job's verified writes. A new planning
  // round must not allocate the same record property to another question just
  // because its original owner is now omitted from the pending-field view.
  const usedPaths = new Map();
  for (const field of context.page.fields.filter((item) => item.knownSourcePath)) {
    usedPaths.set(field.knownSourcePath, [...(usedPaths.get(field.knownSourcePath) || []), field]);
  }
  for (const mapping of fieldMappings.values()) {
    const field = fields.get(mapping.fieldId);
    const fact = facts.get(mapping.sourcePath);
    if (!field || !fact) fail("PLAN_UNKNOWN_REFERENCE");
    if (unresolved.has(field.id)) fail("PLAN_DUPLICATE_REFERENCE", { violation: "field_both_mapped_and_unresolved", fieldIds: [field.id] });
    const previousFields = usedPaths.get(fact.path) || [];
    // One scalar answer can be asked in distinct logical sections (e.g. desired
    // city in application information and job preferences). Indexed records and
    // aggregate record summaries keep the existing single-owner requirement.
    const reusable = !isRepeatedFact(fact) && fact.derivation !== "award_summary_join"
      && !/^formAnswers\.(?:awards|competitions|awardsAndCompetitions)Summary$/.test(fact.path);
    const duplicate = previousFields.find((previous) => previous.id !== field.id && (!reusable || !reusableScalarQuestion(previous, field, fact)));
    if (duplicate) fail("PLAN_DUPLICATE_REFERENCE", { violation: "source_in_multiple_fields",
      fieldIds: [duplicate.id, field.id], sourcePaths: [fact.path] });
    if (!fieldMappingCompatible(field, fact, groups.get(field.groupId)?.label)) fail("PLAN_SEMANTIC_MISMATCH", {
      violation: "incompatible_semantics", fieldIds: [field.id], sourcePaths: [fact.path],
    });
    usedPaths.set(fact.path, [...previousFields, field]);
    if (fieldPolicy(field, groups.get(field.groupId), context.fillMode) === "manual_only") fail("PLAN_MANUAL_TARGET", { violation: "manual_target", fieldIds: [field.id] });
    const sectionKeys = groupMappings.get(field.groupId)?.sectionKeys || [];
    if (!sectionKeys.includes(fact.sectionKey)) fail("PLAN_RECORD_MISMATCH", { violation: "field_section_unmapped",
      groupIds: [field.groupId], fieldIds: [field.id], sourcePaths: [fact.path], sectionKeys });
    const pool = sectionPools.get(field.groupId)?.get(fact.sectionKey) || recordPools.get(field.groupId);
    if (isRepeatedFact(fact) && pool?.[field.entryIndex] !== recordId(fact)) fail("PLAN_RECORD_MISMATCH", {
      violation: "record_out_of_order", groupIds: [field.groupId], fieldIds: [field.id], sourcePaths: [fact.path],
      expectedRecords: [pool?.[field.entryIndex]].filter(Boolean), proposedRecords: [recordId(fact)],
    });
  }
  for (const fieldId of unresolved.keys()) if (!fields.has(fieldId)) fail("PLAN_UNKNOWN_REFERENCE", { violation: "unknown_field", unknownReferenceCount: 1 });
  const items = context.page.fields.map((field) => {
    const mapping = fieldMappings.get(field.id);
    const source = mapping ? facts.get(mapping.sourcePath) : null;
    let status = fieldPolicy(field, groups.get(field.groupId), context.fillMode);
    if (!status) {
      status = !source ? unresolved.get(field.id)?.reason || "unmapped"
        : source.status === "conflicting" ? "source_conflict"
        : !["verified", "user_confirmed"].includes(source.status) ? "source_unverified"
        : field.hasValue === null || field.valueExcluded ? "needs_review"
        : !["text", "textarea", "number"].includes(field.kind) ? "needs_control_adapter" : "mapped";
    }
    return { fieldId: field.id, groupId: field.groupId, entryIndex: field.entryIndex,
      ...(mapping?.semanticRole ? { semanticRole: mapping.semanticRole } : {}),
      label: field.label, kind: field.kind, required: field.required, status,
      sourcePath: source?.path || null, sourceLabel: source?.label || null,
      sourceStatus: source?.status || null, evidenceCount: source?.evidenceCount || 0, executable: false };
  });
  const sections = context.page.groups.map((group) => {
    const pool = recordPools.get(group.id) || [];
    const localPools = sectionPools.get(group.id);
    const unresolvedEntries = localPools ? [...localPools.values()].reduce((sum, records) => sum + Math.max(0, records.length - group.entryCount), 0) : 0;
    return { groupId: group.id, label: group.label, sectionKeys: groupMappings.get(group.id)?.sectionKeys || [],
      observedEntries: group.entryCount, profileEntries: localPools ? [...localPools.values()].reduce((sum, records) => sum + records.length, 0)
        : pool.length || (groupMappings.has(group.id) ? 1 : 0),
      additionalEntries: localPools ? 0 : Math.max(0, pool.length - group.entryCount),
      ...(localPools ? { unresolvedEntries, additionPolicy: "section_boundary_unresolved" } : {}), executable: false };
  });
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return {
    schemaVersion: 1, mode: "read-only-plan", profileKind: context.profileKind, snapshotId: context.snapshotId,
    generatedAt: new Date().toISOString(), executable: false,
    summary: { fieldCount: items.length, mappedCount: counts.mapped || 0,
      additionalEntries: sections.reduce((sum, section) => sum + section.additionalEntries, 0), counts,
      unresolvedEntries: sections.reduce((sum, section) => sum + (section.unresolvedEntries || 0), 0),
      truncated: context.page.truncated },
    sections, items,
    unplacedSections: [...new Set(context.profileCatalog.map((fact) => fact.sectionKey))]
      .filter((sectionKey) => !usedSections.has(sectionKey)),
  };
}

/** Remove disputed references; never select a winner, infer a new path, or change record order. */
export async function createPartialProposal(input, rawProposal) {
  const context = await validatePlanContext(input);
  const parsed = mappingProposalSchema.safeParse(rawProposal);
  if (!parsed.success) fail("PLAN_PROPOSAL_INVALID");
  if (parsed.data.snapshotId !== context.snapshotId) fail("PLAN_SNAPSHOT_INVALID");
  const proposal = structuredClone(parsed.data);
  const fields = new Map(context.page.fields.map((field) => [field.id, field]));
  const facts = new Map(context.profileCatalog.map((fact) => [fact.path, fact]));
  const groups = new Map(context.page.groups.map((group) => [group.id, group]));
  const knownSections = new Set(context.profileCatalog.map((fact) => fact.sectionKey));
  const discarded = new Set(), exclusions = [];
  const removeFields = (predicate) => {
    proposal.fieldMappings = proposal.fieldMappings.filter((mapping) => {
      if (!predicate(mapping)) return true;
      if (fields.has(mapping.fieldId)) discarded.add(mapping.fieldId);
      return false;
    });
  };
  const removeGroups = (groupIds) => {
    const excluded = new Set(groupIds);
    removeFields((mapping) => excluded.has(fields.get(mapping.fieldId)?.groupId));
    proposal.groupMappings = proposal.groupMappings.filter((mapping) => !excluded.has(mapping.groupId));
  };
  for (let round = 0; round < 960; round += 1) {
    try {
      await buildFillPlan(context, proposal);
      if (!exclusions.length) return null;
      for (const fieldId of discarded) {
        proposal.unresolved = proposal.unresolved.filter((item) => item.fieldId !== fieldId);
        proposal.unresolved.push({ fieldId, reason: "ambiguous_mapping" });
      }
      await buildFillPlan(context, proposal);
      return partialProposalSchema.parse({ proposal, exclusions, discardedFieldIds: [...discarded] });
    } catch (error) {
      if (!error?.diagnostic) throw error;
      const feedback = validatePlanFailureFeedback(context, { code: error.code, diagnostic: error.diagnostic });
      const before = JSON.stringify(proposal);
      const d = feedback.diagnostic;
      if (d.violation === "unknown_field") {
        removeFields((mapping) => !fields.has(mapping.fieldId));
        proposal.unresolved = proposal.unresolved.filter((item) => fields.has(item.fieldId));
      } else if (d.violation === "unknown_source") removeFields((mapping) => !facts.has(mapping.sourcePath));
      else if (d.violation === "unknown_group") proposal.groupMappings = proposal.groupMappings.filter((mapping) => groups.has(mapping.groupId));
      else if (d.violation === "unknown_section") removeGroups(proposal.groupMappings
        .filter((mapping) => mapping.sectionKeys.some((sectionKey) => !knownSections.has(sectionKey))).map((mapping) => mapping.groupId));
      else if (d.violation === "section_in_multiple_groups") {
        const sectionKeys = new Set(d.sectionKeys);
        removeFields((mapping) => sectionKeys.has(facts.get(mapping.sourcePath)?.sectionKey));
        proposal.groupMappings = proposal.groupMappings.map((mapping) => ({ ...mapping,
          sectionKeys: mapping.sectionKeys.filter((sectionKey) => !sectionKeys.has(sectionKey)) })).filter((mapping) => mapping.sectionKeys.length);
      } else if (d.violation === "duplicate_group") removeGroups(d.groupIds);
      else if (d.violation === "source_in_multiple_fields") removeFields((mapping) => d.sourcePaths.includes(mapping.sourcePath));
      else if (d.violation === "record_out_of_order") {
        const target = fields.get(d.fieldIds[0]), fact = facts.get(d.sourcePaths[0]);
        removeFields((mapping) => fields.get(mapping.fieldId)?.groupId === target.groupId
          && fields.get(mapping.fieldId)?.entryIndex === target.entryIndex && facts.get(mapping.sourcePath)?.sectionKey === fact.sectionKey);
      } else {
        if (d.groupIds?.length) removeGroups(d.groupIds);
        if (d.fieldIds?.length) {
          removeFields((mapping) => d.fieldIds.includes(mapping.fieldId));
          proposal.unresolved = proposal.unresolved.filter((item) => !d.fieldIds.includes(item.fieldId));
          for (const fieldId of d.fieldIds) { discarded.add(fieldId); proposal.unresolved.push({ fieldId, reason: "ambiguous_mapping" }); }
        }
      }
      if (JSON.stringify(proposal) === before) throw error;
      exclusions.push(feedback);
    }
  }
  fail("PLAN_PROPOSAL_INVALID");
}

/** Validate the fallback again on the caller side, including every diagnostic reference. */
export async function validatePartialProposal(context, input) {
  const parsed = partialProposalSchema.safeParse(input);
  if (!parsed.success) fail("PLAN_PROPOSAL_INVALID");
  const partial = parsed.data;
  for (const feedback of partial.exclusions) validatePlanFailureFeedback(context, feedback);
  const plan = await buildFillPlan(context, partial.proposal);
  if (new Set(partial.discardedFieldIds).size !== partial.discardedFieldIds.length
    || partial.discardedFieldIds.some((fieldId) => !plan.items.some((item) => item.fieldId === fieldId && !item.sourcePath)
      || !partial.proposal.unresolved.some((item) => item.fieldId === fieldId && item.reason === "ambiguous_mapping"))) fail("PLAN_PROPOSAL_INVALID");
  return { partial, plan };
}

/** A page may change during model latency; a fresh observation gates publication. */
export async function generateReadOnlyPlan({ scan, ledger, planner, assertSelection = async () => {}, onPhase = () => {}, fillMode = "overwrite" }) {
  onPhase("observe");
  try { await assertSelection(); } catch { fail("PLAN_PAGE_CHANGED"); }
  const before = await scan();
  const context = await createPlanContext(before, ledger, { fillMode });
  onPhase("model");
  const proposal = await planner.planMappings(context);
  onPhase("validate");
  const plan = await buildFillPlan(context, proposal);
  onPhase("reobserve");
  try { await assertSelection(); } catch { fail("PLAN_PAGE_CHANGED"); }
  const after = await scan();
  const current = await createPlanContext(after, ledger, { fillMode });
  if (current.snapshotId !== context.snapshotId) fail("PLAN_PAGE_CHANGED");
  return { report: after, plan };
}
