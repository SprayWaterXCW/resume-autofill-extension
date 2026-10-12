import { ResumeSchema } from "../vendor/formfill/resume-schema.js";
import { createProfileLedger } from "../core/profile-ledger.js";
import { withAwardSummaries, withAwardLevels } from "../core/award-details.js";

/** Fictional scale reproduction: no real applicant data or captured browser state. */
export function largeFormPlanFixture() {
  const counts = { personal: [22], contactAndLocation: [7], identityAndAuthorization: [5], jobPreferences: [10],
    skills: [4], educations: [14, 14], internships: [11, 10], projects: [5, 5],
    campusExperiences: [7, 7, 7], certificates: [4, 4], languages: [3], additional: [1] };
  const facts = [], labels = new Map(), kinds = new Map();
  const add = (path, label, sectionKey, entryIndex, kind = "text") => {
    facts.push({ path, label, sectionKey, entryIndex,
      candidates: [{ sourceId: "fictional_fixture", value: "虚构资料-" + path, status: "verified" }] });
    labels.set(path, label);
    kinds.set(path, ["select", "textarea", "date", "number"].includes(kind) ? kind : "text");
  };
  for (const section of ResumeSchema.sections) {
    if (!counts[section.key]) continue;
    const fields = section.fields || section.itemFields;
    counts[section.key].forEach((count, index) => {
      if (!fields || fields.length < count) throw new Error("Insufficient fictional fixture fields: " + section.key);
      fields.slice(0, count).forEach((field) => add(section.key + (section.type === "list" ? "." + index : "") + "." + field.key,
        field.label, section.key, index, field.input));
    });
  }
  for (const section of ["awards", "competitions"]) {
    for (let index = 0; index < 5; index++) {
      const properties = section === "awards" ? index === 2 ? ["name", "scope", "rank"] : ["name", "scope"]
        : index === 0 || index === 2 ? ["name", "scope", "rank", "description"]
          : index === 1 ? ["name", "scope", "description"] : ["name", "scope", "rank"];
      for (const property of properties) add(section + "." + index + "." + property,
        { name: "名称", scope: "级别", rank: "等次", description: "详细信息" }[property], section, index);
    }
  }
  const base = withAwardLevels(withAwardSummaries(createProfileLedger({
    schemaVersion: 1, sources: [{ id: "fictional_fixture", kind: "fixture" }], facts,
  })));
  const copies = Array.from({ length: 10 }, (_, i) => ({ path: "formAnswers.fixtureCopy" + i,
    label: "虚构派生属性 " + (i + 1), sectionKey: "formAnswers", entryIndex: 0, status: "verified",
    evidenceCount: 1, derivedFrom: [facts[i].path], derivation: "copy" }));
  const ledger = { ...base, profileKind: "synthetic", publicFacts: [...base.publicFacts, ...copies] };
  const basic = facts.filter((fact) => !/^\d+$/.test(fact.path.split(".")[1])).slice(0, 46).map((fact) => fact.path);
  const education = [0, 1].flatMap((i) => ["school", "major", "degree", "startDate", "endDate"].map((key) => "educations." + i + "." + key));
  if ([...basic, ...education].some((path) => !base.hasPath(path))) throw new Error("Missing fictional fixture source");
  const fields = [
    ...basic.map((path) => ({ path, groupId: "group-1", entryIndex: 0 })),
    ...education.map((path, i) => ({ path, groupId: "group-2", entryIndex: Math.floor(i / 5) })),
    { path: "awards.0.name", groupId: "group-3", entryIndex: 0 },
  ].map(({ path, groupId, entryIndex }, i) => ({ id: "field-" + i, groupId, entryIndex,
    label: path === "awards.0.name" ? "奖项名称" : labels.get(path), labelSource: "placeholder",
    kind: kinds.get(path) || "text", required: false, disabled: false, readOnly: false,
    hasValue: false, valueExcluded: false }));
  const report = { mode: "read-only", origin: "https://jobs.example.test", summary: { fieldCount: 57, groupCount: 3, truncated: false },
    groups: [{ id: "group-1", label: "基本信息", entryCount: 1 }, { id: "group-2", label: "教育经历", entryCount: 2 },
      { id: "group-3", label: "获奖情况", entryCount: 1 }],
    fields, controls: [{ groupId: "group-3", intent: "add-candidate" }] };
  if (ledger.publicFacts.length !== 201) throw new Error("Unexpected fictional catalog size: " + ledger.publicFacts.length);
  return { report, ledger, expectedPaths: [...basic, ...education, "awards.0.name"] };
}
