export type HighlightPresetId = "yellow" | "green" | "pink" | "blue" | "purple" | "orange";

/** 支持内置预设 ID 或任意自定义 Hex 颜色（如 #a7f3d0）。 */
export type HighlightColorId = HighlightPresetId | `#${string}`;

export const DEFAULT_HIGHLIGHT_COLOR: HighlightPresetId = "yellow";
export const MAX_HIGHLIGHT_HISTORY = 5;

export interface HighlightPreset {
  id: HighlightPresetId;
  label: string;
  swatch: string;
  light: string;
  dark: string;
}

/** 固定的 6 个常用荧光笔颜色点；用户自定义颜色另存到 highlightHistory。 */
export const HIGHLIGHT_COLORS: readonly HighlightPreset[] = [
  { id: "yellow", label: "暖黄", swatch: "#fde047", light: "rgba(253, 224, 71, 0.62)", dark: "rgba(250, 204, 21, 0.34)" },
  { id: "green", label: "浅绿", swatch: "#86efac", light: "rgba(134, 239, 172, 0.58)", dark: "rgba(74, 222, 128, 0.32)" },
  { id: "pink", label: "浅粉", swatch: "#f9a8d4", light: "rgba(249, 168, 212, 0.56)", dark: "rgba(244, 114, 182, 0.34)" },
  { id: "blue", label: "浅蓝", swatch: "#93c5fd", light: "rgba(147, 197, 253, 0.56)", dark: "rgba(96, 165, 250, 0.34)" },
  { id: "purple", label: "浅紫", swatch: "#c4b5fd", light: "rgba(196, 181, 253, 0.56)", dark: "rgba(167, 139, 250, 0.34)" },
  { id: "orange", label: "浅橙", swatch: "#fdba74", light: "rgba(253, 186, 116, 0.58)", dark: "rgba(251, 146, 60, 0.34)" },
];

/** 归一化十六进制颜色输入（支持 #rgb / #rrggbb / 无 # 前缀）。无效返回 null。 */
export function normalizeHexColor(raw: unknown): `#${string}` | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[0]!;
    const g = s[1]!;
    const b = s[2]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase() as `#${string}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return `#${s.toLowerCase()}` as `#${string}`;
  }
  return null;
}

export function normalizeHighlightColor(value: unknown): HighlightColorId {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (HIGHLIGHT_COLORS.some((c) => c.id === trimmed)) {
      return trimmed as HighlightPresetId;
    }
    const hex = normalizeHexColor(trimmed);
    if (hex) {
      const preset = HIGHLIGHT_COLORS.find((c) => c.swatch.toLowerCase() === hex);
      return preset ? preset.id : hex;
    }
  }
  return DEFAULT_HIGHLIGHT_COLOR;
}

export function highlightSwatchHex(color: HighlightColorId): `#${string}` {
  const preset = HIGHLIGHT_COLORS.find((c) => c.id === color);
  if (preset) return preset.swatch as `#${string}`;
  return normalizeHexColor(color) ?? (HIGHLIGHT_COLORS[0]!.swatch as `#${string}`);
}

/** 计算给定颜色在浅色/深色主题下对应的荧光笔半透明背景值。 */
export function resolveHighlightVars(color: HighlightColorId): { swatch: `#${string}`; light: string; dark: string } {
  const preset = HIGHLIGHT_COLORS.find((c) => c.id === color);
  if (preset) {
    return { swatch: preset.swatch as `#${string}`, light: preset.light, dark: preset.dark };
  }
  const hex = normalizeHexColor(color) ?? "#fde047";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return {
    swatch: hex,
    light: `rgba(${r}, ${g}, ${b}, 0.56)`,
    dark: `rgba(${r}, ${g}, ${b}, 0.36)`,
  };
}

/** 更新最近使用自定义颜色历史（去重、跳过固定预设、最多保留 max 个）。 */
export function pushHighlightHistory(prev: readonly string[], color: string, max = MAX_HIGHLIGHT_HISTORY): `#${string}`[] {
  const hex = normalizeHexColor(color);
  if (!hex) return normalizeHighlightHistory(prev, max);
  if (HIGHLIGHT_COLORS.some((c) => c.swatch.toLowerCase() === hex)) {
    return normalizeHighlightHistory(prev, max);
  }
  const rest = normalizeHighlightHistory(prev, max).filter((h) => h !== hex);
  return [hex, ...rest].slice(0, max);
}

export function normalizeHighlightHistory(raw: unknown, max = MAX_HIGHLIGHT_HISTORY): `#${string}`[] {
  if (!Array.isArray(raw)) return [];
  const out: `#${string}`[] = [];
  for (const item of raw) {
    const hex = normalizeHexColor(item);
    if (!hex) continue;
    if (HIGHLIGHT_COLORS.some((c) => c.swatch.toLowerCase() === hex)) continue;
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}
