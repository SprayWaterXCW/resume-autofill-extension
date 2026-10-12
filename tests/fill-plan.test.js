import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createProfileLedger } from "../src/core/profile-ledger.js";
import { createSyntheticLedger } from "../src/fixtures/synthetic-ledger.js";
import { syntheticProfileFields } from "../src/fixtures/synthetic-form.js";
import { readFormStructure } from "../agent-extension/src/page-scan.js";
import { createPlanContext, buildFillPlan, createPartialProposal, validatePartialProposal, generateReadOnlyPlan, validatePlanContext, validatePlanFailureFeedback } from "../src/core/fill-plan.js";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { z } from "zod";
import { LocalModelSocket } from "../agent-extension/src/model-socket.js";
import { attachAgentSocket, EXTENSION_ORIGIN } from "../web-demo/agent-socket.js";
import { runRealForm } from "../src/core/real-runner.js";

const url = "https://myjob.hzbank.com.cn/hzzp-apply-web/static/index.html#/createResume?type=school";
const educationHtml = `<div class="resume-form-container"><h2 class="resume-form-title">教育经历</h2><form>
  <div class="el-form-item"><label>毕业学校</label><div class="el-autocomplete"><input id="school"></div></div>
  <div class="el-form-item"><label>所学专业</label><input id="major"></div>
  <div class="el-form-item"><label>教育类型</label><div class="el-select"><input readonly></div></div>
  <button type="button">继续添加</button></form></div>
  <div class="resume-form-container"><h2 class="resume-form-title">有关声明</h2><form><label>声明<textarea>虚构声明内容</textarea></label><canvas></canvas></form></div>
  <button type="submit">提交简历</button>`;

function fixture(html = educationHtml) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  for (const method of ["click", "focus", "blur", "dispatchEvent"]) {
    dom.window.HTMLElement.prototype[method] = () => { throw new Error("Unexpected browser mutation"); };
  }
  dom.window.fetch = () => { throw new Error("Unexpected page network request"); };
  return { dom, scan: () => JSON.parse(JSON.stringify(dom.window.eval(`(${readFormStructure.toString()})(${JSON.stringify(url)})`))) };
}

function proposalFor(context) {
  const group = context.page.groups.find((item) => item.label === "教育经历");
  const fieldMappings = context.page.fields.filter((item) => ["毕业学校", "所学专业"].includes(item.label)).map((field) => ({
    fieldId: field.id, sourcePath: `educations.${field.entryIndex}.${field.label === "毕业学校" ? "school" : "major"}`,
  }));
  return { snapshotId: context.snapshotId, groupMappings: [{ groupId: group.id, sectionKeys: ["educations"] }],
    fieldMappings, unresolved: context.page.fields.filter((field) => !fieldMappings.some((item) => item.fieldId === field.id))
      .map((field) => ({ fieldId: field.id, reason: "missing_profile" })) };
}

test("read-only workflow detects record shortage and distinguishes mapping from complex-control execution", async () => {
  const { dom, scan } = fixture();
  try {
    const before = dom.window.document.documentElement.outerHTML;
    const phases = [];
    let requests = 0;
    const result = await generateReadOnlyPlan({ scan, ledger: createSyntheticLedger(),
      planner: { async planMappings(context) { requests += 1; return proposalFor(context); } }, onPhase: (phase) => phases.push(phase) });
    assert.deepEqual(phases, ["observe", "model", "validate", "reobserve"]);
    assert.equal(requests, 1);
    assert.equal(result.plan.summary.additionalEntries, 1);
    assert.equal(result.plan.items.find((field) => field.label === "毕业学校").status, "needs_control_adapter");
    assert.equal(result.plan.items.find((field) => field.label === "所学专业").status, "mapped");
    assert.ok(result.plan.items.filter((field) => field.kind === "signature" || field.label === "声明").every((field) => field.status === "manual_only"));
    assert.ok(result.plan.items.every((field) => !field.executable));
    assert.equal(result.plan.executable, false);
    assert.equal(JSON.stringify(result).includes("虚构声明内容"), false);
    assert.equal(dom.window.document.documentElement.outerHTML, before);
    for (const { value } of syntheticProfileFields) assert.equal(JSON.stringify(result).includes(value), false);
  } finally { dom.window.close(); }
});

