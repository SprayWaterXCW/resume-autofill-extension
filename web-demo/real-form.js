let finalActions = 0;
const label = document.getElementById("verification");
function refresh() {
  const count = [...document.querySelectorAll("input, select")].filter((element) => element.id !== "existing-name"
    && (["radio", "checkbox"].includes(element.type) ? element.checked : Boolean(element.value))).length;
  label.textContent = `已填写 ${count} 项 · 教育 ${document.querySelectorAll("#education [data-agent-entry]").length} 组 · 获奖 ${document.querySelectorAll("#awards [data-agent-entry]").length} 组 · 提交动作 ${finalActions} 次`;
}
for (const button of document.querySelectorAll("[data-add]")) button.addEventListener("click", () => {
  const section = button.closest("section");
  const card = section.querySelector("[data-agent-entry]").cloneNode(true);
  for (const field of card.querySelectorAll("input, textarea, select")) field.value = "";
  section.insertBefore(card, button);
  refresh();
});
const proficiency = document.getElementById("proficiency");
const options = document.getElementById("proficiency-options");
proficiency.addEventListener("click", () => { options.hidden = false; proficiency.setAttribute("aria-expanded", "true"); });
proficiency.addEventListener("keydown", (event) => { if (event.key === "Escape") { options.hidden = true; proficiency.setAttribute("aria-expanded", "false"); } });
for (const option of options.children) option.addEventListener("click", () => {
  proficiency.value = option.textContent; options.hidden = true; proficiency.setAttribute("aria-expanded", "false"); refresh();
});
document.addEventListener("input", refresh);
document.addEventListener("change", refresh);
document.getElementById("declaration").addEventListener("submit", (event) => { event.preventDefault(); finalActions += 1; refresh(); });
document.getElementById("deceptive").addEventListener("click", () => { finalActions += 1; refresh(); });
// Optional delayed request probe sends no profile values. A retained guard must keep the hit count unchanged.
if (new URLSearchParams(location.search).get("probe") === "1") document.addEventListener("input", () => {
  setTimeout(() => fetch("/api/probe/event", { method: "POST", headers: { "X-Demo-Probe": "1" }, body: "{}" }).catch(() => {}), 500);
  setTimeout(() => { const pixel = new Image(); pixel.src = `/api/probe/pixel?nonce=${crypto.randomUUID()}`; }, 500);
});
refresh();
