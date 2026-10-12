import { readFormStructure } from "./page-scan.js";
import { DropdownSelect } from "../../src/vendor/formfill/dropdown-select.js";
import { beisenPickerKind, fillBeisenPicker } from "./beisen-picker.js";
import { awardMappingCompatible, awardSourceAxis, resolveAwardChoice } from "../../src/core/award-levels.js";
import { matchWrittenTargets } from "../../src/core/form-structure-identity.js";
import { fieldMappingCompatible } from "../../src/core/field-semantics.js";
import { monthlySalaryChoice, parseSalaryInterval } from "../../src/core/salary-choices.js";
import { resolveFillMode } from "../../src/core/fill-mode.js";

function salaryChoiceFor(field, sourcePath, options, value) {
  return ["formAnswers.expectedMonthlySalary", "jobPreferences.expectedMonthlySalary"].includes(sourcePath)
    && /月薪|月工资|薪.*月|monthly/i.test(field.label) && parseSalaryInterval(value)
    ? monthlySalaryChoice(options, value) : null;
}
import { pause } from "./page-wait.js";

const forbidden = /提交|投递|递交|报名|签名|签署|同意|承诺|声明|授权|注册|删除|保存|submit|apply|send|publish|sign\b|consent|register|delete|save/i;
const manualGroup = /有关声明|声明|签署|承诺|同意|declaration|consent|signature/i;
const result = (code, verified = false, extras = {}) => ({ code, verified, ...extras });
// Keep private, nonserializable receipts in the isolated world across bundle
// updates. Navigation destroys this document and its receipts together.
const receipts = globalThis.__resumeAgentWriteReceipts instanceof WeakMap ? globalThis.__resumeAgentWriteReceipts
  : (globalThis.__resumeAgentWriteReceipts = new WeakMap());
const writeAttempts = new WeakMap();
const pendingCommits = new Map();
let inducedDateDefaults = new WeakMap();
const dateDisplay = (element) => String(DropdownSelect.readDisplayText(element) || element.value || "").trim();
const dateFamily = (field) => field.label.replace(/\s*\/\s*(年|月|日)$/, "");
function emptyDatePeers(binding, state) {
  if (!binding?.field.datePart || binding.field.kind !== "custom-select") return [];
  const peers = [...state.fields.values()].filter((peer) => peer !== binding && peer.field.datePart
    && peer.field.kind === "custom-select" && peer.field.groupId === binding.field.groupId
    && peer.field.entryIndex === binding.field.entryIndex && peer.root === binding.root
    && peer.field.dateRole === binding.field.dateRole && dateFamily(peer.field) === dateFamily(binding.field));
  if (peers.length > 2 || new Set([binding.field.datePart, ...peers.map((peer) => peer.field.datePart)]).size !== peers.length + 1) return [];
  return peers.filter((peer) => peer.assertIdentity() && !dateDisplay(peer.element));
}
function canReplaceInducedDateDefault(binding) {
  const mark = inducedDateDefaults.get(binding.element);
  return Boolean(mark && binding.field.datePart && !mark.userTouched && binding.assertIdentity()
    && mark.widget === DropdownSelect.findSelectRoot(binding.element) && mark.display === dateDisplay(binding.element));
}
const identityFailure = (binding, phase) => result(phase === "open" && binding?.element.isConnected === false
  ? "REAL_FIELD_BINDING_STALE" : "REAL_PAGE_CHANGED", false, {
  diagnostic: { phase, adapter: "field_identity", ...(binding?.identityState?.() || { connected: false }) },
});
const phoenixChoiceOptions = (element) => [...element.querySelectorAll(":scope > .phoenix-radio-group__radioItem > .phoenix-radio")]
  .map((el) => ({ el, text: String(el.querySelector(".phoenix-radio__radio-text")?.textContent || "").trim() }));
const isPhoenixChoiceChecked = (element) => element.isConnected && element.classList.contains("phoenix-radio--checked")
  && Boolean(element.querySelector(".phoenix-radio__circle-wrapper--checked"));

function bindings(token) {
  const state = globalThis.__resumeAgentBindings;
  if (!state || state.token !== token || state.expectedUrl !== location.href) throw new Error("REAL_PAGE_CHANGED");
  return state;
}

function nativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("REAL_CONTROL_UNSUPPORTED");
  setter.call(element, value);
}

