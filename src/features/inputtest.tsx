import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { RotateCcw } from "lucide-preact";
import { Settings } from "../mygo";
import { keyLabel } from "./keys";
import { Btn, Seg } from "./ui";
import type { FeatureProps } from "./types";

interface Key {
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 生成一把全尺寸键盘（104 键）的位置，单位是“一个普通键的宽度”。 */
function layout(mac: boolean): { keys: Key[]; width: number; height: number } {
  const keys: Key[] = [];
  const row = (y: number, x: number, items: (string | [string, number] | number)[]) => {
    for (const it of items) {
      if (typeof it === "number") {
        x += it; // 空隙
        continue;
      }
      const [code, w] = typeof it === "string" ? [it, 1] : it;
      keys.push({ code, x, y, w, h: 1 });
      x += w;
    }
  };
  const letters = (s: string) => s.split("").map((c) => "Key" + c);
  row(0, 0, ["Escape", 1, "F1", "F2", "F3", "F4", 0.5, "F5", "F6", "F7", "F8", 0.5, "F9", "F10", "F11", "F12"]);
  row(1.5, 0, ["Backquote", ..."1234567890".split("").map((d) => "Digit" + d), "Minus", "Equal", ["Backspace", 2]]);
  row(2.5, 0, [["Tab", 1.5], ...letters("QWERTYUIOP"), "BracketLeft", "BracketRight", ["Backslash", 1.5]]);
  row(3.5, 0, [["CapsLock", 1.75], ...letters("ASDFGHJKL"), "Semicolon", "Quote", ["Enter", 2.25]]);
  row(4.5, 0, [["ShiftLeft", 2.25], ...letters("ZXCVBNM"), "Comma", "Period", "Slash", ["ShiftRight", 2.75]]);
  // 苹果键盘上 ⌥ 和 ⌘ 的位置和 Windows 键盘的 Alt、Win 是反的。
  const [l2, l3, r1, r2] = mac ? ["AltLeft", "MetaLeft", "MetaRight", "AltRight"] : ["MetaLeft", "AltLeft", "AltRight", "MetaRight"];
  row(5.5, 0, [["ControlLeft", 1.25], [l2!, 1.25], [l3!, 1.25], ["Space", 6.25], [r1!, 1.25], [r2!, 1.25], ["ContextMenu", 1.25], ["ControlRight", 1.25]]);
  // 编辑键区
  const nx = 15.5;
  row(0, nx, ["PrintScreen", "ScrollLock", "Pause"]);
  row(1.5, nx, ["Insert", "Home", "PageUp"]);
  row(2.5, nx, ["Delete", "End", "PageDown"]);
  row(4.5, nx + 1, ["ArrowUp"]);
  row(5.5, nx, ["ArrowLeft", "ArrowDown", "ArrowRight"]);
  // 数字小键盘
  const px = 19;
  row(1.5, px, ["NumLock", "NumpadDivide", "NumpadMultiply", "NumpadSubtract"]);
  row(2.5, px, ["Numpad7", "Numpad8", "Numpad9"]);
  row(3.5, px, ["Numpad4", "Numpad5", "Numpad6"]);
  row(4.5, px, ["Numpad1", "Numpad2", "Numpad3"]);
  row(5.5, px, [["Numpad0", 2], "NumpadDecimal"]);
  keys.push({ code: "NumpadAdd", x: px + 3, y: 2.5, w: 1, h: 2 }, { code: "NumpadEnter", x: px + 3, y: 4.5, w: 1, h: 2 });
  return { keys, width: 23, height: 6.5 };
}

const short: Record<string, string> = {
  Escape: "Esc", Backspace: "⌫", Enter: "↵", CapsLock: "Caps", PrintScreen: "PrtSc", ScrollLock: "ScrLk", Pause: "Pause", Insert: "Ins", Delete: "Del",
  PageUp: "PgUp", PageDown: "PgDn", ContextMenu: "☰", NumLock: "Num", NumpadDivide: "/", NumpadMultiply: "*", NumpadSubtract: "-", NumpadAdd: "+", NumpadEnter: "↵", NumpadDecimal: ".",
  ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Ctrl", ControlRight: "Ctrl", Space: "",
};
const cap = (code: string, mac: boolean) => {
  if (code in short) return short[code]!;
  if (code.startsWith("Numpad")) return code.slice(6);
  if (code.startsWith("Alt")) return mac ? "⌥" : "Alt";
  if (code.startsWith("Meta")) return mac ? "⌘" : "Win";
  return keyLabel(code, mac);
};

function KeyboardTest({ mac, armed }: { mac: boolean; armed: boolean }) {
  const board = useMemo(() => layout(mac), [mac]);
  const [down, setDown] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [last, setLast] = useState<{ key: string; code: string; keyCode: number } | null>(null);
  const [maxDown, setMaxDown] = useState(0);
  const [chatter, setChatter] = useState<Record<string, number>>({});
  const [unknown, setUnknown] = useState<Record<string, number>>({});
  const times = useRef<Record<string, number>>({});
  const held = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!armed) return;
    const known = new Set(board.keys.map((k) => k.code));
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || !e.code) return;
      const now = performance.now();
      // 松开后不到 30 毫秒又按下：人按不了这么快，多半是按键抖动（连击）。
      const up = times.current[e.code];
      if (up && now - up < 30) setChatter((c) => ({ ...c, [e.code]: (c[e.code] ?? 0) + 1 }));
      held.current.add(e.code);
      setDown(new Set(held.current));
      setMaxDown((m) => Math.max(m, held.current.size));
      setCounts((c) => ({ ...c, [e.code]: (c[e.code] ?? 0) + 1 }));
      setLast({ key: e.key, code: e.code, keyCode: e.keyCode });
      if (!known.has(e.code)) setUnknown((u) => ({ ...u, [e.code]: (u[e.code] ?? 0) + 1 }));
    };
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      times.current[e.code] = performance.now();
      held.current.delete(e.code);
      // 苹果系统上按着 ⌘ 时别的键收不到松开事件：⌘ 松开时把还“按着”的都放掉。
      if (e.code.startsWith("Meta")) held.current.clear();
      setDown(new Set(held.current));
    };
    const clear = () => {
      held.current.clear();
      setDown(new Set());
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [armed, board]);

  const reset = () => {
    setCounts({});
    setChatter({});
    setUnknown({});
    setLast(null);
    setMaxDown(0);
    times.current = {};
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tested = board.keys.filter((k) => counts[k.code]).length;
  const suspects = Object.entries(chatter);
  const extra = Object.entries(unknown);

  return (
    <>
      <div class="fx-kb-wrap">
        <div class="fx-kb" style={{ "--cols": board.width, "--rows": board.height } as Record<string, number>}>
          {board.keys.map((k) => (
            <div
              key={k.code}
              class={`fx-key${down.has(k.code) ? " is-down" : ""}${counts[k.code] ? " is-tested" : ""}${chatter[k.code] ? " is-suspect" : ""}`}
              style={{ left: `calc(${k.x} * var(--u))`, top: `calc(${k.y} * var(--u))`, width: `calc(${k.w} * var(--u) - 3px)`, height: `calc(${k.h} * var(--u) - 3px)` }}
              title={`${k.code}${counts[k.code] ? `：${counts[k.code]} 次` : "：还没按过"}`}
            >
              <span>{cap(k.code, mac)}</span>
              {counts[k.code] ? <small>{counts[k.code]}</small> : null}
            </div>
          ))}
        </div>
      </div>
      <div class="fx-test-stats">
        <div><b>{total}</b><span>总按键次数</span></div>
        <div><b>{tested} / {board.keys.length}</b><span>测过的键</span></div>
        <div><b>{down.size}</b><span>正按着</span></div>
        <div title="同时按住过的最多键数。普通键盘一般 6 个左右，全键无冲的更多"><b>{maxDown}</b><span>最多同时按下</span></div>
        <div class="is-wide">
          <b>{last ? keyLabel(last.code, mac) : "—"}</b>
          <span>{last ? `${last.code} · key "${last.key === " " ? "空格" : last.key}" · keyCode ${last.keyCode}` : "最近按下的键"}</span>
        </div>
        <Btn small ghost onClick={reset}><RotateCcw size={13} /> 清零</Btn>
      </div>
      <div class="fx-meta fx-test-notes">
        {suspects.length > 0 && <span class="fx-error-text">疑似连击（松开后 30 毫秒内又触发）：{suspects.map(([c, n]) => `${keyLabel(c, mac)} ×${n}`).join("、")}　</span>}
        {extra.length > 0 && <span>图上没有的键：{extra.map(([c, n]) => `${c} ×${n}`).join("、")}　</span>}
        <span>{armed ? "按过的键会变色并记下次数。Win / ⌘ 加别的键、PrtSc 等系统自己要用的组合，页面收不到。" : "测试已暂停，点右上角“开始测试”继续。"}</span>
      </div>
    </>
  );
}

