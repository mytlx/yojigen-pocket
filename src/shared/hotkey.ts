export type HotkeyInputMode = "selection" | "clipboard" | "both" | "none";

export const hotkeyInputOptions: { value: HotkeyInputMode; label: string }[] = [
  { value: "selection", label: "选中文字" },
  { value: "clipboard", label: "剪贴板" },
  { value: "both", label: "选中或剪贴板" },
  { value: "none", label: "不带入" },
];

const PAGE_MODULES = new Set(["module:calc", "module:clipboard", "module:files"]);

/** 只有功能页（含带页面的内置模块）和脚本会在按直达热键时接收带入内容。 */
export function supportsHotkeyInput(id: string): boolean {
  return id.startsWith("features:") || id.startsWith("scripts:") || PAGE_MODULES.has(id);
}

export function normalizeHotkeyInputMode(v?: string): HotkeyInputMode {
  switch (v) {
    case "clipboard":
    case "both":
    case "none":
      return v;
    default:
      return "selection";
  }
}

export function applyHotkeyInputMode(map: Record<string, string>, id: string, mode: string) {
  const normalized = normalizeHotkeyInputMode(mode);
  if (normalized === "selection") delete map[id];
  else map[id] = normalized;
}
