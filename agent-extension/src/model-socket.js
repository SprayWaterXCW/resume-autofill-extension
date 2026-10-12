const SOCKET_URL = "ws://127.0.0.1:4174/agent";

/** Model requests stay on localhost; the socket also keeps an MV3 run alive. */
export class LocalModelSocket {
  constructor(url = SOCKET_URL, WebSocketImpl = WebSocket) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.keepAlive = null;
  }

  async connect() {
    if (this.socket) throw new Error("Model socket is already connected");
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("无法连接本机模型服务，请启动 npm run demo:web"));
      socket.onclose = () => reject(new Error("本机模型连接已关闭"));
    });
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { return; }
      if (message.type === "pong") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "plan_progress") {
        if (pending.context?.page?.groups.some((group) => group.id === message.groupId)
          && ["started", "completed"].includes(message.phase)
          && Number.isInteger(message.totalRegions) && message.totalRegions > 0 && message.totalRegions <= 160
          && Number.isInteger(message.completedRegions) && message.completedRegions >= 0 && message.completedRegions <= message.totalRegions) {
          pending.onProgress?.({ groupId: message.groupId, phase: message.phase,
            completedRegions: message.completedRegions, totalRegions: message.totalRegions });
        }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.type === pending.expectedType) pending.resolve(message[pending.resultKey]);
      else {
        const code = /^(PLAN_|MODEL_)[A-Z_]+$/.test(message.code || "") ? message.code : "MODEL_RESPONSE_INVALID";
        const error = Object.assign(new Error(code), { code });
        const responseDiagnostic = planResponseDiagnosticSchema.safeParse(message.responseDiagnostic);
        if (responseDiagnostic.success) error.responseDiagnostic = responseDiagnostic.data;
        const httpDiagnostic = modelHttpDiagnosticSchema.safeParse(message.httpDiagnostic);
        if (httpDiagnostic.success) { error.httpDiagnostic = httpDiagnostic.data; error.status = httpDiagnostic.data.httpStatus; }
        if (pending.context?.page && message.diagnostic) {
          try { error.diagnostic = validatePlanFailureFeedback(pending.context, { code, diagnostic: message.diagnostic }).diagnostic; }
          catch { /* Untrusted error metadata is not logged or returned. */ }
        }
        const partial = partialProposalSchema.safeParse(message.partial);
        if (partial.success) error.partial = partial.data; // Caller independently validates all references before using it.
        pending.reject(error);
      }
    };
    socket.onclose = () => this.failPending("本机模型连接已关闭");
    socket.onerror = () => this.failPending("本机模型连接出错");
    this.keepAlive = setInterval(() => {
      if (socket.readyState === this.WebSocketImpl.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
  }

  failPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  request(type, context, expectedType, resultKey, feedback, onProgress) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("本机模型连接已断开");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("MODEL_TIMEOUT");
        error.code = "MODEL_TIMEOUT";
        reject(error);
      }, 135_000);
      this.pending.set(id, { resolve, reject, timer, expectedType, resultKey, context, onProgress });
      this.socket.send(JSON.stringify({ type, id, context, ...(feedback ? { feedback } : {}) }));
    });
  }

  decide(context) { return this.request("decide", context, "decision", "decision"); }
  planMappings(context, feedback, { onProgress } = {}) { return this.request("plan", context, "mapping", "proposal", feedback, onProgress); }

  reportExecution(runId, event) {
    const safe = executionDiagnostic(event);
    if (safe && this.socket?.readyState === this.WebSocketImpl.OPEN) {
      try { this.socket.send(JSON.stringify({ type: "execution_event", runId, event: safe })); }
      catch { /* Diagnostics cannot interrupt form execution. */ }
    }
  }

  close() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.failPending("本机模型连接已关闭");
    if (this.socket && this.socket.readyState !== this.WebSocketImpl.CLOSED) {
      try { this.socket.close(); } catch { /* Connection may still be opening. */ }
    }
    this.socket = null;
  }
}
import { validatePlanFailureFeedback, partialProposalSchema } from "../../src/core/fill-plan.js";
import { planResponseDiagnosticSchema } from "../../src/core/plan-response-diagnostics.js";
import { modelHttpDiagnosticSchema } from "../../src/core/model-http-diagnostics.js";
import { executionDiagnostic } from "../../src/core/execution-diagnostics.js";
