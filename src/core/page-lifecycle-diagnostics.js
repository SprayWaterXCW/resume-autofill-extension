import { z } from "zod";

// Only lifecycle facts can cross the diagnostic boundary. Never include URLs,
// browser error messages, field contents or application payloads.
export const pageDiagnosticSchema = z.object({
  stage: z.enum(["startup", "bind", "scan", "tool", "input", "document", "lifecycle"]),
  trigger: z.enum(["start_failed", "tab_loading", "tab_closed", "tab_missing", "url_mismatch", "document_mismatch", "script_failed", "worker_restarted"]),
  cause: z.enum(["access_denied", "document_unavailable", "context_invalidated", "script_error"]).optional(),
  tabActive: z.boolean().optional(), tabDiscarded: z.boolean().optional(),
  tabLoading: z.boolean().optional(), urlMatched: z.boolean().optional(),
  outputCount: z.number().int().min(0).max(1000).optional(),
}).strict();

export function safePageDiagnostic(value) {
  if (!value || typeof value !== "object") return undefined;
  const safe = {};
  for (const [key, schema] of Object.entries(pageDiagnosticSchema.shape)) {
    if (value[key] !== undefined && schema.safeParse(value[key]).success) safe[key] = value[key];
  }
  const parsed = pageDiagnosticSchema.safeParse(safe);
  return parsed.success ? parsed.data : undefined;
}

export function scriptFailureCause(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/Cannot access|permission|not allowed/i.test(message)) return "access_denied";
  if (/No (?:such )?(?:document|frame)|(?:document|frame).*(?:not found|removed)/i.test(message)) return "document_unavailable";
  if (/context invalidated|extension.*unloaded/i.test(message)) return "context_invalidated";
  return "script_error";
}
