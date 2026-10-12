import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeAgentProfile } from "../core/award-details.js";
import { importProfile, ledgerFromProfile } from "../core/profile-import.js";
import { generateReadOnlyPlan } from "../core/fill-plan.js";
import { OpenAICompatiblePlanner } from "../llm/openai-compatible-planner.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set RESUME_AGENT_API_KEY to run synthetic award mapping evaluation");
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const model = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const profile = normalizeAgentProfile({ additional: { awards: "虚构荣誉甲", competitions: "虚构竞赛甲" } });
Object.assign(profile.awardRecords.awards[0], { scope: "国家级", rank: "一等奖", description: "虚构独立获奖详情" });
Object.assign(profile.awardRecords.competitions[0], { scope: "省级", rank: "二等奖", description: "虚构独立竞赛详情" });
const ledger = ledgerFromProfile(importProfile({ profile, agentProfilePurpose: "synthetic_evaluation" }).stored);

function report(groups) {
  let fieldIndex = 0;
  return { mode: "read-only", origin: "https://jobs.example.test", summary: { truncated: false },
    groups: groups.map(([label, records], i) => ({ id: "group-" + i, label, entryCount: records.length })),
    fields: groups.flatMap(([, records], i) => records.flatMap((labels, entryIndex) => labels.map((input) => {
      const label = typeof input === "string" ? input : input.label;
      return ({
      id: "field-" + fieldIndex++, groupId: "group-" + i, entryIndex, label, labelSource: "label",
      kind: typeof input === "object" ? input.kind : /描述|详细信息/.test(label) ? "textarea" : label === "奖项名称" || label === "竞赛名称" ? "text" : "select", required: false,
      disabled: false, readOnly: false, hasValue: false, valueExcluded: false,
    }); }))) };
}
const unknown = ledgerFromProfile(importProfile({ profile: { additional: { awards: "虚构全国竞赛：二等奖" } }, agentProfilePurpose: "synthetic_evaluation" }).stored);
const labels = ["奖项名称", "获奖级别", "获奖等次", "详细信息"];
const semanticLabels = [
  { label: "荣誉事项", kind: "text" }, { label: "评定层次", kind: "select" },
  { label: "奖励档次", kind: "select" }, { label: "成果叙事", kind: "textarea" },
];
const cases = [
  { id: "award-only-merged-levels", ledger, report: report([["获奖经历", [labels, labels]]]),
    paths: ["awards.0.name", "awards.0.scope", "awards.0.rank", "awards.0.description",
      "competitions.0.name", "competitions.0.scope", "competitions.0.rank", "competitions.0.description"],
    routes: [["awards", "competitions"]] },
  { id: "separate-award-competition-levels", ledger, report: report([["获奖经历", [labels]], ["竞赛经历", [["竞赛名称", "获奖级别", "获奖等次", "竞赛描述"]]]]),
    paths: ["awards.0.name", "awards.0.scope", "awards.0.rank", "awards.0.description",
      "competitions.0.name", "competitions.0.scope", "competitions.0.rank", "competitions.0.description"],
    routes: [["awards"], ["competitions"]] },
  { id: "generic-dropdown-with-unconfirmed-scope", ledger: unknown,
    report: report([["获奖经历", [["奖项名称", "获奖等级", "获奖级别"]]]]),
    paths: ["awards.0.name", "awards.0.level", null], routes: [["awards"]] },
  { id: "novel-group-and-field-wording", ledger,
    report: report([["奖励记录", [semanticLabels]], ["参赛记录", [semanticLabels]]]),
    paths: ["awards.0.name", "awards.0.scope", "awards.0.rank", "awards.0.description",
      "competitions.0.name", "competitions.0.scope", "competitions.0.rank", "competitions.0.description"],
    roles: ["name", "scope", "rank", "description", "name", "scope", "rank", "description"],
    routes: [["awards"], ["competitions"]] },
  { id: "single-prose-box-with-all-awards-and-competitions", ledger,
    report: report([["获奖情况", [[{ label: "所获表彰说明", kind: "textarea" }]]]]),
    paths: ["formAnswers.awardsAndCompetitionsSummary"], roles: ["summary"],
    routes: [["awards", "competitions", "formAnswers"]] },
  { id: "separate-prose-boxes", ledger,
    report: report([["荣誉记录", [[{ label: "所获表彰说明", kind: "textarea" }]]],
      ["竞赛经历", [[{ label: "参赛成果说明", kind: "textarea" }]]]]),
    paths: ["formAnswers.awardsSummary", "formAnswers.competitionsSummary"], roles: ["summary", "summary"],
    routes: [["awards", "formAnswers"], ["competitions", "formAnswers"]] },
];
const results = [];
for (const spec of cases) {
  const planner = new OpenAICompatiblePlanner({ apiKey, baseUrl, model,
    timeoutMs: Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000), disableThinking: new URL(baseUrl).hostname === "api.deepseek.com" });
  let proposedPaths = [], proposedRoles = [];
  const observedPlanner = { async planMappings(context) {
    const proposal = await planner.planMappings(context);
    // Log only references already in the synthetic public catalog.
    const known = new Set(context.profileCatalog.map((fact) => fact.path));
    proposedPaths = context.page.fields.map((field) => {
      const mapping = proposal.fieldMappings.find((item) => item.fieldId === field.id);
      return mapping ? known.has(mapping.sourcePath) ? mapping.sourcePath : "invalid_reference" : null;
    });
    proposedRoles = context.page.fields.map((field) => proposal.fieldMappings.find((item) => item.fieldId === field.id)?.semanticRole || null);
    return proposal;
  } };
  try {
    const { plan } = await generateReadOnlyPlan({ scan: async () => structuredClone(spec.report), ledger: spec.ledger, planner: observedPlanner });
    const paths = plan.items.map((item) => item.sourcePath), routes = plan.sections.map((section) => section.sectionKeys);
    const roles = plan.items.map((item) => item.semanticRole || null);
    const passed = JSON.stringify(paths) === JSON.stringify(spec.paths) && JSON.stringify(routes) === JSON.stringify(spec.routes)
      && (!spec.roles || JSON.stringify(roles) === JSON.stringify(spec.roles))
      && plan.summary.additionalEntries === 0 && (spec.id !== "generic-dropdown-with-unconfirmed-scope" || plan.items[2].status === "missing_profile");
    results.push({ id: spec.id, passed, paths, roles, routes, fieldStatuses: plan.items.map((item) => item.status), metrics: planner.metrics });
  } catch (error) {
    results.push({ id: spec.id, passed: false, code: /^(PLAN_|MODEL_)[A-Z_]+$/.test(error.code || "") ? error.code : "EVALUATION_FAILED",
      proposedPaths, proposedRoles, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}), metrics: planner.metrics });
  }
  console.log(JSON.stringify(results.at(-1)));
}
const output = process.argv.slice(2).find((arg) => arg.startsWith("--output="))?.slice(9);
const result = { schemaVersion: 1, createdAt: new Date().toISOString(), model,
  scope: "Synthetic award mapping requests only; model receives labels/paths, no profile values or browser actions",
  passed: results.filter((item) => item.passed).length, total: results.length, cases: results };
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); }
console.log(JSON.stringify({ passed: result.passed, total: result.total, output: output || null }));
if (result.passed !== result.total) process.exitCode = 1;
