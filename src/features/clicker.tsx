import { useEffect, useRef, useState } from "preact/hooks";
import { Crosshair, Play, Square } from "lucide-preact";
import { Auto, events, type AutoState, type AutoStatus, type ClickerConfig } from "../mygo";
import { Hotkey } from "../settings/ui";
import "../settings/settings.css";
import { Btn, Seg, Toggle } from "./ui";
import type { FeatureProps } from "./types";

/** 数字输入：空着或写错时不把设置冲掉，离开时再回到合法的值。 */
export function Num({ value, onChange, min = 0, max = 1e9, step = 1, width = 76, unit }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number; unit?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <span class="fx-num">
      <input
        class="ui-input is-mono"
        style={{ width: `${width}px` }}
        inputMode="decimal"
        value={text}
        onInput={(e) => {
          const t = (e.target as HTMLInputElement).value;
          setText(t);
          const n = Number(t);
          if (t.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(step >= 1 ? Math.round(n) : n);
        }}
        onBlur={() => setText(String(value))}
      />
      {unit && <span class="fx-meta">{unit}</span>}
    </span>
  );
}

export function elapsed(ms: number) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} 秒` : `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}

/** 鼠标连点器。 */
export function ClickerTool({ ctx }: FeatureProps) {
  const [state, setState] = useState<AutoState | null>(null);
  const [cfg, setCfg] = useState<ClickerConfig | null>(null);
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [random, setRandom] = useState(false);
  const [picking, setPicking] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = () =>
    Auto.state().then((s) => {
      setState(s);
      setCfg(s.clicker);
      setStatus(s.status);
      setRandom(s.clicker.intervalMaxMs > s.clicker.intervalMs);
    });
  useEffect(() => {
    void load();
    return events.autoStatus.on(setStatus);
  }, []);

  const update = (patch: Partial<ClickerConfig>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void Auto.saveClicker(next).then(() => Auto.state().then(setState)), 250);
  };
  if (!cfg || !state) return <div class="fx-page fx-loading"><span class="ui-spinner" /></div>;

  const running = !!status?.running && status.kind === "clicker";
  const busy = !!status?.running && status.kind !== "clicker";
  const start = async () => {
    clearTimeout(timer.current);
    await Auto.saveClicker(cfg);
    Auto.startClicker().catch((e: Error) => ctx.toast(e.message, true));
  };
  const pick = async () => {
    setPicking(3);
    const tick = setInterval(() => setPicking((n) => Math.max(0, n - 1)), 1000);
    try {
      const pos = await Auto.pickPosition(3);
      if (pos) update({ position: "fixed", x: pos[0]!, y: pos[1]! });
    } catch (e) {
      ctx.toast((e as Error).message, true);
    } finally {
      clearInterval(tick);
      setPicking(0);
    }
  };
  const cps = 1000 / (random ? (cfg.intervalMs + Math.max(cfg.intervalMaxMs, cfg.intervalMs)) / 2 : cfg.intervalMs);
  const hotkeyError = state.errors?.["auto:clicker"];

  return (
    <div class="fx-page fx-auto">
      {!state.allowed && (
        <div class="fx-banner is-warn">
          系统还不允许本应用模拟鼠标。在“系统设置 → 隐私与安全性 → 辅助功能”里打开它。
          <Btn small onClick={() => void Auto.openAccessibility()}>去授权</Btn>
          <Btn small ghost onClick={() => void load()}>我已授权</Btn>
        </div>
      )}
      <div class="fx-out fx-grow-1 fx-scroll fx-form">
        <div class="fx-row">
          <label>按键</label>
          <Seg value={cfg.button as "left"} options={[{ value: "left", label: "左键" }, { value: "right", label: "右键" }, { value: "middle", label: "中键" }]} onChange={(v) => update({ button: v })} />
        </div>
        <div class="fx-row">
          <label>点法</label>
          <Seg value={cfg.kind as "single"} options={[{ value: "single", label: "单击" }, { value: "double", label: "双击" }, { value: "triple", label: "三击" }, { value: "hold", label: "长按" }]} onChange={(v) => update({ kind: v })} />
          {cfg.kind === "hold" && (
            <span class="fx-inline">每次按住 <Num value={cfg.holdMs} min={10} max={600000} unit="毫秒" onChange={(v) => update({ holdMs: v })} /></span>
          )}
        </div>
        <div class="fx-row">
          <label>间隔</label>
          <Num value={cfg.intervalMs} min={1} max={3600000} unit={random ? "到" : "毫秒"} onChange={(v) => update({ intervalMs: v, intervalMaxMs: random ? Math.max(cfg.intervalMaxMs, v) : 0 })} />
          {random && <Num value={Math.max(cfg.intervalMaxMs, cfg.intervalMs)} min={cfg.intervalMs} max={3600000} unit="毫秒之间随机" onChange={(v) => update({ intervalMaxMs: v })} />}
          <label class="fx-inline">
            随机间隔 <Toggle checked={random} label="随机间隔" onChange={(v) => { setRandom(v); update({ intervalMaxMs: v ? Math.round(cfg.intervalMs * 1.5) : 0 }); }} />
          </label>
          <span class="fx-meta">约每秒 {cps >= 10 ? cps.toFixed(0) : cps.toFixed(1)} 次</span>
        </div>
        <div class="fx-row">
          <label>什么时候停</label>
          <Seg value={cfg.stopMode as "manual"} options={[{ value: "manual", label: "手动停止" }, { value: "count", label: "点够次数" }, { value: "duration", label: "到时间" }]} onChange={(v) => update({ stopMode: v })} />
          {cfg.stopMode === "count" && <Num value={cfg.count} min={1} max={10000000} unit="次" onChange={(v) => update({ count: v })} />}
          {cfg.stopMode === "duration" && <Num value={cfg.durationSec} min={0.1} max={86400} step={0.1} unit="秒" onChange={(v) => update({ durationSec: v })} />}
        </div>
        <div class="fx-row">
          <label>点哪里</label>
          <Seg value={cfg.position as "cursor"} options={[{ value: "cursor", label: "鼠标所在的位置" }, { value: "fixed", label: "固定位置" }]} onChange={(v) => update({ position: v })} />
          {cfg.position === "fixed" && (
            <>
              <span class="fx-inline">X <Num value={cfg.x} min={-100000} max={100000} width={64} onChange={(v) => update({ x: v })} /></span>
              <span class="fx-inline">Y <Num value={cfg.y} min={-100000} max={100000} width={64} onChange={(v) => update({ y: v })} /></span>
              <Btn small disabled={picking > 0} title="点了之后把鼠标移到要点的地方，3 秒后记下位置" onClick={() => void pick()}>
                <Crosshair size={13} /> {picking > 0 ? `${picking} 秒后记录…` : "拾取位置"}
              </Btn>
              <span class="fx-inline">随机偏移 <Num value={cfg.jitter} min={0} max={500} width={56} unit="像素" onChange={(v) => update({ jitter: v })} /></span>
            </>
          )}
        </div>
        <div class="fx-row">
          <label>开始前等待</label>
          <Num value={cfg.startDelaySec} min={0} max={60} step={0.5} unit="秒" onChange={(v) => update({ startDelaySec: v })} />
          <span class="fx-meta">来得及切到要点的窗口</span>
        </div>
        <div class="fx-row">
          <label>快捷键</label>
          <Hotkey value={cfg.hotkey} platform={ctx.platform} clearable placeholder="点击设置" onChange={(v) => update({ hotkey: v })} />
          <span class="fx-meta">{hotkeyError ? <span class="fx-error-text">注册失败：{hotkeyError}</span> : "在任何窗口里按它开始，再按一次停止"}</span>
        </div>
        <div class="fx-row">
          <label>紧急停止</label>
          <Toggle checked={cfg.failsafe} label="紧急停止" onChange={(v) => update({ failsafe: v })} />
          <span class="fx-meta">把鼠标甩到屏幕左上角立刻停下</span>
        </div>
      </div>
      <div class="fx-auto-bar">
        {running ? (
          <Btn danger onClick={() => void Auto.stop()}>
            <Square size={13} /> 停止
          </Btn>
        ) : (
          <Btn primary disabled={!state.allowed || busy} onClick={() => void start()}>
            <Play size={13} /> 开始
          </Btn>
        )}
        <div class={`fx-auto-status${running ? " is-running" : ""}`} aria-live="polite">
          {running ? (
            status!.countdown > 0 ? (
              <b>{status!.countdown} 秒后开始…</b>
            ) : (
              <>
                <b>已点 {status!.count} 次</b> · {elapsed(status!.elapsedMs)}
              </>
            )
          ) : busy ? (
            "有一个宏正在运行"
          ) : status?.kind === "clicker" && status.note ? (
            `${status.note}${status.count ? ` · 共 ${status.count} 次，用了 ${elapsed(status.elapsedMs)}` : ""}`
          ) : (
            "点“开始”，或者按上面设的快捷键"
          )}
        </div>
      </div>
    </div>
  );
}
