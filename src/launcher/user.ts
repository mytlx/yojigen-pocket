import type { Item } from "../mygo";

/** user.js 能用的接口，挂在 window.pocket 上。 */
type QueryHook = (text: string) => string;
type ResultsHook = (items: Item[], ctx: { text: string; scope: string }) => Item[];
type Binding = { shortcut: string; fn: () => void };

let queryHooks: QueryHook[] = [];
let resultHooks: ResultsHook[] = [];
let bindings: Binding[] = [];
let bridge: { get: () => string; set: (text: string) => void } | null = null;

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error("[user.js]", err);
    return fallback;
  }
}

export const hooks = {
  query: (text: string) => queryHooks.reduce((acc, fn) => safely(() => fn(acc), acc), text),
  results: (items: Item[], ctx: { text: string; scope: string }) =>
    resultHooks.reduce((acc, fn) => safely(() => fn(acc, ctx) ?? acc, acc), items),
};

export function setQueryBridge(b: { get: () => string; set: (text: string) => void }) {
  bridge = b;
}

/** 判断按键是否符合 "mod+shift+p" 这样的写法。mod 在 macOS 是 ⌘，其他系统是 Ctrl。 */
export function matchShortcut(e: KeyboardEvent, shortcut: string, mac: boolean): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop();
  const want = {
    meta: parts.includes("cmd") || parts.includes("meta") || (mac && parts.includes("mod")),
    ctrl: parts.includes("ctrl") || (!mac && parts.includes("mod")),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
  if (e.metaKey !== want.meta || e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const pressed = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.toLowerCase();
  return pressed === key;
}

export function formatShortcut(shortcut: string, mac: boolean): string[] {
  return shortcut.split("+").map((part) => {
    switch (part.toLowerCase()) {
      case "mod":
        return mac ? "⌘" : "Ctrl";
      case "shift":
        return mac ? "⇧" : "Shift";
      case "alt":
        return mac ? "⌥" : "Alt";
      case "ctrl":
        return mac ? "⌃" : "Ctrl";
      case "backspace":
        return "⌫";
      default:
        return part.toUpperCase();
    }
  });
}

export const keymap = {
  dispatch(e: KeyboardEvent, mac: boolean): boolean {
    for (const b of bindings) {
      if (matchShortcut(e, b.shortcut, mac)) {
        safely(b.fn, undefined);
        return true;
      }
    }
    return false;
  },
};

const pocket = {
  hooks: {
    onQuery(fn: QueryHook) {
      queryHooks.push(fn);
    },
    onResults(fn: ResultsHook) {
      resultHooks.push(fn);
    },
  },
  keymap: {
    bind(shortcut: string, fn: () => void) {
      bindings.push({ shortcut, fn });
    },
  },
  query: {
    get: () => bridge?.get() ?? "",
    set: (text: string) => bridge?.set(text),
  },
};

declare global {
  interface Window {
    pocket: typeof pocket;
  }
}
window.pocket = pocket;

/** 运行 user.js。重新运行前清掉旧的钩子，避免重复注册。 */
export function installUserScript(code: string) {
  queryHooks = [];
  resultHooks = [];
  bindings = [];
  document.getElementById("pk-user-js")?.remove();
  if (!code.trim()) return;
  const el = document.createElement("script");
  el.id = "pk-user-js";
  el.textContent = `try{${code}\n}catch(e){console.error("[user.js]",e)}`;
  document.body.append(el);
}

/** 判断按键是否符合 accelerator 写法（CmdOrCtrl+D、Alt+Shift+K……）。 */
export function matchAccelerator(e: KeyboardEvent, accel: string, mac: boolean): boolean {
  if (!accel) return false;
  const parts = accel.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  const wantMeta = has("cmd", "command", "meta", "super", "win") || (mac && has("cmdorctrl", "commandorcontrol"));
  const wantCtrl = has("ctrl", "control") || (!mac && has("cmdorctrl", "commandorcontrol"));
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== has("alt", "option") || e.shiftKey !== has("shift")) return false;
  const pressed = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.toLowerCase();
  return pressed === key || (key === "space" && e.code === "Space");
}
