import { WebSocket, WebSocketServer } from "ws";
import { validatePlanContext, buildFillPlan, createPartialProposal, FillPlanError, validatePlanFailureFeedback } from "../src/core/fill-plan.js";
import { randomUUID } from "node:crypto";
import { awardPlanningDiagnostic } from "../src/core/award-planning-diagnostics.js";
import { planResponseDiagnosticSchema } from "../src/core/plan-response-diagnostics.js";
import { formDiagnostic } from "../src/core/form-diagnostics.js";
import { modelHttpDiagnosticSchema } from "../src/core/model-http-diagnostics.js";
import { executionEventSchema } from "../src/core/execution-diagnostics.js";

export const EXTENSION_ORIGIN = "chrome-extension://lmgllncoafdghpeaoephgojaifocofbo";

/** The model runs locally; an invoked extension sends only field metadata. */
export function attachAgentSocket(server, { planner, contextSchema, port }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 250_000 });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/agent" || request.headers.host !== `127.0.0.1:${port}`
      || request.headers.origin !== EXTENSION_ORIGIN) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });

  sockets.on("connection", (client) => {
    const connectionId = randomUUID();
    client.on("message", async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); }
      catch { client.close(1003, "Invalid JSON"); return; }
      if (message?.type === "ping") {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message?.type === "execution_event") {
        const parsed = executionEventSchema.safeParse(message.event);
        if (parsed.success && /^[a-f0-9-]{36}$/.test(message.runId || "")) {
          console.info("扩展真实执行", JSON.stringify({ at: new Date().toISOString(), connectionId, runId: message.runId, ...parsed.data }));
        }
        return;
      }
      const id = message?.id;
      if (!["decide", "plan"].includes(message?.type) || !Number.isSafeInteger(id) || id < 1) {
        client.close(1003, "Invalid request");
        return;
      }
      if (message.type === "plan") {
        let context, feedback;
        try { context = await validatePlanContext(message.context);
          if (message.feedback) feedback = validatePlanFailureFeedback(context, message.feedback);
        }
        catch {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code: "PLAN_CONTEXT_INVALID" }));
          return;
        }
        if (!planner?.planMappings) {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code: "MODEL_CONFIG_MISSING" }));
          return;
        }
        let proposal;
        const started = Date.now();
        try {
          proposal = await planner.planMappings(context, feedback, { onProgress: (progress) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "plan_progress", id, ...progress }));
          } });
          const plan = await buildFillPlan(context, proposal);
          console.info("扩展表单规划", JSON.stringify({ at: new Date().toISOString(), connectionId,
            requestId: id, formDiagnostic: formDiagnostic(context, plan) }));
          const awardPlanning = awardPlanningDiagnostic(context, { proposal, plan });
          if (awardPlanning) console.info("扩展获奖规划", JSON.stringify({ at: new Date().toISOString(), connectionId,
            requestId: id, snapshotId: context.snapshotId.slice(0, 12), awardPlanning }));
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "mapping", id, proposal }));
        } catch (error) {
          const code = /^(PLAN_|MODEL_)[A-Z_]+$/.test(error?.code || "") ? error.code : "PLAN_MODEL_RESPONSE_INVALID";
          const diagnostic = error instanceof FillPlanError ? error.diagnostic : undefined;
          const parsedResponse = planResponseDiagnosticSchema.safeParse(error?.responseDiagnostic);
          const responseDiagnostic = parsedResponse.success ? parsedResponse.data : undefined;
          const parsedHttp = modelHttpDiagnosticSchema.safeParse(error?.httpDiagnostic);
          const httpDiagnostic = parsedHttp.success ? parsedHttp.data : undefined;
          let partial;
          if (proposal && diagnostic) { try { partial = await createPartialProposal(context, proposal); } catch { /* Invalid schema/snapshot remains fatal. */ } }
          const awardPlanning = awardPlanningDiagnostic(context, { proposal,
            failures: partial?.exclusions || [{ diagnostic }], discardedFieldIds: partial?.discardedFieldIds || [] });
          console.error("扩展计划生成失败", JSON.stringify({ at: new Date().toISOString(), connectionId, requestId: id,
            formDiagnostic: formDiagnostic(context),
            snapshotId: context.snapshotId.slice(0, 12), latencyMs: Date.now() - started, code,
            ...(diagnostic ? { diagnostic } : {}), ...(partial ? { exclusions: partial.exclusions, discardedFieldIds: partial.discardedFieldIds } : {}),
            ...(awardPlanning ? { awardPlanning } : {}),
            ...(responseDiagnostic ? { responseDiagnostic } : {}),
            ...(httpDiagnostic ? { httpDiagnostic } : {}),
            ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}) }));
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code,
            ...(diagnostic ? { diagnostic } : {}), ...(partial ? { partial } : {}),
            ...(responseDiagnostic ? { responseDiagnostic } : {}), ...(httpDiagnostic ? { httpDiagnostic } : {}) }));
        }
        return;
      }
      const parsed = contextSchema.safeParse(message.context);
      if (!parsed.success) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code: "INVALID_CONTEXT" }));
        return;
      }
      if (!planner) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code: "MODEL_CONFIG_MISSING" }));
        return;
      }
      try {
        const decision = await planner.decide(parsed.data);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "decision", id, decision }));
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "MODEL_RESPONSE_INVALID";
        console.error("扩展模型决策失败", JSON.stringify({ code, ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}) }));
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", id, code }));
      }
    });
  });

  return sockets;
}
