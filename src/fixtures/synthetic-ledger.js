import { createProfileLedger } from "../core/profile-ledger.js";
import { syntheticProfileFields } from "./synthetic-form.js";

export function createSyntheticLedger() {
  return createProfileLedger({
    schemaVersion: 1,
    sources: [{ id: "fictional_fixture", kind: "fixture" }],
    facts: syntheticProfileFields.map(({ path, label, value }) => ({
      path, label, sectionKey: "educations", entryIndex: Number(path.split(".")[1]),
      candidates: [{ sourceId: "fictional_fixture", value, status: "verified" }],
    })),
  });
}
