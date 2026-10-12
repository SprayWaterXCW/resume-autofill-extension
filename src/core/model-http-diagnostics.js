import { z } from "zod";

const categories = ["invalid_tool_schema", "unsupported_request", "authentication", "rate_limit", "quota", "provider_failure", "unknown"];
const errorTypes = ["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "insufficient_quota", "server_error", "unknown"];
const parameters = ["tools", "tool_choice", "model", "messages", "thinking", "unknown"];
const count = z.number().int().min(0).max(1_000_000);

// A closed contract keeps provider messages, echoed requests and credentials out
// of execution records. Only categories and schema counts leave this module.
export const modelHttpDiagnosticSchema = z.object({
  version: z.literal(1), httpStatus: z.number().int().min(100).max(599),
  category: z.enum(categories), providerErrorType: z.enum(errorTypes), parameter: z.enum(parameters).nullable(),
  bodyParsed: z.boolean(), bodyTruncated: z.boolean(), emptyEnumCount: count, emptyUnionCount: count,
}).strict();

export async function modelHttpDiagnostic(response, tools) {
  let text = "", bodyTruncated = false, payload;
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16_384) { bodyTruncated = true; await reader.cancel(); break; }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch { /* The HTTP status still describes the failed request. */ }
    finally { reader.releaseLock(); }
  }
  try { if (!bodyTruncated) payload = JSON.parse(text); } catch { /* A non-JSON error exposes no contents. */ }
  const provider = payload?.error;
  const message = typeof provider?.message === "string" ? provider.message : "";
  let category = "unknown";
  if (response.status === 401 || response.status === 403) category = "authentication";
  else if (/quota|balance|credit|余额|额度/i.test(message)) category = "quota";
  else if (response.status === 429) category = "rate_limit";
  else if (response.status >= 500) category = "provider_failure";
  else if (/invalid schema|schema for function|json schema/i.test(message)) category = "invalid_tool_schema";
  else if (/unsupported|not support|unknown parameter|unrecognized parameter/i.test(message)) category = "unsupported_request";
  let emptyEnumCount = 0, emptyUnionCount = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) && !value.length) {
        if (key === "enum") emptyEnumCount++;
        if (["anyOf", "oneOf", "allOf"].includes(key)) emptyUnionCount++;
      }
      if (value && typeof value === "object") visit(value);
    }
  };
  for (const tool of tools) visit(tool.function?.parameters);
  return modelHttpDiagnosticSchema.parse({
    version: 1, httpStatus: response.status, category,
    providerErrorType: errorTypes.includes(provider?.type) ? provider.type : "unknown",
    parameter: provider?.param == null ? null : parameters.includes(provider.param) ? provider.param : "unknown",
    bodyParsed: Boolean(payload && typeof payload === "object"), bodyTruncated, emptyEnumCount, emptyUnionCount,
  });
}

export function modelHttpHint(diagnostic) {
  const parsed = modelHttpDiagnosticSchema.safeParse(diagnostic);
  if (!parsed.success) return "模型接口请求失败";
  const labels = { invalid_tool_schema: "接口拒绝了工具参数格式", unsupported_request: "接口不支持请求参数",
    authentication: "接口认证或访问权限失败", rate_limit: "接口请求频率受限", quota: "接口额度或余额不足",
    provider_failure: "模型服务内部错误", unknown: "模型接口请求失败" };
  return `HTTP ${parsed.data.httpStatus}：${labels[parsed.data.category]}`;
}
