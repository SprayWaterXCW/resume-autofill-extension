import test from "node:test";
import assert from "node:assert/strict";
import { createProfileLedger } from "../src/core/profile-ledger.js";

const sources = [
  { id: "current_resume", kind: "document" }, { id: "old_resume", kind: "document" },
  { id: "answer", kind: "user_confirmation" }, { id: "model", kind: "model_suggestion" },
];
const candidate = (sourceId, value, status = "verified") => ({ sourceId, value, status });
const fact = (candidates, extra = {}) => ({
  path: "educations.0.school", label: "毕业院校", sectionKey: "educations", entryIndex: 0, candidates, ...extra,
});
const ledger = (facts) => createProfileLedger({ schemaVersion: 1, sources, facts });

test("conflicting verified sources stay unavailable until an explicit resolution", () => {
  const candidates = [candidate("current_resume", "虚构院校甲"), candidate("old_resume", "虚构院校乙")];
  const unresolved = ledger([fact(candidates)]);
  assert.equal(unresolved.publicFacts[0].status, "conflicting");
  assert.equal(unresolved.hasPath("educations.0.school"), false);
  assert.equal(unresolved.getValue("educations.0.school"), undefined);
  assert.equal(unresolved.publicEntries.length, 0);
  const resolved = ledger([fact(candidates, { selectedSourceId: "current_resume" })]);
  assert.equal(resolved.getValue("educations.0.school"), "虚构院校甲");
  assert.equal(resolved.publicFacts[0].evidenceCount, 2);
  assert.equal(JSON.stringify(resolved).includes("虚构院校"), false);
});

test("model suggestions, placeholders, and unverified candidates cannot become factual values", () => {
  for (const candidates of [
    [candidate("model", "虚构模型猜测", "verified")],
    [candidate("current_resume", "虚构未核实", "unverified")],
    [candidate("answer", "<SCHOOL>", "user_confirmed")],
    [candidate("answer", "虚构临时答案", "application_placeholder")],
  ]) {
    const result = ledger([fact(candidates)]);
    assert.equal(result.publicFacts[0].status, "unknown");
    assert.equal(result.getValue("educations.0.school"), undefined);
    assert.throws(() => ledger([fact(candidates, { selectedSourceId: candidates[0].sourceId })]), /PROFILE_RESOLUTION_UNVERIFIED/);
  }
});

test("matching evidence yields a private value and invalid provenance or record metadata fails", () => {
  const result = ledger([fact([
    candidate("current_resume", "虚构相同院校"), candidate("answer", "虚构相同院校", "user_confirmed"),
  ])]);
  assert.equal(result.publicFacts[0].status, "user_confirmed");
  assert.equal(result.publicFacts[0].evidenceCount, 2);
  assert.equal(result.getValue("educations.0.school"), "虚构相同院校");
  assert.throws(() => ledger([fact([candidate("missing", "虚构院校")])]), /PROFILE_SOURCE_INVALID/);
  assert.throws(() => ledger([fact([], { entryIndex: 1 })]), /PROFILE_RECORD_MISMATCH/);
  assert.throws(() => ledger([fact([]), fact([])]), /PROFILE_PATH_DUPLICATE/);
});
