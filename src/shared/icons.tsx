import { useState } from "preact/hooks";
import {
  Activity, AlertTriangle, AlignLeft, Bluetooth, Calculator, Clipboard, Code, Eraser, File, FileText, Folder, Globe,
  Image, Keyboard, LayoutGrid, Lock, LogOut, Monitor, MonitorOff, Moon, Palette, Plus, Power, Puzzle, RefreshCw,
  RotateCw, Search, Settings, SlidersHorizontal, Terminal, Trash2, Volume2, Wifi, Wrench, Info,
  Languages, ScanText, BookOpen, Braces, Binary, Fingerprint, Clock, Regex, KeyRound, Diff, Dices, Link,
  CaseSensitive, AppWindow, Sparkles, EyeOff, Play, Download, ExternalLink,
  type LucideIcon, NotebookPen, MousePointerClick, Keyboard as KeyboardIcon, Gamepad2, PawPrint } from "lucide-preact";

/** 口袋：应用自己的标志。 */
/**
 * 应用的标志：蓝底、红项圈、金铃铛、白口袋，和应用图标是同一个图形。
 * 颜色是固定的，不跟主题色走，这样在哪儿都认得出来。
 */
export function PocketLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="pk-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2aa9fb" />
          <stop offset="1" stop-color="#0b6fe0" />
        </linearGradient>
        <linearGradient id="pk-logo-bell" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffe45c" />
          <stop offset="1" stop-color="#f5a800" />
        </linearGradient>
        <clipPath id="pk-logo-clip">
          <rect x="1" y="1" width="22" height="22" rx="5.6" />
        </clipPath>
      </defs>
      <g clip-path="url(#pk-logo-clip)">
        <rect x="1" y="1" width="22" height="22" fill="url(#pk-logo-bg)" />
        {/* 口袋 */}
        <path d="M5 11.4h14c.42 0 .74.36.69.77C19.2 16.1 16 19.2 12 19.2s-7.2-3.1-7.69-7.03c-.05-.41.27-.77.69-.77Z" fill="#fff" />
        {/* 项圈 */}
        <path d="M1 6.2q11 1.5 22 0v2.1q-11 1.5-22 0Z" fill="#e5342f" />
        {/* 铃铛 */}
        <circle cx="12" cy="9" r="3.05" fill="url(#pk-logo-bell)" stroke="#a86a00" stroke-width="0.45" />
        <path d="M9.15 8.2h5.7" stroke="#a86a00" stroke-width="0.5" />
        <circle cx="12" cy="9.95" r="0.62" fill="#6b4300" />
        <path d="M12 10.3v1.6" stroke="#6b4300" stroke-width="0.5" />
      </g>
    </svg>
  );
}

const svgIcons: Record<string, LucideIcon> = {
  app: LayoutGrid, activity: Activity, alert: AlertTriangle, text: AlignLeft, bluetooth: Bluetooth,
  calculator: Calculator, clipboard: Clipboard, code: Code, eraser: Eraser, file: File, folder: Folder, globe: Globe,
  image: Image, keyboard: Keyboard, lock: Lock, logout: LogOut, monitor: Monitor, "monitor-off": MonitorOff, moon: Moon,
  palette: Palette, plus: Plus, power: Power, puzzle: Puzzle, refresh: RefreshCw, rotate: RotateCw, search: Search,
  settings: Settings, sliders: SlidersHorizontal, snippet: FileText, terminal: Terminal, trash: Trash2, volume: Volume2,
  wifi: Wifi, wrench: Wrench, info: Info,
  languages: Languages, "scan-text": ScanText, "book-open": BookOpen, braces: Braces, binary: Binary,
  fingerprint: Fingerprint, clock: Clock, regex: Regex, "key-round": KeyRound, diff: Diff, dices: Dices, link: Link,
  "case-sensitive": CaseSensitive, "app-window": AppWindow, sparkles: Sparkles, "eye-off": EyeOff, play: Play,
  notebook: NotebookPen, "mouse-click": MousePointerClick, "keyboard-macro": KeyboardIcon, gamepad: Gamepad2, paw: PawPrint,
  "layout-grid": LayoutGrid, download: Download, external: ExternalLink,
};

/** 统一的图标：svg:名称、text:字符，或者一个图片地址。 */
export function Icon({ icon, size = 30 }: { icon?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { "--icon": `${size}px` } as Record<string, string>;
  const inner = Math.round(size * 0.58);

  if (icon?.startsWith("text:")) {
    return (
      <span class="pk-icon tile" style={style}>
        <span class="glyph">{icon.slice(5)}</span>
      </span>
    );
  }
  if (icon && !icon.startsWith("svg:") && !broken) {
    return (
      <span class="pk-icon" style={style}>
        <img src={icon} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
      </span>
    );
  }
  const name = icon?.startsWith("svg:") ? icon.slice(4) : "file";
  if (name === "pocket") {
    return (
      <span class="pk-icon" style={style}>
        <PocketLogo size={size} />
      </span>
    );
  }
  const Svg = svgIcons[name] ?? File;
  return (
    <span class="pk-icon tile" style={style}>
      <Svg size={inner} strokeWidth={1.8} />
    </span>
  );
}
