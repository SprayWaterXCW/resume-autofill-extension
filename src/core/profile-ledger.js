import { z } from "zod";

const key = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/);
const path = z.string().max(140).regex(/^[a-z][a-zA-Z0-9]*(?:\.(?:[a-z][a-zA-Z0-9]*|0|[1-9]\d*))+$/);
const inputSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(z.object({
    id: key,
    kind: z.enum(["user_confirmation", "document", "model_suggestion", "fixture"]),
  }).strict()).max(100),
  facts: z.array(z.object({
    path, label: z.string().trim().min(1).max(180), sectionKey: key,
    entryIndex: z.number().int().min(0).max(299),
    candidates: z.array(z.object({
      sourceId: key, value: z.string().trim().min(1).max(20_000),
      status: z.enum(["verified", "user_confirmed", "unverified", "application_placeholder"]),
    }).strict()).max(10),
    selectedSourceId: key.optional(),
  }).strict()).max(1200),
}).strict();

const trusted = (candidate, source) => source.kind !== "model_suggestion"
  && ["verified", "user_confirmed"].includes(candidate.status)
  && !/^<[^>]+>$|^\{\{.+\}\}$/.test(candidate.value);

/** Evidence is supplied by the user/importer; this does not verify a document's truth. */
export function createProfileLedger(input) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new TypeError("PROFILE_LEDGER_INVALID");
  const { sources, facts } = parsed.data;
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  if (sourcesById.size !== sources.length) throw new TypeError("PROFILE_SOURCE_DUPLICATE");
  const valuesByPath = new Map();
  const seen = new Set();
  const publicFacts = facts.map((fact) => {
    if (seen.has(fact.path)) throw new TypeError("PROFILE_PATH_DUPLICATE");
    seen.add(fact.path);
    const parts = fact.path.split(".");
    if (parts[0] !== fact.sectionKey
      || (/^\d+$/.test(parts[1]) ? Number(parts[1]) !== fact.entryIndex : fact.entryIndex !== 0)) {
      throw new TypeError("PROFILE_RECORD_MISMATCH");
    }
    const candidateIds = new Set();
    for (const candidate of fact.candidates) {
      if (!sourcesById.has(candidate.sourceId) || candidateIds.has(candidate.sourceId)) {
        throw new TypeError("PROFILE_SOURCE_INVALID");
      }
      candidateIds.add(candidate.sourceId);
    }
    const verified = fact.candidates.filter((item) => trusted(item, sourcesById.get(item.sourceId)));
    let chosen;
    let status = verified.length ? "conflicting" : "unknown";
    if (fact.selectedSourceId) {
      // A conflict can only be resolved by an explicit, supported source selection.
      chosen = verified.find((item) => item.sourceId === fact.selectedSourceId);
      if (!chosen) throw new TypeError("PROFILE_RESOLUTION_UNVERIFIED");
    } else if (new Set(verified.map((item) => item.value)).size === 1) {
      chosen = verified.find((item) => item.status === "user_confirmed") || verified[0];
    }
    if (chosen) {
      status = chosen.status;
      valuesByPath.set(fact.path, chosen.value);
    }
    return Object.freeze({
      path: fact.path, label: fact.label, sectionKey: fact.sectionKey, entryIndex: fact.entryIndex,
      status, evidenceCount: verified.length,
    });
  });
  return Object.freeze({
    publicFacts: Object.freeze(publicFacts),
    publicEntries: Object.freeze(publicFacts.filter((fact) => valuesByPath.has(fact.path))
      .map(({ path: factPath, label }) => Object.freeze({ path: factPath, label }))),
    hasPath: (factPath) => valuesByPath.has(factPath),
    getValue: (factPath) => valuesByPath.get(factPath),
  });
}
