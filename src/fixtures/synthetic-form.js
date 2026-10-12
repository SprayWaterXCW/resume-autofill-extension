import { createCatalog } from "../core/catalog.js";

// All names and values here are invented. Real resume exports must never be used as fixtures.
export const syntheticProfileFields = Object.freeze([
  { path: "educations.0.school", label: "毕业院校", value: "星河示例大学" },
  { path: "educations.0.major", label: "专业", value: "信息科学" },
  { path: "educations.1.school", label: "毕业院校", value: "松林示例学院" },
  { path: "educations.1.major", label: "专业", value: "应用数学" },
]);

export function createSyntheticCatalog() {
  return createCatalog(syntheticProfileFields);
}

/** A tiny BrowserGym-style environment: reset(), step(), observation, evaluator. */
export class SyntheticFormEnvironment {
  constructor({ dropFirstWriteFor = [], unsafeAddControl = false, fieldLabels = {}, initialEntryCount = 1 } = {}) {
    this.dropFirstWriteFor = new Set(dropFirstWriteFor);
    this.unsafeAddControl = unsafeAddControl;
    this.fieldLabels = { school: fieldLabels.school || "毕业学校", major: fieldLabels.major || "所学专业" };
    if (!Number.isInteger(initialEntryCount) || initialEntryCount < 1) throw new RangeError("initialEntryCount must be positive");
    this.initialEntryCount = initialEntryCount;
    this.stepCalls = [];
    this.submissionCount = 0;
    this.reset();
  }

  reset() {
    this.nextFieldNumber = 1;
    this.fields = [];
    this.droppedWrites = new Set();
    this.stepCalls = [];
    this.submissionCount = 0;
    for (let index = 0; index < this.initialEntryCount; index += 1) this.addEducationEntry();
    return this.observe();
  }

  addEducationEntry() {
    const entryIndex = this.fields.length / 2;
    for (const [key, label] of [["school", this.fieldLabels.school], ["major", this.fieldLabels.major]]) {
      this.fields.push({
        id: `field-${this.nextFieldNumber++}`,
        key,
        label,
        sectionKey: "educations",
        entryIndex,
        value: "",
        writable: true,
      });
    }
  }

  observe() {
    return {
      pageId: "local-synthetic-education-form",
      sections: [{
        key: "educations",
        label: "教育经历",
        entryCount: this.fields.length / 2,
        addControl: {
          id: "add-education",
          text: "添加教育经历",
          intent: "add_entry",
          role: "button",
          type: this.unsafeAddControl ? "submit" : "button",
          formAction: null,
        },
      }],
      fields: this.fields.map(({ key: _key, ...field }) => ({ ...field })),
      otherControls: [{ id: "submit-application", text: "提交简历", role: "button", type: "submit" }],
    };
  }

  async step(action) {
    // Deliberately no generic click, navigation, save-and-submit or submit branch.
    if (action.tool !== "add_entry" && action.tool !== "fill_field") {
      throw new Error("Unsupported environment action");
    }
    this.stepCalls.push({ tool: action.tool, fieldId: action.fieldId, sectionKey: action.sectionKey });
    if (action.tool === "add_entry") {
      if (action.sectionKey !== "educations") throw new Error("Unknown repeat section");
      this.addEducationEntry();
    } else {
      const field = this.fields.find((item) => item.id === action.fieldId);
      if (!field) throw new Error("Unknown field");
      if (this.dropFirstWriteFor.has(action.sourcePath) && !this.droppedWrites.has(action.sourcePath)) {
        this.droppedWrites.add(action.sourcePath); // A page silently ignored the first write.
      } else {
        field.value = action.value;
      }
    }
    return { observation: this.observe(), reward: 0, terminated: false, truncated: false, info: {} };
  }

  evaluate(catalog) {
    const missing = [];
    for (const entry of catalog.publicEntries) {
      const match = /^educations\.(\d+)\.(school|major)$/.exec(entry.path);
      if (!match) continue;
      const field = this.fields.find((item) => item.entryIndex === Number(match[1]) && item.key === match[2]);
      if (!field || field.value !== catalog.getValue(entry.path)) missing.push(entry.path);
    }
    const expectedCount = 1 + Math.max(...catalog.publicEntries
      .map((entry) => /^educations\.(\d+)\./.exec(entry.path))
      .filter(Boolean)
      .map((match) => Number(match[1])));
    const countMatches = this.fields.length / 2 === expectedCount;
    return {
      complete: countMatches && missing.length === 0 && this.submissionCount === 0,
      missingCount: missing.length,
      entryCount: this.fields.length / 2,
      expectedEntryCount: expectedCount,
      submissionCount: this.submissionCount,
    };
  }
}
