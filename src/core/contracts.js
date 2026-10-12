import { z } from "zod";

export const decisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("act"),
    tool: z.string().min(1),
    args: z.unknown(),
    rationale: z.string().trim().min(1).max(160).optional(),
    discardedProposals: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({ kind: z.literal("finish") }).strict(),
  z.object({
    kind: z.literal("halt"),
    reason: z.enum(["ambiguous_mapping", "unsafe_page", "unsupported_control", "missing_profile"]),
  }).strict(),
]);

export const toolSchemas = Object.freeze({
  add_entry: z.object({ sectionKey: z.string().min(1) }).strict(),
  fill_field: z.object({
    fieldId: z.string().min(1),
    sourcePath: z.string().min(1),
  }).strict(),
});
