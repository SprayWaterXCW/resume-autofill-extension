/**
 * Test double for an LLM, not the product's semantic planner.
 * It understands only our invented education fixture and chooses one action per turn.
 */
export class ScriptedFixturePlanner {
  async decide({ page, profileCatalog }) {
    const expectedEntries = new Set(profileCatalog
      .map(({ path }) => /^educations\.(\d+)\./.exec(path)?.[1])
      .filter((index) => index !== undefined)).size;
    const education = page.sections.find((section) => section.key === "educations");
    if (education.entryCount < expectedEntries) {
      return {
        kind: "act", tool: "add_entry", args: { sectionKey: "educations" },
        rationale: `资料库有 ${expectedEntries} 段教育经历，页面只有 ${education.entryCount} 段，先补足卡片。`,
      };
    }

    for (const field of page.fields) {
      if (field.filled) continue;
      const key = { "毕业学校": "school", "所学专业": "major" }[field.label];
      if (!key) continue;
      return {
        kind: "act",
        tool: "fill_field",
        args: { fieldId: field.id, sourcePath: `educations.${field.entryIndex}.${key}` },
        rationale: `第 ${field.entryIndex + 1} 段的「${field.label}」为空，按脚本规则选择对应的资料字段。`,
      };
    }
    return { kind: "finish" };
  }
}
