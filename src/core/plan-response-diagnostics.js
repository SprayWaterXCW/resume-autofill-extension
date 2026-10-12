import { z } from "zod";

const keys = ["snapshotId", "groupMappings", "groupId", "sectionKeys", "fieldMappings", "fieldId",
  "sourcePath", "semanticRole", "unresolved", "reason", "unknown_key"];
const types = ["string", "number", "boolean", "object", "array", "null", "undefined", "other"];
const issueCodes = ["invalid_type", "unrecognized_keys", "too_big", "too_small", "invalid_format",
  "invalid_value", "invalid_union", "custom", "other"];
const finishes = ["stop", "length", "tool_calls", "function_call", "content_filter", "unknown"];
const count = z.number().int().min(0).max(10_000_000);

/** Closed metadata contract: never response text, values, unknown keys or function names. */
export const planResponseDiagnosticSchema = z.object({
  version: z.literal(1),
  stage: z.enum(["tool_call_missing", "tool_call_count", "tool_call_invalid", "output_truncated",
    "arguments_json", "arguments_schema"]),
  finishReason: z.enum(finishes).nullable(), toolCallCount: count.nullable(),
  toolNameMatches: z.boolean(), hasContent: z.boolean(), hasReasoningContent: z.boolean(),
  argumentChars: count.nullable(), fieldCount: count, catalogCount: count, toolSchemaChars: count,
  inputTokens: count.nullable(), outputTokens: count.nullable(),
  issues: z.array(z.object({
    code: z.enum(issueCodes), path: z.array(z.union([z.enum(keys), count])).max(8),
    actualType: z.enum(types), expectedType: z.enum(types).optional(), unknownKeyCount: count.optional(),
  }).strict()).max(20),
}).strict();

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
const typeOf = (value) => value === null ? "null" : Array.isArray(value) ? "array"
  : types.includes(typeof value) ? typeof value : "other";

export function planResponseDiagnostic({ stage, payload, proposal, schemaError, fieldCount, catalogCount, toolSchemaChars }) {
  const choice = payload?.choices?.[0], message = choice?.message, calls = message?.tool_calls;
  const argument = Array.isArray(calls) ? calls[0]?.function?.arguments : null;
  const issues = (schemaError?.issues || []).slice(0, 20).map((issue) => {
    const originalPath = issue.path || [];
    let value = proposal;
    for (const key of originalPath) value = value?.[key];
    return {
      code: issueCodes.includes(issue.code) ? issue.code : "other",
      path: originalPath.slice(0, 8).map((key) => typeof key === "number" ? safeCount(key) ?? 0
        : keys.includes(key) ? key : "unknown_key"),
      actualType: typeOf(value),
      ...(types.includes(issue.expected) ? { expectedType: issue.expected } : {}),
      ...(Array.isArray(issue.keys) ? { unknownKeyCount: issue.keys.length } : {}),
    };
  });
  return planResponseDiagnosticSchema.parse({
    version: 1, stage,
    finishReason: typeof choice?.finish_reason === "string" ? finishes.includes(choice.finish_reason) ? choice.finish_reason : "unknown" : null,
    toolCallCount: Array.isArray(calls) ? safeCount(calls.length) : null,
    toolNameMatches: calls?.[0]?.function?.name === "propose_form_mapping",
    hasContent: typeof message?.content === "string" && message.content.length > 0,
    hasReasoningContent: typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0,
    argumentChars: typeof argument === "string" ? safeCount(argument.length) : null,
    fieldCount, catalogCount, toolSchemaChars,
    inputTokens: safeCount(payload?.usage?.prompt_tokens), outputTokens: safeCount(payload?.usage?.completion_tokens),
    issues,
  });
}
