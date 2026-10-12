import { DropdownSelect } from "../../src/vendor/formfill/dropdown-select.js";

import { pause } from "./page-wait.js";
const clean = (value) => String(value || "").replace(/[\s\u200b\u200c\u200d\ufeff]/g, "");
const regionName = (value) => clean(value).replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|省|市|地区|盟|区|县)$/, "");
const specs = {
  nation: { panel: ".constant-main-selector-container", items: ".left-container .list-item-container",
    label: ".item-text-label", unchecked: "svg.RadioUnchecked", checked: "svg.RadioChecked", footer: ".selector-footer-button",
    adapter: "beisen_constant_picker" },
  areas: { panel: ".area-selector-container", items: ".left-container .area-item-container",
    label: ".area-item-name .area-text-label", unchecked: "svg.area-icon-RadioUnchecked", checked: "svg.area-icon-RadioChecked",
    footer: ".area-footer-button", adapter: "beisen_area_picker" },
};

export function beisenPickerKind(binding, sourcePath, pageUrl) {
  try {
    const page = new URL(pageUrl);
    if (!["http:", "https:"].includes(page.protocol) || !binding.element.closest(".phoenix-select")) return null;
  } catch { return null; }
  const label = clean(binding.field.label).replace(/^[*＊]/, "").replace(/[:：]$/, "");
  if (label === "民族" && ["formAnswers.ethnicity", "personal.ethnicity"].includes(sourcePath)) return "nation";
  if (label === "籍贯" && sourcePath === "formAnswers.hometown") return "areas";
  if (label === "生源地" && sourcePath === "formAnswers.studentOrigin") return "areas";
  return null;
}