function events(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function preparePageCommit(binding, desired, sourcePath, fillMode, extras = {}) {
  const ticket = crypto.randomUUID();
  binding.element.setAttribute("data-resume-agent-commit", ticket);
  pendingCommits.set(ticket, { binding, desired, sourcePath });
  return result("PAGE_COMMIT_PENDING", false, { ...extras, commitRequest: { ticket, value: desired, fillMode } });
}

function uniqueOption(options, desired) {
  const enabled = options.filter((option) => !option.el.disabled && option.el.getAttribute("aria-disabled") !== "true"
    && !option.el.matches(".is-disabled, .disabled") && option.text);
  const exact = enabled.filter((option) => DropdownSelect.normalize(option.text) === DropdownSelect.normalize(desired));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const picked = DropdownSelect.pickBestOption(enabled, desired);
  if (!picked || picked.score < 0.85) return null;
  // Reject fuzzy ties. The confirmed language four-level preference is a deliberate exception.
  const ties = enabled.filter((option) => DropdownSelect.scoreOption(option.text, desired) === picked.score);
  return ties.length > 1 ? null : picked.option;
}

function dropdownOptions(element, state) {
  const controlled = ["aria-controls", "aria-owns"].flatMap((key) => (element.getAttribute(key) || "").split(/\s+/))
    .filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const allPanels = [...document.querySelectorAll(DropdownSelect.OPTION_CONTAINER_SELECTORS.join(","))].filter((panel) => state.visible(panel)
    && [...panel.querySelectorAll(DropdownSelect.OPTION_ITEM_SELECTORS.join(","))].some(state.visible));
  let panels = controlled.length ? allPanels.filter((panel) => controlled.some((root) => root === panel || root.contains(panel))) : allPanels;
  if (!controlled.length) {
    const anchor = element.getBoundingClientRect();
    const distance = (panel) => {
      const rect = panel.getBoundingClientRect();
      return Math.max(0, anchor.left - rect.right, rect.left - anchor.right)
        + Math.max(0, anchor.top - rect.bottom, rect.top - anchor.bottom);
    };
    const nearest = Math.min(...panels.map(distance));
    panels = nearest < 160 ? panels.filter((panel) => distance(panel) <= nearest + 12) : [];
  }
  const elements = new Set(panels.flatMap((panel) => [...panel.querySelectorAll(DropdownSelect.OPTION_ITEM_SELECTORS.join(","))]));
  const choices = [...elements].filter((item) => state.visible(item) && !item.closest("button, a, [role=button]"))
    .map((el) => ({ el, text: String(el.textContent || "").trim() })).filter((option) => option.text.length <= 100);
  // Component selectors can match both an option wrapper and its content.
  // Retain the deepest equal-label node; distinct choices with equal text stay
  // ambiguous and are never silently resolved by DOM order.
  return choices.filter((choice) => !choices.some((other) => other !== choice && choice.el.contains(other.el)
    && DropdownSelect.normalize(choice.text) === DropdownSelect.normalize(other.text)))
    .filter((choice) => !choice.el.closest('[aria-disabled=true], .is-disabled, .disabled'));
}

function closeDropdown(element) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  element.blur();
  // Phoenix listens for an outside mousedown, rather than Escape alone.
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function fillDropdown(binding, value, state, sourcePath) {
  const element = binding.element;
  const original = element.value ?? "";
  element.scrollIntoView?.({ block: "center" });
  element.focus();
  element.click();
  await pause(180);
  let options = dropdownOptions(element, state);
  const award = awardSourceAxis(sourcePath);
  let awardChoice = award ? resolveAwardChoice(options, sourcePath, value) : null;
  // Lazy popups may need another render. Never type a multi-axis payload into a search input.
  for (let attempt = 0; award && !options.length && attempt < 8; attempt += 1) {
    await pause(150);
    if (!binding.assertIdentity()) { const outcome = identityFailure(binding, "open"); closeDropdown(element); return outcome; }
    options = dropdownOptions(element, state);
    awardChoice = resolveAwardChoice(options, sourcePath, value);
  }
  if (award && !awardChoice.picked) {
    closeDropdown(element);
    return result(awardChoice.code, false, { optionCount: options.length,
      diagnostic: { phase: "select", adapter: "award_choice", ...(awardChoice.axis ? { awardAxis: awardChoice.axis } : {}) } });
  }
  const pick = (choices) => {
    const salary = salaryChoiceFor(binding.field, sourcePath, choices, value);
    if (salary) return salary.picked;
    const unit = binding.field.datePart === "year" || sourcePath === "formAnswers.graduationYear" ? "年"
      : binding.field.datePart === "month" || sourcePath === "formAnswers.graduationMonth" ? "月"
      : binding.field.datePart === "day" ? "日" : null;
    if (unit && /^\d+$/.test(value)) {
      const pattern = unit === "年" ? /^(\d{4})年?$/ : unit === "月" ? /^(\d{1,2})月?$/ : /^(\d{1,2})日?$/;
      const matches = choices.filter((choice) => {
        const match = choice.text.trim().match(pattern);
        return match && Number(match[1]) === Number(value) && !choice.el.disabled;
      });
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return uniqueOption(choices, value);
  };
  let picked = award ? awardChoice.picked : pick(options);
  let searched = false;
  if (!award && !picked && !element.readOnly && element.matches("input")) {
    nativeValue(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    searched = true;
    for (let attempt = 0; attempt < 8 && !picked; attempt += 1) {
      await pause(150);
      if (!binding.assertIdentity()) { const outcome = identityFailure(binding, "search"); closeDropdown(element); return outcome; }
      options = dropdownOptions(element, state);
      picked = pick(options);
    }
  }
  if (!picked) {
    if (searched) { nativeValue(element, original); element.dispatchEvent(new Event("input", { bubbles: true })); }
    closeDropdown(element);
    return result("OPTION_UNAVAILABLE", false, { optionCount: options.length,
      diagnostic: { phase: searched ? "search" : "open", adapter: "dropdown", searched } });
  }
  // Only a recognized option belonging to this popup can be clicked; no general click tool exists.
  if (!picked.el.isConnected || forbidden.test(picked.text) || picked.el.closest("button, a, [role=button]")) {
    closeDropdown(element);
    return result("OPTION_UNSAFE");
  }
  picked.el.click();
  await pause(200);
  if (!binding.assertIdentity()) { const outcome = identityFailure(binding, "commit"); closeDropdown(element); return outcome; }
  closeDropdown(element);
  // Remote selects can retain their closing portal while applying a fetched
  // choice. Observe a committed label and a closed menu together; a search query
  // or an eventual timeout is never a receipt. No additional choice is clicked.
  const startedAt = Date.now();
  let valueMatched = false, expanded = true, stable = 0;
  do {
    await pause(100);
    if (!binding.assertIdentity()) return identityFailure(binding, "commit");
    const display = DropdownSelect.readDisplayText(element);
    valueMatched = DropdownSelect.normalize(display) === DropdownSelect.normalize(picked.text)
      || DropdownSelect.scoreOption(display, picked.text) >= 0.95;
    expanded = element.getAttribute("aria-expanded") === "true" || dropdownOptions(element, state).length > 0;
    stable = valueMatched && !expanded ? stable + 1 : 0;
  } while (stable < 2 && Date.now() - startedAt < 2_000);
  const verified = stable >= 2;
  return result(verified && !expanded ? "VERIFIED" : "OPTION_NOT_COMMITTED", verified && !expanded,
    { optionCount: options.length, diagnostic: { phase: "commit", adapter: award ? "award_choice" : "dropdown", expanded,
      waitedMs: Date.now() - startedAt, valueMatched,
      ...(awardChoice?.axis ? { awardAxis: awardChoice.axis } : {}) } });
}

function normalizeDate(value, element, sourcePath, monthStartDay) {
  const match = String(value).match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?日?$/);
  if (!match) return null;
  const confirmedCompletion = monthStartDay === true
    && /^(educations|internships|workExperiences|projects|campusExperiences)\.\d+\.(startDate|endDate)$/.test(sourcePath || "");
  if (!match[3] && element.type !== "month" && !confirmedCompletion) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3] || "1");
  if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) return null;
  const base = `${match[1]}-${String(month).padStart(2, "0")}`;
  return element.type === "month" ? base : `${base}-${String(day).padStart(2, "0")}`;
}