const buttonNames = ["左键", "中键", "右键", "后退键", "前进键"];

function MouseTest() {
  const [down, setDown] = useState<Set<number>>(new Set());
  const [counts, setCounts] = useState<number[]>([0, 0, 0, 0, 0]);
  const [wheel, setWheel] = useState({ up: 0, down: 0, dir: 0 });
  const [fastest, setFastest] = useState<number[]>([0, 0, 0, 0, 0]);
  const [suspect, setSuspect] = useState<number[]>([0, 0, 0, 0, 0]);
  const [hold, setHold] = useState(0);
  const [pos, setPos] = useState({ x: 0, y: 0, speed: 0, rate: 0 });
  const lastDown = useRef<number[]>([0, 0, 0, 0, 0]);
  const downAt = useRef<number[]>([0, 0, 0, 0, 0]);
  const move = useRef({ t: 0, x: 0, y: 0, n: 0, since: 0, dist: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>();

  const bump = <T,>(arr: T[], i: number, v: T) => arr.map((x, k) => (k === i ? v : x));
  const onDown = (e: MouseEvent) => {
    e.preventDefault();
    const b = e.button;
    if (b < 0 || b > 4) return;
    const now = performance.now();
    const gap = lastDown.current[b] ? now - lastDown.current[b]! : 0;
    lastDown.current[b] = now;
    downAt.current[b] = now;
    setDown((d) => new Set(d).add(b));
    setCounts((c) => bump(c, b, c[b]! + 1));
    if (gap > 0) {
      setFastest((f) => bump(f, b, f[b] ? Math.min(f[b]!, gap) : gap));
      // 两次按下间隔不到 60 毫秒，人手基本点不出来：多半是微动老化造成的“单击变双击”。
      if (gap < 60) setSuspect((s) => bump(s, b, s[b]! + 1));
    }
  };
  const onUp = (e: MouseEvent) => {
    e.preventDefault();
    const b = e.button;
    setDown((d) => {
      const n = new Set(d);
      n.delete(b);
      return n;
    });
    if (downAt.current[b]) setHold(performance.now() - downAt.current[b]!);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const up = e.deltaY < 0;
    setWheel((w) => ({ up: w.up + (up ? 1 : 0), down: w.down + (up ? 0 : 1), dir: up ? -1 : 1 }));
    clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => setWheel((w) => ({ ...w, dir: 0 })), 160);
  };
  const onMove = (e: MouseEvent) => {
    const m = move.current;
    const now = performance.now();
    if (m.t) m.dist += Math.hypot(e.clientX - m.x, e.clientY - m.y);
    m.n++;
    if (!m.since) m.since = now;
    if (now - m.since >= 400) {
      const secs = (now - m.since) / 1000;
      setPos({ x: Math.round(e.clientX), y: Math.round(e.clientY), speed: Math.round(m.dist / secs), rate: Math.round(m.n / secs) });
      m.n = 0;
      m.dist = 0;
      m.since = now;
    }
    m.t = now;
    m.x = e.clientX;
    m.y = e.clientY;
  };
  const pad = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pad.current;
    if (!el) return;
    // 滚轮要用非被动的监听才能拦住页面滚动。
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const reset = () => {
    setCounts([0, 0, 0, 0, 0]);
    setFastest([0, 0, 0, 0, 0]);
    setSuspect([0, 0, 0, 0, 0]);
    setWheel({ up: 0, down: 0, dir: 0 });
    setHold(0);
    lastDown.current = [0, 0, 0, 0, 0];
  };
  const on = (b: number) => (down.has(b) ? " is-down" : counts[b] ? " is-tested" : "");
  const bad = suspect.map((n, i) => (n ? `${buttonNames[i]} ×${n}` : "")).filter(Boolean);

  return (
    <>
      <div
        class="fx-mouse-pad"
        ref={pad}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseMove={onMove}
        onContextMenu={(e) => e.preventDefault()}
        onAuxClick={(e) => e.preventDefault()}
        onDblClick={(e) => e.preventDefault()}
      >
        <svg class="fx-mouse" viewBox="0 0 220 320" aria-label="鼠标示意图">
          {/* 侧键 */}
          <rect class={`fx-mouse-part${on(4)}`} x="6" y="118" width="16" height="46" rx="8" />
          <rect class={`fx-mouse-part${on(3)}`} x="6" y="172" width="16" height="46" rx="8" />
          {/* 机身 */}
          <path class="fx-mouse-body" d="M110 12c52 0 88 34 88 92v104c0 58-36 100-88 100S22 266 22 208V104c0-58 36-92 88-92Z" />
          {/* 左右键 */}
          <path class={`fx-mouse-part${on(0)}`} d="M104 18c-46 2-76 34-76 86v34h76Z" />
          <path class={`fx-mouse-part${on(2)}`} d="M116 18c46 2 76 34 76 86v34h-76Z" />
          {/* 滚轮 */}
          <rect class={`fx-mouse-part is-wheel${on(1)}`} x="97" y="46" width="26" height="66" rx="13" />
          <path class={`fx-mouse-arrow${wheel.dir < 0 ? " is-on" : ""}`} d="M110 54l8 12h-16Z" />
          <path class={`fx-mouse-arrow${wheel.dir > 0 ? " is-on" : ""}`} d="M110 104l8-12h-16Z" />
        </svg>
        <div class="fx-mouse-hint">在这片区域里点击、滚动、移动鼠标</div>
      </div>
      <div class="fx-test-stats">
        {buttonNames.map((n, i) => (
          <div key={n} class={down.has(i) ? "is-active" : ""}>
            <b>{counts[i]}</b>
            <span>{n}{fastest[i] ? ` · 最快 ${Math.round(fastest[i]!)}ms` : ""}</span>
          </div>
        ))}
        <div><b>{wheel.up} / {wheel.down}</b><span>滚轮上 / 下</span></div>
        <div title="最近一次按住了多久"><b>{hold ? `${Math.round(hold)}ms` : "—"}</b><span>按住时长</span></div>
        <div title="页面每秒收到多少次移动事件。受系统和窗口刷新的限制，通常低于鼠标本身的回报率，只能做相对比较"><b>{pos.rate || "—"}</b><span>移动事件 / 秒</span></div>
        <div><b>{pos.speed || "—"}</b><span>速度 像素/秒</span></div>
        <Btn small ghost onClick={reset}><RotateCcw size={13} /> 清零</Btn>
      </div>
      <div class="fx-meta fx-test-notes">
        {bad.length > 0 ? <span class="fx-error-text">疑似连击（两次按下间隔不到 60 毫秒）：{bad.join("、")}。单击时出现这个，多半是微动开关老化。　</span> : <span>检查“单击变双击”：一下一下慢慢点，如果这里出现“疑似连击”，说明按键有问题。　</span>}
        <span>位置 {pos.x}, {pos.y}</span>
      </div>
    </>
  );
}

/** 按键测试：键盘和鼠标各一页。 */
export function InputTest({ args, ctx }: FeatureProps) {
  const [tab, setTab] = useState<"keyboard" | "mouse">(args.tab === "mouse" ? "mouse" : "keyboard");
  const [armed, setArmed] = useState(true);
  const mac = ctx.platform === "darwin";
  const capturing = armed && tab === "keyboard";
  // 测键盘时全局快捷键先停掉：不然按 Alt+空格 会把主窗口收起来。
  useEffect(() => {
    if (!capturing) return;
    void Settings.suspendHotkeys(true);
    return () => void Settings.suspendHotkeys(false);
  }, [capturing]);

  return (
    <div class="fx-page fx-inputtest">
      <div class="fx-toolbar">
        <Seg value={tab} options={[{ value: "keyboard", label: "键盘" }, { value: "mouse", label: "鼠标" }]} onChange={setTab} />
        <span class="fx-spacer" />
        {tab === "keyboard" && (
          <>
            <span class="fx-meta">{armed ? "所有按键都被测试接管了（包括 Esc），全局快捷键暂停" : ""}</span>
            <Btn small primary={!armed} on={armed} onClick={() => setArmed(!armed)}>
              {armed ? "暂停测试" : "开始测试"}
            </Btn>
          </>
        )}
      </div>
      {tab === "keyboard" ? <KeyboardTest mac={mac} armed={armed} /> : <MouseTest />}
    </div>
  );
}