test("invented paths, stale IDs, repeated fields and cross-record mappings are rejected", async () => {
  const { dom, scan } = fixture();
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const checks = [
      ["PLAN_UNKNOWN_REFERENCE", (proposal) => { proposal.fieldMappings[0].sourcePath = "educations.0.invented"; }],
      ["PLAN_UNKNOWN_REFERENCE", (proposal) => { proposal.fieldMappings[0].fieldId = "invented-field"; }],
      ["PLAN_RECORD_MISMATCH", (proposal) => { proposal.fieldMappings[0].sourcePath = "educations.1.school"; }],
      ["PLAN_DUPLICATE_REFERENCE", (proposal) => { proposal.fieldMappings.push(proposal.fieldMappings[0]); }],
      ["PLAN_PROPOSAL_INVALID", (proposal) => { proposal.click = "submit"; }],
      ["PLAN_PROPOSAL_INVALID", (proposal) => { proposal.fieldMappings[0].value = "虚构模型编造"; }],
      ["PLAN_SNAPSHOT_INVALID", (proposal) => { proposal.snapshotId = "0".repeat(64); }],
    ];
    for (const [code, change] of checks) {
      const proposal = proposalFor(context);
      change(proposal);
      await assert.rejects(buildFillPlan(context, proposal), { code });
    }
  } finally { dom.window.close(); }
});

test("singleton preferences span separate form groups while repeated fields produce value-free conflict diagnostics", async () => {
  const { dom, scan } = fixture(`<div class="resume-form-container"><h2 class="resume-form-title">个人信息</h2><form><label>期望月薪<input></label></form></div><div class="resume-form-container"><h2 class="resume-form-title">附加问题</h2><form><label>了解到公司的渠道<input></label></form></div>`);
  try {
    const ledger = createProfileLedger({ schemaVersion: 1, sources: [{ id: "user", kind: "user_confirmation" }], facts:
      [["salary", "期望月薪", "FICTIONAL_SALARY"], ["channel", "了解到公司的渠道", "FICTIONAL_CHANNEL"]].map(([key, label, value]) => ({
        path: `jobPreferences.${key}`, sectionKey: "jobPreferences", entryIndex: 0, label,
        candidates: [{ sourceId: "user", status: "user_confirmed", value }],
      })) });
    const context = await createPlanContext(scan(), ledger);
    const proposal = { snapshotId: context.snapshotId,
      groupMappings: context.page.groups.map((group) => ({ groupId: group.id, sectionKeys: ["jobPreferences"] })),
      fieldMappings: context.page.fields.map((field, index) => ({ fieldId: field.id, sourcePath: ledger.publicFacts[index].path })), unresolved: [] };
    const plan = await buildFillPlan(context, proposal);
    assert.equal(plan.summary.mappedCount, 2);
    assert.equal(plan.summary.additionalEntries, 0);
    proposal.groupMappings = [];
    const completed = await buildFillPlan(context, proposal);
    assert.equal(completed.summary.mappedCount, 2);
    assert.ok(completed.sections.every((section) => section.sectionKeys.includes("jobPreferences")));
    proposal.fieldMappings[1].sourcePath = proposal.fieldMappings[0].sourcePath;
    await assert.rejects(buildFillPlan(context, proposal), (error) => {
      assert.equal(error.code, "PLAN_DUPLICATE_REFERENCE");
      assert.equal(error.diagnostic.violation, "source_in_multiple_fields");
      assert.deepEqual(error.diagnostic.fieldIds, context.page.fields.map((field) => field.id));
      assert.deepEqual(error.diagnostic.sourcePaths, ["jobPreferences.salary"]);
      assert.equal(JSON.stringify(error.diagnostic).includes("FICTIONAL_"), false);
      return true;
    });
  } finally { dom.window.close(); }
});

test("omitted source sections are derived from known field references without relaxing repeated-record checks", async () => {
  const { dom, scan } = fixture();
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const proposal = proposalFor(context);
    proposal.groupMappings = [];
    const plan = await buildFillPlan(context, proposal);
    assert.equal(plan.summary.additionalEntries, 1);
    assert.deepEqual(plan.sections.find((section) => section.label === "教育经历").sectionKeys, ["educations"]);
    proposal.fieldMappings[0].sourcePath = "educations.1.school";
    await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_RECORD_MISMATCH" });
    const bad = proposalFor(context);
    bad.groupMappings = [];
    bad.fieldMappings[0].sourcePath = "invented.0.school";
    await assert.rejects(buildFillPlan(context, bad), { code: "PLAN_UNKNOWN_REFERENCE" });
  } finally { dom.window.close(); }
});

