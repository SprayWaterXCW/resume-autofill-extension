import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { z } from "zod";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { createProfileLedger } from "../src/core/profile-ledger.js";
import { createPlanContext, buildFillPlan } from "../src/core/fill-plan.js";
import { runRealForm } from "../src/core/real-runner.js";
import { planResponseDiagnostic, planResponseDiagnosticSchema } from "../src/core/plan-response-diagnostics.js";
import { largeFormPlanFixture } from "../src/fixtures/large-form-plan.js";
import { attachAgentSocket, EXTENSION_ORIGIN } from "../web-demo/agent-socket.js";
import { LocalModelSocket } from "../agent-extension/src/model-socket.js";
import { modelHttpDiagnosticSchema } from "../src/core/model-http-diagnostics.js";

function fixture() {
  const ledger = createProfileLedger({ schemaVersion: 1, sources: [{ id: "fixture", kind: "fixture" }],
    facts: [{ path: "personal.phoneNumber", label: "手机号码", sectionKey: "personal", entryIndex: 0,
      candidates: [{ sourceId: "fixture", value: "13900000000", status: "verified" }] }] });
  const report = { mode: "read-only", origin: "https://jobs.example.test",
    summary: { truncated: false, fieldCount: 1, groupCount: 1 },
    groups: [{ id: "group-1", label: "基本信息", entryCount: 1 }],
    fields: [{ id: "field-0", groupId: "group-1", entryIndex: 0, label: "手机号码", labelSource: "label",
      kind: "text", required: true, disabled: false, readOnly: false, hasValue: false, valueExcluded: false }], controls: [] };
  return { ledger, report };
}
const proposal = (context) => ({ snapshotId: context.snapshotId, groupMappings: [],
  fieldMappings: [{ fieldId: "field-0", sourcePath: "personal.phoneNumber" }], unresolved: [] });
