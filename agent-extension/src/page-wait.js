// Isolated content scripts can message their own extension. A page timer can be
// throttled when the tab is hidden, so the job's service worker owns short waits.
// This message carries only a duration; the worker verifies tab + document owner.
export async function pause(ms) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 1000) throw new Error("PAGE_WAIT_INVALID");
  const runtime = globalThis.chrome?.runtime;
  if (runtime?.id && typeof runtime.sendMessage === "function") {
    const response = await runtime.sendMessage({ type: "page-delay", ms });
    if (response?.ok !== true || response.value?.waited !== true) {
      const code = response?.error === "USER_STOPPED" ? "USER_STOPPED" : "REAL_PAGE_CHANGED";
      throw Object.assign(new Error(code), { code });
    }
    return;
  }
  // Fictional standalone DOM fixtures have no extension runtime.
  await new Promise((resolve) => setTimeout(resolve, ms));
}
