import { render, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  ArrowDownLeft, ArrowUpRight, Check, CheckCheck, Copy, File, FileWarning, FolderOpen, History, KeyRound, Link2,
  LoaderCircle, LockKeyhole, RefreshCw, Send, ShieldCheck, Trash2, Unplug, Upload, Wifi, X, Zap,
} from "lucide-preact";
import { pocket } from "../../sdk/pocket";
import { active, avatars, bytes, progress, type Identity, type NATType, type PeerState, type TokenPreview, type Transfer } from "./types";
import "../../../src/shared/tokens.css";
import "../../../src/shared/motion.css";
import "../../../src/shared/controls.css";
import "./peer.css";

type ConnectMode = "direct" | "punch";
type Phase = "idle" | "pending" | "connected";

const rpc = <T,>(method: string, ...args: unknown[]) => pocket.call(`peer.${method}`, ...args) as Promise<T>;
const statusText: Record<PeerState["state"], string> = {
  offline: "等待网络",
  idle: "可以接收连接",
  punching: "正在打洞穿透",
  connecting: "正在连接",
  waiting: "等待对方同意",
  request: "收到连接请求",
  verify: "核对配对数字",
  connected: "已建立安全连接",
};
const natLabel: Record<NATType, string> = {
  cone: "锥形 NAT",
  symmetric: "对称型 NAT",
  unknown: "NAT 未知",
};
const phaseOf = (s: PeerState["state"]): Phase =>
  s === "connected" ? "connected" : s === "idle" || s === "offline" ? "idle" : "pending";

function Avatar({ person, size = "md" }: { person?: Identity; size?: "sm" | "md" | "lg" }) {
  if (!person) return <span class={`pk-avatar is-${size} is-unknown`} aria-label="等待对方">?</span>;
  return <span class={`pk-avatar is-${size} tone-${person.avatar}`} aria-label={`${person.name} 的头像`}>{avatars[person.avatar] ?? "🦦"}</span>;
}

/** 两端头像和中间的通道：连接中是流动的虚线和雷达波纹，连上之后通道合拢、锁扣弹出，传输时有粒子流动。 */
function Link({ self, peer, phase, flow }: { self: Identity; peer?: Identity; phase: Phase; flow: "" | "send" | "recv" | "both" }) {
  return <div class={`pk-link is-${phase}${flow ? ` flow-${flow}` : ""}`} aria-hidden="true">
    <div class="pk-link-end">
      <span class="pk-link-halo" />
      <Avatar person={self} size="lg" />
      <span class="pk-link-name">{self.name}</span>
    </div>
    <div class="pk-link-track">
      <span class="pk-link-rail" />
      <span class="pk-link-fill left" />
      <span class="pk-link-fill right" />
      <span class="pk-link-packet p1" /><span class="pk-link-packet p2" /><span class="pk-link-packet p3" />
      <span class="pk-link-packet r1" /><span class="pk-link-packet r2" /><span class="pk-link-packet r3" />
      <span class="pk-link-node">
        <span class="pk-link-burst" /><span class="pk-link-burst b2" />
        {phase === "connected" ? <LockKeyhole size={17} /> : <LoaderCircle size={17} class="pk-spin" />}
      </span>
    </div>
    <div class="pk-link-end">
      <span class="pk-link-radar" /><span class="pk-link-radar r2" /><span class="pk-link-radar r3" />
      <span class="pk-link-halo" />
      <Avatar person={peer} size="lg" />
      <span class="pk-link-name">{peer?.name ?? "等待对方"}</span>
    </div>
  </div>;
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  const index = Math.max(0, options.findIndex(([v]) => v === value));
  return <div class="pk-seg" role="tablist" aria-label={label} style={{ "--n": options.length, "--i": index } as Record<string, number>}>
    <span class="pk-seg-thumb" />
    {options.map(([v, text]) => <button type="button" role="tab" key={v} aria-selected={v === value} class={v === value ? "is-on" : ""} onClick={() => onChange(v)}>{text}</button>)}
  </div>;
}

function Section({ title, icon, action, children }: { title: string; icon: ComponentChildren; action?: ComponentChildren; children: ComponentChildren }) {
  return <section class="pk-side-section">
    <header>{icon}<span>{title}</span>{action}</header>
    {children}
  </section>;
}

