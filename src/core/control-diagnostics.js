import { z } from "zod";

const count = z.number().int().min(0).max(1000);
const counters = ["panelCount", "inputCount", "confirmCount", "yearSteps", "levelCount", "selectedCount",
  "inducedDateDefaultCount", "bindingRefreshCount", "checkedOptionCount", "selectedLabelCount"];
const flags = ["searched", "expanded", "hasCurrentValue", "identityVerified", "receiptPresent", "valueMatched", "validityValid", "pathMatched",
  "connected", "labelStable", "kindStable", "groupStable", "recordStable", "replacedDateDefault", "bindingRefreshed", "structureMatched",
  "panelClosed", "rowSelected", "displayOnInput", "displayOnContent", "selectionRowReplaced",
  "documentFocused", "editInserted", "inputEventObserved", "trustedInputObserved", "valueMatchedAfterEdit", "valueMatchedAfterChange", "valueMatchedAfterBlur",
  "targetMatched", "contentProtected", "pageStateObserved", "pageStateMatched", "pageStateMatchedBefore", "pageStateDomMatchedBefore", "mainWorldSetterUsed", "changeEventObserved",
  "blurEventObserved", "focusOutEventObserved", "syntheticBlurUsed"];
export const controlDiagnosticSchema = z.object({
  phase: z.enum(["open", "search", "commit", "precision", "audit", "navigate", "wait", "select"]).optional(),
  adapter: z.enum(["dropdown", "award_choice", "field_identity", "phoenix_calendar", "phoenix_month_calendar", "readback", "phoenix_choice",
    "native_text", "native_edit", "page_input", "beisen_constant_picker", "beisen_area_picker"]).optional(),
  awardAxis: z.enum(["scope", "rank"]).optional(), sourcePrecision: z.enum(["month", "day"]).optional(), targetPrecision: z.enum(["month", "day"]).optional(),
  waitedMs: z.number().int().min(0).max(60_000).optional(),
  ...Object.fromEntries(counters.map((key) => [key, count.optional()])),
  ...Object.fromEntries(flags.map((key) => [key, z.boolean().optional()])),
}).strict();

/** Logs accept counts and predefined states, never option text or private values. */
export function safeControlDiagnostic(input) {
  if (!input || typeof input !== "object") return undefined;
  const safe = {};
  for (const [key, schema] of Object.entries(controlDiagnosticSchema.shape)) {
    if (input[key] !== undefined && schema.safeParse(input[key]).success) safe[key] = input[key];
  }
  return Object.keys(safe).length ? safe : undefined;
}
