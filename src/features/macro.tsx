import { useEffect, useRef, useState } from "preact/hooks";
import { ArrowDown, ArrowUp, Circle, Copy, Keyboard, MousePointerClick, Mouse, Play, Plus, Square, Timer, Trash2, Type, X } from "lucide-preact";
import { Auto, events, type AutoState, type AutoStatus, type Macro, type MacroStep } from "../mygo";
import { Hotkey } from "../settings/ui";
import "../settings/settings.css";
import { Num, elapsed } from "./clicker";
import { comboLabel, isModifier } from "./keys";
import { Btn, Empty, Seg, Toggle } from "./ui";
import type { FeatureProps } from "./types";

const stepNames: Record<string, string> = { key: "按键", down: "按住", up: "松开", text: "输入文字", delay: "等待", click: "鼠标点击", scroll: "滚轮" };

/** 录按键：点一下再按键。按着修饰键再按别的键就是组合键；只按修饰键松开也算。 */
function KeyCapture({ keys, mac, onChange }: { keys: string[]; mac: boolean; onChange: (keys: string[]) => void }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    void import("../mygo").then((m) => m.Settings.suspendHotkeys(true));
    const held: string[] = [];
    const done = (k: string[]) => {
      onChange(k);
      setOn(false);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown") {
        if (e.repeat) return;
        if (isModifier(e.code)) {
          if (!held.includes(e.code)) held.push(e.code);
        } else if (e.code) done([...held, e.code]);
      } else if (isModifier(e.code) && held.length) {
        done([...held]); // 只按了修饰键就松开：这一步就是按修饰键本身
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      void import("../mygo").then((m) => m.Settings.suspendHotkeys(false));
    };
  }, [on]);
  return (
    <button type="button" class={`fx-keycap${on ? " is-on" : ""}${keys.length ? "" : " is-empty"}`} onClick={() => setOn(!on)} onBlur={() => setOn(false)}>
      {on ? "按下按键…" : keys.length ? comboLabel(keys, mac) : "点这里选按键"}
    </button>
  );
}

/** 把录下来的按下 / 松开整理成步骤：一个键按下后紧接着松开，合成一步“按键”，按住的时间记成长按。 */
function fromRecording(raw: { code: string; down: boolean; t: number }[]): MacroStep[] {
  const out: MacroStep[] = [];
  const gap = (ms: number) => {
    if (ms >= 15) out.push({ type: "delay", ms: Math.round(ms / 5) * 5 });
  };
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i]!;
    if (i > 0) gap(ev.t - raw[i - 1]!.t);
    const next = raw[i + 1];
    if (ev.down && next && !next.down && next.code === ev.code) {
      const hold = next.t - ev.t;
      out.push({ type: "key", keys: [ev.code], holdMs: hold >= 150 ? Math.round(hold / 10) * 10 : 0 });
      i++;
    } else {
      out.push({ type: ev.down ? "down" : "up", keys: [ev.code] });
    }
  }
  return out;
}

const blank = (): Macro => ({ id: "", name: "新的宏", steps: [], loops: 1, loopDelayMs: 0, speed: 1, startDelaySec: 3, hotkey: "" });

