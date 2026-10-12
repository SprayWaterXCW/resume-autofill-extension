// Removal-only migration for releases <= 0.7.8. New runs never install rules or
// patch page APIs. Chrome also clears session rules on extension upgrades.
export const LEGACY_RULE_IDS = Object.freeze([901001, 901002, 901011, 901012, 901013, 901014]);

// Serialized by Chrome; keep self-contained. Releasing a legacy closure also
// restores page code that cached its fetch/XHR/form wrappers before the update.
export function releaseLegacyPageHooks(expectedUrl) {
  if (location.href !== expectedUrl) return { code: "LEGACY_DOCUMENT_CHANGED", released: false };
  const installed = Boolean(globalThis.__resumeAgentSubmitGuard);
  globalThis.__resumeAgentSubmitGuard?.release();
  return { code: "LEGACY_PAGE_CLEANED", released: installed };
}

export async function cleanupLegacyInterception(protection, {
  tabs = chrome.tabs, scripting = chrome.scripting, dnr = chrome.declarativeNetRequest,
} = {}) {
  const cleanup = [];
  const targets = new Map();
  if (Number.isInteger(protection?.tabId)) targets.set(protection.tabId, protection);
  let removedRuleCount = 0;
  // No DNR permission is requested anymore. This branch supports a retained API
  // during a development reload; only this extension's historic IDs are removed.
  if (dnr?.getSessionRules) {
    const owned = (await dnr.getSessionRules()).filter((rule) => LEGACY_RULE_IDS.includes(rule.id));
    for (const rule of owned) for (const tabId of rule.condition?.tabIds || []) {
      if (Number.isInteger(tabId) && !targets.has(tabId)) targets.set(tabId, { tabId });
    }
    if (owned.length) {
      await dnr.updateSessionRules({ removeRuleIds: owned.map(({ id }) => id) });
      if ((await dnr.getSessionRules()).some((rule) => LEGACY_RULE_IDS.includes(rule.id))) {
        throw Object.assign(new Error("LEGACY_RULE_CLEANUP_FAILED"), { code: "LEGACY_RULE_CLEANUP_FAILED" });
      }
      removedRuleCount = owned.length;
    }
  }
  for (const target of targets.values()) {
    let tab;
    try { tab = await tabs.get(target.tabId); } catch { continue; }
    // documentIds keep this migration out of a replacement document. A page
    // whose activeTab access expired is retried when its toolbar is opened.
    if (!tab?.url || target.url && target.url !== tab.url) continue;
    try {
      const outputs = await scripting.executeScript({ target: { tabId: target.tabId,
        ...(target.documentId ? { documentIds: [target.documentId] } : { frameIds: [0] }) },
        world: "MAIN", func: releaseLegacyPageHooks, args: [tab.url] });
      if (outputs.length !== 1 || outputs[0].frameId !== 0
        || target.documentId && outputs[0].documentId !== target.documentId
        || outputs[0].result?.code !== "LEGACY_PAGE_CLEANED") throw new Error("LEGACY_PAGE_UNAVAILABLE");
      cleanup.push({ tabId: target.tabId, code: "LEGACY_PAGE_CLEANED", released: outputs[0].result.released === true });
    } catch {
      cleanup.push({ tabId: target.tabId, code: "LEGACY_PAGE_UNAVAILABLE" });
    }
  }
  return { removedRuleCount, cleanup };
}
