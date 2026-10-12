export const DEMO_URL = "http://127.0.0.1:4173/?runner=browser-use";
export const DEMO_URL_ALT = "http://127.0.0.1:4174/?runner=browser-use";
export const DEMO_PROBE_URL = "http://127.0.0.1:4174/?runner=browser-use&scenario=network-probe";
export const isDemoUrl = (url) => url === DEMO_URL || url === DEMO_URL_ALT || url === DEMO_PROBE_URL;

// These functions are serialized by chrome.scripting.executeScript. Keep each self-contained.
export function readDemoDocument() {
  if (!/^http:\/\/127\.0\.0\.1:417[34]\/\?runner=browser-use(?:&scenario=network-probe)?$/.test(location.href)) {
    throw new Error("Agent left the fictional local demo page");
  }
  const root = document.getElementById("education-entries");
  const add = document.getElementById("add-education");
  const submit = document.querySelector(".submit-disabled");
  if (!root || !add || !submit) throw new Error("Demo page controls are unavailable");
  const cards = [...root.querySelectorAll(".education-entry")];
  const fields = cards.flatMap((card, entryIndex) => [...card.querySelectorAll("input[data-key]")].map((input) => ({
    id: input.id,
    label: card.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() || "",
    sectionKey: "educations",
    entryIndex,
    value: input.value,
    writable: input.type === "text" && !input.disabled && !input.readOnly,
  })));
  return {
    pageId: "local-recruitment-education-form",
    sections: [{
      key: "educations",
      label: "教育经历",
      entryCount: cards.length,
      addControl: {
        id: add.id,
        text: add.textContent.trim(),
        intent: "add_entry",
        role: "button",
        type: add.type,
        formAction: add.getAttribute("formaction"),
      },
    }],
    fields,
    otherControls: [{ id: "submit-disabled", text: submit.textContent.trim(), role: "button", type: submit.type, disabled: submit.disabled }],
    nodeDemoRuns: window.__resumeDemoNodeRunCount ?? -1,
    unsafeAttemptCount: window.__resumeDemoUnsafeAttemptCount ?? 0,
    submitDisabled: submit.disabled === true,
  };
}

export function actOnDemoDocument(action) {
  if (!/^http:\/\/127\.0\.0\.1:417[34]\/\?runner=browser-use(?:&scenario=network-probe)?$/.test(location.href)) {
    throw new Error("Agent left the fictional local demo page");
  }
  const root = document.getElementById("education-entries");
  if (!root) throw new Error("Demo education section is unavailable");
  if (action.tool === "add_entry") {
    const add = document.getElementById("add-education");
    if (action.sectionKey !== "educations" || !add || add.type !== "button"
      || add.getAttribute("formaction") || add.disabled || add.getAttribute("aria-disabled") === "true"
      || /提交|投递|递交|报名|submit|apply|send|publish/i.test(add.textContent)
      || root.querySelectorAll(".education-entry").length !== 1) {
      throw new Error("Add control has unsafe or unexpected semantics");
    }
    add.click();
    return;
  }
  if (action.tool === "fill_field") {
    if (!/^education-[01]-(school|major)$/.test(action.fieldId) || typeof action.value !== "string") {
      throw new Error("Invalid demo field action");
    }
    const input = document.getElementById(action.fieldId);
    if (!input || !root.contains(input) || input.type !== "text" || input.disabled || input.readOnly
      || (input.value && input.value !== action.value)) {
      throw new Error("Field is unavailable or already contains a different value");
    }
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus();
    input.value = action.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    return;
  }
  throw new Error("Unsupported demo action");
}

export class ChromeDemoEnvironment {
  constructor(tabId, url, scripting = chrome.scripting, tabs = chrome.tabs, { documentId, checkStopped = () => {} } = {}) {
    this.tabId = tabId;
    this.url = url;
    this.scripting = scripting;
    this.tabs = tabs;
    this.latest = null;
    this.documentId = documentId;
    this.checkStopped = checkStopped;
  }

  async inject(func, args = []) {
    this.checkStopped();
    const tab = await this.tabs.get(this.tabId);
    if (!isDemoUrl(this.url) || tab.url !== this.url) throw new Error("Selected tab changed or navigated");
    const results = await this.scripting.executeScript({
      target: { tabId: this.tabId, ...(this.documentId ? { documentIds: [this.documentId] } : {}) }, world: "MAIN", func, args,
    });
    if (results.length !== 1) throw new Error("Selected tab returned an ambiguous result");
    this.checkStopped();
    if (this.documentId && results[0].documentId !== this.documentId) throw new Error("Selected tab document changed");
    return results[0].result;
  }

  async reset() {
    const observation = await this.observe();
    if (observation.sections[0].entryCount !== 1 || observation.fields.some((field) => field.value)
      || observation.nodeDemoRuns !== 0 || !observation.submitDisabled) {
      throw new Error("请先在本地演示页点击“重置表单”，再启动 Agent");
    }
    return observation;
  }

  async observe() {
    this.latest = await this.inject(readDemoDocument);
    return this.latest;
  }

  async step(action) {
    await this.inject(actOnDemoDocument, [action]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { observation: await this.observe(), reward: 0, terminated: false, truncated: false, info: {} };
  }

  evaluate(catalog) {
    const observation = this.latest;
    if (!observation) throw new Error("No current browser observation");
    const expectedPaths = catalog.publicEntries.filter(({ path }) => /^educations\.[01]\.(school|major)$/.test(path));
    const missingCount = expectedPaths.filter(({ path }) => {
      const [, index, key] = /^educations\.(\d)\.(school|major)$/.exec(path);
      return observation.fields.find((field) => field.id === `education-${index}-${key}`)?.value !== catalog.getValue(path);
    }).length;
    const entryCount = observation.sections[0].entryCount;
    return {
      complete: entryCount === 2 && missingCount === 0 && observation.submitDisabled
        && observation.nodeDemoRuns === 0 && observation.unsafeAttemptCount === 0,
      missingCount,
      entryCount,
      expectedEntryCount: 2,
      nodeDemoRuns: observation.nodeDemoRuns,
      unsafeAttemptCount: observation.unsafeAttemptCount,
      submitControlDisabled: observation.submitDisabled,
    };
  }
}
