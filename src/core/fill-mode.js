export const FILL_MODES = ["overwrite", "empty"];

/** A missing preference uses the user-requested default; invalid input never grants overwrite. */
export function resolveFillMode(value = "overwrite") {
  if (!FILL_MODES.includes(value)) throw new Error("FILL_MODE_INVALID");
  return value;
}

export const fillModeLabel = (mode) => resolveFillMode(mode) === "overwrite" ? "全部覆盖" : "只填空白";
