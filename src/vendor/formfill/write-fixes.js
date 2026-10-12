// Adapted from the user's separately maintained plugin (GPL-3.0), 2026-10-04.
export const WriteFixes = (() => {
    "use strict";

    // ── 一、「至今」这类单一复选框 ────────────────────────────
    //
    // 问题：一个只会勾选/取消的复选框组，如果组里只有一个 input，
    //       它的 label 往往为空、value 是 "Y"/"1"/"on"。
    //       拿「否」去和这些候选做文字匹配，永远匹配不上 → 报
    //       「未找到可匹配的多选项」。
    //
    // 正确做法：单复选框是布尔开关，按语义决定勾不勾。

    const TRUTHY_WORDS = [
      "是", "有", "接受", "同意", "可以", "能", "会",
      "true", "yes", "y", "1", "on", "checked",
    ];
    const FALSY_WORDS = [
      "否", "无", "不", "没有", "不接受", "不同意", "不可以", "不会",
      "false", "no", "n", "0", "off", "unchecked",
    ];

    function normalize(value) {
      return String(value ?? "").trim().toLowerCase();
    }

    /**
     * 把填写值解释成布尔；无法判断时返回 null。
     */
    function toBoolean(value) {
      const v = normalize(value);
      if (!v) return null;
      if (TRUTHY_WORDS.includes(v)) return true;
      if (FALSY_WORDS.includes(v)) return false;
      // 「至今」「仍在」「目前还在」这类词按 true 处理
      if (/至今|仍在|目前还|尚未结束|进行中/.test(v)) return true;
      return null;
    }

    /**
     * 判断一个复选框组是否是「单一布尔开关」。
     *
     * @param {Array} options 组内选项
     * @returns {boolean}
     */
    function isStandaloneBooleanGroup(options) {
      return Array.isArray(options) && options.length === 1;
    }

    /**
     * 为单一复选框决定是否勾选。
     *
     * @returns {{check: boolean}|{check: null, reason: string}}
     */
    function decideStandaloneCheckbox(options, value) {
      if (!isStandaloneBooleanGroup(options)) {
        return { check: null, reason: "不是单一复选框组" };
      }
      const desired = toBoolean(value);
      if (desired === null) {
        return { check: null, reason: `「${value}」无法解释为是/否` };
      }
      return { check: desired };
    }

    // ── 二、超长文本截断 ─────────────────────────────────────
    //
    // 问题：textarea 常有 maxlength 限制。写入超长文本后，
    //       浏览器会截断或直接拒绝，回读校验就失败 → 「写入失败」。
    //
    // 做法：写之前按 maxlength 截断，而不是写完才发现对不上。

    /**
     * 按元素声明的长度上限截断文本。
     *
     * @param {string} text 待写入文字
     * @param {number|string} maxLength 元素 maxlength（可空）
     * @param {number} [softLimit] 元素没声明时用的软上限
     * @returns {{text: string, truncated: boolean, limit: number|null}}
     */
    function clampToMaxLength(text, maxLength, softLimit = 0) {
      const value = String(text ?? "");
      const parsed = Number(maxLength);
      const hasHardLimit = Number.isFinite(parsed) && parsed > 0;
      const limit = hasHardLimit ? parsed : (softLimit > 0 ? softLimit : null);

      if (limit === null || value.length <= limit) {
        return { text: value, truncated: false, limit };
      }
      return { text: value.slice(0, limit), truncated: true, limit };
    }

    /** 将资料库里的项目符号奖项拆成独立条目；无法确认边界时保留原文。 */
    function parseAwardEntries(value) {
      const text = String(value ?? "").trim();
      if (!text) return [];
      const bullets = text.split(/(?:^|\s)[•●▪◦]\s*/u).map((part) => part.trim()).filter(Boolean);
      if (bullets.length > 1 || /^[•●▪◦]/u.test(text)) return bullets;
      const lines = text.split(/\n+|[；;]+/u).map((part) => part.replace(/^[•●▪◦\s]+/u, "").trim()).filter(Boolean);
      return lines.length > 1 ? lines : [text];
    }

    /** 按页面实际区块分配获奖和竞赛，不能用证书数量代替。 */
    function routeAwardEntries(profile, { hasAwardSection = false, hasCompetitionSection = false } = {}) {
      const awards = parseAwardEntries(profile?.additional?.awards);
      const competitions = parseAwardEntries(profile?.additional?.competitions);
      if (hasAwardSection && !hasCompetitionSection) {
        return { awards: [...awards, ...competitions], competitions: [] };
      }
      return {
        awards: hasAwardSection ? awards : [],
        competitions: hasCompetitionSection ? competitions : [],
      };
    }

    /** 单行“奖项名称”输入框不能保留换行，合并竞赛条目的补充说明。 */
    function oneLineAwardEntry(value) {
      return String(value ?? "").trim().replace(/\s*\n\s*/gu, "；");
    }

    // ── 三、只读控件写入后的回读时机 ─────────────────────────
    //
    // 问题：setValueWithEvents 在 finally 里先恢复了 readOnly，
    //       之后才用 el.value 回读校验。
    //       某些组件在 readonly 状态下不保留值 → 校验假失败 → 「写入失败」。
    //
    // 做法：回读必须在恢复 readonly **之前**完成。

    /**
     * 判断某个运行时是否是「写入前需要临时解除只读」的控件。
     * 这类控件的回读时机必须提前。
     */
    function needsEarlyReadback(runtime, el) {
      const wasReadonly = Boolean(runtime?.readOnly || el?.readOnly);
      if (!wasReadonly) return false;
      // 只读日期控件有自己的写入链路，不受影响
      if (runtime?.kind === "readonly_date") return false;
      return true;
    }

    return {
      TRUTHY_WORDS,
      FALSY_WORDS,
      toBoolean,
      isStandaloneBooleanGroup,
      decideStandaloneCheckbox,
      clampToMaxLength,
      parseAwardEntries,
      routeAwardEntries,
      oneLineAwardEntry,
      needsEarlyReadback,
    };
})();