/** 键盘宏：把一串按键存下来，一键重放。 */
export function MacroTool({ ctx }: FeatureProps) {
  const [state, setState] = useState<AutoState | null>(null);
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [macro, setMacro] = useState<Macro | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const rec = useRef<{ code: string; down: boolean; t: number }[]>([]);
  const mac = ctx.platform === "darwin";

  const load = (pick?: string) =>
    Auto.state().then((s) => {
      setState(s);
      setStatus(s.status);
      const list = s.macros ?? [];
      setMacro((cur) => list.find((m) => m.id === (pick ?? cur?.id)) ?? list[0] ?? null);
    });
  useEffect(() => {
    void load();
    return events.autoStatus.on(setStatus);
  }, []);

  const save = (m: Macro, now = false) => {
    setMacro(m);
    clearTimeout(timer.current);
    const run = () =>
      Auto.saveMacro(m).then(
        (saved) => {
          setError("");
          if (!m.id) setMacro(saved);
          return load(saved.id);
        },
        (e: Error) => setError(e.message),
      );
    if (now) return run();
    timer.current = setTimeout(() => void run(), 300);
    return Promise.resolve();
  };
  const patch = (p: Partial<Macro>) => macro && void save({ ...macro, ...p });
  const setStep = (i: number, p: Partial<MacroStep>) => macro && patch({ steps: macro.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const addStep = (s: MacroStep) => macro && patch({ steps: [...(macro.steps ?? []), s] });
  const moveStep = (i: number, d: number) => {
    if (!macro) return;
    const steps = [...macro.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    patch({ steps });
  };

  // 录制：在这个窗口里按键，记下每一次按下和松开，以及中间隔了多久。
  useEffect(() => {
    if (!recording) return;
    rec.current = [];
    void import("../mygo").then((m) => m.Settings.suspendHotkeys(true));
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || !e.code) return;
      rec.current.push({ code: e.code, down: e.type === "keydown", t: performance.now() });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      void import("../mygo").then((m) => m.Settings.suspendHotkeys(false));
    };
  }, [recording]);
  const stopRecording = () => {
    setRecording(false);
    const steps = fromRecording(rec.current);
    if (macro && steps.length) patch({ steps: [...(macro.steps ?? []), ...steps] });
    else if (!steps.length) ctx.toast("没有录到按键");
  };

  if (!state) return <div class="fx-page fx-loading"><span class="ui-spinner" /></div>;
  const macros = state.macros ?? [];
  const running = !!status?.running && status.kind === "macro" && status.id === macro?.id;
  const busy = !!status?.running && !running;
  const steps = macro?.steps ?? [];
  const hotkeyError = macro ? state.errors?.[`macro:${macro.id}`] : "";

  const stepBody = (s: MacroStep, i: number) => {
    switch (s.type) {
      case "key":
        return (
          <>
            <KeyCapture keys={s.keys ?? []} mac={mac} onChange={(keys) => setStep(i, { keys })} />
            <span class="fx-inline" title="0 是轻点一下；填大一点就是长按">按住 <Num value={s.holdMs ?? 0} max={600000} width={64} unit="毫秒" onChange={(v) => setStep(i, { holdMs: v })} /></span>
            <span class="fx-inline">连按 <Num value={s.repeat || 1} min={1} max={100000} width={56} unit="次" onChange={(v) => setStep(i, { repeat: v })} /></span>
            {(s.repeat ?? 1) > 1 && <span class="fx-inline">间隔 <Num value={s.intervalMs || 50} min={1} max={3600000} width={64} unit="毫秒" onChange={(v) => setStep(i, { intervalMs: v })} /></span>}
          </>
        );
      case "down":
      case "up":
        return (
          <>
            <KeyCapture keys={s.keys ?? []} mac={mac} onChange={(keys) => setStep(i, { keys })} />
            <span class="fx-meta">{s.type === "down" ? "一直按着，直到后面有一步“松开”（宏结束时也会自动松开）" : "松开前面按住的键"}</span>
          </>
        );
      case "text":
        return <input class="ui-input fx-step-text" placeholder="要输入的文字（中文也可以）" value={s.text ?? ""} onInput={(e) => setStep(i, { text: (e.target as HTMLInputElement).value })} />;
      case "delay": {
        const random = (s.msMax ?? 0) > (s.ms ?? 0);
        return (
          <>
            <Num value={s.ms ?? 0} max={3600000} unit={random ? "到" : "毫秒"} onChange={(v) => setStep(i, { ms: v })} />
            {random && <Num value={s.msMax ?? 0} min={s.ms ?? 0} max={3600000} unit="毫秒之间随机" onChange={(v) => setStep(i, { msMax: v })} />}
            <label class="fx-inline">随机 <Toggle checked={random} label="随机等待" onChange={(v) => setStep(i, { msMax: v ? Math.round((s.ms || 100) * 1.5) : 0 })} /></label>
          </>
        );
      }
      case "click":
        return (
          <>
            <Seg value={(s.button || "left") as "left"} options={[{ value: "left", label: "左键" }, { value: "right", label: "右键" }, { value: "middle", label: "中键" }]} onChange={(v) => setStep(i, { button: v })} />
            <span class="fx-inline"><Num value={s.repeat || 1} min={1} max={100000} width={56} unit="次" onChange={(v) => setStep(i, { repeat: v })} /></span>
            <label class="fx-inline">先移到 <Toggle checked={!!s.move} label="先移动鼠标" onChange={(v) => setStep(i, { move: v })} /></label>
            {s.move && (
              <>
                <Num value={s.x ?? 0} min={-100000} max={100000} width={60} onChange={(v) => setStep(i, { x: v })} />
                <Num value={s.y ?? 0} min={-100000} max={100000} width={60} onChange={(v) => setStep(i, { y: v })} />
                <Btn small ghost title="3 秒后记下鼠标的位置" onClick={() => void Auto.pickPosition(3).then((p) => p && setStep(i, { x: p[0]!, y: p[1]! }))}>拾取</Btn>
              </>
            )}
          </>
        );
      case "scroll":
        return <span class="fx-inline">滚 <Num value={s.lines ?? 0} min={-1000} max={1000} width={60} unit="行（正数向上，负数向下）" onChange={(v) => setStep(i, { lines: v })} /></span>;
    }
    return null;
  };

  return (
    <div class="fx-page fx-notes fx-macro">
      <aside class="fx-out fx-side">
        <div class="fx-side-head">
          <b>宏</b>
          <span class="fx-spacer" />
          <Btn small ghost icon title="新建宏" onClick={() => void save(blank(), true)}>
            <Plus size={14} />
          </Btn>
        </div>
        <div class="fx-side-list">
          {macros.map((m) => (
            <div key={m.id} class={`fx-side-item${m.id === macro?.id ? " is-selected" : ""}`} onClick={() => setMacro(m)}>
              <Keyboard size={13} />
              <span class="fx-side-name">{m.name}</span>
              {status?.running && status.id === m.id && <span class="ui-spinner" />}
            </div>
          ))}
          {macros.length === 0 && <div class="fx-side-empty">还没有宏</div>}
        </div>
      </aside>
      {!macro ? (
        <div class="fx-out fx-grow-1 fx-scratch-empty">
          <Empty title="把重复的按键交给宏" desc="一串按键、组合键、文字和等待，存下来一键重放，可以绑全局快捷键。">
            <Btn primary onClick={() => void save(blank(), true)}>
              <Plus size={14} /> 新建宏
            </Btn>
          </Empty>
        </div>
      ) : (
        <div class="fx-notes-main">
          {!state.allowed && (
            <div class="fx-banner is-warn">
              系统还不允许本应用模拟键盘。在“系统设置 → 隐私与安全性 → 辅助功能”里打开它。
              <Btn small onClick={() => void Auto.openAccessibility()}>去授权</Btn>
              <Btn small ghost onClick={() => void load()}>我已授权</Btn>
            </div>
          )}
          <div class="fx-notes-head">
            <input class="fx-notes-title" value={macro.name} spellcheck={false} aria-label="宏的名字" onInput={(e) => patch({ name: (e.target as HTMLInputElement).value })} />
            <Btn small ghost icon title="复制一份" onClick={() => void save({ ...macro, id: "", name: macro.name + " 副本", hotkey: "" }, true)}>
              <Copy size={14} />
            </Btn>
            <Btn small ghost icon title="删除这个宏" onClick={() => void Auto.deleteMacro(macro.id).then(() => { setMacro(null); void load(); })}>
              <Trash2 size={14} />
            </Btn>
          </div>
          <div class="fx-toolbar">
            <span class="fx-meta">添加一步：</span>
            <Btn small onClick={() => addStep({ type: "key", keys: [] })}><Keyboard size={13} /> 按键 / 组合键</Btn>
            <Btn small onClick={() => addStep({ type: "text", text: "" })}><Type size={13} /> 文字</Btn>
            <Btn small onClick={() => addStep({ type: "delay", ms: 200 })}><Timer size={13} /> 等待</Btn>
            <Btn small onClick={() => addStep({ type: "click", button: "left" })}><MousePointerClick size={13} /> 点击</Btn>
            <Btn small onClick={() => addStep({ type: "scroll", lines: -3 })}><Mouse size={13} /> 滚轮</Btn>
            <Btn small ghost title="按住一个键不放（比如按着 Shift 再点鼠标），配合后面的“松开”" onClick={() => addStep({ type: "down", keys: [] })}>按住</Btn>
            <Btn small ghost onClick={() => addStep({ type: "up", keys: [] })}>松开</Btn>
            <span class="fx-spacer" />
            {recording ? (
              <Btn small danger onClick={stopRecording}><Square size={12} /> 结束录制</Btn>
            ) : (
              <Btn small title="在这个窗口里把要重放的键按一遍，按下、松开和间隔都会记下来" onClick={() => setRecording(true)}><Circle size={12} /> 录制</Btn>
            )}
          </div>
          <div class={`fx-out fx-grow-1 fx-scroll fx-steps${recording ? " is-recording" : ""}`}>
            {recording && <div class="fx-rec">正在录制：现在按的键都会记下来（全局快捷键暂时不生效）。按完点“结束录制”。</div>}
            {steps.map((s, i) => (
              <div key={i} class={`fx-step${running && status?.step === i + 1 ? " is-active" : ""}`}>
                <span class="fx-step-no">{i + 1}</span>
                <span class="fx-step-type">{stepNames[s.type] ?? s.type}</span>
                <div class="fx-step-body">{stepBody(s, i)}</div>
                <button type="button" class="fx-side-del" title="上移" disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp size={12} /></button>
                <button type="button" class="fx-side-del" title="下移" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown size={12} /></button>
                <button type="button" class="fx-side-del" title="删掉这一步" onClick={() => patch({ steps: steps.filter((_, k) => k !== i) })}><X size={12} /></button>
              </div>
            ))}
            {steps.length === 0 && !recording && <div class="fx-side-empty">还没有步骤。用上面的按钮一步步加，或者点“录制”把按键按一遍。</div>}
          </div>
          <div class="fx-row fx-macro-opts">
            <span class="fx-inline" title="0 表示一直重复，直到手动停止">重复 <Num value={macro.loops} max={1000000} width={64} unit={macro.loops === 0 ? "（一直重复）" : "遍"} onChange={(v) => patch({ loops: v })} /></span>
            <span class="fx-inline">每遍间隔 <Num value={macro.loopDelayMs} max={3600000} width={64} unit="毫秒" onChange={(v) => patch({ loopDelayMs: v })} /></span>
            <span class="fx-inline">速度 <Num value={macro.speed} min={0.1} max={20} step={0.1} width={52} unit="倍" onChange={(v) => patch({ speed: v })} /></span>
            <span class="fx-inline">开始前等 <Num value={macro.startDelaySec} max={60} step={0.5} width={52} unit="秒" onChange={(v) => patch({ startDelaySec: v })} /></span>
            <span class="fx-inline">快捷键 <Hotkey value={macro.hotkey} platform={ctx.platform} clearable onChange={(v) => patch({ hotkey: v })} /></span>
          </div>
          <div class="fx-auto-bar">
            {running ? (
              <Btn danger onClick={() => void Auto.stop()}><Square size={13} /> 停止</Btn>
            ) : (
              <Btn primary disabled={!state.allowed || busy || steps.length === 0 || !macro.id} onClick={() => void save(macro, true).then(() => Auto.runMacro(macro.id)).catch((e: Error) => ctx.toast(e.message, true))}>
                <Play size={13} /> 运行
              </Btn>
            )}
            <div class={`fx-auto-status${running ? " is-running" : ""}`} aria-live="polite">
              {error ? (
                <span class="fx-error-text">{error}</span>
              ) : hotkeyError ? (
                <span class="fx-error-text">快捷键注册失败：{hotkeyError}</span>
              ) : running ? (
                status!.countdown > 0 ? <b>{status!.countdown} 秒后开始…</b> : <><b>第 {status!.count + 1} 遍，第 {status!.step} 步</b> · {elapsed(status!.elapsedMs)}</>
              ) : busy ? (
                "有别的任务正在运行"
              ) : status?.kind === "macro" && status.id === macro.id && status.note ? (
                `${status.note} · 用了 ${elapsed(status.elapsedMs)}`
              ) : (
                `${steps.length} 步 · 运行时把输入焦点放在要操作的窗口里`
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
