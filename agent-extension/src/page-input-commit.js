/** Self-contained MAIN-world protocol; only edits a control marked by the isolated runtime. */
export async function commitPageInput(request, expectedUrl) {
  if (location.href !== expectedUrl || !/^[a-f0-9-]{36}$/.test(request?.ticket || "")
    || typeof request.value !== "string" || request.value.length > 20_000) return { targetMatched: false };
  const targets = document.querySelectorAll(`[data-resume-agent-commit="${request.ticket}"]`);
  if (targets.length !== 1) return { targetMatched: false };
  const element = targets[0];
  if (!element.isConnected || !element.matches("input,textarea,select")
    || element.matches("input[type=password],input[type=file],input[type=checkbox],input[type=radio],input[type=submit],input[type=button],input[type=hidden]")
    || request.readOnly !== true && (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true")) return { targetMatched: false };

  // Current React host props are a local read-only witness. Never invoke page
  // callbacks, mutate trackers/stores, or call fetch/save/submit APIs.
  const pageState = () => {
    const entries = Object.entries(Object.getOwnPropertyDescriptors(element))
      .filter(([key, descriptor]) => /^__reactProps\$|^__reactEventHandlers\$/.test(key) && descriptor.value);
    if (entries.length !== 1) return { pageStateObserved: false };
    const descriptors = Object.getOwnPropertyDescriptors(entries[0][1].value);
    const value = descriptors.value?.value;
    const controlled = (typeof value === "string" || typeof value === "number")
      && (typeof descriptors.onChange?.value === "function" || typeof descriptors.onInput?.value === "function");
    return controlled ? { pageStateObserved: true, pageStateMatched: String(value) === request.value, pageStateDomMatched: String(value) === element.value } : { pageStateObserved: false };
  };
  const before = pageState();
  if (request.readOnly === true) return { targetMatched: true, pageStateObserved: before.pageStateObserved,
    ...(before.pageStateObserved ? { pageStateMatched: before.pageStateMatched } : {}), valueMatched: element.value === request.value,
    validityValid: element.validity?.valid !== false };
  if (!["overwrite", "empty"].includes(request.fillMode)) return { targetMatched: false };
  if (request.fillMode === "empty" && String(element.value || "").trim()) return { targetMatched: true, contentProtected: true };
  const documentFocused = document.hasFocus();
  let inputEventObserved = false, trustedInputObserved = false, changeEventObserved = false;
  let blurEventObserved = false, focusOutEventObserved = false, syntheticBlurUsed = false;
  const onInput = (event) => { inputEventObserved = true; trustedInputObserved ||= event.isTrusted; };
  const onChange = () => { changeEventObserved = true; };
  const onBlur = () => { blurEventObserved = true; };
  const onFocusOut = () => { focusOutEventObserved = true; };
  element.addEventListener("input", onInput); element.addEventListener("change", onChange);
  element.addEventListener("blur", onBlur, true); element.addEventListener("focusout", onFocusOut, true);
  let editInserted = false, mainWorldSetterUsed = false;
  try {
    element.scrollIntoView?.({ block: "center" }); element.focus();
    const textEditable = element.matches("textarea,input:not([type]),input[type=text],input[type=tel],input[type=email],input[type=url],input[type=search]");
    if (textEditable && typeof document.execCommand === "function") {
      element.select();
      try { if (document.activeElement === element) editInserted = document.execCommand("insertText", false, request.value) === true; }
      catch { editInserted = false; }
    }
    if (!editInserted || !inputEventObserved || element.value !== request.value) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { targetMatched: true, ...before, inputEventObserved, trustedInputObserved, changeEventObserved };
      setter.call(element, request.value); mainWorldSetterUsed = true;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // A legacy DOM-only write may have left the tracker equal to the displayed
    // value while controlled state is empty. Produce real value changes through
    // native setters/events; never mutate the framework's tracker directly.
    const interim = pageState();
    if (interim.pageStateObserved && !interim.pageStateMatched && element.value === request.value) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) {
        setter.call(element, ""); element.dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(element, request.value); element.dispatchEvent(new Event("input", { bubbles: true }));
        mainWorldSetterUsed = true;
      }
    }
    element.dispatchEvent(new Event("change", { bubbles: true })); element.blur();
    // A tab may have no native focus while the extension popup or another tab
    // owns it. Some controls only forward their edited value on blur; React 17+
    // delegates this through focusout. Complete missing platform events without
    // invoking component callbacks or changing any application store.
    if (element.isConnected && location.href === expectedUrl) {
      if (!blurEventObserved) {
        syntheticBlurUsed = true;
        element.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: null }));
      }
      if (!focusOutEventObserved) {
        syntheticBlurUsed = true;
        element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      }
    }
    // Return immediately: hidden page timers can be throttled or suspended.
    // The extension waits outside the page and reads this ticket again before
    // accepting a receipt, so the write itself is never repeated for readback.
    const after = pageState();
    return { targetMatched: element.isConnected && location.href === expectedUrl,
      pageStateObserved: after.pageStateObserved, ...(after.pageStateObserved ? { pageStateMatched: after.pageStateMatched } : {}),
      ...(before.pageStateObserved ? { pageStateMatchedBefore: before.pageStateMatched, pageStateDomMatchedBefore: before.pageStateDomMatched } : {}),
      valueMatched: element.value === request.value, validityValid: element.validity?.valid !== false,
      documentFocused, editInserted, mainWorldSetterUsed, inputEventObserved, trustedInputObserved, changeEventObserved,
      blurEventObserved, focusOutEventObserved, syntheticBlurUsed };
  } finally {
    element.removeEventListener("input", onInput); element.removeEventListener("change", onChange);
    element.removeEventListener("blur", onBlur, true); element.removeEventListener("focusout", onFocusOut, true);
  }
}
