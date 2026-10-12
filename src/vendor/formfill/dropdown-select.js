// Adapted from the separately maintained AI-Resume-Form-Filling-Assistant (GPL-3.0).
// Copied on 2026-10-04; modifications: ES module exports, no global installation.
export const DropdownSelect = (() => {
    "use strict";

    // ── 选项容器选择器 ────────────────────────────────────────
    // 覆盖主流组件库的弹出层实现
    const OPTION_CONTAINER_SELECTORS = [
      '[role="listbox"]',
      // Phoenix list portal observed in the BOE resume editor.
      ".phoenix-selectList",
      // Moka 自研面板（真实结构：sd-Dropdown-dropdown > sd-Select-menu > sd-Select-scrollable）
      ".sd-Select-menu-36GwS",
      '[class*="sd-Select-menu"]',
      '[class*="sd-Select-scrollable"]',
      '[class*="sd-Dropdown-dropdown"]',
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)",
      ".el-select-dropdown",
      ".next-menu:not(.next-menu-hidden)",
      ".next-overlay-inner",
      '[class*="select-dropdown"]',
      '[class*="SelectDropdown"]',
      '[class*="dropdown-menu"]',
      '[class*="DropdownMenu"]',
      '[class*="cascader-menu"]',
      '[class*="picker-panel"]',
    ];

    const OPTION_ITEM_SELECTORS = [
      '[role="option"]',
      ".phoenix-selectList__listItem",
      '[role="listbox"] > li',
      '[role="listbox"] > [tabindex]',
      // Moka 当前页面：sd-Select-common-item > sd-Menu-container > sd-Menu-content-item
      '[class*="sd-Menu-content-item"]',
      '[class*="sd-Select-common-item"]',
      '[class*="sd-Select-option"]',
      '[class*="Select-option"]',
      ".ant-select-item-option",
      ".el-select-dropdown__item",
      ".next-menu-item",
      "li[class*='option']",
      "li[class*='Option']",
      "[class*='option-item']",
    ];

    // ── 文字归一化 ────────────────────────────────────────────
    function normalize(value) {
      return String(value ?? "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[（）()【】\[\]「」《》]/g, "")
        .replace(/[＊*]+$/g, "")
        .trim();
    }

    /**
     * 生成「等价写法」候选。
     * 用于处理 本科 / 大学本科、上海 / 上海市 这类差异。
     */
    function buildVariants(value) {
      const base = normalize(value);
      if (!base) return [];
      const set = new Set([base]);

      // 去掉常见的学历后缀差异
      const levelMap = {
        本科: ["大学本科", "本科生", "学士"],
        硕士: ["硕士研究生", "研究生", "硕士生"],
        博士: ["博士研究生"],
        大专: ["大学专科", "专科"],
      };
      for (const [k, alts] of Object.entries(levelMap)) {
        if (base === normalize(k)) alts.forEach((a) => set.add(normalize(a)));
      }
      if (["统招", "统招全日制", "全日制统招"].includes(base)) {
        set.add("全日制统分统招");
      }

      // 去掉/补上「市」「省」后缀
      if (/市$/.test(base)) set.add(base.slice(0, -1));
      else set.add(base + "市");
      if (/省$/.test(base)) set.add(base.slice(0, -1));

      // 去掉「前」这类前缀（排名：前30% / 30%）
      if (base.startsWith("前")) set.add(base.slice(1));

      // 全角百分号
      set.add(base.replace(/%/g, "％"));
      set.add(base.replace(/％/g, "%"));

      return [...set].filter(Boolean);
    }

    /**
     * 给「期望值」与「候选项文字」打分。
     * 分数越高越匹配；0 表示不匹配。
     */
    /**
     * 数值等价判断。
     *
     * 解决「09 vs 9」这类问题：
     *   简历里月份存成 "09"，而下拉选项只有 "9"，字符串比较永远不相等。
     *   这类差异是纯格式问题，用数值比较即可，不需要动用模型。
     *
     * 只处理「双方都是纯数字（可带前导零/正负号）」的情况，
     * 避免把 "20W" 和 "20" 这种误判为相等。
     */
    function numericEqual(a, b) {
      const sa = String(a ?? "").trim();
      const sb = String(b ?? "").trim();
      if (!/^[+-]?\d+(\.\d+)?$/.test(sa)) return false;
      if (!/^[+-]?\d+(\.\d+)?$/.test(sb)) return false;
      const na = Number(sa);
      const nb = Number(sb);
      return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
    }

    function isSchoolCareerWebsite(value) {
      return /^(学校|高校|校园|大学)(就业|招聘)(信息)?(网|网站|平台)(?:\/学校careercenter)?$/.test(normalize(value));
    }

    function isSchoolCareerAccount(value) {
      return /^(学校|高校|校园|大学)(就业|招聘)(信息)?(公众号|微信号)$/.test(normalize(value));
    }

    function scoreOption(optionText, desired) {
      const opt = normalize(optionText);
      if (!opt) return 0;

      // A salary stored as 20W is an annual amount in this schema. Match it
      // only to options explicitly expressed per month, after conversion.
      const annual = String(desired ?? "").replace(/[\s,，]/g, "")
        .match(/^(\d+(?:\.\d+)?)[wW万](?:元)?(?:\/年|每年|年薪)?$/);
      const monthlyRange = String(optionText ?? "").replace(/[\s,，]/g, "")
        .match(/^(\d+(?:\.\d+)?)[-~～至](\d+(?:\.\d+)?)\/?月$/);
      if (annual && monthlyRange) {
        const monthly = Number(annual[1]) * 10000 / 12;
        if (monthly >= Number(monthlyRange[1]) && monthly <= Number(monthlyRange[2])) {
          return 0.92;
        }
      }

      if (isSchoolCareerWebsite(desired)) {
        if (isSchoolCareerWebsite(opt)) return opt === normalize(desired) ? 1 : 0.95;
        if (isSchoolCareerAccount(opt)) return 0.8;
      }

      // ① 数值等价：09 == 9、2027 == 2027
      //    纯格式差异，必须匹配（用户反馈的月份问题）
      if (numericEqual(optionText, desired)) return 1;

      const variants = buildVariants(desired);

      let best = 0;
      for (const v of variants) {
        // ② 完全相等
        if (opt === v) {
          best = Math.max(best, 1);
          continue;
        }

        // ③ 一方是另一方的前缀/后缀
        //
        //    只允许「有意义的前后缀」：去掉前后缀后剩下的部分必须够长，
        //    否则「20W」会被当成「20」加后缀「W」而误匹配。
        //    真实需要的场景：
        //      「本科」   vs 「大学本科」   → 去掉前缀「大学」，剩 2 字 ✅
        //      「上海」   vs 「上海市」     → 去掉后缀「市」，剩 2 字 ✅
        //      「20W」    vs 「20」        → 去掉后缀「W」，剩 2 字 ❌ 误判
        //    所以额外要求：数值型不参与前后缀匹配。
        const numericOnly = /^[+-]?\d+(\.\d+)?$/.test(opt) ||
                            /^[+-]?\d+(\.\d+)?$/.test(v);

        if (!numericOnly) {
          if (opt.startsWith(v) || opt.endsWith(v)) {
            const rest = opt.length - v.length;
            if (v.length >= 2 && rest <= 4) best = Math.max(best, 0.85);
          } else if (v.startsWith(opt) || v.endsWith(opt)) {
            const rest = v.length - opt.length;
            if (opt.length >= 2 && rest <= 4) best = Math.max(best, 0.85);
          }
        }
      }
      return best;
    }

    /**
     * 从候选列表里挑最匹配的一项。
     * @param {Array<{text:string, [key:string]:any}>} options
     * @param {string} desired
     * @returns {{option:any, score:number}|null}
     */
    function pickBestOption(options, desired) {
      if (!Array.isArray(options) || !options.length) return null;
      // 资料库用「流利」，Moka 四档菜单没有这一项。用户确认该菜单选「良好」。
      // 只在四档选项完整且没有原词时应用，其他网站优先选精确的「流利」。
      const exact = options.find((option) => normalize(option?.text) === normalize(desired));
      if (exact) return { option: exact, score: 1 };
      const labels = new Set(options.map((option) => normalize(option?.text)));
      if (normalize(desired) === "流利" &&
          ["良好", "熟练", "精通"].every((label) => labels.has(label)) &&
          (labels.has("一般") || labels.has("普通"))) {
        return { option: options.find((option) => normalize(option?.text) === "良好"), score: 0.9 };
      }
      let best = null;
      let bestScore = 0;
      let ambiguous = false;
      for (const option of options) {
        const score = scoreOption(option?.text, desired);
        if (score > bestScore) {
          bestScore = score;
          best = option;
          ambiguous = false;
        } else if (score === bestScore && score >= 0.75 && best &&
          normalize(option?.text) !== normalize(best?.text)) {
          ambiguous = true;
        }
      }
      // 低于 0.7 认为不可靠，宁可不选
      // 阈值 0.75：宁可少匹配，也不要把错误的选项填进去
      if (!best || bestScore < 0.75 || ambiguous) return null;
      return { option: best, score: bestScore };
    }

    /** Match a province/city option against a combined location such as 江苏南京. */
    function pickBestRegionOption(options, desired) {
      const target = normalize(desired).replace(/[，,、\s/]/g, "");
      if (!target || !Array.isArray(options)) return null;
      const matches = options.filter((option) => {
        const core = normalize(option?.text)
          .replace(/(?:壮族|回族|维吾尔)自治区$|自治区$|特别行政区$|省$|市$/, "");
        return core.length >= 2 &&
          (target === core || target.startsWith(core) || target.endsWith(core));
      });
      return matches.length === 1 ? { option: matches[0], score: 0.82 } : null;
    }

    /** 等待异步搜索候选，避免把短暂的「暂无选项」误判成最终结果。 */
    async function waitForBestOption({
      collectOptions,
      desired,
      sleep,
      pickOption = pickBestOption,
      isConnected = () => true,
      now = Date.now,
      timeoutMs = 8000,
      pollMs = 200,
    }) {
      const startedAt = now();
      const deadline = startedAt + timeoutMs;
      let options = [];
      let picked = null;
      while (isConnected()) {
        await sleep(pollMs);
        options = collectOptions();
        picked = pickOption(options, desired);
        if (picked || now() >= deadline) break;
      }
      return { options, picked, elapsedMs: now() - startedAt };
    }

    /**
     * 判断一个输入框是否属于自定义下拉。
     *
     * 判定依据（满足任一即可）：
     *   · ARIA 特征：aria-haspopup / aria-expanded / role=combobox
     *   · 组件库类名：ant-select / el-select / next-select …
     *   · 结构特征：只读输入框，且祖先里有下拉容器
     *
     * 注意：这里只用元素自身与祖先的静态特征，不做「点开试试」的动作。
     */
    function isComboboxLike(el) {
      if (!el || typeof el.getAttribute !== "function") return false;

      const tag = String(el.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        return String(el.getAttribute("role") || "").toLowerCase() === "combobox" ||
          String(el.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox";
      }

      // 键盘可输入的下拉：通过 ARIA 标记识别
      if (el.getAttribute("aria-haspopup")) return true;
      if (el.getAttribute("aria-expanded") !== null) return true;
      if (String(el.getAttribute("role") || "").toLowerCase() === "combobox") return true;
      // Some searchable selects expose no ARIA role until opened. Their wording
      // still distinguishes them from a free-text field; date pickers run first.
      if (/^请?选择/.test(String(el.getAttribute("placeholder") || "").trim())) return true;

      // 只读输入框通常意味着「只能选、不能打」
      const readOnly = el.readOnly === true || el.getAttribute("readonly") !== null;

      // 祖先的组件库类名（这是最可靠的信号）
      let node = el.parentElement;
      let depth = 0;
      while (node && depth < 6) {
        const cls = String(node.className || "");
        if (
          /(^|[-_\s])(ant-select|el-select|next-select|moka-select|select2|v-select|n-select)/.test(cls)
        ) {
          return true;
        }
        if (/(^|[-_\s])(ant-cascader|el-cascader|next-cascader)/.test(cls)) return true;

        // 通用兜底：类名里带 select / dropdown / picker 的容器
        // 覆盖自研组件库（例如 Moka 的 sd-Select-container-xxxxx）
        if (/[-_\s](select|dropdown|picker|combobox)/i.test(cls)) return true;
        if (node.getAttribute && node.getAttribute("role") === "combobox") return true;
        node = node.parentElement;
        depth += 1;
      }

      // 只读 + 旁边有下拉箭头图标，也按自定义下拉处理
      if (readOnly && el.getAttribute("aria-controls")) return true;

      // Moka 的 sd-* 组件：输入框有 has-addon 类，且同容器里有 caretDown 图标
      const ownClass = String(el.className || "");
      if (/has-addon/i.test(ownClass) && el.parentElement) {
        const icon = el.parentElement.querySelector?.("[class*='caretDown'], [class*='caret-down']");
        if (icon) return true;
      }

      return false;
    }

    function findSelectRoot(el) {
      const known = el?.closest?.(".ant-select, .el-select, .next-select, .phoenix-select, [role=combobox]");
      if (known) return known;
      for (let root = el?.parentElement, depth = 0; root && depth < 4; root = root.parentElement, depth++) {
        if (root.matches("form, section, fieldset") || root.querySelectorAll("input:not([type=hidden]), textarea, select").length > 1) break;
        if ([...root.classList].some((name) => /(?:^|[-_])select(?:$|[-_])/i.test(name))) return root;
      }
      return null;
    }

    /** 读取元素自身的文字（用于判断选没选中） */
    function readDisplayText(el) {
      if (!el) return "";
      const tag = String(el.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        const selected = el.querySelector?.(
          '.ant-select-selection-item,.el-select__selected-item,.next-select-values,' +
          '[class*="selection-item"],[class*="selected-value"]'
        );
        const shown = String(selected?.textContent || el.getAttribute?.("aria-valuetext") ||
          el.textContent || "").replace(/\s+/g, " ").trim();
        const placeholder = String(el.getAttribute?.("aria-placeholder") ||
          el.getAttribute?.("data-placeholder") || "").trim();
        if (!shown || shown === placeholder || /^请?选择/.test(shown)) return "";
        if (el.getAttribute?.("aria-expanded") === "true" && !selected) return "";
        return shown;
      }
      // Moka 在用户选中候选后，会清空搜索 input，把选中值放进同一 label
      // 的 sd-Input-display-value span。搜索阶段 input.value 恰好也等于目标值，
      // 因而不能用它作为「选中成功」的证据。
      const mokaSelect = el.closest?.('[class*="sd-Select-container"]');
      if (mokaSelect) {
        const selected = mokaSelect.querySelector?.('[class*="sd-Input-display-value"]');
        return String(selected?.textContent || "").trim();
      }
      const phoenixSelect = el.closest?.(".phoenix-select");
      if (phoenixSelect) {
        // Phoenix clears the query input and renders the committed label in
        // its content list. A query alone must never count as a selection.
        return String(phoenixSelect.querySelector?.(".phoenix-select__content")?.textContent || "").trim();
      }
      const selected = findSelectRoot(el)?.querySelector?.('[class*="display-value"], [class*="selected-value"], [class*="selection-item"]');
      if (selected) return String(selected.textContent || "").trim();
      // An open combobox may show the search query in input.value before any
      // option has been committed. Do not count that query as a selected value.
      if (el.getAttribute?.("aria-expanded") === "true") {
        const selected = el.closest?.(
          ".ant-select, .el-select, .next-select, [role='combobox'], [class*='select']"
        )?.querySelector?.(
          ".ant-select-selection-item, .el-select__selected-item, .next-select-values, [class*='selection-item']"
        );
        return String(selected?.textContent || "").trim();
      }
      const parts = [];
      const push = (v) => {
        const t = String(v ?? "").trim();
        if (t) parts.push(t);
      };
      push(el.value);
      if (typeof el.textContent === "string") push(el.textContent);
      if (typeof el.innerText === "string") push(el.innerText);
      // title / aria-label usually describe the field, not its selected value.
      // 组件常把选中项渲染在同容器的一个 span 里
      const wrap = el.closest?.(
        ".ant-select, .el-select, .next-select, [role='combobox'], [class*='select']"
      );
      if (wrap) {
        const sel = wrap.querySelector?.(
          ".ant-select-selection-item, .el-select__selected-item, .next-select-values, [class*='selection-item']"
        );
        if (sel) push(sel.textContent);
      }
      return parts.join(" ").trim();
    }

    /**
     * 判断写入是否真的生效（回读校验）。
     * 用于确认选项确实被选中，而不是只把文字打进了搜索框。
     */
    function verifySelected(el, desired) {
      const shown = readDisplayText(el);
      if (!shown) return false;
      return scoreOption(shown, desired) >= 0.75;
    }

    return {
      OPTION_CONTAINER_SELECTORS,
      OPTION_ITEM_SELECTORS,
      normalize,
      numericEqual,
      buildVariants,
      scoreOption,
      pickBestOption,
      pickBestRegionOption,
      waitForBestOption,
      isComboboxLike,
      readDisplayText,
      findSelectRoot,
      verifySelected,
    };
})();
