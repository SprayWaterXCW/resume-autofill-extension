/** Select a unique latest record from confirmed dates, without exporting values. */
export function withLatestRecordAnswers(ledger) {
  const additions = [], values = new Map(), sections = new Map();
  const trusted = (fact) => fact && ["verified", "user_confirmed"].includes(fact.status);
  const interval = (value) => {
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value || "");
    if (!match || +match[1] < 1900 || +match[1] > 2200 || +match[2] < 1 || +match[2] > 12) return null;
    const days = new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate();
    if (match[3] && (+match[3] < 1 || +match[3] > days)) return null;
    const month = +match[1] * 10000 + +match[2] * 100;
    return { from: month + +(match[3] || 1), to: month + +(match[3] || days) };
  };
  const originals = ledger.publicFacts.filter((fact) => /^\d+$/.test(fact.path.split(".")[1]) && !fact.derivedFrom);
  for (const fact of originals) {
    if (!sections.has(fact.sectionKey)) sections.set(fact.sectionKey, new Set());
    sections.get(fact.sectionKey).add(fact.entryIndex);
  }
  for (const [section, entries] of sections) {
    let winner, comparison = [];
    for (const key of ["endDate", "startDate"]) {
      const dates = [...entries].map((index) => {
        const path = `${section}.${index}.${key}`, fact = originals.find((fact) => fact.path === path);
        const value = trusted(fact) ? ledger.getValue(path) : "";
        return { index, path, present: Boolean(value), range: interval(value) };
      });
      if (dates.every((date) => !date.present)) continue;
      if (dates.some((date) => !date.range)) break;
      const winners = dates.filter((candidate) => dates.every((other) => candidate === other || candidate.range.from > other.range.to));
      if (winners.length === 1) { winner = winners[0].index; comparison = dates.map((date) => date.path); }
      break; // An overlapping end-date interval cannot be resolved by guessing from start dates.
    }
    if (winner === undefined) continue;
    for (const fact of originals.filter((fact) => fact.sectionKey === section && fact.entryIndex === winner && trusted(fact))) {
      if (ledger.publicFacts.length + additions.length >= 1200) break;
      const property = fact.path.split(".").at(-1);
      const path = `formAnswers.${section}Latest${property[0].toUpperCase()}${property.slice(1)}`;
      if (ledger.hasPath(path)) continue;
      const parents = [...new Set([...comparison, fact.path])];
      values.set(path, ledger.getValue(fact.path));
      additions.push(Object.freeze({ path, label: `最近一条记录 / ${fact.label}`.slice(0, 180), sectionKey: "formAnswers", entryIndex: 0,
        status: parents.every((path) => ledger.publicFacts.find((fact) => fact.path === path)?.status === "user_confirmed") ? "user_confirmed" : "verified",
        evidenceCount: Math.min(...parents.map((path) => ledger.publicFacts.find((fact) => fact.path === path).evidenceCount)),
        derivedFrom: parents, derivation: "latest_record" }));
    }
  }
  return Object.freeze({ ...ledger, publicFacts: Object.freeze([...ledger.publicFacts, ...additions]),
    publicEntries: Object.freeze([...ledger.publicEntries, ...additions.map(({ path, label }) => ({ path, label }))]),
    hasPath: (path) => values.has(path) || ledger.hasPath(path),
    getValue: (path) => values.has(path) ? values.get(path) : ledger.getValue(path) });
}
