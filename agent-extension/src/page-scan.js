export function isScannableUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

export function isAuthenticationUrl(url) {
  try {
    const parsed = new URL(url);
    return /(?:^|\/)(?:login|signin|sign-in|signup|sign-up|register)(?:[/.?]|$)/i.test(`${parsed.pathname}/${parsed.hash.replace(/^#/, "")}`);
  } catch { return true; }
}

// Chrome serializes this function. Read DOM metadata only; never dispatch events or call page code.
export function readFormStructure(expectedUrl, bindForExecution = false) {
  if (location.href !== expectedUrl) throw new Error("SCAN_PAGE_CHANGED");
  const hzBank = location.hostname === "myjob.hzbank.com.cn"
    && location.pathname === "/hzzp-apply-web/static/index.html"
    && /^#\/createResume(?:\?|$)/.test(location.hash);
  const localDemo = location.hostname === "127.0.0.1" && ["4173", "4174"].includes(location.port)
    && location.pathname === "/" && new URLSearchParams(location.search).get("runner") === "browser-use";
  const phoenix = Boolean(document.querySelector(".ux-standard-form .form-item--phoenix"));
  const fieldSelector = "input, textarea, select, [role=combobox], [role=textbox], [contenteditable=true], canvas, .phoenix-radio-group";
  const popupSelector = ".phoenix-date-picker__wrap, .phoenix-date-picker-special-wrap, .phoenix-selectList, [role=listbox], .el-select-dropdown, .ant-select-dropdown, .constant-main-selector-container, .area-selector-container, [class*=Select-menu], [class*=select-menu], [class*=Dropdown-dropdown], [class*=dropdown-menu]";
  const groupSelector = hzBank ? ".resume-form-container, #statementForm" : "fieldset, section, form, [role=region]";
  const sensitiveLabel = /姓名|手机|电话|联系方式|联系人|邮箱|邮件|地址|居住|户口|籍贯|出生|身高|体重|证件|身份证|护照|证书号|证书编号|血型|民族|政治|婚姻|疾病|患有|亲属|不良行为|处罚|处分|居留权|签名|password|email|phone|address|passport|social.security/i;
  const trim = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const metadataText = (element) => {
    if (!element) return "";
    const walk = (node) => {
      if (node.nodeType === 3) return node.nodeValue || "";
      if (node.nodeType !== 1) return "";
      if (node.matches("input, textarea, select, script, style, [contenteditable=true]")) return "";
      return [...node.childNodes].map(walk).join(" ");
    };
    return trim(walk(element));
  };
  const visible = (element) => {
    if (element.closest("[hidden], [aria-hidden=true]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const labelledBy = (element) => (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/).filter(Boolean).map((id) => metadataText(document.getElementById(id))).join(" ");
  // Searchable selects can clear their unit placeholder while focused or after
  // committing a choice. Retain only a unit observed on this exact widget node,
  // never its value. A new explicit unit takes precedence, and moving/replacing
  // the widget invalidates the hint; labels and region/record checks still run.
  const datePartHints = globalThis.__resumeAgentDatePartHints instanceof WeakMap
    ? globalThis.__resumeAgentDatePartHints : (globalThis.__resumeAgentDatePartHints = new WeakMap());
  // Captions must stay independent of the selected/displayed value. A numeric
  // country code or a selected option is not an accessible field name.
  const captionText = (element) => {
    const selected = "[role=option], [role=listbox], .ant-select-selection-item, .el-select__selected-item, .next-select-values, .phoenix-select__content, [class*=display-value], [class*=selected-value], [class*=selection-item]";
    if (!element || element.closest(selected)) return "";
    const walk = (node) => node.nodeType === 3 ? node.nodeValue || "" : node.nodeType !== 1
      || node.matches("input, textarea, select, script, style, [contenteditable=true], " + selected) ? ""
      : [...node.childNodes].map(walk).join(" ");
    const text = trim(walk(element)).replace(/[\uE000-\uF8FF▾▿▼▽⌄⌃]/gu, "").trim();
    return !text || /^\+?\d[\d\s.,/-]*$/.test(text) ? "" : text;
  };
  const isFieldCaption = (node) => {
    // A decorated input can contain labels, selected-value spans and arrows.
    // Those descendants do not turn the preceding field caption into a section.
    let caption = node;
    while (caption?.parentElement && !caption.nextElementSibling
      && !caption.parentElement.querySelector(fieldSelector)
      && captionText(caption.parentElement) === captionText(node)) caption = caption.parentElement;
    const target = caption?.nextElementSibling;
    if (!target) return false;
    if (target.matches("input, textarea, select, [role=combobox]")) return true;
    const count = target.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox]").length;
    if (!count || count > 6) return false;
    if (count === 1 && !sectionCaption.test(captionText(node))) return true;
    const nestedCaptions = [...target.querySelectorAll("label, span, div, p, h1, h2, h3, h4, [role=heading]")]
      .some((child) => visible(child) && !child.children.length && !child.matches(fieldSelector)
        && !child.closest(popupSelector)
        && /[\p{L}]/u.test(captionText(child))
        && !/^(?:年|月|日|至今|请选择|请输入|year|month|day|present|select|please select)$/i.test(captionText(child)));
    return !nestedCaptions;
  };
  const labelFor = (element) => {
    const item = element.closest(".el-form-item, .form-group, .form-item--phoenix");
    const containerLabel = captionText(item?.querySelector(".form-item__title .form-item__text, label"));
    if (containerLabel) return { label: containerLabel, source: "container-label" };
    const linked = trim(labelledBy(element));
    if (linked) return { label: linked, source: "aria-labelledby" };
    const labels = [...(element.labels || [])].map(captionText).filter(Boolean).join(" ");
    if (labels) return { label: trim(labels), source: "label" };
    const aria = trim(element.getAttribute("aria-label"));
    if (aria) return { label: aria, source: "aria-label" };
    for (let parent = element.parentElement, level = 0; parent && level < 3; parent = parent.parentElement, level += 1) {
      if (parent.matches("form, section, fieldset")) break;
      const direct = captionText(parent.querySelector(":scope > label"));
      if (direct) return { label: direct, source: "nearby-label" };
    }
    // A bounded field row can use a plain caption div/span instead of <label>.
    // Read only a preceding, control-free sibling, never a whole form/card.
    for (let child = element, level = 0; child?.parentElement && level < 9; child = child.parentElement, level += 1) {
      const parent = child.parentElement;
      if (parent.matches("form, section, fieldset, [data-agent-group]")) break;
      const count = parent.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox]").length;
      if (count > 6) break;
      const sibling = child.previousElementSibling;
      const text = sibling && !sibling.matches(fieldSelector) && !sibling.querySelector(fieldSelector)
        && !sibling.matches("button, a, [role=button], [role=option], h1, h2, h3, h4, h5, h6, legend, [role=heading]") ? captionText(sibling) : "";
      if (text && text.length <= 90 && (!sectionCaption.test(text) || isFieldCaption(sibling))
        && !/^(?:年|月|日|year|month|day|至|到|[-—–~])$/i.test(text)) return { label: text, source: "sibling-caption" };
    }
    const placeholder = trim(element.getAttribute("placeholder"));
    if (placeholder && !/^(请选择|请输入|select|please select)$/i.test(placeholder)) {
      return { label: placeholder, source: "placeholder" };
    }
    return { label: "未识别字段", source: "missing" };
  };
  const fullDateWidgetFor = (element) => {
    const type = element.getAttribute("type") || "";
    if (["date", "datetime-local", "month", "time"].includes(type)
      || element.closest(".el-date-editor, [class*=phoenix-date]")) return true;
    // Phoenix calendars and list selects share the same outer wrapper. Their
    // generic input placeholder can be "年", even for a complete date. Use the
    // field caption to distinguish a calendar from an explicitly split unit.
    const caption = labelFor(element).label;
    return phoenix && Boolean(element.closest(".phoenix-select"))
      && /(?:日期|时间|年月|\bdate\b)\s*$/i.test(caption)
      && !/(?:[（(]\s*(?:年|月|日|year|month|day)\s*[）)]|\/(?:年|月|日))\s*$/i.test(caption);
  };
  const datePartFor = (element) => {
    if (fullDateWidgetFor(element)) return null;
    const unit = trim(element.getAttribute("placeholder") || element.getAttribute("aria-label"));
    const part = /^(?:请输入|请选择|select\s+)?(?:年|年份|year|yyyy)$/i.test(unit) ? "year"
      : /^(?:请输入|请选择|select\s+)?(?:月|月份|month|mm)$/i.test(unit) ? "month"
      : /^(?:请输入|请选择|select\s+)?(?:日|day|dd)$/i.test(unit) ? "day" : null;
    const widget = selectRootFor(element);
    if (part) {
      if (widget) datePartHints.set(element, { part, widget });
      return part;
    }
    const hint = datePartHints.get(element);
    if (!unit && widget && hint?.widget === widget) return hint.part;
    const text = labelFor(element).label;
    if (/年份|(?:时间|日期|date|start|end|birth|graduation).*?(?:[（(]\s*(?:年|year)\s*[）)]|\byear\b)\s*$/i.test(text)) return "year";
    if (/月份|(?:时间|日期|date|start|end|birth|graduation).*?(?:[（(]\s*(?:月|month)\s*[）)]|\bmonth\b)\s*$/i.test(text)) return "month";
    if (/(?:时间|日期|date|birth).*?(?:[（(]\s*(?:日|day)\s*[）)]|\bday\b)\s*$/i.test(text)) return "day";
    return null;
  };
  const observedLabelFor = (element) => {
    const result = labelFor(element), part = datePartFor(element);
    if (!part || result.source === "missing") return result;
    const suffix = { year: "年", month: "月", day: "日" }[part];
    const role = dateRoleFor(element);
    return { ...result, label: result.label === suffix || result.label === part ? result.label
      : trim(result.label + (role ? role === "start" ? " / 开始" : " / 结束" : "") + ` / ${suffix}`) };
  };
  const dateRoleFor = (element) => {
    if (!datePartFor(element)) return null;
    const caption = labelFor(element).label;
    if (/开始|起始|入学|\bstart\b/i.test(caption)) return "start";
    if (/结束|终止|\bend\b/i.test(caption)) return "end";
    for (let root = element.parentElement, depth = 0; root && depth < 9; root = root.parentElement, depth += 1) {
      const inputs = [...root.querySelectorAll("input, select")].filter((control) => datePartFor(control));
      if (inputs.length > 6) break;
      const units = inputs.map(datePartFor), half = inputs.length / 2;
      const rangeCaption = /起止|就读时间|期间|时间段|date range|period/i.test(caption);
      const separator = /(?:^|\s)[—–~至到-](?:\s|$)/.test(captionText(root));
      if ([2, 3].includes(half) && (rangeCaption || separator)
        && JSON.stringify(units.slice(0, half)) === JSON.stringify(units.slice(half))
        && new Set(units.slice(0, half)).size === half) return inputs.indexOf(element) < half ? "start" : "end";
    }
    return null;
  };
  const groups = [];
  const groupRoots = new Map();
  const entryRoots = new Map();
  // Observed Phoenix layout: a plain title div with an id, followed by the
  // record container. Avoid generated styled-component class names.
  const phoenixHeading = (root) => [...root.children].find((child) => child.matches("div[id]")
    && !child.querySelector(fieldSelector) && /^(基本信息|个人信息|联系方式|简历附件|教育经历|实习经历|工作经历|项目经历|获奖情况|获奖经历|竞赛经历|在校职务|校园经历|论文\/专著|附加信息|附加问题)$/.test(metadataText(child)));
  const phoenixGroupFor = (element) => {
    if (!phoenix) return null;
    for (let root = element.parentElement, level = 0; root && root !== document.body && level < 32; root = root.parentElement, level += 1) {
      if (phoenixHeading(root) && root.querySelector(".ux-standard-form")) return root;
    }
    return null;
  };
  // Logical sections are observed through headings/ARIA and their DOM ranges.
  // This works inside a single form, including plain div layouts, without a
  // hostname, generated CSS name or company-specific field mapping.
  const sectionCaption = /^(?:申请信息|基本信息|基本资料|个人信息|个人资料|联系方式|联系信息|求职意向|求职信息|教育(?:经历|背景)|学习经历|实习经历|工作经历|职业经历|项目(?:经历|经验)|校园经历|在校经历|在校职务|社会实践|语言(?:能力|技能)|技能(?:信息|特长)|证书(?:与认证)?|资格证书|认证信息|获奖(?:情况|经历)|奖项(?:与荣誉)?|荣誉(?:情况|经历)?|竞赛经历|比赛经历|自我描述|附加信息|补充信息|其他信息|附加问题|更新说明|有关声明|简历附件|application information|personal information|contact information|education|academic background|employment|work experience|internships?|projects?|languages?|skills?|certifications?|awards?|honors?|competitions?)(?:\s*[（(].*[）)])?$/i;
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, [role=heading], div, p, span")].filter((node) => {
    if (!visible(node) || node.querySelector(fieldSelector) || node.closest("label, button, a, [role=button], " + popupSelector)) return false;
    if (node.closest("[data-agent-entry], .education-entry, .experience-entry, .resume-entry, .repeat-entry, .ux-standard-form, [role=listitem]")) return false;
    const text = captionText(node);
    if (!text || text.length > 90) return false;
    const semantic = node.matches("h1, h2, h3, h4, h5, h6, legend, [role=heading]");
    if (isFieldCaption(node) && !(semantic && sectionCaption.test(text))) return false;
    const named = /(?:^|[\s_-])(?:section[-_])?(?:title|heading|header)(?:[\s_-]|$)/i.test(String(node.className || ""));
    return semantic || named || sectionCaption.test(text) && ![...node.children].some((child) => captionText(child) === text);
  });
  const headingSet = new Set(headings), regionCache = new WeakMap();
  const regionFor = (element) => {
    if (regionCache.has(element)) return regionCache.get(element);
    const explicit = hzBank ? element.closest(".resume-form-container") || element.closest("#statementForm")
      : element.closest(".resume-form-container, [data-agent-group]") || phoenixGroupFor(element);
    let descriptor;
    if (explicit) descriptor = { key: explicit, root: explicit, heading: phoenix ? phoenixHeading(explicit) : null,
      source: "explicit" };
    if (!descriptor && !hzBank) {
      for (let root = element.parentElement, depth = 0; root && depth < 32; root = root.parentElement, depth += 1) {
        const preceding = headings.filter((heading) => root.contains(heading) && !heading.contains(element)
          && (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
        // Do not let a heading buried in another record label the current one.
        const eligible = preceding.filter((heading) => {
          let branch = heading;
          while (branch.parentElement !== root) branch = branch.parentElement;
          return headingSet.has(branch) || !branch.querySelector(fieldSelector);
        });
        const heading = eligible.at(-1);
        if (heading) { descriptor = { key: heading, root, heading, source: "heading-range" }; break; }
        if (root.matches("fieldset, section, [role=region]") && (labelledBy(root) || root.getAttribute("aria-label"))) {
          descriptor = { key: root, root, source: "semantic" }; break;
        }
      }
    }
    if (!descriptor) {
      const root = element.closest("fieldset, section, [role=region], form") || document.body;
      descriptor = { key: root, root, source: "fallback" };
    }
    regionCache.set(element, descriptor);
    return descriptor;
  };
  const groupFor = (element) => {
    const { key, root, heading: observedHeading, source } = regionFor(element);
    if (!groupRoots.has(key)) {
      const heading = observedHeading || (root === document.body ? null : root.querySelector(".resume-form-title, legend, h1, h2, h3, h4, [role=heading]"));
      const label = (source === "heading-range" ? metadataText(heading) : "") || trim(labelledBy(root)) || trim(root.getAttribute("aria-label")) || metadataText(heading)
        || (hzBank && root.id === "statementForm" ? "有关声明" : root === document.body ? "页面其他控件" : `未命名分组 ${groups.length + 1}`);
      const group = { id: `group-${groups.length + 1}`, label, source, entryCount: 0, fieldCount: 0, controlCount: 0 };
      groupRoots.set(key, group);
      entryRoots.set(group.id, new Map());
      groups.push(group);
    }
    return groupRoots.get(key);
  };
  if (hzBank) [...document.querySelectorAll(groupSelector)].filter(visible).forEach(groupFor);
  const selectRootFor = (element) => {
    const known = element.closest(".el-select, .phoenix-select, .ant-select, .rc-select, .next-select");
    if (known) return known;
    for (let root = element.parentElement, depth = 0; root && depth < 4; root = root.parentElement, depth += 1) {
      if (root.matches("form, section, fieldset") || root.querySelectorAll("input:not([type=hidden]), textarea, select").length > 1) break;
      if ([...root.classList].some((name) => /(?:^|[-_])select(?:$|[-_])/i.test(name))) return root;
    }
    return null;
  };
  const kindFor = (element) => {
    const type = element.getAttribute("type") || "";
    if (element.matches("canvas")) return "signature";
    if (type === "password") return "credential";
    if (type === "file") return "file";
    if (["radio", "checkbox"].includes(type)) return type;
    if (phoenix && element.matches(".phoenix-radio-group")) return "radio";
    if (element.closest(".el-cascader, [class*=phoenix-cascader]")) return "cascader";
    if (fullDateWidgetFor(element)) return "date";
    if (element.closest(".el-select, .phoenix-select, .ant-select, .rc-select, .next-select")
      || element.getAttribute("aria-haspopup") === "listbox" || !element.matches("select") && selectRootFor(element)) return "custom-select";
    if (element.closest(".el-date-editor, [class*=phoenix-date]") || ["date", "datetime-local", "month", "time"].includes(type)) return "date";
    if (element.closest(".el-autocomplete") || element.getAttribute("aria-autocomplete") === "list") return "autocomplete";
    if (element.matches("select")) return "select";
    if (element.closest("[role=combobox]")) return "combobox";
    if (type === "number" || element.closest(".el-input-number")) return "number";
    if (element.matches("textarea, [contenteditable=true]")) return "textarea";
    return "text";
  };
  const fields = [];
  const fieldBindings = new Map();
  const controlBindings = new Map();
  let hiddenFieldCount = 0;
  let auxiliaryFieldCount = 0;
  let omittedFieldCount = 0;
  const signatureCache = new WeakMap();
  const entrySignature = (root, region) => {
    if (signatureCache.get(root)?.has(region.key)) return signatureCache.get(root).get(region.key);
    const controls = [...root.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]), textarea, select")]
      .filter((control) => !control.closest(popupSelector) && visible(control) && regionFor(control).key === region.key);
    const labels = controls.map((control) => observedLabelFor(control).label);
    const informative = new Set(labels.filter((text) => text !== "未识别字段" && !/^(年|月|日|year|month|day)$/i.test(text)));
    const regionLabel = captionText(region.heading) || labelledBy(region.root) || region.root.getAttribute("aria-label") || "";
    const recordRegion = /教育|学习经历|实习|工作经历|职业经历|项目(?:经历|经验)|校园|在校|语言(?:能力|技能)|证书|获奖|奖项|竞赛|家庭成员|education|internship|work experience|projects?|languages?|awards?|competitions?|family/i.test(regionLabel);
    // Similar scalar decorators (phone country code + phone, for example)
    // are not separate people. Single-field repeated records require a
    // section that actually describes records; multi-field cards use shape.
    const signature = controls.length && (informative.size > 1 || informative.size && recordRegion)
      && !controls.every((control) => ["radio", "checkbox"].includes(control.type))
      ? JSON.stringify(controls.map((control, index) => [control.tagName, control.type, kindFor(control), labels[index]])) : null;
    if (!signatureCache.has(root)) signatureCache.set(root, new Map());
    signatureCache.get(root).set(region.key, signature);
    return signature;
  };
  const entryFor = (element) => {
    const region = regionFor(element);
    const explicit = element.closest("[data-agent-entry], .education-entry, .experience-entry, .resume-entry, .repeat-entry")
      || (phoenix ? element.closest(".ux-standard-form") : null);
    if (explicit && region.root.contains(explicit)) return { root: explicit, source: "explicit" };
    let repeated;
    for (let root = element.parentElement, depth = 0; root && root !== region.root && depth < 24; root = root.parentElement, depth += 1) {
      const signature = entrySignature(root, region);
      if (signature && [...root.parentElement.children].filter((sibling) => entrySignature(sibling, region) === signature).length > 1) repeated = root;
    }
    if (repeated) return { root: repeated, source: "repeated-siblings" };
    const form = element.closest("form");
    return { root: form && region.root.contains(form) ? form : region.key, source: "single" };
  };
  for (const element of document.querySelectorAll(fieldSelector)) {
    if (element.closest(popupSelector)) continue;
    if (element.matches("[role=combobox], [role=textbox], [contenteditable=true]")
      && element.querySelector("input, textarea, select")) continue;
    if (element.matches("input[type=hidden], input[type=submit], input[type=reset], input[type=button], input[type=image]")) continue;
    // Navigation/job-search inputs are not resume answers. This uses functional
    // roles and explicit search captions, independently of the site's hostname.
    if (element.closest("nav, header, aside, [role=navigation], [role=search]")
      || /^(?:搜索(?:职位|岗位)?|输入职位(?:关键字|关键词)|search(?: jobs?| positions?)?|job search)$/i
        .test(trim(element.getAttribute("placeholder") || element.getAttribute("aria-label")))) {
      auxiliaryFieldCount += 1; continue;
    }
    const rendered = visible(element) || (element.matches("input[type=radio], input[type=checkbox]")
      && visible(element.closest("label") || element.parentElement));
    if (!rendered) { hiddenFieldCount += 1; continue; }
    if (fields.length >= 300) { omittedFieldCount += 1; continue; }
    const group = groupFor(element);
    const labels = observedLabelFor(element);
    const kind = kindFor(element);
    const privateValue = sensitiveLabel.test(labels.label) || /有关声明|声明|signature|declaration/i.test(group.label)
      || ["credential", "file", "signature", "radio", "checkbox"].includes(kind);
    // Only presence leaves this function; sensitive fields are not read at all.
    const committedPhoenix = privateValue ? null : (selectRootFor(element) || element.closest(".phoenix-select, .ant-select, .el-select, .next-select"))
      ?.querySelector(".phoenix-select__content, .ant-select-selection-item, .el-select__selected-item, .next-select-values, [class*=display-value], [class*=selected-value]");
    const hasValue = privateValue ? null : Boolean(committedPhoenix?.textContent?.trim()) || ("value" in element
      ? String(element.value || "").trim().length > 0 : Boolean(element.textContent?.trim()));
    const entry = entryFor(element), form = entry.root;
    const entries = entryRoots.get(group.id);
    // A trailing, unidentified scalar must not become a phantom extra card
    // in a flat heading range. Explicit/repeated record roots remain counted.
    const recordRoot = labels.source === "missing" && entry.source === "single" && entries.size ? entries.keys().next().value : form;
    if (!entries.has(recordRoot)) entries.set(recordRoot, entries.size);
    const field = {
      id: `field-${fields.length + 1}`, groupId: group.id, entryIndex: entries.get(recordRoot),
      label: labels.label, labelSource: labels.source, kind,
      entrySource: entry.source,
      ...(datePartFor(element) ? { datePart: datePartFor(element) } : {}),
      ...(dateRoleFor(element) ? { dateRole: dateRoleFor(element) } : {}),
      required: element.required === true || element.getAttribute("aria-required") === "true"
        || Boolean(element.closest(".is-required")) || Boolean(element.closest(".form-item--phoenix")?.querySelector(".form-item__required")),
      disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      readOnly: element.readOnly === true || element.getAttribute("aria-readonly") === "true",
      hasValue, valueExcluded: privateValue,
      optionLabel: ["radio", "checkbox"].includes(kind) ? metadataText(element.closest("label")) : null,
    };
    fields.push(field);
    if (bindForExecution) {
      const identityState = () => {
        regionCache.delete(element);
        return { connected: element.isConnected, labelStable: element.isConnected && observedLabelFor(element).label === field.label,
          kindStable: element.isConnected && kindFor(element) === field.kind,
          groupStable: element.isConnected && groupFor(element).id === field.groupId,
          recordStable: element.isConnected && entryFor(element).root === form };
      };
      fieldBindings.set(field.id, { element, field, group, root: form, identityState,
        assertIdentity: () => Object.values(identityState()).every(Boolean) });
    }
    group.fieldCount += 1;
    group.entryCount = entries.size;
  }
  const controls = [];
  let omittedControlCount = 0;
  const observedNonNativeAdds = phoenix ? [...new Set([...document.querySelectorAll("span, div")]
    .filter((element) => /^添加(?:\s*(?:教育经历|实习经历|工作经历|项目经历|获奖情况|获奖经历|竞赛经历|在校职务|校园经历|论文\/专著|附加信息))?$/.test(metadataText(element))
      && !element.querySelector("span, div") && phoenixGroupFor(element))
    .map((leaf) => {
      const parent = leaf.parentElement;
      return parent?.matches("div") && parent.querySelector("svg")
        && /^添加(?:教育经历|实习经历|工作经历|项目经历|获奖情况|获奖经历|竞赛经历|在校职务|校园经历|论文\/专著|附加信息)?$/.test(metadataText(parent).replace(/\s+/g, ""))
        ? parent : null;
    }).filter(Boolean))] : [];
  for (const element of new Set([...document.querySelectorAll("button, input[type=submit], input[type=reset], input[type=button], [role=button]"), ...observedNonNativeAdds])) {
    if (element.closest(popupSelector)) continue;
    if (!visible(element)) continue;
    if (controls.length >= 160) { omittedControlCount += 1; continue; }
    const group = groupFor(element);
    const label = trim(element.getAttribute("aria-label")) || metadataText(element) || "未命名按钮";
    const intent = /签名|signature/i.test(label) ? "signature"
      : /提交|投递|递交|申请职位|报名|submit|apply|send|publish/i.test(label) || element.type === "submit" ? "submit"
      : /保存|暂存|存草稿|save|draft/i.test(label) ? "save-candidate"
      : /添加|新增|增加|add/i.test(label) ? "add-candidate" : "other";
    const control = { id: `control-${controls.length + 1}`, groupId: group.id, label, intent, executable: false };
    controls.push(control);
    if (bindForExecution) controlBindings.set(control.id, { element, control, group,
      observedPhoenixAdd: observedNonNativeAdds.includes(element) });
    group.controlCount += 1;
  }
  const kindCounts = {};
  for (const field of fields) kindCounts[field.kind] = (kindCounts[field.kind] || 0) + 1;
  const frameCount = document.querySelectorAll("iframe, frame").length;
  const shadowHostCount = [...document.querySelectorAll("*")].filter((element) => element.shadowRoot).length;
  const warnings = ["扫描过程仅读取主文档结构，不输入、点击或保存。",
    "扫描本身不调用模型；生成填写计划会通过本机服务请求模型。", "诊断不包含字段值；敏感字段和声明答案未读取。"];
  if (frameCount) warnings.push(`发现 ${frameCount} 个框架，其内部字段尚未扫描。`);
  if (shadowHostCount) warnings.push(`发现 ${shadowHostCount} 个开放 Shadow DOM，其内部字段尚未扫描。`);
  if (hiddenFieldCount) warnings.push(`${hiddenFieldCount} 个隐藏字段未扫描。`);
  if (auxiliaryFieldCount) warnings.push(`${auxiliaryFieldCount} 个导航或职位搜索字段已排除。`);
  if (omittedFieldCount || omittedControlCount) warnings.push("页面控件超过扫描上限；当前诊断不完整。");
  if (fields.some((field) => field.labelSource === "missing")) warnings.push("存在未识别字段，请先核实字段标签再计划填写。");
  // Diagnostic metadata for an observed question whose choices have no native
  // input/AX role. Never include answers, input values, or arbitrary page text.
  const customQuestions = phoenix ? [...document.querySelectorAll("span, div, label")]
    .filter((element) => /^请问您是通过.*渠道.*招聘信息/.test(metadataText(element)) && !element.querySelector("span, div, label"))
    .slice(0, 1).map((question) => {
      let root = question.parentElement;
      for (let level = 0; root && level < 6; level += 1, root = root.parentElement) {
        if (metadataText(root).includes("学校Career Center")) break;
      }
      const choices = root ? [...root.querySelectorAll("span, div, label")]
        .filter((element) => !element.querySelector("span, div, label") && /^(学校就业信息网\/学校Career Center|BOE官网\/BOE招聘官方微信公众号)$/.test(metadataText(element)))
        .slice(0, 2) : [];
      return { kind: "unrecognized-choice", label: metadataText(question), choices: choices.map((choice) => {
        const ancestors = [];
        for (let element = choice, level = 0; element && level < 4; element = element.parentElement, level += 1) {
          ancestors.push({ tag: element.tagName.toLowerCase(), classes: String(element.className || "").slice(0, 180),
            role: element.getAttribute("role"), inputCount: element.querySelectorAll("input").length,
            cursorPointer: getComputedStyle(element).cursor === "pointer",
            children: [...element.children].slice(0, 5).map((child) => ({ tag: child.tagName.toLowerCase(),
              classes: String(child.className?.baseVal ?? child.className ?? "").slice(0, 180), role: child.getAttribute("role") })) });
        }
        return { label: metadataText(choice), ancestors };
      }) };
    }) : [];
  const addDiagnostics = phoenix ? [...document.querySelectorAll("span, div")]
    .filter((element) => /^添加(?:\s*(?:教育经历|实习经历|工作经历|项目经历|获奖情况|获奖经历|竞赛经历|在校职务|校园经历|论文\/专著|附加信息))?$/.test(metadataText(element)) && !element.querySelector("span, div"))
    .slice(0, 8).map((leaf) => {
      const ancestors = [];
      for (let element = leaf, level = 0; element && level < 4; element = element.parentElement, level += 1) {
        ancestors.push({ tag: element.tagName.toLowerCase(), classes: String(element.className || "").slice(0, 180),
          hasSvg: Boolean(element.querySelector("svg")), nativeControlCount: element.querySelectorAll("input, button, a").length,
          observedGroup: phoenixGroupFor(element) ? metadataText(phoenixHeading(phoenixGroupFor(element))) : null,
          exactAdd: metadataText(element) === "添加", addWithSection: /^添加(?:教育经历|实习经历|工作经历|项目经历|获奖情况|获奖经历|竞赛经历|在校职务|校园经历)?$/.test(metadataText(element).replace(/\s+/g, "")),
          children: [...element.children].slice(0, 5).map((child) => ({ tag: child.tagName.toLowerCase(),
            classes: String(child.className?.baseVal ?? child.className ?? "").slice(0, 100) })) });
      }
      return { label: "添加", ancestors };
    }) : [];
  const calendarDiagnostics = phoenix ? [...document.querySelectorAll(".phoenix-date-picker__wrap")]
    .filter((root) => visible(root) && root.querySelector(".phoenix-calendar-month-panel, .phoenix-calendar-input"))
    .slice(0, 2).map((root) => ({ controls: [".phoenix-calendar-month-panel-year-select", ".phoenix-calendar-month-panel-prev-year-btn",
      ".phoenix-calendar-month-panel-next-year-btn", ".phoenix-calendar-year-select", ".phoenix-calendar-prev-year-btn", ".phoenix-calendar-next-year-btn"]
      .map((selector) => {
        const control = root.querySelector(selector), text = String(control?.textContent || "").replace(/\s+/g, "");
        const href = control?.getAttribute("href");
        return { selector, present: Boolean(control), visible: Boolean(control && visible(control)),
          yearLabel: /^\d{4}年?$/.test(text), emptyLabel: !text,
          hrefKind: href == null ? "none" : ["", "#"].includes(href) ? "empty" : /^javascript:\s*(?:;|void\(0\);?)$/i.test(href) ? "noop" : "other" };
      }) })) : [];
  if (location.href !== expectedUrl) throw new Error("SCAN_PAGE_CHANGED");
  if (bindForExecution) {
    globalThis.__resumeAgentBindings = { expectedUrl, token: crypto.randomUUID(), fields: fieldBindings,
      controls: controlBindings, groups: groupRoots, visible };
  }
  return {
    schemaVersion: 1, mode: "read-only", origin: location.origin,
    adapter: hzBank ? "hzbank-layout-observed" : phoenix ? "phoenix-layout-observed" : localDemo ? "local-demo-layout-observed" : "generic-semantic-dom",
    summary: {
      fieldCount: fields.length, groupCount: groups.filter((group) => group.fieldCount > 0).length,
      controlCount: controls.length, knownExistingFields: fields.filter((field) => field.hasValue === true).length,
      excludedValueFields: fields.filter((field) => field.valueExcluded).length,
      unlabeledFields: fields.filter((field) => field.labelSource === "missing").length,
      hiddenFieldCount, auxiliaryFieldCount, frameCount, shadowHostCount, truncated: omittedFieldCount + omittedControlCount > 0, kindCounts,
    }, groups: groups.filter((group) => group.fieldCount > 0 || group.controlCount > 0), fields, controls, warnings, customQuestions, addDiagnostics, calendarDiagnostics,
  };
}

export async function scanCurrentTab(selection, scripting = chrome.scripting, tabs = chrome.tabs) {
  if (!Number.isInteger(selection?.tabId) || !isScannableUrl(selection?.url)) throw new Error("SCAN_INVALID_PAGE");
  const before = await tabs.get(selection.tabId);
  if (before.url !== selection.url) throw new Error("SCAN_PAGE_CHANGED");
  const results = await scripting.executeScript({
    target: { tabId: selection.tabId }, world: "ISOLATED", func: readFormStructure, args: [selection.url],
  });
  const after = await tabs.get(selection.tabId);
  if (after.url !== selection.url || results.length !== 1 || results[0].frameId !== 0) throw new Error("SCAN_PAGE_CHANGED");
  if (results[0].result?.mode !== "read-only") throw new Error("SCAN_RESULT_INVALID");
  return results[0].result;
}
