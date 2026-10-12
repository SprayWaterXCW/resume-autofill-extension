function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Real DOM adapter for the local fixture page only. It never navigates or submits. */
export class DemoDomEnvironment {
  constructor(document, { visualDelayMs = 450 } = {}) {
    this.document = document;
    this.visualDelayMs = visualDelayMs;
    this.entries = document.getElementById("education-entries");
    this.addButton = document.getElementById("add-education");
    this.template = document.getElementById("education-card-template");
    this.submissionCount = 0;
    this.addButton.addEventListener("click", () => this.addEducationEntry());
    this.reset();
  }

  addEducationEntry() {
    const index = this.entries.querySelectorAll(".education-entry").length;
    const card = this.template.content.firstElementChild.cloneNode(true);
    card.dataset.entryIndex = String(index);
    card.querySelector(".entry-number").textContent = `教育经历 ${String(index + 1).padStart(2, "0")}`;
    for (const input of card.querySelectorAll("input[data-key]")) {
      input.id = `education-${index}-${input.dataset.key}`;
      card.querySelector(`[data-label-key="${input.dataset.key}"]`).htmlFor = input.id;
      input.addEventListener("input", () => this.updateCardState(card));
    }
    this.entries.append(card);
    this.document.getElementById("entry-count").textContent = `${index + 1} 段经历`;
    if (index > 0) card.classList.add("entry-new");
  }

  updateCardState(card) {
    const filled = [...card.querySelectorAll("input[data-key]")].every((input) => Boolean(input.value.trim()));
    card.classList.toggle("filled", filled);
    card.querySelector(".entry-state").textContent = filled ? "已填写" : "等待填写";
  }

  reset() {
    this.entries.replaceChildren();
    this.submissionCount = 0;
    this.addEducationEntry();
    return this.observe();
  }

  observe() {
    const cards = [...this.entries.querySelectorAll(".education-entry")];
    const fields = cards.flatMap((card, entryIndex) => [...card.querySelectorAll("input[data-key]")].map((input) => ({
      id: input.id,
      label: card.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() || "",
      sectionKey: "educations",
      entryIndex,
      value: input.value,
      writable: !input.disabled && !input.readOnly,
    })));
    return {
      pageId: "local-recruitment-education-form",
      sections: [{
        key: "educations",
        label: "教育经历",
        entryCount: cards.length,
        addControl: {
          id: this.addButton.id,
          text: this.addButton.textContent.trim(),
          intent: "add_entry",
          role: "button",
          type: this.addButton.type,
          formAction: this.addButton.getAttribute("formaction"),
        },
      }],
      fields,
      otherControls: [{ id: "submit-disabled", text: "提交申请", role: "button", type: "button", disabled: true }],
    };
  }

  async step(action) {
    if (action.tool === "add_entry") {
      if (action.sectionKey !== "educations" || this.addButton.type !== "button") throw new Error("Unsafe add target");
      this.addButton.click();
      await wait(this.visualDelayMs);
    } else if (action.tool === "fill_field") {
      const input = this.document.getElementById(action.fieldId);
      if (!input || !this.entries.contains(input) || input.disabled || input.readOnly) throw new Error("Field unavailable");
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
      input.classList.add("agent-active");
      const card = input.closest(".education-entry");
      card.classList.add("agent-active");
      input.value = action.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
      await wait(this.visualDelayMs);
      input.classList.remove("agent-active");
      card.classList.remove("agent-active");
    } else {
      throw new Error("Unsupported action");
    }
    return { observation: this.observe(), reward: 0, terminated: false, truncated: false, info: {} };
  }

  evaluate(catalog) {
    const paths = catalog.publicEntries
      .map(({ path }) => ({ path, match: /^educations\.(\d+)\.(school|major)$/.exec(path) }))
      .filter(({ match }) => match);
    const expectedEntryCount = 1 + Math.max(...paths.map(({ match }) => Number(match[1])));
    const missingCount = paths.filter(({ path, match }) => {
      const input = this.document.getElementById(`education-${match[1]}-${match[2]}`);
      return !input || input.value !== catalog.getValue(path);
    }).length;
    const entryCount = this.entries.querySelectorAll(".education-entry").length;
    return {
      complete: missingCount === 0 && entryCount === expectedEntryCount && this.submissionCount === 0,
      missingCount,
      entryCount,
      expectedEntryCount,
      submissionCount: this.submissionCount,
    };
  }
}