test("repair feedback accepts observed references and rejects invented records or private text", async () => {
  const { dom, scan } = fixture();
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const invalid = proposalFor(context);
    invalid.fieldMappings[0].sourcePath = "educations.1.school";
    let feedback;
    await assert.rejects(buildFillPlan(context, invalid), (error) => {
      feedback = { code: error.code, diagnostic: error.diagnostic };
      assert.deepEqual(feedback.diagnostic.expectedRecords, ["educations.0"]);
      assert.deepEqual(feedback.diagnostic.proposedRecords, ["educations.1"]);
      return error.code === "PLAN_RECORD_MISMATCH";
    });
    assert.deepEqual(validatePlanFailureFeedback(context, feedback), feedback);
    for (const change of [
      (value) => { value.diagnostic.expectedRecords = ["educations.99"]; },
      (value) => { value.diagnostic.fieldIds = ["unknown-field"]; },
      (value) => { value.diagnostic.sourcePaths = ["educations.0.invented"]; },
      (value) => { value.diagnostic.value = "PRIVATE_TEXT"; },
      (value) => { value.message = "PRIVATE_TEXT"; },
    ]) {
      const changed = structuredClone(feedback);
      change(changed);
      assert.throws(() => validatePlanFailureFeedback(context, changed), { code: "PLAN_FEEDBACK_INVALID" });
    }
  } finally { dom.window.close(); }
});

test("known existing fields are protected and conflicting sources never appear as usable mappings", async () => {
  const { dom, scan } = fixture();
  try {
    dom.window.document.getElementById("major").value = "虚构已填写专业";
    const input = {
      schemaVersion: 1, sources: [{ id: "a", kind: "document" }, { id: "b", kind: "document" }],
      facts: [
        { path: "educations.0.school", label: "毕业院校", sectionKey: "educations", entryIndex: 0,
          candidates: [{ sourceId: "a", value: "虚构院校甲", status: "verified" }, { sourceId: "b", value: "虚构院校乙", status: "verified" }] },
        { path: "educations.0.major", label: "专业", sectionKey: "educations", entryIndex: 0,
          candidates: [{ sourceId: "a", value: "虚构新专业", status: "verified" }] },
      ],
    };
    const context = await createPlanContext(scan(), createProfileLedger(input), { fillMode: "empty" });
    const plan = await buildFillPlan(context, proposalFor(context));
    assert.equal(plan.items.find((field) => field.label === "毕业学校").status, "source_conflict");
    assert.equal(plan.items.find((field) => field.label === "所学专业").status, "protected");
    const serialized = JSON.stringify({ context, plan });
    for (const value of ["虚构已填写专业", "虚构院校甲", "虚构院校乙", "虚构新专业"]) assert.equal(serialized.includes(value), false);
  } finally { dom.window.close(); }
});

test("unknown references identify their kind and known target without exposing the invented text", async () => {
  const { dom, scan } = fixture();
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const cases = [
      ["unknown_source", (proposal) => { proposal.fieldMappings[0].sourcePath = "PRIVATE_MODEL_TEXT"; }],
      ["unknown_field", (proposal) => { proposal.fieldMappings[0].fieldId = "PRIVATE_MODEL_TEXT"; }],
      ["unknown_group", (proposal) => { proposal.groupMappings[0].groupId = "PRIVATE_MODEL_TEXT"; }],
      ["unknown_section", (proposal) => { proposal.groupMappings[0].sectionKeys.push("PRIVATE_MODEL_TEXT"); }],
    ];
    for (const [violation, change] of cases) {
      const proposal = proposalFor(context);
      change(proposal);
      await assert.rejects(buildFillPlan(context, proposal), (error) => {
        assert.equal(error.code, "PLAN_UNKNOWN_REFERENCE");
        assert.equal(error.diagnostic.violation, violation);
        assert.equal(error.diagnostic.unknownReferenceCount, 1);
        assert.equal(JSON.stringify(error.diagnostic).includes("PRIVATE_MODEL_TEXT"), false);
        validatePlanFailureFeedback(context, { code: error.code, diagnostic: error.diagnostic });
        return true;
      });
    }
  } finally { dom.window.close(); }
});

