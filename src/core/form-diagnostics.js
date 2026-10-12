const labelSources = new Set(["container-label", "aria-labelledby", "label", "aria-label", "nearby-label", "sibling-caption", "placeholder", "missing"]);

/** Complete observation/coverage, deliberately excluding labels and values. */
export function formDiagnostic(context, plan) {
  const items = new Map((plan?.items || []).map((item) => [item.fieldId, item]));
  return { version: 1, snapshotId: context.snapshotId.slice(0, 12),
    fieldCount: context.page.fields.length, groupCount: context.page.groups.length,
    groups: context.page.groups.map((group) => {
      const section = plan?.sections.find((section) => section.groupId === group.id);
      return { groupId: group.id, source: group.source || "legacy", entryCount: group.entryCount,
        fieldCount: context.page.fields.filter((field) => field.groupId === group.id).length,
        hasAddCandidate: group.hasAddCandidate === true,
        ...(section ? { sectionKeys: section.sectionKeys, additionalEntries: section.additionalEntries,
          unresolvedEntries: section.unresolvedEntries || 0,
          ...(section.additionPolicy ? { additionPolicy: section.additionPolicy } : {}) } : {}) };
    }),
    fields: context.page.fields.map((field) => {
      const item = items.get(field.id);
      return { fieldId: field.id, groupId: field.groupId, entryIndex: field.entryIndex, kind: field.kind,
        labelSource: labelSources.has(field.labelSource) ? field.labelSource : "unknown",
        entrySource: field.entrySource || "legacy", ...(field.datePart ? { datePart: field.datePart } : {}),
        ...(field.dateRole ? { dateRole: field.dateRole } : {}),
        required: field.required, disabled: field.disabled, readOnly: field.readOnly,
        hasValue: field.hasValue, valueExcluded: field.valueExcluded,
        ...(item ? { status: item.status, sourcePath: item.sourcePath } : {}) };
    }), ...(plan ? { counts: plan.summary.counts } : {}) };
}
