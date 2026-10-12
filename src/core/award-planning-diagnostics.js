import { awardFieldRole, awardSourceRole } from "./award-levels.js";
import { mappingProposalSchema } from "./fill-plan.js";

const awardGroup = (label) => /获奖|奖项|荣誉|竞赛|比赛|awards?|competitions?/i.test(label);
const knownLabelSources = new Set(["container-label", "aria-labelledby", "label", "aria-label", "nearby-label", "sibling-caption", "placeholder", "missing"]);

/** Record types, known references and presence flags; never labels or profile values. */
export function awardPlanningDiagnostic(context, { proposal, failures = [], discardedFieldIds = [], plan } = {}) {
  const knownPaths = new Set(context.profileCatalog.map((fact) => fact.path));
  const knownFields = new Map(context.page.fields.map((field) => [field.id, field]));
  const parsed = mappingProposalSchema.safeParse(proposal);
  const mappings = parsed.success ? parsed.data.fieldMappings : [];
  const groups = new Set(context.page.groups.filter((group) => awardGroup(group.label)).map((group) => group.id));
  for (const item of [...mappings, ...(plan?.items || [])]) {
    if (knownPaths.has(item.sourcePath) && awardSourceRole(item.sourcePath) && knownFields.has(item.fieldId)) {
      groups.add(knownFields.get(item.fieldId).groupId);
    }
  }
  for (const failure of failures) {
    if (!(failure.diagnostic?.sourcePaths || []).some((path) => knownPaths.has(path) && awardSourceRole(path))) continue;
    for (const fieldId of failure.diagnostic?.fieldIds || []) {
      if (knownFields.has(fieldId)) groups.add(knownFields.get(fieldId).groupId);
    }
  }
  const fields = context.page.fields.filter((field) => groups.has(field.groupId) || awardGroup(field.label));
  if (!fields.length) return null;
  const references = new Map(fields.map((field) => [field.id, new Set()]));
  const proposedRoles = new Map(mappings.map((mapping) => [mapping.fieldId, mapping.semanticRole]));
  for (const mapping of mappings) {
    if (references.has(mapping.fieldId) && knownPaths.has(mapping.sourcePath)) references.get(mapping.fieldId).add(mapping.sourcePath);
  }
  // Single-source failures can reconstruct disputed references even when the model
  // proposal stayed on the local server. Multi-source failures are not guessed.
  for (const failure of failures) {
    const paths = (failure.diagnostic?.sourcePaths || []).filter((path) => knownPaths.has(path));
    if (paths.length !== 1) continue;
    for (const fieldId of failure.diagnostic?.fieldIds || []) references.get(fieldId)?.add(paths[0]);
  }
  const records = new Map();
  for (const fact of context.profileCatalog) {
    const match = /^(awards|competitions)\.\d+\.(name|scope|rank|description|level|summary)$/.exec(fact.path);
    if (!match) continue;
    const record = fact.path.slice(0, fact.path.lastIndexOf("."));
    if (!records.has(record)) records.set(record, { record, availableProperties: [], verifiedProperties: [] });
    records.get(record).availableProperties.push(match[2]);
    if (["verified", "user_confirmed"].includes(fact.status)) records.get(record).verifiedProperties.push(match[2]);
  }
  const discarded = new Set(discardedFieldIds);
  const items = new Map((plan?.items || []).map((item) => [item.fieldId, item]));
  return { version: 2, records: [...records.values()], fields: fields.map((field) => {
    const item = items.get(field.id);
    const nameFields = fields.filter((peer) => peer.groupId === field.groupId && peer.entryIndex === field.entryIndex
      && !peer.disabled && awardFieldRole(peer) === "name").map((peer) => peer.id);
    return { fieldId: field.id, groupId: field.groupId, entryIndex: field.entryIndex, kind: field.kind,
      labelSource: knownLabelSources.has(field.labelSource) ? field.labelSource : "unknown",
      semanticRole: awardFieldRole(field), proposedSemanticRole: proposedRoles.get(field.id) || null,
      resolvedSemanticRole: item?.semanticRole || awardFieldRole(field, proposedRoles.get(field.id)),
      recognizedNameFieldIds: nameFields,
      hasValue: field.hasValue, valueExcluded: field.valueExcluded, disabled: field.disabled, readOnly: field.readOnly,
      proposedSourcePaths: [...references.get(field.id)],
      proposedSourceRoles: [...references.get(field.id)].map(awardSourceRole),
      ...(item ? { planStatus: item.status, plannedSourcePath: knownPaths.has(item.sourcePath) ? item.sourcePath : null } : {}),
      discarded: discarded.has(field.id) };
  }) };
}
