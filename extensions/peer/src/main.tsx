import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArrowDownLeft, ArrowUpRight, Check, CheckCheck, ChevronRight, Copy, File, FolderOpen, History, Link2, LoaderCircle, LockKeyhole, Radio, RefreshCw, Send, ShieldCheck, Unplug, Upload, Wifi, X } from "lucide-preact";
import { pocket } from "../../sdk/pocket";
import { active, avatars, bytes, progress, type Identity, type PeerState, type Transfer } from "./types";
import "../../../src/shared/tokens.css";
import "../../../src/shared/motion.css";
import "../../../src/shared/controls.css";
import "./peer.css";

const rpc = <T,>(method: string, ...args: unknown[]) => pocket.call(`peer.${method}`, ...args) as Promise<T>;
const statusText: Record<PeerState["state"], string> = { offline: "等待 IPv6 网络", idle: "可以接收连接", connecting: "正在连接", waiting: "等待对方同意", request: "收到连接请求", verify: "核对连接数字", connected: "已建立安全连接" };
function Avatar({ person, small = false }: { person: Identity; small?: boolean }) {
  return <span class={`peer-avatar tone-${person.avatar}${small ? " small" : ""}`} aria-label={`${person.name} 的头像`}>{avatars[person.avatar] ?? "🦦"}</span>;
}
function App() {
  const [state, setState] = useState<PeerState | null>(null);
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState("");
  const [dismissedError, setDismissedError] = useState("");
  const [working, setWorking] = useState("");
  const [tab, setTab] = useState<"current" | "history">("current");
  const [dragging, setDragging] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
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
  const act = async (name: string, ...args: unknown[]) => {
    setWorking(name); setNotice("");
    try {
      const result = await rpc<PeerState | null>(name, ...args);
      if (name === "start" && result) { setState(result); if (result.error) setNotice(result.error); }
      else await refresh();
    } catch (e) { setNotice((e as Error).message); }
    finally { setWorking(""); setConfirmCancel(false); }
  };
  const copy = async (text: string) => { try { await pocket.ui.copy(text, "已复制 IPv6 地址"); setCopied(text); setTimeout(() => setCopied(""), 1800); } catch (e) { setNotice((e as Error).message); } };
  const busy = state?.busy ?? false;
  const current = state?.records.filter(active) ?? [];
  const history = state?.records.filter(r => !active(r)) ?? [];
  const connected = state?.state === "connected";
  const remaining = state?.expires ? Math.max(0, Math.ceil((state.expires - now) / 1000)) : 0;
  const error = notice || (state?.error !== dismissedError ? state?.error : "");
  return <main class={`peer-app${dragging ? " is-dragging" : ""}`}>
    <header class="peer-heading">
      <div class="peer-brand"><span class="peer-brand-icon"><Send size={21} /></span><div><h1>口袋直传</h1><p>文件直达，距离不设限</p></div></div>
      <span class={`peer-status ${connected ? "connected" : ""}`}><i />{state ? statusText[state.state] : "正在准备"}</span>
    </header>
    {error && <div class="peer-notice" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => { setNotice(""); setDismissedError(state?.error ?? ""); }}><X size={14} /></button></div>}
    {!state ? <div class="peer-loading"><LoaderCircle class="spin" />正在准备你的传输空间…{notice && <button class="peer-button" onClick={() => void act("start")}>重试</button>}</div> : <>
      <section class="peer-identity-card">
        <div class="peer-me"><Avatar person={state.self} /><div><span class="peer-eyebrow">这台电脑</span><h2>{state.self.name}</h2><span class="peer-muted">每次打开，都是一个新身份</span></div></div>
        <div class="peer-network"><div class="peer-network-label"><Wifi size={14} /><span>我的 IPv6 地址</span><button title="重新检测 IPv6" disabled={!!working || busy} onClick={() => void act("start")}><RefreshCw size={13} /></button></div>
          {state.addresses.length ? state.addresses.map(ip => <button class="peer-ip" key={ip} title="复制 IPv6 地址" onClick={() => void copy(ip)}><code>{ip}</code>{copied === ip ? <Check size={14} /> : <Copy size={14} />}</button>) : <span class="peer-muted">尚未检测到公网 IPv6</span>}
          <span class="peer-network-note">双方都需要公网 IPv6 · 直连端口 {state.port}</span>
        </div>
      </section>
      <section class={`peer-connect-card ${connected ? "is-connected" : ""}`}>
        {state.state === "idle" || state.state === "offline" ? <div class="peer-connect-idle">
          <div class="peer-orbit"><Radio size={30} /><i /><i /></div>
          <div class="peer-connect-copy"><h2>把文件送到另一台电脑</h2><p>将你的地址发给对方，或输入对方地址发起连接。</p>
            <form onSubmit={e => { e.preventDefault(); void act("connect", address); }}><label class="peer-address-input"><Link2 size={16} /><input aria-label="对方 IPv6 地址" placeholder="输入对方的 IPv6 地址" value={address} onInput={e => setAddress(e.currentTarget.value)} spellcheck={false} /></label><button class="peer-button primary" disabled={!!working || !address.trim() || !state.addresses.length}><span>发起连接</span><ArrowUpRight size={16} /></button></form>
            <span class="peer-muted">连接前需要对方同意，并核对数字。</span>
          </div>
        </div> : state.state === "request" ? <div class="peer-pairing" role="dialog" aria-label="连接请求">
          <Avatar person={state.peer!} /><h2>{state.peer?.name} 请求与您建立连接</h2><p><code>{state.address}</code></p><p>同意后，请核对对方屏幕上的数字。连接成功后可互相发送文件。</p>
          <div class="peer-actions"><button class="peer-button" disabled={!!working} onClick={() => void act("reject")}>暂不连接</button><button class="peer-button primary" disabled={!!working} onClick={() => void act("accept")}>同意连接<ChevronRight size={16} /></button></div>
        </div> : state.state === "verify" ? <div class="peer-pairing" role="dialog" aria-label="数字验证">
          <span class="peer-pair-lock"><ShieldCheck size={24} /></span><h2>{state.code ? "让对方选择这个数字" : "对方屏幕上显示的是哪个数字？"}</h2><p>{state.code ? `请通过电话或当面告诉 ${state.peer?.name}，等待对方确认。` : `请与 ${state.peer?.name} 核对，只有选择正确的数字才会建立连接。`}</p>
          {state.code ? <div class="peer-number single" aria-label="连接确认数字">{state.code}</div> : <div class="peer-number-options">{state.choices?.map(n => <button class="peer-number" key={n} disabled={!!working} onClick={() => void act("confirm", n)}>{n}</button>)}</div>}
          <div class="peer-pair-foot"><span>{remaining} 秒后失效</span><button class="peer-text-button" onClick={() => void act("disconnect")}>取消连接</button></div>
        </div> : connected ? <div class="peer-connected-content">
          <div class={`peer-route ${busy ? "moving" : ""}`}><Avatar person={state.self} small /><div class="peer-route-line"><span /><span /><span /></div><span class="peer-route-lock"><LockKeyhole size={16} /></span><div class="peer-route-line"><span /><span /><span /></div><Avatar person={state.peer!} small /></div>
          <h2>已与 {state.peer?.name} 连接</h2><p>拖拽文件到这个窗口，或选择文件发送</p>
          <div class="peer-actions"><button class="peer-button primary" disabled={!!working || current.some(r => r.direction === "send")} onClick={() => void act("pick")}><Upload size={16} />选择文件</button><button class="peer-button" disabled={busy || !!working} onClick={() => void act("disconnect")}><Unplug size={15} />断开</button></div>
          {busy && <div class="peer-protected"><LockKeyhole size={12} />传输中已保护退出 · 请保持双方软件运行</div>}
        </div> : <div class="peer-pairing"><LoaderCircle class="spin peer-wait" size={30} /><h2>{statusText[state.state]}</h2><p>{state.peer?.name ?? state.address}</p><span class="peer-muted">对方同意后，会进入数字确认</span><button class="peer-text-button" onClick={() => void act("disconnect")}>取消请求</button></div>}
      </section>
      <div class="peer-folder"><span><FolderOpen size={15} /><span>接收到 <strong title={state.folder}>{state.folder}</strong></span></span><button class="peer-text-button" disabled={busy || !!working} onClick={() => void act("folder")}>更改目录</button></div>
      <section class="peer-transfers">
        <header><div class="peer-tabs"><button class={tab === "current" ? "selected" : ""} onClick={() => setTab("current")}><Send size={14} />传输任务 <span>{current.length}</span></button><button class={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}><History size={14} />传输记录 <span>{history.length}</span></button></div>
          {busy && <button class="peer-text-button danger" onClick={() => setConfirmCancel(!confirmCancel)}>取消传输</button>}</header>
        {confirmCancel && <div class="peer-cancel-confirm">取消会断开连接，未完成的文件需要重新发送。<button class="peer-button" onClick={() => setConfirmCancel(false)}>继续传输</button><button class="peer-button danger" onClick={() => void act("cancel")}>确认取消</button></div>}
        <div class="peer-record-list">{(tab === "current" ? current : history).map(r => <TransferRow key={r.id} record={r} reveal={() => void act("reveal", r.id)} />)}
          {(tab === "current" ? current : history).length === 0 && <div class="peer-empty"><File size={25} /><div>{tab === "current" ? "暂时没有正在传输的文件" : "还没有传输记录"}<small>{tab === "current" ? history.length ? "文件传输结果可在“传输记录”中查看" : "建立连接后，把文件拖到这里就能开始" : "完成、取消和中断的传输都会留在这里"}</small></div></div>}
        </div>
      </section>
      <footer class="peer-footer"><ShieldCheck size={13} />端到端直连 · TLS 加密 · SHA-256 校验<span>文件不经过中转服务器</span></footer>
      {state.state === "offline" && <p class="peer-network-help">请确认网络提供公网 IPv6，并允许双方防火墙的 TCP {state.port} 入站连接。检测到地址不代表对端一定可达。</p>}
    </>}
    {dragging && <div class="peer-drop-overlay"><Upload size={36} /><h2>{connected ? "松手，开始发送" : "请先建立连接"}</h2><p>{connected ? "文件将直接传到对方的接收文件夹" : "完成数字确认后即可拖拽传输"}</p></div>}
  </main>;
}
function TransferRow({ record: r, reveal }: { record: Transfer; reveal: () => void }) {
  const pct = progress(r), running = active(r), success = r.status === "completed";
  const labels = { queued: "排队中", transferring: r.direction === "send" ? "发送中" : "接收中", verifying: "正在校验", completed: "校验完成", failed: "传输失败", interrupted: "已中断" };
  return <article class={`peer-record ${success ? "success" : ""}`}>
    <span class="peer-file-icon">{success ? <CheckCheck size={22} /> : <File size={22} />}</span>
    <div class="peer-record-main"><div class="peer-record-title"><strong title={r.name}>{r.name}</strong><span>{running ? `${pct.toFixed(0)}%` : labels[r.status]}</span></div>
      {running && <div class={`peer-progress ${r.status === "verifying" ? "verifying" : ""}`} role="progressbar" aria-label={`${r.name} 传输进度`} aria-valuenow={Math.floor(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>}
      <div class="peer-record-meta">{r.direction === "send" ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}<span>{r.direction === "send" ? "发送给" : "接收自"} {r.peer}</span><span>·</span><span>{running ? `${bytes(r.done)} / ` : ""}{bytes(r.size)}</span><span class="peer-record-tail">{running ? r.status === "transferring" ? `${bytes(r.speed)}/s` : labels[r.status] : new Date(r.finished ?? r.started).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></div>
      {r.error && <div class="peer-record-error">{r.error}</div>}
    </div>
    {success && <button class="peer-reveal" title="在文件夹中显示" onClick={reveal}><FolderOpen size={16} /></button>}
  </article>;
}
render(<App />, document.getElementById("app")!);
