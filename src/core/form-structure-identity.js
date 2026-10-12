// A same-document node refresh may reuse a validated plan only if its complete
// semantic topology is unchanged. Presence is dynamic; values are never read.
const keys = {
  groups: ["id", "label", "source", "entryCount", "fieldCount"],
  fields: ["id", "groupId", "entryIndex", "label", "labelSource", "entrySource", "kind", "datePart", "dateRole", "required", "disabled", "readOnly", "valueExcluded", "optionLabel"],
  controls: ["id", "groupId", "label", "tag", "type", "intent", "disabled"],
  omitted: ["omittedFieldCount", "omittedControlCount", "frameCount", "shadowHostCount"],
};
const valid = (report) => report && Array.isArray(report.fields) && Array.isArray(report.groups);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Names of changed properties only: no URLs, labels, field values or option text. */
export function formStructureDifference(before, after) {
  const changes = [];
  const counts = (report) => Object.fromEntries(["groups", "fields", "controls"].map((area) => [area, report?.[area]?.length || 0]));
  if (!valid(before) || !valid(after)) return { before: counts(before), after: counts(after), changedCount: 1, changes: [{ area: "report", properties: ["missing"] }] };
  if (!equal(before.url, after.url)) changes.push({ area: "report", properties: ["url"] });
  for (const area of ["groups", "fields", "controls"]) {
    const old = before[area] || [], next = after[area] || [];
    for (let index = 0; index < Math.max(old.length, next.length); index++) {
      const properties = !old[index] || !next[index] ? ["presence"]
        : keys[area].filter((key) => !equal(old[index][key], next[index][key]));
      if (properties.length) {
        const id = next[index]?.id || old[index]?.id;
        changes.push({ area, index, ...(/^(field|group|control)-\d+$/.test(id || "") ? { id } : {}), properties });
      }
    }
  }
  const omitted = keys.omitted.filter((key) => !equal(before.summary?.[key], after.summary?.[key]));
  if (omitted.length) changes.push({ area: "omitted", properties: omitted });
  return { before: counts(before), after: counts(after), changedCount: changes.length, changes: changes.slice(0, 40) };
}

export function sameFormStructure(before, after) {
  return formStructureDifference(before, after).changedCount === 0;
}

/** Fill bindings depend on fields and their record groups. Other page buttons
 * and groups containing no fields do not address any fill target. Adds always
 * use a fresh observation and their own control checks. */
export function sameFillTargets(before, after) {
  if (!valid(before) || !valid(after)) return false;
  const targets = (report) => {
    const referenced = new Set(report.fields.map((field) => field.groupId));
    return { ...report, groups: report.groups.filter((group) => referenced.has(group.id)), controls: [],
      summary: { ...report.summary, omittedControlCount: 0 } };
  };
  return sameFormStructure(targets(before), targets(after));
}

/** Logical identities for receipts and audit references, never permissions to
 * reuse an old plan. A new layout must still receive a newly validated plan. */
export function fillTargetIdentity(report, field) {
  const group = report?.groups.find((group) => group.id === field?.groupId);
  if (!group || !field || field.labelSource === "missing" || !field.label) return null;
  return JSON.stringify([group.label, field.entryIndex, field.label, field.kind,
    field.datePart ?? null, field.dateRole ?? null, field.required, field.disabled,
    field.readOnly, field.valueExcluded, field.optionLabel ?? null]);
}

export function matchFillTargets(before, after) {
  if (!valid(before) || !valid(after) || before.url !== after.url) return [];
  const index = (report) => {
    const found = new Map();
    for (const field of report.fields) {
      const key = fillTargetIdentity(report, field);
      if (key) found.set(key, [...(found.get(key) || []), field.id]);
    }
    return found;
  };
  const old = index(before), next = index(after);
  return [...old].flatMap(([key, ids]) => ids.length === 1 && next.get(key)?.length === 1
    ? [{ beforeId: ids[0], afterId: next.get(key)[0] }] : []);
}

/** A field can become locked after a dependent field changes. Carry its
 * existing receipt only for readback; this never permits another write or
 * reuses a plan. Unique semantic identity and a present value are required. */
export function matchWrittenTargets(before, after, verifiedIds = []) {
  const exact = matchFillTargets(before, after);
  if (!valid(before) || !valid(after) || before.url !== after.url) return exact;
  const owned = new Set(verifiedIds), matched = new Set(exact.map((pair) => pair.beforeId));
  const receiptKey = (report, field) => {
    const identity = fillTargetIdentity(report, field);
    if (!identity) return null;
    const parts = JSON.parse(identity);
    // Editability changes do not change the question. All other attributes,
    // including kind, date units, record index and excluded-value policy stay.
    parts.splice(7, 2);
    return JSON.stringify(parts);
  };
  const index = (report) => {
    const entries = new Map();
    for (const field of report.fields) {
      const key = receiptKey(report, field);
      if (key) entries.set(key, [...(entries.get(key) || []), field]);
    }
    return entries;
  };
  const old = index(before), next = index(after);
  for (const [key, fields] of old) {
    if (fields.length !== 1 || next.get(key)?.length !== 1) continue;
    const previous = fields[0], current = next.get(key)[0];
    if (!owned.has(previous.id) || matched.has(previous.id) || previous.disabled || previous.readOnly
      || !current.disabled && !current.readOnly || current.hasValue !== true) continue;
    exact.push({ beforeId: previous.id, afterId: current.id, auditOnly: true });
  }
  return exact;
}
