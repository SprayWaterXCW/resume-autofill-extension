import { createProfileLedger } from "../core/profile-ledger.js";
import { createSyntheticLedger } from "./synthetic-ledger.js";

function observation(groups) {
  const fields = [];
  return {
    mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: groups.map((group, groupIndex) => {
      const id = `group-${groupIndex + 1}`;
      for (const field of group.fields) fields.push({
        id: `field-${fields.length + 1}`, groupId: id, entryIndex: 0, label: field.label,
        labelSource: "label", kind: field.kind || "text", required: true, disabled: false,
        readOnly: false, hasValue: false, valueExcluded: false,
      });
      return { id, label: group.label, entryCount: 1 };
    }),
    fields, controls: [],
  };
}

function awardLedger() {
  return createProfileLedger({
    schemaVersion: 1, sources: [{ id: "invented", kind: "fixture" }],
    facts: ["awards", "competitions"].flatMap((sectionKey) => Array.from({ length: sectionKey === "awards" ? 5 : 2 }, (_, entryIndex) => ({
      path: `${sectionKey}.${entryIndex}.title`, label: sectionKey === "awards" ? "奖项名称" : "竞赛名称", sectionKey, entryIndex,
      candidates: [{ sourceId: "invented", value: `虚构记录-${sectionKey}-${entryIndex}`, status: "verified" }],
    }))),
  });
}

/** Independent expected routing; contains no real applicant facts or website execution. */
export function planCases() {
  return [
    {
      id: "education-alias-and-shortage", ledger: createSyntheticLedger(),
      report: observation([{ label: "Academic background", fields: [
        { label: "University / college attended", kind: "autocomplete" }, { label: "Field of study" },
      ] }]),
      expected: { additionalEntries: 1, routes: [["educations"]], paths: ["educations.0.school", "educations.0.major"] },
    },
    {
      id: "awards-competitions-merged", ledger: awardLedger(),
      report: observation([{ label: "获奖经历", fields: [{ label: "奖项名称" }] }]),
      expected: { additionalEntries: 6, routes: [["awards", "competitions"]], paths: ["awards.0.title"] },
    },
    {
      id: "awards-competitions-separated", ledger: awardLedger(),
      report: observation([{ label: "获奖经历", fields: [{ label: "奖项名称" }] }, { label: "竞赛经历", fields: [{ label: "竞赛名称" }] }]),
      expected: { additionalEntries: 5, routes: [["awards"], ["competitions"]], paths: ["awards.0.title", "competitions.0.title"] },
    },
  ];
}