async function fillPhoenixDate(binding, value, state, sourcePath, monthStartDay) {
  const element = binding.element;
  closeDropdown(element);
  element.scrollIntoView?.({ block: "center" });
  element.focus(); element.click();
  await pause(200);
  const anchor = element.getBoundingClientRect();
  const distance = (panel) => {
    const rect = panel.getBoundingClientRect();
    return Math.max(0, anchor.left - rect.right, rect.left - anchor.right)
      + Math.max(0, anchor.top - rect.bottom, rect.top - anchor.bottom);
  };
  const panels = [...document.querySelectorAll(".phoenix-date-picker__wrap")].filter((root) => state.visible(root)
    && [...root.querySelectorAll(".phoenix-calendar-month-panel, .phoenix-calendar-input")].some(state.visible));
  const nearest = Math.min(...panels.map(distance));
  const matching = nearest < 180 ? panels.filter((panel) => distance(panel) <= nearest + 8) : [];
  const panel = matching.length === 1 ? matching[0] : null;
  if (panel?.querySelector(".phoenix-calendar-month-calendar")) return fillPhoenixMonth(binding, value, state, panel);
  const desired = normalizeDate(value, { type: "date" }, sourcePath, monthStartDay);
  const completedDay = Boolean(desired && /^\d{4}[-/.年]\d{1,2}月?$/.test(value));
  if (!desired) {
    closeDropdown(element);
    return result("DATE_FORMAT_UNSUPPORTED", false, { diagnostic: { phase: "precision", adapter: "phoenix_calendar" } });
  }
  const inputs = panel ? [...panel.querySelectorAll("input.phoenix-calendar-input")]
    .filter((input) => state.visible(input) && !input.readOnly && !input.disabled) : [];
  if (inputs.length !== 1 || !binding.assertIdentity()) {
    closeDropdown(element);
    return result("CALENDAR_INPUT_UNAVAILABLE", false, { diagnostic: { phase: "open", adapter: "phoenix_calendar",
      panelCount: matching.length, inputCount: inputs.length } });
  }
  const input = inputs[0];
  nativeValue(input, desired); events(input);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  await pause(240);
  const committed = () => normalizeDate(DropdownSelect.readDisplayText(element), { type: "date" }) === desired;
  let verified = binding.assertIdentity() && committed();
  const confirms = [...panel.querySelectorAll(".phoenix-calendar-ok-btn")]
    .filter((control) => state.visible(control) && /^(确定|确认|OK)$/i.test(String(control.textContent || "").trim())
      && control.type !== "submit" && !control.disabled && !control.closest("form[action]"));
  if (!verified && confirms.length === 1) {
    confirms[0].click(); await pause(240);
    verified = binding.assertIdentity() && committed();
  }
  closeDropdown(element);
  return result(verified ? "VERIFIED" : "CALENDAR_NOT_COMMITTED", verified, { completedDay,
    diagnostic: { phase: "commit", adapter: "phoenix_calendar", panelCount: matching.length,
      inputCount: inputs.length, confirmCount: confirms.length, sourcePrecision: completedDay ? "month" : "day" } });
}

function safeCalendarControl(control, panel, state) {
  return control?.isConnected && panel.contains(control) && state.visible(control) && !control.disabled
    && control.getAttribute("aria-disabled") !== "true" && !/disabled/i.test(control.closest("td")?.className || "")
    && !forbidden.test(String(control.textContent || "")) && control.type !== "submit"
    && (!control.matches("a") || [null, "", "#"].includes(control.getAttribute("href")));
}

