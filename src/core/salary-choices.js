/** Interpret only observed numeric salary choices. Units and interval bounds
 * are explicit; overlapping ranges remain ambiguous. No private values leave
 * the page through this helper. */
function amount(number, suffix) {
  return Number(number) * (/^[k千]$/i.test(suffix) ? 1000 : suffix === "万" ? 10000 : 1);
}
export function parseSalaryInterval(label) {
  const text = String(label || "").normalize("NFKC").replace(/[\s,]/g, "")
    .replace(/[–—−]/g, "-").replace(/(?:元)?(?:\/月|每月|月薪)?$/, "");
  const range = text.match(/^(\d+(?:\.\d+)?)([k千万元]?)[-~至](\d+(?:\.\d+)?)([k千万元]?)$/i);
  if (range) {
    const low = amount(range[1], range[2] || range[4]), high = amount(range[3], range[4] || range[2]);
    return low < high ? { low, high, lowInclusive: true, highInclusive: true } : null;
  }
  const threshold = text.match(/^(\d+(?:\.\d+)?)([k千万元]?)(以上|及以上|以下|及以下|以内|超过|高于|低于)$/i);
  if (!threshold) {
    const exact = text.match(/^(\d+(?:\.\d+)?)([k千万元]?)$/i);
    return exact ? { low: amount(exact[1], exact[2]), high: amount(exact[1], exact[2]), lowInclusive: true, highInclusive: true } : null;
  }
  const edge = amount(threshold[1], threshold[2]);
  return /以上/.test(threshold[3]) ? { low: edge, high: Infinity, lowInclusive: true, highInclusive: false }
    : /以下|以内/.test(threshold[3]) ? { low: 0, high: edge, lowInclusive: true, highInclusive: true }
    : /超过|高于/.test(threshold[3]) ? { low: edge, high: Infinity, lowInclusive: false, highInclusive: false }
    : { low: 0, high: edge, lowInclusive: true, highInclusive: false };
}

export function monthlySalaryChoice(options, value) {
  const desired = parseSalaryInterval(value);
  if (!desired) return { picked: null, ambiguous: false };
  const matches = options.filter((option) => {
    if (option.el?.disabled || option.el?.getAttribute?.("aria-disabled") === "true") return false;
    const observed = parseSalaryInterval(option.text);
    if (!observed) return false;
    if (desired.low !== desired.high) return desired.low === observed.low && desired.high === observed.high
      && desired.lowInclusive === observed.lowInclusive && desired.highInclusive === observed.highInclusive;
    return (observed.lowInclusive ? desired.low >= observed.low : desired.low > observed.low)
      && (observed.highInclusive ? desired.high <= observed.high : desired.high < observed.high);
  });
  return { picked: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}