test("partial plan excludes both duplicate targets and unknown paths, preserving independently valid mappings", async () => {
  const { dom, scan } = fixture(`<div class="resume-form-container"><h2 class="resume-form-title">个人信息</h2><form>
    <label>手机号码<input></label><label>英语等级成绩<input></label><label>其他语言能力及等级/分数<input></label><label>推荐人<input></label>
    </form></div>`);
  try {
    const ledger = createProfileLedger({ schemaVersion: 1, sources: [{ id: "fictional", kind: "fixture" }], facts: [
      { path: "personal.phoneNumber", label: "手机号码", sectionKey: "personal", entryIndex: 0, candidates: [{ sourceId: "fictional", status: "verified", value: "PRIVATE_FICTIONAL_PHONE" }] },
      { path: "languages.0.testScore", label: "语言成绩", sectionKey: "languages", entryIndex: 0, candidates: [{ sourceId: "fictional", status: "verified", value: "PRIVATE_FICTIONAL_SCORE" }] },
    ] });
    const context = await createPlanContext(scan(), ledger);
    const proposal = { snapshotId: context.snapshotId, groupMappings: [], unresolved: [], fieldMappings: context.page.fields.map((field, i) => ({
      fieldId: field.id, sourcePath: i === 0 ? "personal.phoneNumber" : i < 3 ? "languages.0.testScore" : "PRIVATE_INVENTED_PATH",
    })) };
    const partial = await createPartialProposal(context, proposal);
    const { plan } = await validatePartialProposal(context, partial);
    assert.deepEqual(partial.discardedFieldIds.sort(), context.page.fields.slice(1).map((field) => field.id).sort());
    assert.deepEqual(plan.items.filter((item) => item.sourcePath).map((item) => item.sourcePath), ["personal.phoneNumber"]);
    assert.equal(partial.exclusions.length, 2);
    assert.ok(plan.items.slice(1).every((item) => item.status === "ambiguous_mapping"));
    assert.equal(JSON.stringify(partial).includes("PRIVATE_"), false);
    const spoofed = structuredClone(partial);
    spoofed.exclusions[0].diagnostic.fieldIds = ["PRIVATE_MODEL_TEXT"];
    await assert.rejects(validatePartialProposal(context, spoofed), { code: "PLAN_FEEDBACK_INVALID" });
    await assert.rejects(createPartialProposal(context, { ...proposal, value: "PRIVATE" }), { code: "PLAN_PROPOSAL_INVALID" });
    await assert.rejects(createPartialProposal(context, { ...proposal, snapshotId: "0".repeat(64) }), { code: "PLAN_SNAPSHOT_INVALID" });
  } finally { dom.window.close(); }
});

test("partial plan quarantines cross-group records rather than choosing an education group or reordering records", async () => {
  const { dom, scan } = fixture(`<div class="resume-form-container"><h2 class="resume-form-title">个人信息</h2><form><label>本科院校<input></label></form></div>${educationHtml}`);
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const proposal = proposalFor(context);
    const basic = context.page.fields.find((field) => field.label === "本科院校");
    proposal.fieldMappings.push({ fieldId: basic.id, sourcePath: "educations.0.school" });
    proposal.unresolved = proposal.unresolved.filter((field) => field.fieldId !== basic.id);
    const { plan } = await validatePartialProposal(context, await createPartialProposal(context, proposal));
    assert.ok(plan.items.every((item) => !item.sourcePath));
    assert.equal(plan.summary.additionalEntries, 0);
    assert.ok(plan.unplacedSections.includes("educations"));
    const badRecord = proposalFor(context);
    badRecord.fieldMappings[0].sourcePath = "educations.1.school";
    const isolated = await validatePartialProposal(context, await createPartialProposal(context, badRecord));
    assert.ok(isolated.plan.items.every((item) => !item.sourcePath));
    assert.equal(isolated.partial.exclusions[0].diagnostic.violation, "record_out_of_order");
  } finally { dom.window.close(); }
});