async function fillPhoenixMonth(binding, value, state, panel) {
  const desired = normalizeDate(value, { type: "month" });
  if (!desired || binding.field.label === "出生日期") {
    closeDropdown(binding.element);
    return result("DATE_FORMAT_UNSUPPORTED", false, { diagnostic: { phase: "precision", adapter: "phoenix_month_calendar" } });
  }
  const year = Number(desired.slice(0, 4)), month = Number(desired.slice(5, 7));
  const navigation = [
    { year: ".phoenix-calendar-year-select", prev: ".phoenix-calendar-prev-year-btn", next: ".phoenix-calendar-next-year-btn" },
    { year: ".phoenix-calendar-month-panel-year-select", prev: ".phoenix-calendar-month-panel-prev-year-btn", next: ".phoenix-calendar-month-panel-next-year-btn" },
  ].find((selectors) => {
    const control = panel.querySelector(selectors.year);
    return control && state.visible(control) && /^\d{4}年?$/.test(String(control.textContent || "").replace(/\s+/g, ""));
  });
  const currentYear = () => {
    const text = String(navigation && panel.querySelector(navigation.year)?.textContent || "").replace(/\s+/g, "");
    return /^\d{4}年?$/.test(text) ? Number(text.replace("年", "")) : null;
  };
  let yearSteps = 0;
  while (currentYear() !== year && yearSteps < 80) {
    const before = currentYear();
    if (before === null) break;
    const direction = year < before ? -1 : 1;
    const control = panel.querySelector(direction < 0 ? navigation.prev : navigation.next);
    if (!safeCalendarControl(control, panel, state)) break;
    control.click(); await pause(70); yearSteps += 1;
    if (!binding.assertIdentity()) return result("REAL_PAGE_CHANGED");
    if (currentYear() !== before + direction) break;
  }
  if (currentYear() !== year) {
    closeDropdown(binding.element);
    return result("CALENDAR_YEAR_UNAVAILABLE", false, { diagnostic: { phase: "navigate", adapter: "phoenix_month_calendar", yearSteps } });
  }
  const options = [...panel.querySelectorAll(".phoenix-calendar-month-panel-month")]
    .filter((control) => safeCalendarControl(control, panel, state));
  const matches = options.filter((control) => /^\d{1,2}月$/.test(String(control.textContent || "").trim())
    && Number(String(control.textContent).trim().replace("月", "")) === month);
  if (matches.length !== 1) {
    closeDropdown(binding.element);
    return result("CALENDAR_MONTH_UNAVAILABLE", false, { optionCount: options.length,
      diagnostic: { phase: "search", adapter: "phoenix_month_calendar", yearSteps } });
  }
  matches[0].click(); await pause(220);
  const verified = binding.assertIdentity() && normalizeDate(DropdownSelect.readDisplayText(binding.element), { type: "month" }) === desired;
  closeDropdown(binding.element);
  return result(verified ? "VERIFIED" : "CALENDAR_NOT_COMMITTED", verified, { optionCount: options.length,
    diagnostic: { phase: "commit", adapter: "phoenix_month_calendar", yearSteps, targetPrecision: "month" } });
}

