import type { AppInfo, ConfigView, UserAssets } from "../mygo";

const root = document.documentElement;

function hexToRgb(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const densityRow: Record<string, number> = { compact: 40, normal: 48, comfortable: 56 };

let lastView: ConfigView | null = null;
let lastInfo: AppInfo | null = null;

/** 把配置写成 CSS 变量。主窗口和设置窗口都走这里。 */
export function applyAppearance(view: ConfigView, info: AppInfo) {
  lastView = view;
  lastInfo = info;
  const a = view.config.appearance;
  root.dataset.platform = info.platform;
  root.dataset.material = a.material;
  root.dataset.density = a.density;

  const reduce = window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  root.dataset.glass = info.glassSupported && a.material !== "none" && !reduce ? "on" : "off";

  const accent = a.accent === "system" ? (view.systemAccent ?? "#2f6bff") : a.accent;
  const rgb = hexToRgb(accent);
  if (rgb) root.style.setProperty("--accent-rgb", rgb);
  root.style.setProperty("--tint", String(a.tint / 100));
  root.style.setProperty("--font-size", `${a.fontSize}px`);
  root.style.setProperty("--panel-width", `${a.width}px`);
  root.style.setProperty("--row-h", `${densityRow[a.density] ?? 48}px`);
  root.style.setProperty("--rows", String(a.rows));
  syncTheme();
}

/** mygo 会把 prefers-color-scheme 同步成配置的主题，这里只需要跟着媒体查询走。 */
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function syncTheme() {
  root.dataset.theme = darkQuery.matches ? "dark" : "light";
}

darkQuery.addEventListener("change", syncTheme);
window.matchMedia("(prefers-reduced-transparency: reduce)").addEventListener("change", () => {
  if (lastView && lastInfo) applyAppearance(lastView, lastInfo);
});
syncTheme();

function styleTag(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.append(el);
  }
  return el;
}

/** 载入用户的 theme.css / user.css。放在最后，保证能覆盖内置样式。 */
export function applyUserStyles(assets: UserAssets) {
  styleTag("pk-user-theme").textContent = assets.themeCss;
  styleTag("pk-user-css").textContent = assets.userCss;
}

/** 平台相关的按键文字。 */
export function keyLabel(platform: string) {
  const mac = platform === "darwin";
  return {
    mac,
    mod: mac ? "⌘" : "Ctrl",
    alt: mac ? "⌥" : "Alt",
    shift: mac ? "⇧" : "Shift",
    enter: "↵",
    index: mac ? "⌘" : "Alt",
  };
}

/** 把 accelerator 转成好看的按键文字。 */
export function formatAccelerator(accel: string, platform: string): string[] {
  const k = keyLabel(platform);
  return accel
    .split("+")
    .filter(Boolean)
    .map((part) => {
      switch (part.toLowerCase()) {
        case "cmdorctrl":
        case "commandorcontrol":
          return k.mod;
        case "cmd":
        case "command":
        case "meta":
        case "super":
          return k.mac ? "⌘" : "Win";
        case "ctrl":
        case "control":
          return k.mac ? "⌃" : "Ctrl";
        case "alt":
        case "option":
          return k.alt;
        case "shift":
          return k.shift;
        case "space":
          return "Space";
        case "enter":
        case "return":
          return "↵";
        case "up":
          return "↑";
        case "down":
          return "↓";
        case "left":
          return "←";
        case "right":
          return "→";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    });
}
