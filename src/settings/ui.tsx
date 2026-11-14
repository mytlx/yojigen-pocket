import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Settings, events } from "../mygo";
import { formatAccelerator } from "../shared/theme";

/** 设置页的基础控件。所有分区都用这几个，风格才统一。 */
export function Section({ title, description, actions, children }: { title?: string; description?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="st-section">
      {(title || actions) && (
        <div class="st-section-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div class="st-section-actions">{actions}</div>}
        </div>
      )}
      <div class="st-card">{children}</div>
    </section>
  );
}

export function Row({ label, description, children, error }: { label: ComponentChildren; description?: ComponentChildren; children?: ComponentChildren; error?: string }) {
  return (
    <div class="st-row">
      <div class="st-row-text">
        <div class="st-row-label">{label}</div>
        {description && <div class="st-row-desc">{description}</div>}
        {error && <div class="st-row-error">{error}</div>}
      </div>
      {children && <div class="st-row-control">{children}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      class={`st-toggle${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="st-segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} class={o.value === value ? "is-on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, unit = "", onChange }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div class="st-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--pct": `${((value - min) / (max - min)) * 100}%` }}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
      <output>
        {value}
        {unit}
      </output>
    </div>
  );
}

export function Text({ value, onChange, placeholder, width, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number; mono?: boolean }) {
  return (
    <input
      class={`st-input${mono ? " is-mono" : ""}`}
      style={width ? { width: `${width}px` } : undefined}
      value={value}
      placeholder={placeholder}
      spellcheck={false}
      autocomplete="off"
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  );
}

export function NumberInput({ value, onChange, min, max, width = 80 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; width?: number }) {
  return (
    <input
      class="st-input"
      type="number"
      style={{ width: `${width}px` }}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function Button({ children, onClick, primary, danger, title, disabled }: { children: ComponentChildren; onClick?: () => void; primary?: boolean; danger?: boolean; title?: string; disabled?: boolean }) {
  return (
    <button class={`st-button${primary ? " is-primary" : ""}${danger ? " is-danger" : ""}`} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

const CODE_KEYS: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

/** 把按键转成 mygo 的 accelerator 写法。用 code 而不是 key：macOS 上 Option+字母的 key 是特殊符号。 */
function toAccelerator(e: KeyboardEvent, mac: boolean): string | null {
  let key = "";
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (/^F\d+$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] ?? "";
  if (!key) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push(mac ? "Cmd" : "Win");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // 全局热键至少要有一个修饰键（功能键除外），否则打字时会被抢走。
  if (parts.length === 0 && !/^F\d+$/.test(key)) return null;
  parts.push(key);
  return parts.join("+");
}

const KEY_NAMES = new Set(Object.values(CODE_KEYS).map((k) => k.toLowerCase()));
const MODIFIER_NAMES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", opt: "Alt", shift: "Shift",
  cmd: "Cmd", command: "Cmd", "⌘": "Cmd", win: "Win", windows: "Win", super: "Win", meta: "Win", cmdorctrl: "CmdOrCtrl",
};

/** 把手写的快捷键（alt+space、Ctrl + Shift + K）整理成规范写法；写得不对时返回 null。 */
export function parseAccelerator(text: string, mac: boolean): string | null {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (text.trim().endsWith("++") || text.trim() === "+") parts.push("+");
  const mods: string[] = [];
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    let mod = MODIFIER_NAMES[lower];
    if (mod === "Win" && mac) mod = "Cmd";
    if (mod === "Cmd" && !mac) mod = "Win";
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    if (key) return null; // 两个主键
    if (/^[a-z0-9]$/.test(lower)) key = lower.toUpperCase();
    else if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) key = lower.toUpperCase();
    else if (KEY_NAMES.has(lower)) key = Object.values(CODE_KEYS).find((k) => k.toLowerCase() === lower)!;
    else return null;
  }
  if (!key) return null;
  if (mods.length === 0 && !/^F\d+$/.test(key)) return null;
  const order = ["Cmd", "Win", "CmdOrCtrl", "Ctrl", "Alt", "Shift"];
  mods.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return [...mods, key].join("+");
}

/**
 * 快捷键输入：点一下再按组合键。
 *
 * 录的时候全局热键先停掉，否则按下已经在用的组合（比如 Alt+Space）会直接触发它。
 * 有的组合系统自己要用，页面收不到，所以旁边留了“手动输入”。
 */
export function Hotkey({ value, platform, onChange, clearable, placeholder = "点击设置" }: { value: string; platform: string; onChange: (v: string) => void; clearable?: boolean; placeholder?: string }) {
  const [recording, setRecording] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const mac = platform === "darwin";

  useEffect(() => {
    if (!recording) return;
    void Settings.suspendHotkeys(true);
    let recorded = false;
    const finish = (accel: string) => {
      if (recorded) return;
      recorded = true;
      onChange(accel);
      setRecording(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // 按下和松开都拦住：单按 Alt 松开时，系统会去激活窗口菜单。
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== "keydown") return;
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        return;
      }
      const accel = toAccelerator(e, mac);
      if (accel) finish(accel);
    };
    const offCaptured = events.hotkeyCaptured.on((accel) => finish(accel));
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      offCaptured();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      void Settings.suspendHotkeys(false);
    };
  }, [recording, onChange, mac]);

  const commit = () => {
    if (typing === null) return;
    if (!typing.trim()) {
      setTyping(null);
      return;
    }
    const accel = parseAccelerator(typing, mac);
    if (!accel) {
      setInvalid(true);
      return;
    }
    onChange(accel);
    setTyping(null);
  };

  if (typing !== null) {
    return (
      <span class="st-hotkey-wrap">
        <input
          class={`st-input is-mono st-hotkey-text${invalid ? " is-invalid" : ""}`}
          value={typing}
          placeholder={mac ? "例如 Alt+Space、Cmd+Shift+K" : "例如 Alt+Space、Ctrl+Shift+K"}
          spellcheck={false}
          autoFocus
          aria-label="手动输入快捷键"
          title={invalid ? "写法不对：修饰键（Ctrl、Alt、Shift、Win/Cmd）加一个键，用加号连起来" : undefined}
          onInput={(e) => {
            setTyping((e.target as HTMLInputElement).value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              e.stopPropagation();
              setTyping(null);
            }
          }}
        />
        <button class="st-link" onClick={commit}>
          确定
        </button>
        <button class="st-link" onClick={() => setTyping(null)}>
          取消
        </button>
      </span>
    );
  }

  return (
    <span class="st-hotkey-wrap">
      <button
        ref={button}
        class={`st-hotkey${recording ? " is-recording" : ""}`}
        onClick={() => setRecording(!recording)}
        onBlur={() => setRecording(false)}
      >
        {recording ? (
          "按下快捷键…"
        ) : value ? (
          formatAccelerator(value, platform).map((k) => <kbd key={k}>{k}</kbd>)
        ) : (
          <span class="st-hotkey-empty">{placeholder}</span>
        )}
      </button>
      {!recording && (
        <button
          class="st-link"
          title="按不出来的组合可以直接写，例如 Alt+Space"
          onClick={() => {
            setInvalid(false);
            setTyping(value);
          }}
        >
          手动输入
        </button>
      )}
      {clearable && value && !recording && (
        <button class="st-link" onClick={() => onChange("")}>
          清除
        </button>
      )}
    </span>
  );
}