export async function fillBoundField({ token, fieldId, value, sourcePath, semanticRole, regionParts = [], monthStartDay = false, browserEditRetry = false, fillMode = "overwrite", requirePageCommit = false }) {
  fillMode = resolveFillMode(fillMode);
  const state = bindings(token);
  const binding = state.fields.get(fieldId);
  if (!binding || !binding.assertIdentity()) return identityFailure(binding, "open");
  const { field, group, element } = binding;
  const confirmedDiscoveryQuestion = sourcePath === "jobPreferences.discoveryChannel" && field.kind === "radio"
    && /通过.*渠道.*招聘信息/.test(field.label);
  if (manualGroup.test(group.label) || forbidden.test(field.label) && !confirmedDiscoveryQuestion
    || ["credential", "file", "signature", "checkbox"].includes(field.kind)) return result("MANUAL_ONLY");
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return result("PROTECTED");
  if (typeof value !== "string" || !value.trim() || value.length > 20_000) return result("SOURCE_UNAVAILABLE");
  if (!awardMappingCompatible(field, group.label, sourcePath, [...state.fields.values()].map((item) => item.field), semanticRole)) return result("AWARD_MAPPING_MISMATCH");
  if (field.kind === "radio") {
    if (element.matches(".phoenix-radio-group")) {
      const options = phoenixChoiceOptions(element);
      if (fillMode === "empty" && options.some((option) => isPhoenixChoiceChecked(option.el))) return result("PROTECTED");
      const awardChoice = resolveAwardChoice(options, sourcePath, value);
      const salaryChoice = salaryChoiceFor(field, sourcePath, options, value);
      const picked = awardChoice ? awardChoice.picked : salaryChoice ? salaryChoice.picked : uniqueOption(options, value);
      if (awardChoice && !picked) return result(awardChoice.code, false, { optionCount: options.length,
        diagnostic: { phase: "select", adapter: "award_choice", ...(awardChoice.axis ? { awardAxis: awardChoice.axis } : {}) } });
      if (!picked) return result("OPTION_UNAVAILABLE", false, { optionCount: options.length,
        diagnostic: { phase: "search", adapter: "phoenix_choice" } });
      if (forbidden.test(picked.text) || !picked.el.querySelector(".phoenix-radio__wrapper")) return result("MANUAL_ONLY");
      picked.el.querySelector(".phoenix-radio__wrapper").click(); await pause(180);
      const verified = binding.assertIdentity() && isPhoenixChoiceChecked(picked.el)
        && options.filter((option) => isPhoenixChoiceChecked(option.el)).length === 1;
      return result(verified ? "VERIFIED" : "OPTION_NOT_COMMITTED", verified, { optionCount: options.length,
        diagnostic: { phase: "commit", adapter: awardChoice ? "award_choice" : "phoenix_choice",
          ...(awardChoice?.axis ? { awardAxis: awardChoice.axis } : {}) } });
    }
    const scope = element.closest(".el-form-item, .form-group, .form-item--phoenix") || element.form || binding.root;
    const options = [...scope.querySelectorAll('input[type="radio"]')].filter((radio) => radio.name === element.name)
      .map((el) => ({ el, text: String(el.closest("label")?.textContent || el.getAttribute("aria-label") || "").trim() }));
    if (fillMode === "empty" && options.some((option) => option.el.checked)) return result("PROTECTED");
    const awardChoice = resolveAwardChoice(options, sourcePath, value);
    const salaryChoice = salaryChoiceFor(field, sourcePath, options, value);
    const picked = awardChoice ? awardChoice.picked : salaryChoice ? salaryChoice.picked : uniqueOption(options, value);
    if (awardChoice && !picked) return result(awardChoice.code, false, { optionCount: options.length,
      diagnostic: { phase: "select", adapter: "award_choice", ...(awardChoice.axis ? { awardAxis: awardChoice.axis } : {}) } });
    if (!picked) return result("OPTION_UNAVAILABLE", false, { optionCount: options.length });
    if (forbidden.test(picked.text)) return result("MANUAL_ONLY");
    picked.el.click();
    await pause(120);
    return result(picked.el.checked ? "VERIFIED" : "READBACK_MISMATCH", picked.el.checked, awardChoice
      ? { optionCount: options.length, diagnostic: { phase: "commit", adapter: "award_choice", awardAxis: awardChoice.axis } } : {});
  }
  // Values stay in the isolated page world; only a presence/code leaves it.
  const existing = "value" in element ? String(element.value || "").trim() : String(element.textContent || "").trim();
  const committed = DropdownSelect.findSelectRoot(element)
    ?.querySelector(".ant-select-selection-item, .el-select__selected-item, .next-select-values, .phoenix-select__content, [class*=display-value], [class*=selected-value]");
  if (fillMode === "empty" && (existing || committed?.textContent?.trim()) && !canReplaceInducedDateDefault(binding)) return result("PROTECTED");
  const picker = beisenPickerKind(binding, sourcePath, state.expectedUrl);
  if (picker) return fillBeisenPicker(binding, value, state, picker, regionParts);
  if (field.kind === "date" && element.closest(".phoenix-select")) return fillPhoenixDate(binding, value, state, sourcePath, monthStartDay);
  if (["custom-select", "combobox", "autocomplete"].includes(field.kind)) return fillDropdown(binding, value, state, sourcePath);
  if (field.kind === "cascader" || (field.kind === "date" && (element.readOnly || !["date", "month"].includes(element.type)))) return result("CONTROL_UNSUPPORTED");
  if (element.readOnly || !element.matches("input, textarea, select")) return result("CONTROL_UNSUPPORTED");
  if (field.kind === "select") {
    const options = [...element.options].filter((option) => option.value !== "")
      .map((el) => ({ el, text: String(el.textContent || "").trim() }));
    const awardChoice = resolveAwardChoice(options, sourcePath, value);
    const salaryChoice = salaryChoiceFor(field, sourcePath, options, value);
    const picked = awardChoice ? awardChoice.picked : salaryChoice ? salaryChoice.picked : uniqueOption(options, value);
    if (awardChoice && !picked) return result(awardChoice.code, false, { optionCount: options.length,
      diagnostic: { phase: "select", adapter: "award_choice", ...(awardChoice.axis ? { awardAxis: awardChoice.axis } : {}) } });
    if (!picked || forbidden.test(picked.text)) return result("OPTION_UNAVAILABLE", false, { optionCount: options.length });
    if (requirePageCommit) return preparePageCommit(binding, picked.el.value, sourcePath, fillMode, { optionCount: options.length });
    nativeValue(element, picked.el.value);
    events(element);
    await pause(120);
    const verified = binding.assertIdentity() && element.value === picked.el.value;
    return result(verified ? "VERIFIED" : "READBACK_MISMATCH", verified, awardChoice
      ? { optionCount: options.length, diagnostic: { phase: "commit", adapter: "award_choice", awardAxis: awardChoice.axis } } : {});
  }
  let desired = value.trim();
  const completedDay = field.kind === "date" && element.type === "date" && /^\d{4}[-/.年]\d{1,2}月?$/.test(desired);
  if (field.kind === "date") { desired = normalizeDate(desired, element, sourcePath, monthStartDay); if (!desired) return result("DATE_FORMAT_UNSUPPORTED"); }
  if (field.kind === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(desired)) return result("NUMBER_FORMAT_UNSUPPORTED");
    const number = Number(desired);
    if ((element.min && number < Number(element.min)) || (element.max && number > Number(element.max))) return result("NUMBER_OUT_OF_RANGE");
  }
  if (element.maxLength > 0 && desired.length > element.maxLength) return result("VALUE_TOO_LONG");
  if (requirePageCommit && !browserEditRetry) return preparePageCommit(binding, desired, sourcePath, fillMode, completedDay ? { completedDay: true } : {});
  if (browserEditRetry) {
    const previous = writeAttempts.get(element);
    const receipt = receipts.get(element);
    const failedAttempt = previous?.code === "READBACK_MISMATCH";
    const lostReceipt = previous?.code === "VERIFIED" && receipt?.sourcePath === sourcePath;
    if (sourcePath !== "identityAndAuthorization.personalIdNumber" || !/证件号码|身份证.*号码/.test(field.label)
      || field.kind !== "text" || !element.matches("input[type=text], input:not([type])")
      || !previous || previous.sourcePath !== sourcePath || previous.label !== field.label
      || previous.retryAttempted || !failedAttempt && !lostReceipt) return result("WRITE_RECOVERY_UNAVAILABLE");
    previous.retryAttempted = true;
    if (requirePageCommit) return preparePageCommit(binding, desired, sourcePath, fillMode);
    element.scrollIntoView?.({ block: "center" }); element.focus(); element.select();
    if (document.activeElement !== element || typeof document.execCommand !== "function") return result("NATIVE_EDIT_UNAVAILABLE");
    const documentFocused = document.hasFocus();
    let inputEventObserved = false, trustedInputObserved = false;
    const observeInput = (event) => { inputEventObserved = true; trustedInputObserved ||= event.isTrusted; };
    element.addEventListener("input", observeInput);
    const inserted = document.execCommand("insertText", false, desired);
    const valueMatchedAfterEdit = element.value === desired;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    const valueMatchedAfterChange = element.value === desired;
    element.blur();
    const valueMatchedAfterBlur = element.value === desired;
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pause(600);
    element.removeEventListener("input", observeInput);
    const verified = inserted === true && binding.assertIdentity() && element.value === desired && element.validity?.valid !== false;
    return result(verified ? "VERIFIED" : "NATIVE_EDIT_REJECTED", verified, { diagnostic: { phase: "commit", adapter: "native_edit",
      identityVerified: binding.assertIdentity(), valueMatched: element.value === desired, validityValid: element.validity?.valid !== false,
      documentFocused, editInserted: inserted === true, inputEventObserved, trustedInputObserved,
      valueMatchedAfterEdit, valueMatchedAfterChange, valueMatchedAfterBlur } });
  }
  element.scrollIntoView?.({ block: "center" });
  element.focus();
  nativeValue(element, desired);
  events(element);
  element.blur();
  await pause(120);
  const verified = binding.assertIdentity() && element.value === desired && element.validity?.valid !== false;
  return result(verified ? "VERIFIED" : "READBACK_MISMATCH", verified, { ...(completedDay ? { completedDay: true } : {}),
    diagnostic: { phase: "commit", adapter: "native_text", identityVerified: binding.assertIdentity(),
      valueMatched: element.value === desired, validityValid: element.validity?.valid !== false } });
}