test("awards and competitions form a complete ordered pool when merged and remain separate otherwise", async () => {
  const facts = ["awards", "competitions"].flatMap((sectionKey) => Array.from({ length: sectionKey === "awards" ? 5 : 2 }, (_, entryIndex) => ({
    path: `${sectionKey}.${entryIndex}.title`, label: sectionKey === "awards" ? "奖项名称" : "竞赛名称", sectionKey, entryIndex,
    candidates: [{ sourceId: "fictional", value: `虚构记录-${sectionKey}-${entryIndex}`, status: "verified" }],
  })));
  const ledger = createProfileLedger({ schemaVersion: 1, sources: [{ id: "fictional", kind: "fixture" }], facts });
  for (const separate of [false, true]) {
    const groupsHtml = `<div class="resume-form-container"><h2 class="resume-form-title">获奖经历</h2><form><label>奖项名称<input></label></form></div>`
      + (separate ? `<div class="resume-form-container"><h2 class="resume-form-title">竞赛经历</h2><form><label>竞赛名称<input></label></form></div>` : "");
    const { dom, scan } = fixture(groupsHtml);
    try {
      const context = await createPlanContext(scan(), ledger);
      const groupMappings = context.page.groups.map((group) => ({ groupId: group.id,
        sectionKeys: separate ? [group.label === "获奖经历" ? "awards" : "competitions"] : ["awards", "competitions"] }));
      const fieldMappings = context.page.fields.map((field) => ({ fieldId: field.id,
        sourcePath: `${field.label === "奖项名称" ? "awards" : "competitions"}.0.title` }));
      const proposal = { snapshotId: context.snapshotId, groupMappings, fieldMappings, unresolved: [] };
      const plan = await buildFillPlan(context, proposal);
      assert.equal(plan.summary.additionalEntries, separate ? 5 : 6);
      assert.equal(plan.sections.reduce((count, group) => count + group.profileEntries, 0), 7);
      assert.deepEqual(plan.unplacedSections, []);
      if (separate) {
        proposal.groupMappings[0].sectionKeys.push("competitions");
        await assert.rejects(buildFillPlan(context, proposal), { code: "PLAN_DUPLICATE_REFERENCE" });
      }
    } finally { dom.window.close(); }
  }
});

test("empty add sections can plan their first records, while empty consent sections remain manual", async () => {
  const { dom, scan } = fixture(`<section data-agent-group><h2>教育经历</h2><button type="button">添加教育经历</button></section>
    <section data-agent-group><h2>有关声明</h2><button type="button">添加声明</button></section>`);
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    const education = context.page.groups.find((group) => group.label === "教育经历");
    const consent = context.page.groups.find((group) => group.label === "有关声明");
    assert.equal(context.page.fields.length, 0);
    assert.equal(education.hasAddCandidate, true);
    const proposal = { snapshotId: context.snapshotId, groupMappings: [{ groupId: education.id, sectionKeys: ["educations"] }],
      fieldMappings: [], unresolved: [] };
    const plan = await buildFillPlan(context, proposal);
    assert.equal(plan.sections.find((section) => section.groupId === education.id).additionalEntries, 2);
    await assert.rejects(buildFillPlan(context, { ...proposal,
      groupMappings: [{ groupId: consent.id, sectionKeys: ["educations"] }] }), { code: "PLAN_MANUAL_TARGET" });
  } finally { dom.window.close(); }
});

test("changes during model latency invalidate the plan and tab changes stop before the model", async () => {
  const { dom, scan } = fixture();
  try {
    await assert.rejects(generateReadOnlyPlan({ scan, ledger: createSyntheticLedger(), planner: {
      async planMappings(context) { dom.window.document.getElementById("major").value = "虚构人工修改"; return proposalFor(context); },
    } }), { code: "PLAN_PAGE_CHANGED" });
    let requests = 0;
    await assert.rejects(generateReadOnlyPlan({ scan, ledger: createSyntheticLedger(),
      assertSelection: async () => { throw new Error("tab changed"); },
      planner: { async planMappings() { requests += 1; } },
    }), { code: "PLAN_PAGE_CHANGED" });
    assert.equal(requests, 0);
  } finally { dom.window.close(); }
});

