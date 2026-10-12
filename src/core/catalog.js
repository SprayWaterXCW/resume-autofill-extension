/**
 * The profile stays local. A planner receives paths and labels, never values.
 * The later LLM adapter must use publicCatalog(), not entries or valuesByPath.
 */
export function createCatalog(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Profile fields must be an array");

  const valuesByPath = new Map();
  const publicEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.label !== "string"
      || typeof entry.value !== "string" || !entry.path || !entry.label || !entry.value) {
      throw new TypeError("Each profile field needs a nonempty path, label and value");
    }
    if (valuesByPath.has(entry.path)) throw new TypeError(`Duplicate profile path: ${entry.path}`);
    valuesByPath.set(entry.path, entry.value);
    publicEntries.push(Object.freeze({ path: entry.path, label: entry.label }));
  }

  return Object.freeze({
    publicEntries: Object.freeze(publicEntries),
    getValue(path) { return valuesByPath.get(path); },
    hasPath(path) { return valuesByPath.has(path); },
  });
}

export function toPlannerObservation(observation) {
  return {
    pageId: observation.pageId,
    sections: observation.sections.map((section) => ({
      key: section.key,
      label: section.label,
      entryCount: section.entryCount,
      addControl: section.addControl ? { ...section.addControl } : null,
    })),
    fields: observation.fields.map((field) => ({
      id: field.id,
      label: field.label,
      sectionKey: field.sectionKey,
      entryIndex: field.entryIndex,
      writable: field.writable,
      filled: Boolean(field.value),
    })),
    otherControls: observation.otherControls.map((control) => ({ ...control })),
  };
}
