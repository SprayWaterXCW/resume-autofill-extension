const parts = Object.freeze({ year: ["Year", "年"], month: ["Month", "月"], day: ["Day", "日"] });

/** Private, reversible projections for every confirmed date, across sections. */
export function withDateParts(ledger) {
  const additions = [], values = new Map();
  for (const fact of ledger.publicFacts) {
    if (!/(?:Date|date|日期)$/.test(fact.path) || !["verified", "user_confirmed"].includes(fact.status)) continue;
    const value = ledger.getValue(fact.path);
    const match = /^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?[日月]?$/.exec(value || "");
    if (!match || +match[1] < 1900 || +match[1] > 2200 || +match[2] < 1 || +match[2] > 12) continue;
    if (match[3] && (+match[3] < 1 || +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate())) continue;
    for (const [part, [suffix, label]] of Object.entries(parts)) {
      const component = match[{ year: 1, month: 2, day: 3 }[part]];
      if (!component) continue; // No invented day for a year/month fact.
      if (ledger.publicFacts.length + additions.length >= 1200) break;
      const path = fact.path + suffix;
      if (ledger.hasPath(path)) continue;
      values.set(path, String(Number(component)));
      additions.push(Object.freeze({ path, label: (fact.label + `（${label}）`).slice(0, 180), sectionKey: fact.sectionKey,
        entryIndex: fact.entryIndex, status: fact.status, evidenceCount: fact.evidenceCount,
        derivedFrom: [fact.path], derivation: `date_${part}` }));
    }
  }
  return Object.freeze({ ...ledger, publicFacts: Object.freeze([...ledger.publicFacts, ...additions]),
    publicEntries: Object.freeze([...ledger.publicEntries, ...additions.map(({ path, label }) => ({ path, label }))]),
    hasPath: (path) => values.has(path) || ledger.hasPath(path),
    getValue: (path) => values.has(path) ? values.get(path) : ledger.getValue(path) });
}

export function datePartCompatible(field, fact) {
  if (field.kind === "date" && !field.datePart && /^date_(year|month|day)$/.test(fact.derivation || "")) return false;
  if (field.datePart && !(fact.derivation === `date_${field.datePart}`
    || new RegExp(field.datePart + "$", "i").test(fact.path))) return false;
  if (field.dateRole && !new RegExp(`\\.${field.dateRole}Date(?:Year|Month|Day)?$`, "i").test(fact.path)) return false;
  // Explicit date captions must not borrow an unrelated date that happens to
  // have the same unit. This applies even to a fragmented/fallback observation.
  const text = field.label || "";
  if (/获奖|奖项|award|prize/i.test(text) && (field.datePart || field.kind === "date")) {
    return /^(?:awards|competitions)\.\d+\.(?:date|awardDate|receivedDate)(?:Year|Month|Day)?$/i.test(fact.path);
  }
  if (/出生|birth/i.test(text) && (field.datePart || field.kind === "date")) return /(?:birthDate|birthday)(?:Year|Month|Day)?$/i.test(fact.path);
  if (/毕业|graduation/i.test(text) && (field.datePart || field.kind === "date")) return /(?:endDate|graduation(?:Date|Year|Month|Day))(?:Year|Month|Day)?$/i.test(fact.path)
    && /^(?:educations\.|formAnswers\.)/.test(fact.path);
  return true;
}