function mouse(control, navigate = false) {
  control.scrollIntoView?.({ block: "nearest" });
  if (navigate) {
    control.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    control.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  }
  for (const type of ["mousedown", "mouseup", "click"]) control.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

function controls(panel, spec, state, label) {
  return [...panel.querySelectorAll(`${spec.footer} .phoenix-button`)].filter((control) => control.isConnected && state.visible(control)
    && clean(control.querySelector(".phoenix-button__content")?.textContent || control.textContent) === label
    && control.matches("div, button[type=button]") && !control.disabled && control.getAttribute("aria-disabled") !== "true"
    && !control.hasAttribute("formaction") && !control.closest("a") && !control.querySelector("a, input, button[type=submit]"));
}

function cancel(panel, spec, state) {
  if (!panel?.isConnected || !state.visible(panel)) return;
  const buttons = controls(panel, spec, state, "取消");
  if (buttons.length === 1) mouse(buttons[0].querySelector(".phoenix-button__content") || buttons[0]);
}

function available(panel, spec, state) {
  return [...panel.querySelectorAll(spec.items)].filter((item) => state.visible(item) && item.isConnected
    && !item.matches(".disabled, .is-disabled") && item.getAttribute("aria-disabled") !== "true")
    .map((el) => ({ el, text: String(el.querySelector(spec.label)?.textContent || "").trim() })).filter((item) => item.text);
}

function localPanels(element, spec, state) {
  const anchor = element.getBoundingClientRect();
  return [...document.querySelectorAll(spec.panel)].filter((panel) => state.visible(panel)
    && panel.querySelector("input.phoenix-input__input") && panel.querySelector(spec.footer))
    .filter((panel) => {
      const rect = panel.getBoundingClientRect();
      return Math.max(0, anchor.left - rect.right, rect.left - anchor.right)
        + Math.max(0, anchor.top - rect.bottom, rect.top - anchor.bottom) < 180;
    });
}

function orderedPath(parts, text) {
  const segments = String(text || "").split(/[\/\s>＞,，;；→\-]+/).map(regionName).filter(Boolean);
  let cursor = -1;
  return parts.every((part) => {
    const next = segments.findIndex((segment, index) => index > cursor && segment === regionName(part));
    if (next < 0) return false;
    cursor = next; return true;
  });
}

/** Observed Phoenix picker protocol: load -> radio -> local confirm -> field readback.
 * Values and selected paths stay in the isolated page world. No generic click is exposed. */
export async function fillBeisenPicker(binding, value, state, kind, regionParts = []) {
  const spec = specs[kind], started = Date.now();
  let panel, phase = "open", optionCount = 0, panelCount = 0, levelCount = 0, confirmCount = 0, selectedCount = 0;
  let pathMatched = false, valueMatched = false, picked, selectionRowReplaced = false;
  const diagnostic = () => ({ phase, adapter: spec.adapter, panelCount, levelCount, confirmCount, selectedCount,
    checkedOptionCount: panel?.querySelectorAll(`.left-container ${spec.checked}`).length || 0,
    selectedLabelCount: panel?.querySelectorAll(".right-container .select-data-container .select-area-text-label, .right-container .select-data-container .item-text-label").length || 0,
    panelClosed: Boolean(panel && (!panel.isConnected || !state.visible(panel))),
    rowSelected: Boolean(picked?.el.querySelector(spec.checked)), selectionRowReplaced,
    displayOnInput: Boolean(binding.element.value), displayOnContent: Boolean(binding.element.closest(".phoenix-select")?.querySelector(".phoenix-select__content")?.textContent?.trim()),
    waitedMs: Math.min(60_000, Date.now() - started), pathMatched, valueMatched, identityVerified: binding.assertIdentity() });
  const finish = (code, verified = false) => {
    const observed = diagnostic();
    if (!verified) cancel(panel, spec, state);
    return { code, verified, optionCount, diagnostic: observed };
  };
  const valid = () => binding.assertIdentity() && state.expectedUrl === location.href;
  const waitFor = async (read, timeout = 45_000) => {
    const deadline = Date.now() + timeout;
    do {
      if (!valid()) return null;
      const found = read(); if (found) return found;
      await pause(180);
    } while (Date.now() < deadline);
    return null;
  };
  let parts = [];
  if (kind === "areas") {
    if (!Array.isArray(regionParts) || !regionParts.length || regionParts.length > 3
      || regionParts.some((part) => typeof part !== "string" || !part.trim() || part.length > 50)) return finish("SOURCE_UNAVAILABLE");
    // Legacy profile fields can repeat a province. Preserve the explicit precision.
    parts = regionParts.filter((part, index) => !index || clean(part) !== clean(regionParts[index - 1]));
    if (/^(中国|中国大陆|中华人民共和国)$/.test(clean(parts[0])) && parts.length > 1) parts.shift();
    if (!parts.length) return finish("SOURCE_UNAVAILABLE");
  }
  binding.element.scrollIntoView?.({ block: "center" });
  const oldPanels = localPanels(binding.element, spec, state);
  if (oldPanels.length > 1) return finish("PICKER_AMBIGUOUS");
  if (oldPanels.length === 1) { cancel(oldPanels[0], spec, state); await pause(160); }
  const trigger = binding.element.closest(".phoenix-select")?.querySelector(".phoenix-select__switchArrow");
  if (!trigger || !state.visible(trigger)) return finish("PICKER_TRIGGER_UNAVAILABLE");
  mouse(trigger);
  phase = "wait";
  const loaded = await waitFor(() => {
    const panels = localPanels(binding.element, spec, state); panelCount = panels.length;
    if (panels.length > 1) return { ambiguous: true };
    panel = panels[0];
    const items = panel ? available(panel, spec, state) : [];
    optionCount = items.length;
    return items.length ? { items } : null;
  });
  if (!valid()) return finish("REAL_PAGE_CHANGED");
  if (loaded?.ambiguous) return finish("PICKER_AMBIGUOUS");
  if (!loaded) return finish("DICTIONARY_NOT_LOADED");
  if (kind === "nation") {
    phase = "search";
    const matching = loaded.items.filter((item) => clean(item.text) === clean(value));
    if (matching.length !== 1) return finish(matching.length > 1 ? "PICKER_AMBIGUOUS" : "OPTION_UNAVAILABLE");
    picked = matching[0];
  } else {
    phase = "navigate";
    let candidates = loaded.items;
    for (let index = 0; index < parts.length; index += 1) {
      const matches = candidates.filter((item) => regionName(item.text) === regionName(parts[index]));
      if (matches.length !== 1) return finish(matches.length > 1 ? "PICKER_AMBIGUOUS" : "REGION_LEVEL_UNAVAILABLE");
      picked = matches[0]; levelCount += 1;
      if (index === parts.length - 1) break;
      const arrow = picked.el.querySelector(".area-icon-right.visible");
      if (!arrow || !state.visible(arrow)) return finish("REGION_NAVIGATION_UNAVAILABLE");
      const previous = new Set(available(panel, spec, state).map((item) => item.el));
      mouse(arrow, true);
      const children = await waitFor(() => {
        const current = available(panel, spec, state);
        // Both nested rows and replaced breadcrumb lists are observed safely.
        const next = current.filter((item) => !previous.has(item.el) || picked.el.contains(item.el) && item.el !== picked.el);
        return next.length ? next : null;
      }, 12_000);
      if (!valid()) return finish("REAL_PAGE_CHANGED");
      if (!children) return finish("REGION_NAVIGATION_NOT_OBSERVED");
      candidates = children; optionCount = candidates.length;
    }
  }
  phase = "select";
  if (!valid() || !picked.el.isConnected || !panel.contains(picked.el)) return finish("REAL_PAGE_CHANGED");
  const radio = picked.el.querySelector(spec.unchecked);
  if (!radio || picked.el.querySelector(spec.checked)) return finish("PICKER_SELECTION_UNAVAILABLE");
  mouse(radio);
  const selected = await waitFor(() => {
    const matches = available(panel, spec, state).filter((item) => clean(item.text) === clean(picked.text));
    if (matches.length !== 1) return false;
    if (matches[0].el !== picked.el) selectionRowReplaced = true;
    picked = matches[0];
    const checked = [...panel.querySelectorAll(`.left-container ${spec.checked}`)];
    selectedCount = checked.length;
    return checked.length === 1 && picked.el.isConnected && picked.el.contains(checked[0]);
  }, 2_000);
  if (!valid()) return finish("REAL_PAGE_CHANGED");
  if (!selected) return finish("PICKER_SELECTION_NOT_OBSERVED");
  if (kind === "areas") {
    const labels = [...panel.querySelectorAll(".right-container .select-data-container .select-area-text-label")];
    pathMatched = labels.length === 1 && orderedPath(parts, labels[0].textContent);
    if (!pathMatched) return finish("REGION_PATH_MISMATCH");
  } else pathMatched = clean(picked.text) === clean(value);
  phase = "commit";
  const confirms = controls(panel, spec, state, "确定"); confirmCount = confirms.length;
  if (confirms.length !== 1 || !valid()) return finish("PICKER_CONFIRM_UNAVAILABLE");
  // Some versions attach the callback to the content child. Dispatching on
  // the wrapper cannot reach a child's handler; clicking the content bubbles
  // to either implementation while remaining inside the verified local footer.
  mouse(confirms[0].querySelector(".phoenix-button__content") || confirms[0]);
  const committed = await waitFor(() => {
    const closed = !panel.isConnected || !state.visible(panel);
    const display = DropdownSelect.readDisplayText(binding.element);
    valueMatched = kind === "nation" ? clean(display) === clean(value) : orderedPath(parts, display)
      || pathMatched && regionName(display) === regionName(parts.at(-1));
    return closed && valueMatched;
  }, 2_500);
  return finish(!valid() ? "REAL_PAGE_CHANGED" : committed ? "VERIFIED" : "PICKER_NOT_COMMITTED", Boolean(committed && valid()));
}