function App() {
  const [state, setState] = useState<PeerState | null>(null);
  const [mode, setMode] = useState<ConnectMode>("direct");
  const [address, setAddress] = useState("");
  const [useSelfPin, setUseSelfPin] = useState(false);
  const [selfPin, setSelfPin] = useState("");
  const [peerToken, setPeerToken] = useState("");
  const [peerPin, setPeerPin] = useState("");
  const [peerPreview, setPeerPreview] = useState<TokenPreview | null>(null);
  const [notice, setNotice] = useState("");
  const [dismissedError, setDismissedError] = useState("");
  const [working, setWorking] = useState("");
  const [tab, setTab] = useState<"current" | "history">("current");
  const [dragging, setDragging] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(Date.now());
  const refresh = async () => setState(await rpc<PeerState>("state"));

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await rpc<PeerState>("state"); if (alive) setState(next); }
      catch (e) { if (alive) setNotice((e as Error).message); }
      if (alive) timer = setTimeout(poll, 500);
    };
    void pocket.ready.then(async () => {
      const next = await rpc<PeerState>("start");
      if (alive) { setState(next); if (next.error) setNotice(next.error); void poll(); }
    }).catch((e: Error) => { if (alive) setNotice(e.message); });
    const off = pocket.on("peer:error", (error: string) => setNotice(error));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Native MyGo file-drop delivers original paths to the host. Do not read
    // File.arrayBuffer() or preventDefault here: that would bypass native drops.
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = () => setDragging(false);
    document.addEventListener("dragenter", enter); document.addEventListener("dragleave", leave); document.addEventListener("drop", drop);
    return () => { alive = false; clearTimeout(timer); clearInterval(tick); off(); document.removeEventListener("dragenter", enter); document.removeEventListener("dragleave", leave); document.removeEventListener("drop", drop); };
  }, []);

  useEffect(() => {
    if (state?.state === "request") void pocket.call("notify", "口袋直传 · 连接请求", `${state.peer?.name} 请求与您建立连接`).catch(() => undefined);
  }, [state?.state]);

  useEffect(() => {
    if (mode !== "punch" || !state) return;
    const activePin = useSelfPin ? selfPin.trim() : "";
    const timer = setTimeout(() => {
      void rpc<PeerState>("punchPrepare", activePin, "", false)
        .then(next => setState(next))
        .catch((e: Error) => setNotice(e.message));
    }, state.punch ? 220 : 0);
    return () => clearTimeout(timer);
  }, [mode, useSelfPin, selfPin]);

  useEffect(() => {
    const raw = peerToken.trim();
    if (!raw.startsWith("PK2")) {
      setPeerPreview(null);
      return;
    }
    let alive = true;
    void rpc<TokenPreview>("punchInspect", raw, peerPin.trim())
      .then(res => { if (alive) setPeerPreview(res); })
      .catch(() => {
        if (alive) setPeerPreview(prev => (prev?.encrypted ? { encrypted: true, hasIPv6: false, hasIPv4: false } : null));
      });
    return () => { alive = false; };
  }, [peerToken, peerPin]);

  const act = async (name: string, ...args: unknown[]) => {
    setWorking(name); setNotice("");
    try {
      const result = await rpc<PeerState | null>(name, ...args);
      if ((name === "start" || name === "punchPrepare") && result) {
        setState(result);
        if (result.error) setNotice(result.error);
      } else {
        await refresh();
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("提取码")) setPeerPreview(prev => ({ encrypted: true, hasIPv6: prev?.hasIPv6 ?? false, hasIPv4: prev?.hasIPv4 ?? false }));
      setNotice(msg);
    } finally {
      setWorking("");
      setConfirmCancel(false);
    }
  };

  const clearHistory = async () => {
    setConfirmClear(false);
    setWorking("clearHistory");
    try {
      const n = await rpc<number>("clearHistory");
      await refresh();
      void pocket.ui.toast(n ? `已清除 ${n} 条传输记录` : "没有可清除的记录").catch(() => undefined);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setWorking("");
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await pocket.ui.copy(text, label);
      setCopied(text);
      setTimeout(() => setCopied(""), 1800);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  if (!state) {
    return <main class="pk-app">
      <div class="pk-loading"><span class="pk-loading-orb"><Send size={22} /></span><span>正在准备传输空间…</span>
        {notice && <><small>{notice}</small><button class="pk-btn" onClick={() => void act("start")}>重试</button></>}
      </div>
    </main>;
  }

  const busy = state.busy;
  const current = state.records.filter(active);
  const history = state.records.filter(r => !active(r));
  const phase = phaseOf(state.state);
  const connected = phase === "connected";
  const remaining = state.expires ? Math.max(0, Math.ceil((state.expires - now) / 1000)) : 0;
  const error = notice || (state.error !== dismissedError ? state.error : "");
  const punch = state.punch;
  const peerNeedsPin = !!peerPreview?.encrypted;
  const sending = current.some(r => r.direction === "send" && r.status === "transferring");
  const receiving = current.some(r => r.direction === "receive" && r.status === "transferring");
  const flow = sending && receiving ? "both" : sending ? "send" : receiving ? "recv" : "";
  const status = mode === "punch" && state.state === "offline"
    ? (punch?.ready ? "打洞通道就绪" : punch?.preparing ? "正在准备打洞" : "等待打洞准备")
    : statusText[state.state];
  const oneSideSymmetric = !!peerPreview?.targets?.length &&
    !(punch?.hasIPv6 && peerPreview.hasIPv6) &&
    (peerPreview.natType === "symmetric" || punch?.natType === "symmetric");
  const list = tab === "current" ? current : history;

  return <main class={`pk-app is-${phase}${dragging ? " is-dragging" : ""}`}>
    <aside class="pk-side">
      <div class="pk-brand"><span class="pk-brand-icon"><Send size={17} /></span><div><h1>口袋直传</h1><p>点对点 · 不经中转</p></div></div>

      <div class="pk-me">
        <Avatar person={state.self} size="lg" />
        <div><small>这台电脑</small><strong>{state.self.name}</strong><span>每次打开都是新身份</span></div>
      </div>

      {mode === "direct" ? (
        <Section title="我的 IPv6 地址" icon={<Wifi size={13} />} action={<button class="pk-icon-btn" title="重新检测 IPv6" disabled={!!working || busy} onClick={() => void act("start")}><RefreshCw size={13} class={working === "start" ? "pk-spin" : ""} /></button>}>
          {state.addresses.length
            ? <div class="pk-ip-list">{state.addresses.map(ip => <button class="pk-ip" key={ip} title="复制 IPv6 地址" onClick={() => void copy(ip, "已复制 IPv6 地址")}><code>{ip}</code>{copied === ip ? <Check size={13} /> : <Copy size={13} />}</button>)}</div>
            : <p class="pk-dim">尚未检测到公网 IPv6</p>}
          <p class="pk-hint">直连端口 TCP {state.port}，双方都需要公网 IPv6</p>
        </Section>
      ) : (
        <Section title="穿透路径" icon={<Wifi size={13} />} action={<button class="pk-icon-btn" title="重新检测穿透路径（会更新口令）" disabled={!!working || busy} onClick={() => void act("punchPrepare", useSelfPin ? selfPin.trim() : "", "", true)}><RefreshCw size={13} class={punch?.preparing ? "pk-spin" : ""} /></button>}>
          <div class="pk-badges">
            {punch?.preparing && <span class="pk-badge"><LoaderCircle class="pk-spin" size={10} />探测中</span>}
            {punch?.hasIPv6 && <span class="pk-badge ok">IPv6 直出</span>}
            {punch?.natType && <span class={`pk-badge ${punch.natType === "symmetric" ? "warn" : ""}`}>{natLabel[punch.natType]}</span>}
            {punch?.v6Port ? <span class="pk-badge">UDP6 {punch.v6Port}</span> : null}
            {punch?.v4Port ? <span class="pk-badge">UDP4 {punch.v4Port}</span> : null}
          </div>
          {punch?.candidates?.length
            ? <div class="pk-cands">{punch.candidates.map(c => <code key={c}>{c}</code>)}</div>
            : <p class="pk-dim">{punch?.preparing ? "正在收集本地与公网地址…" : (punch?.error || "等待生成穿透路径…")}</p>}
          {punch?.stunError && <p class="pk-hint warn">{punch.stunError}</p>}
        </Section>
      )}

      <Section title="接收文件夹" icon={<FolderOpen size={13} />} action={<button class="pk-link-btn" disabled={busy || !!working} onClick={() => void act("folder")}>更改</button>}>
        <p class="pk-folder" title={state.folder}>{state.folder}</p>
      </Section>

      <div class="pk-side-foot"><ShieldCheck size={13} /><span>TLS 1.3 加密 · SHA-256 校验<br />文件只在两台电脑之间传输</span></div>
    </aside>

    <section class="pk-main">
      <header class="pk-topbar">
        <span class={`pk-status is-${phase}`}><i />{status}</span>
        {connected && state.sessionMode && <span class="pk-chip">{state.sessionMode === "punch" ? "打洞通道" : "IPv6 直连"}</span>}
      </header>

      {error && <div class="pk-notice" role="alert"><FileWarning size={15} /><span>{error}</span><button aria-label="关闭提示" onClick={() => { setNotice(""); setDismissedError(state.error ?? ""); }}><X size={14} /></button></div>}

      <div class={`pk-stage is-${phase}`} key={phase}>
        {phase === "idle" ? <div class="pk-connect">
          <div class="pk-connect-head">
            <div><h2>连接另一台电脑</h2><p>{mode === "direct" ? "把你的 IPv6 地址发给对方，或输入对方的地址发起连接。" : "双方互换口令，并在 60 秒内各自开始连接。"}</p></div>
            <Segmented label="连接模式" value={mode} options={[["direct", "IPv6 直连"], ["punch", "打洞穿透"]]} onChange={v => { setMode(v); setNotice(""); }} />
          </div>

          {mode === "direct" ? <>
            <form class="pk-row" onSubmit={e => { e.preventDefault(); void act("connect", address); }}>
              <label class="pk-input"><Link2 size={15} /><input aria-label="对方 IPv6 地址" placeholder="对方的 IPv6 地址，例如 2408:8207::1" value={address} onInput={e => setAddress(e.currentTarget.value)} spellcheck={false} /></label>
              <button class="pk-btn primary" disabled={!!working || !address.trim() || !state.directReady}>发起连接<ArrowUpRight size={15} /></button>
            </form>
            {!state.directReady
              ? <p class="pk-hint warn">未检测到可用的公网 IPv6。路由器限制入站时，可以切换到“打洞穿透”。</p>
              : <p class="pk-hint">对方同意后，双方核对一个两位数字即可建立连接。</p>}
          </> : <>
            <div class="pk-step">
              <div class="pk-step-head"><span class="pk-step-no">1</span><span>把我的口令发给对方{punch?.encrypted ? "（已加密）" : ""}</span>
                <label class="pk-check"><input type="checkbox" checked={useSelfPin} onChange={e => { const on = e.currentTarget.checked; setUseSelfPin(on); if (!on) setSelfPin(""); }} />提取码加密</label>
              </div>
              {useSelfPin && <label class="pk-input"><KeyRound size={14} /><input aria-label="设置提取码" placeholder="4–16 位提取码，另行告诉对方" value={selfPin} maxLength={16} onInput={e => setSelfPin(e.currentTarget.value)} spellcheck={false} /></label>}
              {punch?.ready && punch.token
                ? <button type="button" class={`pk-token${copied === punch.token ? " is-copied" : ""}`} title="复制我的打洞口令" onClick={() => void copy(punch.token!, "已复制我的打洞口令")}><code>{punch.token}</code><span>{copied === punch.token ? <><Check size={13} />已复制</> : <><Copy size={13} />复制</>}</span></button>
                : <div class="pk-token is-empty"><LoaderCircle size={13} class={punch?.preparing ? "pk-spin" : ""} />{punch?.preparing ? "正在探测穿透路径并生成口令…" : (punch?.error || "等待生成口令")}</div>}
            </div>
            <form class="pk-step" onSubmit={e => { e.preventDefault(); void act("punchConnect", peerToken, peerPin); }}>
              <div class="pk-step-head"><span class="pk-step-no">2</span><span>填入对方的口令</span></div>
              <div class="pk-row">
                <label class="pk-input"><Link2 size={15} /><input aria-label="对方打洞口令" placeholder="粘贴对方的口令（PK2…）" value={peerToken} onInput={e => setPeerToken(e.currentTarget.value)} spellcheck={false} /></label>
                <button class="pk-btn primary" disabled={!!working || !punch?.ready || !peerToken.trim() || (peerNeedsPin && !peerPin.trim())}>开始连接<Zap size={14} /></button>
              </div>
              {peerNeedsPin && <label class="pk-input"><KeyRound size={14} /><input aria-label="对方提取码" placeholder="输入对方设置的提取码" value={peerPin} maxLength={16} onInput={e => setPeerPin(e.currentTarget.value)} spellcheck={false} /></label>}
              {peerPreview?.targets?.length ? <p class="pk-hint mono">对方候选：{peerPreview.targets.join(" · ")}{peerPreview.natType ? ` · ${natLabel[peerPreview.natType]}` : ""}</p> : null}
              {oneSideSymmetric && <p class="pk-hint warn">存在对称型 NAT 且没有共同的 IPv6，IPv4 打洞可能失败。</p>}
            </form>
            <p class="pk-hint">刷新穿透路径会换新口令，需要重新发给对方。</p>
          </>}
        </div> : <>
          <Link self={state.self} peer={state.peer} phase={phase} flow={connected && busy ? flow : ""} />

          {state.state === "request" ? <div class="pk-panel" role="dialog" aria-label="连接请求">
            <h2>{state.peer?.name} 想和你建立连接</h2>
            <p class="pk-mono-line">{state.address}</p>
            <p>同意后，请核对对方屏幕上的两位数字。</p>
            <div class="pk-actions"><button class="pk-btn" disabled={!!working} onClick={() => void act("reject")}>拒绝</button><button class="pk-btn primary" disabled={!!working} onClick={() => void act("accept")}><Check size={15} />同意连接</button></div>
          </div> : state.state === "verify" ? <div class="pk-panel" role="dialog" aria-label="数字验证">
            <h2>{state.code ? "把这个数字告诉对方" : "对方屏幕上是哪个数字？"}</h2>
            <p>{state.code ? `通过电话或当面告诉 ${state.peer?.name}，等对方选择。` : `向 ${state.peer?.name} 确认，选错会立即断开。`}</p>
            {state.code
              ? <div class="pk-code" aria-label="连接确认数字">{state.code.split("").map((d, i) => <span key={i} style={{ "--d": i } as Record<string, number>}>{d}</span>)}</div>
              : <div class="pk-choices">{state.choices?.map((n, i) => <button class="pk-choice" key={n} style={{ "--d": i } as Record<string, number>} disabled={!!working} onClick={() => void act("confirm", n)}>{n}</button>)}</div>}
            <div class="pk-timer"><span class="pk-timer-bar"><i style={{ width: `${Math.min(100, remaining / 120 * 100)}%` }} /></span><span>{remaining} 秒后失效</span><button class="pk-link-btn" onClick={() => void act("disconnect")}>取消</button></div>
          </div> : connected ? <div class="pk-panel pk-connected" data-testid="connected">
            <h2>已与 {state.peer?.name} 安全连接</h2>
            <p>把文件拖进窗口，或点“选择文件”。对方也可以同时给你发文件。</p>
            <div class="pk-actions">
              <button class="pk-btn primary" disabled={!!working || current.some(r => r.direction === "send")} onClick={() => void act("pick")}><Upload size={15} />选择文件</button>
              <button class="pk-btn" disabled={busy || !!working} onClick={() => void act("disconnect")}><Unplug size={14} />断开</button>
            </div>
            {busy && <p class="pk-hint center"><LockKeyhole size={11} />传输中已拦截退出，请保持双方软件运行</p>}
          </div> : state.state === "punching" ? <div class="pk-panel">
            <h2>正在打洞穿透…</h2>
            <p class="pk-mono-line">{punch?.peerTargets?.join(" · ") || state.address}</p>
            <div class="pk-diag">
              <span><b>{punch?.sentProbes ?? 0}</b>已发探测</span>
              <span><b>{punch?.recvPings ?? 0}</b>收到探测</span>
              <span><b>{punch?.recvPongs ?? 0}</b>回包</span>
            </div>
            {punch?.lastRemote && <p class="pk-hint mono">最近来源 {punch.lastRemote}</p>}
            {punch?.dialError && <p class="pk-hint warn">QUIC 握手重试中：{punch.dialError}</p>}
            <div class="pk-timer"><span>请确认双方都已开始连接 · {remaining} 秒后超时</span><button class="pk-link-btn" onClick={() => void act("disconnect")}>取消</button></div>
          </div> : <div class="pk-panel">
            <h2>{statusText[state.state]}<span class="pk-dots"><i /><i /><i /></span></h2>
            <p class="pk-mono-line">{state.peer?.name ?? state.address}</p>
            <p>对方同意后会进入数字确认。</p>
            <div class="pk-timer"><button class="pk-link-btn" onClick={() => void act("disconnect")}>取消请求</button></div>
          </div>}
        </>}
      </div>

      <section class="pk-transfers">
        <header>
          <div class="pk-tabs">
            <button class={tab === "current" ? "is-on" : ""} onClick={() => { setTab("current"); setConfirmClear(false); }}><Send size={13} />传输中<span>{current.length}</span></button>
            <button class={tab === "history" ? "is-on" : ""} onClick={() => setTab("history")}><History size={13} />传输记录<span>{history.length}</span></button>
          </div>
          {tab === "current" && busy && <button class="pk-link-btn danger" onClick={() => setConfirmCancel(!confirmCancel)}>取消传输</button>}
          {tab === "history" && history.length > 0 && <button class="pk-link-btn danger" disabled={!!working} onClick={() => setConfirmClear(!confirmClear)}><Trash2 size={12} />清除记录</button>}
        </header>
        {confirmCancel && <div class="pk-confirm">取消会断开连接，未完成的文件需要重新发送。<span /><button class="pk-btn sm" onClick={() => setConfirmCancel(false)}>继续传输</button><button class="pk-btn sm danger" onClick={() => void act("cancel")}>确认取消</button></div>}
        {confirmClear && tab === "history" && <div class="pk-confirm">清除全部 {history.length} 条记录？已接收的文件不会被删除。<span /><button class="pk-btn sm" onClick={() => setConfirmClear(false)}>保留</button><button class="pk-btn sm danger" onClick={() => void clearHistory()}>清除</button></div>}
        <div class="pk-records">
          {list.map(r => <TransferRow key={r.id} record={r} reveal={() => void act("reveal", r.id)} remove={() => void act("removeRecord", r.id)} />)}
          {list.length === 0 && <div class="pk-empty"><File size={22} /><div>{tab === "current" ? "没有正在传输的文件" : "还没有传输记录"}<small>{tab === "current" ? (connected ? "把文件拖到窗口里就能开始" : "建立连接后即可互相发送文件") : "完成、失败和中断的传输都会留在这里"}</small></div></div>}
        </div>
      </section>
    </section>

    {dragging && <div class={`pk-drop${connected ? "" : " is-blocked"}`}><span class="pk-drop-icon"><Upload size={30} /></span><h2>{connected ? "松手，开始发送" : "请先建立连接"}</h2><p>{connected ? `文件将直接送到 ${state.peer?.name} 的接收文件夹` : "完成数字确认后即可拖拽发送"}</p></div>}
  </main>;
}

function TransferRow({ record: r, reveal, remove }: { record: Transfer; reveal: () => void; remove: () => void }) {
  const pct = progress(r), running = active(r), success = r.status === "completed";
  const labels = { queued: "排队中", transferring: r.direction === "send" ? "发送中" : "接收中", verifying: "校验中", completed: "已完成", failed: "失败", interrupted: "已中断" };
  const when = new Date(r.finished ?? r.started).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return <article class={`pk-record is-${r.status}`}>
    <span class={`pk-file-icon ${r.direction}`}>{success ? <CheckCheck size={18} /> : r.direction === "send" ? <ArrowUpRight size={18} /> : <ArrowDownLeft size={18} />}</span>
    <div class="pk-record-main">
      <div class="pk-record-title"><strong title={r.name}>{r.name}</strong><span class={`pk-tag is-${r.status}`}>{running && r.status === "transferring" ? `${pct.toFixed(0)}%` : labels[r.status]}</span></div>
      {running && <div class={`pk-progress${r.status === "verifying" ? " is-verifying" : ""}`} role="progressbar" aria-label={`${r.name} 传输进度`} aria-valuenow={Math.floor(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>}
      <div class="pk-record-meta">
        <span>{r.direction === "send" ? "发给" : "来自"} {r.peer}</span><span>·</span>
        <span>{running ? `${bytes(r.done)} / ` : ""}{bytes(r.size)}</span>
        <span class="pk-record-tail">{running ? (r.status === "transferring" ? `${bytes(r.speed)}/s` : labels[r.status]) : when}</span>
      </div>
      {r.error && <div class="pk-record-error">{r.error}</div>}
    </div>
    {!running && <div class="pk-record-actions">
      {success && r.path && <button class="pk-icon-btn" title="在文件夹中显示" onClick={reveal}><FolderOpen size={15} /></button>}
      <button class="pk-icon-btn" title="删除这条记录（不删除文件）" onClick={remove}><Trash2 size={14} /></button>
    </div>}
  </article>;
}

render(<App />, document.getElementById("app")!);