export async function addBoundEntry({ token, groupId }) {
  const state = bindings(token);
  const candidates = [...state.controls.values()].filter(({ element, control, observedPhoenixAdd }) => control.groupId === groupId
    && control.intent === "add-candidate" && !forbidden.test(control.label)
    && (element.matches("button[type=button], input[type=button]") || observedPhoenixAdd && element.matches("div, span")
      && !element.querySelector("button, input, a")) && !element.disabled
    && !element.hasAttribute("formaction") && !element.closest("a") && state.visible(element));
  if (candidates.length !== 1) return result("ADD_CONTROL_UNAVAILABLE", false, { candidateCount: candidates.length });
  const { element, control, group } = candidates[0];
  const currentText = String(element.getAttribute("aria-label") || element.textContent || element.value || "").trim();
  if (!element.isConnected || !/添加|新增|增加|\badd\b/i.test(currentText)
    || forbidden.test(currentText) || manualGroup.test(group.label)) return result("ADD_CONTROL_UNSAFE");
  const before = group.entryCount;
  element.click();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pause(150);
    if (location.href !== state.expectedUrl) return result("REAL_PAGE_CHANGED");
    const report = readFormStructure(state.expectedUrl, true);
    const after = report.groups.find((item) => item.id === control.groupId && item.label === group.label);
    if (after?.entryCount === before + 1) return result("VERIFIED", true, { entryCount: after.entryCount });
    if (after?.entryCount > before + 1) return result("ADD_COUNT_MISMATCH");
  }
  return result("ADD_NOT_OBSERVED");
}

