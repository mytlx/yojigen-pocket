import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Launcher, events, type AppInfo } from "../mygo";

/** 扩展页面需要宿主帮忙做的几件界面上的事。没给的就退化成最简单的做法。 */
export interface PluginHostHooks {
  toast?: (text: string, error?: boolean) => void;
  detach?: () => void;
  remember?: (value: string) => void;
}

export interface PluginFrameProps extends PluginHostHooks {
  plugin?: string;
  tool?: string;
  url?: string;
  html?: string;
  title?: string;
  input?: string;
  args?: Record<string, string>;
  detached?: boolean;
  float?: boolean;
  /** 分离窗口的快捷键（accelerator 写法），页面里按下时转给宿主。 */
  detachKey?: string;
  onClose: () => void;
  class?: string;
  style?: Record<string, string>;
}

let infoPromise: Promise<AppInfo> | null = null;
const appInfo = () => (infoPromise ??= Launcher.info());

/** 把宿主页面上的主题属性和 CSS 变量打包，扩展页面原样套上，外观就一致了。 */
function themeSnapshot() {
  const el = document.documentElement;
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (a.name.startsWith("data-")) attrs[a.name] = a.value;
  return { attrs, style: el.style.cssText };
}

function parseDetachKey(accel?: string) {
  if (!accel) return null;
  const parts = accel.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  if (key.length !== 1) return null;
  return { key, mod: parts.some((p) => ["cmdorctrl", "cmd", "ctrl", "command", "control"].includes(p)), shift: parts.includes("shift"), alt: parts.includes("alt") };
}

const escapeBridge = `<script>addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();parent.postMessage({__pocket:true,method:"back"},"*")}})</script>`;

/**
 * 扩展（和 panel 模式脚本）的页面：跑在 iframe 里，和宿主隔离。
 * 页面里的 window.pocket 通过 postMessage 找到这里：界面上的事（提示、关闭、分离）在这里办，
 * 其余的转给后端，后端按扩展声明的权限放行。
 */
export function PluginFrame(props: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const post = (msg: object) => frame.current?.contentWindow?.postMessage(msg, "*");

  // 同步注册（useLayoutEffect）：useEffect 可能排在 iframe 发出第一条消息之后，那条消息就丢了。
  useLayoutEffect(() => {
    const evals = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let evalSeq = 0;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      if (e.data.__pocketEvalReply) {
        const p = evals.get(e.data.id);
        evals.delete(e.data.id);
        if (p) e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
        return;
      }
      if (!e.data.__pocket) return;
      const { id, method, args = [] } = e.data as { id: number; method: string; args?: unknown[] };
      const p = latest.current;
      const reply = (payload: object) => (e.source as Window).postMessage({ __pocketReply: true, id, ...payload }, "*");
      switch (method) {
        case "back":
          if (!p.detached) p.onClose();
          reply({});
          return;
        case "ui.close":
          p.onClose();
          reply({});
          return;
        case "ui.toast":
          p.toast?.(String(args[0] ?? ""), !!args[1]);
          reply({});
          return;
        case "ui.copy":
          void Launcher.copyText(String(args[0] ?? "")).then(() => {
            p.toast?.(typeof args[1] === "string" ? args[1] : "已复制");
            reply({});
          });
          return;
        case "ui.detach":
          p.detach?.();
          reply({});
          return;
        case "ui.remember":
          p.remember?.(String(args[0] ?? ""));
          reply({});
          return;
        case "init":
          void appInfo().then((info) =>
            reply({
              result: {
                api: 1, plugin: p.plugin, tool: p.tool ?? "", input: p.input ?? "", args: p.args ?? {}, detached: !!p.detached, float: !!p.float,
                platform: info.platform, version: info.version, e2e: !!info.e2e, theme: themeSnapshot(), detachKey: parseDetachKey(p.detachKey),
              },
            }),
          );
          return;
      }
      if (!p.plugin) {
        reply({ error: "这个页面不能调用 pocket 接口" });
        return;
      }
      Launcher.pluginCall(p.plugin, p.tool ?? "", method, args).then(
        (result) => reply({ result }),
        (err: Error) => reply({ error: err.message }),
      );
    };
    window.addEventListener("message", onMessage);
    // 后端推来的事件只转给它所属的扩展。
    const offEvent = events.pluginEvent.on((ev) => {
      if (ev.plugin === latest.current.plugin) post({ __pocketEvent: ev.name, data: ev.data });
    });
    // 主题变了（深浅色、强调色）跟着变。
    const watch = new MutationObserver(() => post({ __pocketEvent: "theme", data: themeSnapshot() }));
    watch.observe(document.documentElement, { attributes: true });
    // 测试构建里，端到端测试通过它查看扩展页面内部。
    const hook = window as unknown as { __pluginEval?: (code: string) => Promise<unknown> };
    const evalIn = (code: string) =>
      new Promise((resolve, reject) => {
        const id = ++evalSeq;
        evals.set(id, { resolve, reject });
        post({ __pocketEval: true, id, code });
        setTimeout(() => evals.delete(id) && reject(new Error("扩展页面没有回应")), 8000);
      });
    hook.__pluginEval = evalIn;
    return () => {
      window.removeEventListener("message", onMessage);
      offEvent();
      watch.disconnect();
      if (hook.__pluginEval === evalIn) delete hook.__pluginEval;
    };
  }, []);

  // 页面开着的时候换了带入的内容（独立窗口再次被叫到）：告诉它。
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    post({ __pocketEvent: "enter", data: { input: props.input ?? "", args: props.args ?? {}, tool: props.tool ?? "" } });
  }, [props.input, JSON.stringify(props.args ?? {})]);

  useEffect(() => {
    const el = frame.current;
    const focus = () => el?.contentWindow?.focus();
    el?.addEventListener("load", focus);
    return () => el?.removeEventListener("load", focus);
  }, []);

  return (
    <iframe
      ref={frame}
      class={props.class ?? "pk-frame"}
      style={props.style}
      src={props.html ? undefined : props.url}
      srcDoc={props.html ? (props.detached ? props.html : escapeBridge + props.html) : undefined}
      sandbox={props.plugin ? "allow-scripts allow-forms allow-same-origin allow-modals allow-popups allow-downloads" : "allow-scripts allow-forms"}
      allow="clipboard-read; clipboard-write"
      title={props.title}
    />
  );
}