const toolPayload = (args, finish = "tool_calls") => ({ choices: [{ finish_reason: finish, message: {
  tool_calls: [{ type: "function", function: { name: "propose_form_mapping", arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
} }], usage: { prompt_tokens: 123, completion_tokens: 45 } });
const plannerFor = (respond) => new OpenAICompatiblePlanner({ baseUrl: "https://api.example.test", apiKey: "fixture-key",
  model: "fixture-model", disableThinking: true,
  fetchImpl: async (_url, init) => new Response(JSON.stringify(await respond(JSON.parse(init.body)))) });
const stateFrom = (body) => JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf("{")));

test("repair requests only the conflicting region and validates the combined fresh proposal", async () => {
  const { report } = fixture();
  report.groups.push({ id: "group-2", label: "联系方式", entryCount: 1 });
  report.fields.push({ ...report.fields[0], id: "field-1", groupId: "group-2", label: "邮箱" });
  report.summary.fieldCount = 2; report.summary.groupCount = 2;
  const ledger = createProfileLedger({ schemaVersion: 1, sources: [{ id: "fixture", kind: "fixture" }], facts: [
    { path: "personal.phoneNumber", label: "手机号码", sectionKey: "personal", entryIndex: 0, candidates: [{ sourceId: "fixture", value: "13900000000", status: "verified" }] },
    { path: "personal.email", label: "邮箱", sectionKey: "personal", entryIndex: 0, candidates: [{ sourceId: "fixture", value: "fictional@example.test", status: "verified" }] },
  ] });
  const context = await createPlanContext(report, ledger), requested = [];
  const planner = plannerFor((body) => {
    const input = stateFrom(body), id = input.page.fields[0].id; requested.push(id);
    const mapping = { fieldId: id, sourcePath: id === "field-0" ? "personal.phoneNumber" : "personal.email" };
    return toolPayload({ snapshotId: input.snapshotId, groupMappings: [],
      fieldMappings: requested.length === 1 ? [mapping, mapping] : [mapping], unresolved: [] });
  });
  const first = await planner.planMappings(context);
  let failure;
  try { await buildFillPlan(context, first); } catch (error) { failure = error; }
  assert.equal(failure.code, "PLAN_DUPLICATE_REFERENCE");
  const repaired = await planner.planMappings(context, { code: failure.code, diagnostic: failure.diagnostic });
  const plan = await buildFillPlan(context, repaired);
  assert.deepEqual(requested, ["field-0", "field-1", "field-0"]);
  assert.equal(plan.items.filter((item) => item.sourcePath).length, 2);
});

test("region progress stays pending until the final mapping and forwards only known metadata", async () => {
  const { report, ledger } = fixture(), context = await createPlanContext(report, ledger);
  const server = createServer((_request, response) => response.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = attachAgentSocket(server, { port: server.address().port, contextSchema: z.object({}).strict(),
    planner: { async planMappings(input, _feedback, { onProgress }) {
      onProgress({ phase: "started", groupId: "unobserved", completedRegions: 0, totalRegions: 1 });
      onProgress({ phase: "started", groupId: "group-1", completedRegions: 0, totalRegions: 1, rawText: "PRIVATE_PROGRESS_MARKER" });
      onProgress({ phase: "completed", groupId: "group-1", completedRegions: 1, totalRegions: 1 });
      return proposal(input);
    } } });
  class ExtensionSocket extends WebSocket { constructor(url) { super(url, { origin: EXTENSION_ORIGIN }); } }
  const client = new LocalModelSocket(`ws://127.0.0.1:${server.address().port}/agent`, ExtensionSocket);
  const progress = [];
  try {
    await client.connect();
    const result = await client.planMappings(context, undefined, { onProgress: (event) => {
      assert.equal(client.pending.size, 1);
      progress.push(event);
    } });
    assert.deepEqual(result, proposal(context));
    assert.deepEqual(progress.map((event) => event.phase), ["started", "completed"]);
    assert.equal(JSON.stringify(progress).includes("PRIVATE_PROGRESS_MARKER"), false);
    assert.equal(client.pending.size, 0);
  } finally { client.close(); sockets.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("each malformed planning response has a closed diagnostic without response contents or unknown keys", async () => {
  const { report, ledger } = fixture(), context = await createPlanContext(report, ledger);
  const cases = [
    ["tool_call_missing", { choices: [{ finish_reason: "stop", message: { content: "PRIVATE_RESPONSE_MARKER" } }] }],
    ["tool_call_count", { choices: [{ message: { tool_calls: [toolPayload("{}").choices[0].message.tool_calls[0],
      { type: "function", function: { name: "PRIVATE_FUNCTION_MARKER", arguments: "PRIVATE_RESPONSE_MARKER" } }] } }] }],
    ["tool_call_invalid", { choices: [{ message: { tool_calls: [
      { type: "function", function: { name: "PRIVATE_FUNCTION_MARKER", arguments: "{}" } }] } }] }],
    ["output_truncated", toolPayload('{"PRIVATE_RESPONSE_MARKER":', "length")],
    ["arguments_json", toolPayload('{"PRIVATE_RESPONSE_MARKER":')],
    ["arguments_schema", toolPayload({ ...proposal(context), fieldMappings: [
      { ...proposal(context).fieldMappings[0], semanticRole: "PRIVATE_RESPONSE_MARKER" }] })],
    ["arguments_schema", toolPayload({ ...proposal(context), fieldMappings: [
      { ...proposal(context).fieldMappings[0], PRIVATE_KEY_MARKER: "PRIVATE_RESPONSE_MARKER" }] })],
  ];
  for (const [stage, payload] of cases) {
    const planner = plannerFor(() => payload);
    await assert.rejects(planner.planMappings(context), (error) => {
      assert.equal(error.code, "PLAN_MODEL_RESPONSE_INVALID");
      assert.equal(error.responseDiagnostic.stage, stage);
      assert.equal(planResponseDiagnosticSchema.safeParse(error.responseDiagnostic).success, true);
      const text = JSON.stringify(error.responseDiagnostic);
      for (const value of ["PRIVATE_RESPONSE_MARKER", "PRIVATE_FUNCTION_MARKER", "PRIVATE_KEY_MARKER", "13900000000"]) {
        assert.equal(text.includes(value), false);
      }
      if (stage === "arguments_schema") assert.ok(error.responseDiagnostic.issues.length);
      return true;
    });
  }
});

test("optional null and nonapplicable ordinary-field role annotations cannot change a reference or excuse extra values", async () => {
  const { report, ledger } = fixture(), context = await createPlanContext(report, ledger);
  for (const role of [null, "name", "description"]) {
    const annotated = proposal(context);
    annotated.fieldMappings[0].semanticRole = role;
    const result = await plannerFor(() => toolPayload(annotated)).planMappings(context);
    assert.deepEqual(result, proposal(context));
    assert.equal((await buildFillPlan(context, result)).items[0].sourcePath, "personal.phoneNumber");
  }
  const invalid = proposal(context);
  invalid.fieldMappings[0].value = "PRIVATE_RESPONSE_MARKER";
  invalid.fieldMappings[0].semanticRole = null;
  await assert.rejects(plannerFor(() => toolPayload(invalid)).planMappings(context), (error) => {
    assert.equal(error.responseDiagnostic.stage, "arguments_schema");
    assert.equal(error.responseDiagnostic.issues[0].unknownKeyCount, 1);
    assert.equal(JSON.stringify(error.responseDiagnostic).includes("PRIVATE_RESPONSE_MARKER"), false);
    return true;
  });
  const unknown = proposal(context);
  unknown.fieldMappings[0] = { fieldId: "not-observed", sourcePath: "personal.phoneNumber", semanticRole: "name" };
  const result = await plannerFor(() => toolPayload(unknown)).planMappings(context);
  await assert.rejects(buildFillPlan(context, result), { code: "PLAN_UNKNOWN_REFERENCE" });
});

test("format repair uses the existing three-attempt loop and performs no action before a valid proposal", async () => {
  const { report, ledger } = fixture(), events = [], writes = [], feedback = [];
  let calls = 0;
  const planner = plannerFor((body) => {
    assert.equal(writes.length, 0, "no action is allowed during response repair");
    assert.equal(JSON.stringify(body).includes("13900000000"), false);
    const context = stateFrom(body);
    feedback.push(context.validationFeedback);
    calls++;
    if (calls === 1) return { choices: [{ finish_reason: "stop", message: { content: "PRIVATE_RESPONSE_MARKER" } }] };
    if (calls === 2) return toolPayload("{");
    return toolPayload(proposal(context));
  });
  const run = await runRealForm({ ledger, planner, onEvent: (event) => events.push(event), environment: {
    async observe() { return structuredClone(report); },
    async add() { assert.fail("basic facts need no cards"); },
    async fill(item) { writes.push(item.sourcePath); report.fields[0].hasValue = true; return { verified: true, code: "VERIFIED" }; },
    async audit(targets) { return targets.map((item) => ({ fieldId: item.fieldId, sourcePath: item.sourcePath, verified: true, code: "VERIFIED" })); },
  } });
  assert.equal(run.result.modelCalls, 3);
  assert.equal(run.result.agentWrittenFields, 1);
  assert.deepEqual(writes, ["personal.phoneNumber"]);
  assert.equal(feedback[1].responseDiagnostic.stage, "tool_call_missing");
  assert.equal(feedback[2].responseDiagnostic.stage, "arguments_json");
  assert.equal(feedback[2].previousFailures[0].responseDiagnostic.stage, "tool_call_missing");
  assert.deepEqual(events.filter((event) => event.responseDiagnostic).map((event) => event.responseDiagnostic.stage),
    ["tool_call_missing", "arguments_json"]);
  assert.equal(JSON.stringify(events).includes("PRIVATE_RESPONSE_MARKER"), false);
});

test("three malformed proposals stop with all format events and zero browser actions", async () => {
  const { report, ledger } = fixture(), events = [];
  let actions = 0;
  const planner = plannerFor(() => toolPayload("{", "length"));
  await assert.rejects(runRealForm({ ledger, planner, onEvent: (event) => events.push(event),
    environment: { async observe() { return structuredClone(report); },
      async fill() { actions++; }, async add() { actions++; } },
  }), { code: "PLAN_MODEL_RESPONSE_INVALID" });
  assert.equal(planner.metrics.requests, 3);
  assert.equal(actions, 0);
  assert.equal(events.filter((event) => event.responseDiagnostic?.stage === "output_truncated").length, 3);
});

test("a page change during format repair invalidates the task before retry or write", async () => {
  const { report, ledger } = fixture();
  let actions = 0;
  const planner = plannerFor(() => { report.fields[0].hasValue = true; return toolPayload("{"); });
  await assert.rejects(runRealForm({ ledger, planner,
    environment: { async observe() { return structuredClone(report); },
      async fill() { actions++; }, async add() { actions++; } },
  }), { code: "REAL_PAGE_CHANGED" });
  assert.equal(planner.metrics.requests, 1);
  assert.equal(actions, 0);
});

test("large planning contracts stay bounded and enumerate only pending targets and their possible sources", async () => {
  const { report, ledger } = largeFormPlanFixture();
  let body;
  const planner = plannerFor((input) => { body = input; return toolPayload({
    snapshotId: stateFrom(input).snapshotId, groupMappings: [], fieldMappings: [], unresolved: [],
  }); });
  await planner.planMappings(await createPlanContext(report, ledger));
  assert.ok(JSON.stringify(body.tools).length < 80_000, "do not duplicate every source list for every field");
  assert.equal(JSON.stringify(body.tools).includes("sourceChoices"), false);
  for (const field of report.fields.slice(0, 56)) field.hasValue = true;
  await planner.planMappings(await createPlanContext(report, ledger, { fillMode: "empty" }));
  const parameters = body.tools[0].function.parameters.properties;
  assert.deepEqual(parameters.fieldMappings.items.properties.fieldId.enum, ["field-56"]);
  assert.deepEqual(parameters.unresolved.items.properties.fieldId.enum, ["field-56"]);
  assert.deepEqual(parameters.fieldMappings.items.properties.sourcePath.enum, ["awards.0.name"]);
  assert.ok(JSON.stringify(body.tools).length < 15_000);
  const view = stateFrom(body);
  assert.deepEqual(view.page.fields.map((field) => field.id), ["field-56"]);
  assert.deepEqual(view.profileCatalog.map((fact) => fact.path), ["awards.0.name"]);
  assert.equal(view.profileSections.find((section) => section.sectionKey === "competitions").recordCount, 5);
  assert.equal(view.observation.fullFieldCount, 57);
  assert.equal(view.observation.fullCatalogCount, 201);
  report.fields[56].hasValue = true;
  const requestsBefore = planner.metrics.requests;
  const result = await planner.planMappings(await createPlanContext(report, ledger, { fillMode: "empty" }));
  assert.equal(planner.metrics.requests, requestsBefore, "all protected fields need no model request");
  assert.deepEqual(result.fieldMappings, []);
  assert.deepEqual(result.unresolved, []);
});

test("a region without eligible facts is resolved locally and other regions keep valid provider schemas", async () => {
  const { report, ledger } = fixture();
  report.groups.push({ id: "group-2", label: "工作经历", entryCount: 1, hasAddCandidate: true, source: "heading-range" });
  report.fields.push({ ...report.fields[0], id: "field-1", groupId: "group-2", label: "公司名称" });
  report.summary.fieldCount = 2; report.summary.groupCount = 2;
  const bodies = [], planner = plannerFor((body) => {
    bodies.push(body);
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (["enum", "anyOf", "oneOf", "allOf"].includes(key)) assert.ok(value.length, "provider schema must not contain empty " + key);
        if (value && typeof value === "object") visit(value);
      }
    };
    visit(body.tools);
    return toolPayload(proposal(stateFrom(body)));
  });
  const context = await createPlanContext(report, ledger), result = await planner.planMappings(context);
  assert.equal(bodies.length, 1, "work experience with no qualified source requires no model call");
  assert.deepEqual(result.unresolved, [{ fieldId: "field-1", reason: "missing_profile" }]);
  assert.equal((await buildFillPlan(context, result)).items.find((item) => item.fieldId === "field-0").status, "mapped");
});

test("HTTP diagnostics survive the local socket but unknown response contents are discarded", async (context) => {
  const { report, ledger } = fixture(), input = await createPlanContext(report, ledger), logs = [];
  const diagnostic = modelHttpDiagnosticSchema.parse({ version: 1, httpStatus: 400, category: "invalid_tool_schema",
    providerErrorType: "invalid_request_error", parameter: "tools", bodyParsed: true, bodyTruncated: false,
    emptyEnumCount: 1, emptyUnionCount: 1 });
  context.mock.method(console, "error", (_message, json) => logs.push(JSON.parse(json)));
  const server = createServer((_request, response) => response.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let poison = false;
  const sockets = attachAgentSocket(server, { port, contextSchema: z.object({}).strict(), planner: {
    async planMappings() { throw Object.assign(new Error("MODEL_HTTP_ERROR"), { code: "MODEL_HTTP_ERROR", status: 400,
      httpDiagnostic: poison ? { ...diagnostic, rawMessage: "PRIVATE_RESPONSE_MARKER" } : diagnostic }); },
  } });
  class ExtensionSocket extends WebSocket { constructor(url) { super(url, { origin: EXTENSION_ORIGIN }); } }
  const client = new LocalModelSocket("ws://127.0.0.1:" + port + "/agent", ExtensionSocket);
  try {
    await client.connect();
    await assert.rejects(client.planMappings(input), (error) => {
      assert.deepEqual(error.httpDiagnostic, diagnostic); assert.equal(error.status, 400); return true;
    });
    assert.deepEqual(logs[0].httpDiagnostic, diagnostic);
    poison = true;
    await assert.rejects(client.planMappings(input), (error) => { assert.equal(error.httpDiagnostic, undefined); return true; });
    assert.equal(logs[1].httpDiagnostic, undefined);
    assert.equal(JSON.stringify(logs).includes("PRIVATE_RESPONSE_MARKER"), false);
  } finally {
    client.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server and extension round-trip only validated model format diagnostics", async (context) => {
  const { report, ledger } = fixture(), input = await createPlanContext(report, ledger);
  const diagnostic = planResponseDiagnostic({ stage: "arguments_json", payload: toolPayload("{"),
    fieldCount: 1, catalogCount: 1, toolSchemaChars: 100, proposal: null });
  const logs = [];
  context.mock.method(console, "error", (_message, json) => logs.push(JSON.parse(json)));
  const server = createServer((_request, response) => response.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let poison = false;
  const sockets = attachAgentSocket(server, { port, contextSchema: z.object({}).strict(),
    planner: { async planMappings() { throw Object.assign(new Error("PLAN_MODEL_RESPONSE_INVALID"), {
      code: "PLAN_MODEL_RESPONSE_INVALID", responseDiagnostic: poison
        ? { ...diagnostic, rawArguments: "PRIVATE_RESPONSE_MARKER" } : diagnostic,
    }); } } });
  class ExtensionSocket extends WebSocket {
    constructor(url) { super(url, { origin: EXTENSION_ORIGIN }); }
  }
  const client = new LocalModelSocket("ws://127.0.0.1:" + port + "/agent", ExtensionSocket);
  try {
    await client.connect();
    await assert.rejects(client.planMappings(input), (error) => {
      assert.deepEqual(error.responseDiagnostic, diagnostic);
      return true;
    });
    assert.deepEqual(logs[0].responseDiagnostic, diagnostic);
    poison = true;
    await assert.rejects(client.planMappings(input), (error) => {
      assert.equal(error.responseDiagnostic, undefined);
      return true;
    });
    assert.equal(logs[1].responseDiagnostic, undefined);
    assert.equal(JSON.stringify(logs).includes("PRIVATE_RESPONSE_MARKER"), false);
  } finally {
    client.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