export function installRealPageRuntime() {
  // Trusted interaction with an affected date widget revokes ownership of its
  // generated default. User values and edits are never acquired as Agent work.
  globalThis.__resumeAgentDateDefaultCleanup?.();
  const interactionTypes = ["pointerdown", "mousedown", "keydown", "input", "change"];
  const onTrustedDateInteraction = (event) => {
    if (!event.isTrusted) return;
    for (const binding of globalThis.__resumeAgentBindings?.fields.values() || []) {
      const mark = inducedDateDefaults.get(binding.element);
      if (mark && (event.target === binding.element || mark.widget.contains(event.target))) mark.userTouched = true;
    }
  };
  for (const type of interactionTypes) document.addEventListener(type, onTrustedDateInteraction, true);
  globalThis.__resumeAgentDateDefaultCleanup = () => {
    for (const type of interactionTypes) document.removeEventListener(type, onTrustedDateInteraction, true);
    inducedDateDefaults = new WeakMap();
  };
  globalThis.__resumeAgentRuntime = {
    finishCommit: ({ token, ticket, evidence }) => {
      const state = bindings(token), pending = pendingCommits.get(ticket);
      if (!pending) return result("PAGE_COMMIT_UNAVAILABLE");
      const { binding, desired, sourcePath } = pending;
      pendingCommits.delete(ticket);
      const marked = binding.element.getAttribute("data-resume-agent-commit") === ticket;
      if (marked) binding.element.removeAttribute("data-resume-agent-commit");
      if (!marked || state.fields.get(binding.field.id) !== binding || !binding.assertIdentity()) return identityFailure(binding, "commit");
      if (evidence?.contentProtected === true) return result("PROTECTED");
      const valueMatched = String(binding.element.value) === desired;
      const stateMatched = evidence?.pageStateObserved !== true || evidence.pageStateMatched === true;
      const verified = evidence?.targetMatched === true && evidence.valueMatched === true && valueMatched
        && evidence.validityValid === true && evidence.inputEventObserved === true && stateMatched;
      const diagnostic = { ...evidence, phase: "commit", adapter: "page_input", identityVerified: binding.assertIdentity(), valueMatched };
      const code = verified ? "VERIFIED" : !stateMatched ? "PAGE_STATE_MISMATCH" : "PAGE_INPUT_NOT_COMMITTED";
      writeAttempts.set(binding.element, { sourcePath, label: binding.field.label, code, retryAttempted: false });
      if (verified) receipts.set(binding.element, { sourcePath, label: binding.field.label, kind: binding.field.kind,
        value: desired, display: null, pageStateRequired: evidence.pageStateObserved === true });
      return result(code, verified, { diagnostic });
    },
    prepareCommitAudit: ({ token, targets }) => {
      const state = bindings(token);
      return targets.flatMap(({ fieldId, sourcePath }) => {
        const binding = state.fields.get(fieldId), receipt = binding && receipts.get(binding.element);
        if (!receipt?.pageStateRequired || receipt.sourcePath !== sourcePath || !binding.assertIdentity()) return [];
        const ticket = crypto.randomUUID();
        binding.element.setAttribute("data-resume-agent-commit", ticket);
        pendingCommits.set(ticket, { binding, desired: receipt.value, sourcePath });
        return [{ fieldId, sourcePath, ticket, value: receipt.value, readOnly: true }];
      });
    },
    finishCommitAudit: ({ token, ticket, evidence }) => {
      bindings(token);
      const pending = pendingCommits.get(ticket);
      if (!pending) return result("PAGE_COMMIT_UNAVAILABLE");
      pendingCommits.delete(ticket);
      if (pending.binding.element.getAttribute("data-resume-agent-commit") === ticket) pending.binding.element.removeAttribute("data-resume-agent-commit");
      const verified = evidence?.targetMatched === true && evidence.valueMatched === true
        && evidence.pageStateObserved === true && evidence.pageStateMatched === true && pending.binding.assertIdentity();
      return result(verified ? "VERIFIED" : "FINAL_PAGE_STATE_MISMATCH", verified,
        { diagnostic: { ...evidence, phase: "audit", adapter: "page_input", identityVerified: pending.binding.assertIdentity() } });
    },
    scan: (url) => {
      const previous = globalThis.__resumeAgentBindings;
      const report = readFormStructure(url, true), current = globalThis.__resumeAgentBindings;
      if (previous?.expectedUrl === url) {
        const ownedIds = [...previous.fields].filter(([, binding]) => receipts.has(binding.element)).map(([id]) => id);
        for (const pair of matchWrittenTargets(previous.report, report, ownedIds)) {
          const binding = current.fields.get(pair.afterId), old = previous.fields.get(pair.beforeId);
          if (!old || old.element === binding.element || !binding.assertIdentity()) continue;
          const receipt = receipts.get(old.element);
          // A disconnected node is not proof of data loss. Reacquire a receipt
          // only after the same logical field still displays this Agent value.
          if (receipt && !receipt.radio && !receipt.choice && (receipt.display !== null
            ? DropdownSelect.readDisplayText(binding.element) === receipt.display
            : String(binding.element.value ?? "") === receipt.value)) {
            receipts.set(binding.element, receipt);
            const attempt = writeAttempts.get(old.element);
            if (attempt) writeAttempts.set(binding.element, attempt);
          }
          const mark = inducedDateDefaults.get(old.element), widget = DropdownSelect.findSelectRoot(binding.element);
          if (!pair.auditOnly && mark && !mark.userTouched && widget && mark.display === dateDisplay(binding.element)) {
            inducedDateDefaults.set(binding.element, { ...mark, widget });
          }
        }
      }
      current.report = report;
      return { report, token: current.token };
    },
    fill: async (args) => {
      const state = bindings(args.token), initialBinding = state.fields.get(args.fieldId);
      const peers = emptyDatePeers(initialBinding, state);
      const replacedDateDefault = initialBinding && canReplaceInducedDateDefault(initialBinding);
      const outcome = await fillBoundField(args);
      if (outcome.verified) {
        let generated = 0;
        for (const peer of peers) {
          const display = dateDisplay(peer.element), widget = DropdownSelect.findSelectRoot(peer.element);
          if (display && widget && peer.assertIdentity()) {
            inducedDateDefaults.set(peer.element, { display, widget, userTouched: false }); generated++;
          }
        }
        if (replacedDateDefault) inducedDateDefaults.delete(initialBinding.element);
        if (generated || replacedDateDefault) outcome.diagnostic = { ...outcome.diagnostic,
          ...(generated ? { inducedDateDefaultCount: generated } : {}), ...(replacedDateDefault ? { replacedDateDefault: true } : {}) };
      }
      const attemptBinding = bindings(args.token).fields.get(args.fieldId);
      if (attemptBinding && !args.browserEditRetry && ["VERIFIED", "READBACK_MISMATCH"].includes(outcome.code)) {
        writeAttempts.set(attemptBinding.element, { sourcePath: args.sourcePath, label: attemptBinding.field.label, code: outcome.code, retryAttempted: false });
      }
      if (outcome.verified) {
        const binding = bindings(args.token).fields.get(args.fieldId);
        const element = binding.element;
        const scope = element.closest(".el-form-item, .form-group, .form-item--phoenix") || element.form || binding.root;
        const choice = binding.field.kind === "radio" && element.matches(".phoenix-radio-group")
          ? phoenixChoiceOptions(element).find((item) => isPhoenixChoiceChecked(item.el))?.el : null;
        const radio = binding.field.kind === "radio" && !choice ? [...scope.querySelectorAll('input[type=radio]')]
          .find((item) => item.name === element.name && item.checked) : null;
        receipts.set(element, { sourcePath: args.sourcePath, label: binding.field.label,
          kind: binding.field.kind, value: String(element.value ?? ""), radio, choice,
          display: ["custom-select", "combobox", "autocomplete"].includes(binding.field.kind)
            || binding.field.kind === "date" && element.closest(".phoenix-select") ? DropdownSelect.readDisplayText(element) : null });
      }
      return outcome;
    },
    audit: ({ token, targets }) => {
      const state = bindings(token);
      return targets.map((target) => {
        const binding = state.fields.get(target.fieldId);
        if (binding?.element.isConnected === false) return { fieldId: target.fieldId, sourcePath: target.sourcePath,
          code: "REAL_FIELD_BINDING_STALE", verified: false,
          diagnostic: { phase: "audit", adapter: "field_identity", ...binding.identityState() } };
        const receipt = binding ? receipts.get(binding.element) : null;
        const verified = Boolean(binding?.assertIdentity() && receipt && receipt.sourcePath === target.sourcePath
          && receipt.label === binding.field.label && receipt.kind === binding.field.kind
          && (receipt.choice ? isPhoenixChoiceChecked(receipt.choice)
            && phoenixChoiceOptions(binding.element).filter((item) => isPhoenixChoiceChecked(item.el)).length === 1
            : receipt.radio ? receipt.radio.isConnected && receipt.radio.checked
            : receipt.display !== null ? DropdownSelect.readDisplayText(binding.element) === receipt.display
              : String(binding.element.value ?? "") === receipt.value));
        return { fieldId: target.fieldId, sourcePath: target.sourcePath, verified,
          code: verified ? "VERIFIED" : "FINAL_READBACK_MISMATCH",
          diagnostic: { phase: "audit", adapter: "readback", hasCurrentValue: Boolean(binding &&
            (String(binding.element.value || "").trim() || DropdownSelect.readDisplayText(binding.element))),
            identityVerified: Boolean(binding?.assertIdentity()), receiptPresent: Boolean(receipt) } };
      });
    },
    add: addBoundEntry,
    inspect: ({ token, candidates }) => {
      const state = bindings(token);
      return candidates.flatMap(({ fieldId, sourcePath, fact, expectedValue }) => {
        const binding = state.fields.get(fieldId), element = binding?.element;
        return binding && ["text", "textarea", "number"].includes(binding.field.kind) && !element.disabled && !element.readOnly
          && !fieldMappingCompatible(binding.field, fact, binding.group.label) && expectedValue
          && String(element.value ?? "") === String(expectedValue) && binding.assertIdentity() ? [{ fieldId, sourcePath }] : [];
      });
    },
    repair: async ({ token, fieldId, fact, expectedValue, receiptVerified }) => {
      const binding = bindings(token).fields.get(fieldId), element = binding?.element;
      if (element?.isConnected === false) return identityFailure(binding, "open");
      if (!receiptVerified || !binding?.assertIdentity() || fieldMappingCompatible(binding.field, fact, binding.group.label)
        || forbidden.test(binding.field.label) || manualGroup.test(binding.group.label)
        || !["text", "textarea", "number"].includes(binding.field.kind) || element.disabled || element.readOnly) return result("REPAIR_RECEIPT_UNAVAILABLE");
      if (!expectedValue || String(element.value ?? "") !== String(expectedValue)) return result("OWNED_VALUE_CHANGED");
      nativeValue(element, ""); events(element); element.blur(); await pause(180);
      const cleared = binding.assertIdentity() && String(element.value ?? "") === "";
      return result(cleared ? "OWNED_INVALID_VALUE_CLEARED" : "REPAIR_READBACK_MISMATCH", cleared);
    },
    clear: () => { for (const [ticket, pending] of pendingCommits) if (pending.binding.element.getAttribute("data-resume-agent-commit") === ticket) pending.binding.element.removeAttribute("data-resume-agent-commit");
      pendingCommits.clear(); delete globalThis.__resumeAgentBindings; globalThis.__resumeAgentDateDefaultCleanup?.();
      delete globalThis.__resumeAgentDateDefaultCleanup; },
  };
}
