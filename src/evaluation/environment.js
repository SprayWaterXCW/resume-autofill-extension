import { createCatalog } from "../core/catalog.js";

function fieldKey(sectionKey, entryIndex, key) {
  return `${sectionKey}:${entryIndex}:${key}`;
}

/**
 * A private task oracle. The planner sees only observe(), never the expected
 * source path, expected option, fault configuration, or evaluation result.
 */
export class EvaluationFormEnvironment {
  constructor(spec) {
    this.spec = spec;
    this.catalog = createCatalog(spec.profile);
    this.reset();
  }

  reset() {
    this.visibleCounts = new Map(this.spec.sections.map((section) => [section.key, section.initialCount]));
    this.values = new Map();
    this.committedOptions = new Map();
    this.attemptedWrites = new Map();
    this.stepCalls = [];
    this.submissionCount = 0;
    this.overwriteCount = 0;
    this.generation = 0;
    this.rerendered = false;
    for (const [key, value] of Object.entries(this.spec.prefilled ?? {})) this.values.set(key, value);
    return this.observe();
  }

  fieldId(sectionKey, entryIndex, key) {
    return `g${this.generation}-${sectionKey}-${entryIndex}-${key}`;
  }

  visibleFields() {
    return this.spec.sections.flatMap((section) => section.entries
      .slice(0, this.visibleCounts.get(section.key))
      .flatMap((entry, entryIndex) => entry.fields.map((field) => {
        const key = fieldKey(section.key, entryIndex, field.key);
        return {
          id: this.fieldId(section.key, entryIndex, field.key),
          key,
          label: field.label,
          sectionKey: section.key,
          entryIndex,
          value: this.values.get(key) ?? "",
          writable: field.writable !== false,
          controlType: field.controlType ?? "text",
        };
      })));
  }

  observe() {
    return {
      pageId: this.spec.id,
      sections: this.spec.sections.map((section) => ({
        key: section.key,
        label: section.label,
        entryCount: this.visibleCounts.get(section.key),
        addControl: section.entries.length > 1 ? {
          id: `add-${section.key}`,
          text: section.addControl?.text ?? `添加${section.label}`,
          intent: "add_entry",
          role: "button",
          type: section.addControl?.type ?? "button",
          formAction: section.addControl?.formAction ?? null,
        } : null,
      })),
      fields: this.visibleFields().map(({ key: _privateKey, controlType: _privateType, ...field }) => field),
      otherControls: [{ id: "submit-application", text: "提交简历", role: "button", type: "submit" }],
    };
  }

  async step(action) {
    if (action.tool !== "add_entry" && action.tool !== "fill_field") throw new Error("Unsupported action");
    this.stepCalls.push({ tool: action.tool, target: action.fieldId ?? action.sectionKey, sourcePath: action.sourcePath });
    if (action.tool === "add_entry") {
      const section = this.spec.sections.find((item) => item.key === action.sectionKey);
      if (!section || this.visibleCounts.get(section.key) >= section.entries.length) throw new Error("No card can be added");
      if (section.addControl?.submitsOnClick || section.addControl?.type === "submit") this.submissionCount += 1;
      this.visibleCounts.set(section.key, this.visibleCounts.get(section.key) + 1);
    } else {
      const visibleField = this.visibleFields().find((item) => item.id === action.fieldId);
      if (!visibleField) throw new Error("The target is stale or unavailable");
      const previous = this.values.get(visibleField.key) ?? "";
      if (previous && previous !== action.value) this.overwriteCount += 1;
      const attempts = (this.attemptedWrites.get(action.sourcePath) ?? 0) + 1;
      this.attemptedWrites.set(action.sourcePath, attempts);
      if (this.spec.fault?.throwFirstFor === action.sourcePath && attempts === 1) {
        throw new Error("The widget temporarily rejected this action");
      }
      if (!(this.spec.fault?.dropFirstFor === action.sourcePath && attempts === 1)) {
        // Text typed into a select/autocomplete is visible but is not a committed option.
        // A later select_option tool will have to set committedOptions explicitly.
        this.values.set(visibleField.key, action.value);
      }
      if (this.spec.fault?.rerenderAfterFirstWrite && !this.rerendered) {
        this.rerendered = true;
        this.generation += 1;
      }
    }
    return { observation: this.observe(), reward: 0, terminated: false, truncated: false, info: {} };
  }

  evaluate() {
    let expectedFieldCount = 0;
    let correctCount = 0;
    let missingCount = 0;
    let wrongCount = 0;
    let uncommittedCount = 0;
    let extraEntryCount = 0;
    const sections = [];

    for (const section of this.spec.sections) {
      const actualCount = this.visibleCounts.get(section.key);
      const expectedCount = section.entries.length;
      extraEntryCount += Math.max(0, actualCount - expectedCount);
      sections.push({ key: section.key, actualCount, expectedCount });
      section.entries.forEach((entry, entryIndex) => entry.fields.forEach((field) => {
        expectedFieldCount += 1;
        if (entryIndex >= actualCount) {
          missingCount += 1;
          return;
        }
        const key = fieldKey(section.key, entryIndex, field.key);
        const actual = this.values.get(key) ?? "";
        const expected = field.expectedValue ?? this.catalog.getValue(field.sourcePath);
        if ((field.controlType === "select" || field.controlType === "autocomplete")
          && this.committedOptions.get(key) !== (field.expectedOption ?? expected)) {
          if (actual && actual !== expected) wrongCount += 1;
          else uncommittedCount += 1;
        } else if (actual === expected) correctCount += 1;
        else if (!actual) missingCount += 1;
        else wrongCount += 1;
      }));
    }

    return {
      complete: correctCount === expectedFieldCount && extraEntryCount === 0
        && this.submissionCount === 0 && this.overwriteCount === 0,
      expectedFieldCount, correctCount, missingCount, wrongCount, uncommittedCount,
      extraEntryCount, sections, submissionCount: this.submissionCount, overwriteCount: this.overwriteCount,
    };
  }
}
