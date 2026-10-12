import test from "node:test";
import assert from "node:assert/strict";
import { pause } from "../agent-extension/src/page-wait.js";

test("isolated page waits use only the extension bridge, without a throttled page timer", async () => {
  const previousChrome = globalThis.chrome, previousTimer = globalThis.setTimeout;
  const messages = [];
  try {
    globalThis.setTimeout = () => { throw new Error("Page timers must not be used in Chrome"); };
    globalThis.chrome = { runtime: { id: "fixture-extension", async sendMessage(message) {
      messages.push(message); return { ok: true, value: { waited: true } };
    } } };
    await pause(120);
    assert.deepEqual(messages, [{ type: "page-delay", ms: 120 }]);
    await assert.rejects(pause(1001), /PAGE_WAIT_INVALID/);
    globalThis.chrome.runtime.sendMessage = async () => ({ ok: false, error: "USER_STOPPED" });
    await assert.rejects(pause(120), { code: "USER_STOPPED" });
    globalThis.chrome.runtime.sendMessage = async () => ({ ok: false, error: "PAGE_WAIT_DENIED" });
    await assert.rejects(pause(120), { code: "REAL_PAGE_CHANGED" });
  } finally { globalThis.chrome = previousChrome; globalThis.setTimeout = previousTimer; }
});
