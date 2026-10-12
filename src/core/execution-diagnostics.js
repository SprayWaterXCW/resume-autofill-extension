import { z } from "zod";
import { controlDiagnosticSchema, safeControlDiagnostic } from "./control-diagnostics.js";
import { pageDiagnosticSchema, safePageDiagnostic } from "./page-lifecycle-diagnostics.js";

const count = z.number().int().min(0).max(100_000);
const structureCounts = z.object({ groups: count, fields: count, controls: count }).strict();
export const structureDiagnosticSchema = z.object({
  before: structureCounts, after: structureCounts, changedCount: count,
  changes: z.array(z.object({ area: z.enum(["report", "groups", "fields", "controls", "omitted"]),
    index: count.optional(), id: z.string().regex(/^(field|group|control)-\d+$/).optional(),
    properties: z.array(z.enum(["missing", "url", "presence", "id", "label", "source", "entryCount", "fieldCount", "groupId", "entryIndex", "labelSource", "entrySource", "kind", "datePart", "dateRole", "required", "disabled", "readOnly", "valueExcluded", "optionLabel", "tag", "type", "intent", "omittedFieldCount", "omittedControlCount", "frameCount", "shadowHostCount"])).max(20),
  }).strict()).max(40),
}).strict();
export const executionEventSchema = z.object({
  step: count.optional(), phase: z.enum(["规则", "观察", "计划", "恢复", "核验", "执行", "复核", "完成", "失败"]),
  tool: z.string().regex(/^[a-z_]{1,40}$/), code: z.string().regex(/^[A-Z_]{1,80}$/).optional(),
  fieldId: z.string().regex(/^field-\d+$/).optional(), groupId: z.string().regex(/^group-\d+$/).optional(),
  sourcePath: z.string().regex(/^[a-zA-Z]+(?:\.[a-zA-Z0-9]+){1,3}$/).max(120).optional(),
  structureDiagnostic: structureDiagnosticSchema.optional(),
  diagnostic: controlDiagnosticSchema.optional(),
  pageDiagnostic: pageDiagnosticSchema.optional(),
  progress: z.object({ agentAddedCards: count, agentWrittenFields: count, step: count, modelCalls: count }).strict().optional(),
  counts: z.record(z.string().regex(/^[a-zA-Z_]{1,40}$/), count).optional(),
}).strict();

/** Automatic local troubleshooting deliberately drops all free text and data. */
export function executionDiagnostic(event) {
  const safe = {};
  for (const key of ["step", "phase", "tool", "code", "fieldId", "groupId", "sourcePath", "structureDiagnostic", "progress", "counts"]) {
    if (event[key] !== undefined && event[key] !== null) safe[key] = event[key];
  }
  const diagnostic = safeControlDiagnostic(event.diagnostic);
  if (diagnostic) safe.diagnostic = diagnostic;
  const pageDiagnostic = safePageDiagnostic(event.pageDiagnostic);
  if (pageDiagnostic) safe.pageDiagnostic = pageDiagnostic;
  const parsed = executionEventSchema.safeParse(safe);
  return parsed.success ? parsed.data : null;
}