test("planning transport has one non-executable tool and rejects value-bearing input or output", async () => {
  const { dom, scan } = fixture();
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    let requests = 0;
    let returned;
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://api.example.test/v1", apiKey: "fake-key", model: "fixture-model",
      fetchImpl: async (_url, init) => {
        requests += 1;
        const body = JSON.parse(init.body);
        assert.deepEqual(body.tools.map((tool) => tool.function.name), ["propose_form_mapping"]);
        assert.equal(body.tools[0].function.parameters.additionalProperties, false);
        const mappings = body.tools[0].function.parameters.properties.fieldMappings.items.properties;
        assert.deepEqual(mappings.fieldId.enum, context.page.fields.filter((field) => field.groupId === context.page.groups[0].id).map((field) => field.id));
        assert.deepEqual(mappings.sourcePath.enum, context.profileCatalog.filter((fact) => fact.entryIndex === 0).map((fact) => fact.path));
        for (const { value } of syntheticProfileFields) assert.equal(init.body.includes(value), false);
        assert.equal(init.body.includes("虚构声明内容"), false);
        assert.equal(JSON.stringify(context).includes("control-"), false);
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function",
          function: { name: "propose_form_mapping", arguments: JSON.stringify(returned) } }] } }] }));
      },
    });
    returned = proposalFor(context);
    assert.deepEqual(await planner.planMappings(context), returned);
    const badInput = structuredClone(context);
    badInput.profileCatalog[0].value = "虚构泄露值";
    await assert.rejects(planner.planMappings(badInput), { code: "PLAN_CONTEXT_INVALID" });
    assert.equal(requests, 1);
    returned.fieldMappings[0].value = "虚构编造值";
    await assert.rejects(planner.planMappings(context), { code: "PLAN_MODEL_RESPONSE_INVALID" });
    returned = proposalFor(context);
    const feedback = { code: "PLAN_RECORD_MISMATCH", diagnostic: { violation: "record_out_of_order", expectedRecords: ["educations.0"], proposedRecords: ["educations.1"] } };
    let feedbackPayload;
    planner.fetchImpl = async (_url, init) => {
      feedbackPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function",
        function: { name: "propose_form_mapping", arguments: JSON.stringify(returned) } }] } }] }));
    };
    await planner.planMappings(context, feedback);
    const prompt = feedbackPayload.messages.find((message) => message.role === "user").content;
    assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("{"))).validationFeedback, feedback);
    for (const { value } of syntheticProfileFields) assert.equal(prompt.includes(value), false);
    await assert.rejects(planner.planMappings(context, { ...feedback, rawValue: "PRIVATE" }), { code: "PLAN_FEEDBACK_INVALID" });
    const tampered = structuredClone(context);
    tampered.page.fields[0].label = "changed";
    await assert.rejects(validatePlanContext(tampered), { code: "PLAN_SNAPSHOT_INVALID" });
  } finally { dom.window.close(); }
});

test("extension socket round-trip validates planning metadata and rejects illegal model references", async () => {
  const { dom, scan } = fixture();
  const server = createServer((_request, response) => response.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let requests = 0;
  let illegal = false;
  const sockets = attachAgentSocket(server, { port, contextSchema: z.object({ goal: z.string() }).strict(),
    planner: { async planMappings(context, feedback) {
      requests += 1;
      if (feedback) validatePlanFailureFeedback(context, feedback);
      const proposal = proposalFor(context);
      if (illegal) proposal.fieldMappings[0].sourcePath = "unknown.0.school";
      return proposal;
    } },
  });
  class ExtensionSocket extends WebSocket {
    constructor(socketUrl) { super(socketUrl, { origin: EXTENSION_ORIGIN }); }
  }
  const client = new LocalModelSocket(`ws://127.0.0.1:${port}/agent`, ExtensionSocket);
  try {
    const context = await createPlanContext(scan(), createSyntheticLedger());
    await client.connect();
    assert.deepEqual(await client.planMappings(context), proposalFor(context));
    const invalid = structuredClone(context);
    invalid.page.fields[0].value = "虚构输入框值";
    await assert.rejects(client.planMappings(invalid), { code: "PLAN_CONTEXT_INVALID" });
    assert.equal(requests, 1);
    illegal = true;
    await assert.rejects(client.planMappings(context), (error) => {
      assert.equal(error.code, "PLAN_UNKNOWN_REFERENCE");
      assert.equal(error.diagnostic.violation, "unknown_source");
      assert.ok(error.partial);
      assert.equal(JSON.stringify(error.partial).includes("unknown.0.school"), false);
      return true;
    });
    illegal = false;
    assert.deepEqual(await client.planMappings(context, { code: "PLAN_RECORD_MISMATCH" }), proposalFor(context));
    illegal = true;
    const written = [];
    const run = await runRealForm({ ledger: createSyntheticLedger(), planner: client,
      environment: { async observe() { return scan(); }, async add() { return { verified: false, code: "ADD_CONTROL_UNAVAILABLE" }; },
        async fill(item) { written.push(item.sourcePath); return { verified: true, code: "VERIFIED" }; } },
    });
    assert.equal(run.result.modelCalls, 3);
    assert.equal(run.result.discardedMappingCount, 1);
    assert.deepEqual(written, ["educations.0.major"]);
    assert.equal(run.result.agentWrittenFields, 1);
  } finally {
    client.close();
    dom.window.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
