import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { OpenAICompatiblePlanner } from "../src/llm/openai-compatible-planner.js";
import { attachAgentSocket } from "./agent-socket.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.RESUME_AGENT_DEMO_PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid demo port");
const apiKey = process.env.RESUME_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.RESUME_AGENT_BASE_URL || "https://api.deepseek.com";
const modelName = process.env.RESUME_AGENT_MODEL || "deepseek-flash";
const planner = apiKey ? new OpenAICompatiblePlanner({
  baseUrl, apiKey, model: modelName,
  timeoutMs: Number(process.env.RESUME_AGENT_TIMEOUT_MS || 120_000),
  disableThinking: new URL(baseUrl).hostname === "api.deepseek.com",
}) : null;

const str = (max = 500) => z.string().max(max);
const fieldSchema = z.object({
  id: str(100), label: str(), sectionKey: str(100), entryIndex: z.number().int().nonnegative(),
  writable: z.boolean(), filled: z.boolean(),
}).strict();
const controlSchema = z.object({
  id: str(100), text: str(), intent: str(100), role: str(30), type: str(30), formAction: z.string().nullable(),
}).strict();
const contextSchema = z.object({
  goal: str(1000),
  page: z.object({
    pageId: str(100),
    sections: z.array(z.object({ key: str(100), label: str(), entryCount: z.number().int().nonnegative(), addControl: controlSchema.nullable() }).strict()).max(10),
    fields: z.array(fieldSchema).max(100),
    otherControls: z.array(z.object({ id: str(100), text: str(), role: str(30), type: str(30), disabled: z.boolean().optional() }).strict()).max(30),
  }).strict(),
  profileCatalog: z.array(z.object({ path: str(100), label: str() }).strict()).max(100),
  history: z.array(z.object({
    step: z.number().int().positive(), kind: str(30), tool: str(100).optional(),
    target: z.object({ fieldId: str(100).optional(), sourcePath: str(100).optional(), sectionKey: str(100).optional() }).strict().optional(),
    allowed: z.boolean().optional(), verified: z.boolean().optional(), code: str(100),
    reason: str(100).optional(), httpStatus: z.number().int().optional(),
  }).strict()).max(40),
}).strict();

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./browser.js", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome114",
  write: false,
  logLevel: "silent",
});
const files = new Map([
  ["/", { type: "text/html; charset=utf-8", body: readFileSync(new URL("./index.html", import.meta.url)) }],
  ["/style.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("./style.css", import.meta.url)) }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: bundle.outputFiles[0].contents }],
  ["/real-form.html", { type: "text/html; charset=utf-8", body: readFileSync(new URL("./real-form.html", import.meta.url)) }],
  ["/real-form.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("./real-form.js", import.meta.url)) }],
  ["/real-form.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("./real-form.css", import.meta.url)) }],
  ["/fixtures/example-profile.json", { type: "application/json; charset=utf-8", body: readFileSync(new URL("../src/fixtures/real-profile.json", import.meta.url)) }],
]);
let probeHits = 0;
let probePixelHits = 0;

function respond(response, status, type, body) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'",
  });
  response.end(body);
}

function json(response, status, value) {
  respond(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 80_000) throw Object.assign(new Error("Request too large"), { httpStatus: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    json(response, 403, { code: "LOCAL_HOST_ONLY" });
    return;
  }
  const path = new URL(request.url, `http://${host}`).pathname;
  if (request.method === "GET" && path === "/api/status") {
    json(response, 200, { serviceId: "resume-agent-demo", pid: process.pid, modelConfigured: Boolean(planner), model: planner ? modelName : null });
    return;
  }
  if (request.method === "GET" && path === "/api/probe/status") {
    json(response, 200, { probeHits, probePixelHits });
    return;
  }
  if (request.method === "GET" && path === "/api/probe/pixel") {
    // Empty local image request: tests Chrome DNR independently of fetch hooks.
    probePixelHits += 1;
    respond(response, 200, "image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    return;
  }
  if (request.method === "POST" && path === "/api/probe/event") {
    if (request.headers.origin !== `http://127.0.0.1:${port}` || request.headers["x-demo-probe"] !== "1") {
      json(response, 403, { code: "LOCAL_PROBE_ONLY" });
      return;
    }
    probeHits += 1;
    json(response, 200, { probeHits });
    return;
  }
  if (request.method === "POST" && path === "/api/decide") {
    const origin = request.headers.origin;
    if (!origin || (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)
      || !request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 403, { code: "SAME_ORIGIN_JSON_REQUIRED" });
      return;
    }
    if (!planner) { json(response, 503, { code: "MODEL_CONFIG_MISSING" }); return; }
    let context;
    try {
      context = contextSchema.parse(await readJson(request));
    } catch (error) {
      json(response, error?.httpStatus || 400, { code: "INVALID_CONTEXT" });
      return;
    }
    try {
      const previousDiscarded = planner.metrics.parallelCallsDiscarded;
      const decision = await planner.decide(context);
      const discarded = planner.metrics.parallelCallsDiscarded - previousDiscarded;
      if (discarded > 0) console.info("模型返回多个安全工具建议；仅执行首个并在下轮重新观察", JSON.stringify({ discarded }));
      json(response, 200, { decision });
    } catch (error) {
      console.error("模型决策失败", JSON.stringify({
        code: typeof error?.code === "string" ? error.code : "MODEL_RESPONSE_INVALID",
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
        ...(error?.details ? { details: error.details } : {}),
      }));
      json(response, 502, {
        code: typeof error?.code === "string" ? error.code : "MODEL_RESPONSE_INVALID",
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
        ...(error?.details ? { details: error.details } : {}),
      });
    }
    return;
  }
  if (request.method === "GET" && files.has(path)) {
    const file = files.get(path);
    respond(response, 200, file.type, file.body);
    return;
  }
  if (request.method === "GET" && path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  json(response, 404, { code: "NOT_FOUND" });
});

attachAgentSocket(server, { planner, contextSchema, port });

server.listen(port, "127.0.0.1", () => {
  console.log(`本地招聘演示页已启动：http://127.0.0.1:${port}`);
  console.log(`真实模型模式：${planner ? "已配置" : "未配置（快速演示仍可用）"}`);
  console.log(`项目目录：${projectRoot}`);
});
