import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronDown, Pin } from "lucide-preact";
import { Launcher, Windows, events, type WindowInfo } from "../mygo";
import "../shared/tokens.css";
import "../shared/motion.css";
import "../shared/controls.css";
import "../launcher/launcher.css";
import "./detached.css";
import { Icon } from "../shared/icons";
import { applyAppearance, applyUserStyles } from "../shared/theme";
import { FeatureHost, PanelView, type ActiveView } from "../launcher/views";
import type { FeatureCtx } from "../features/types";
import { featureIcons as icons, featureTitles as titles } from "../features/meta";

const params = new URLSearchParams(location.search);
const initial: ActiveView = {
  type: params.get("u") ? "panel" : "feature",
  feature: params.get("f") ?? undefined,
  input: params.get("q") ?? "",
  args: params.get("a") ? (JSON.parse(params.get("a")!) as Record<string, string>) : {},
  url: params.get("u") ?? undefined,
  plugin: params.get("p") ?? undefined,
  title: params.get("t") ?? "Yojigen Pocket",
  icon: params.get("i") ?? undefined,
  height: Number(params.get("h") ?? 0) || undefined,
  content: "",
};
const stealth = params.get("m") === "stealth";
document.title = initial.title ?? "Yojigen Pocket";

/** 独立窗口：自己的标题栏（可拖动、置顶、切换窗口），下面是功能页。 */
function App() {
  const [view, setView] = useState(initial);
  const [platform, setPlatform] = useState("darwin");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [me, setMe] = useState(0);
  const [menu, setMenu] = useState(false);
  const [top, setTop] = useState(false);
  const [version, setVersion] = useState(0); // 换了新输入时重新挂载功能页
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    void (async () => {
      const [i, c, assets] = await Promise.all([Launcher.info(), Launcher.config(), Launcher.assets()]);
      setPlatform(i.platform);
      applyAppearance(c, i);
      applyUserStyles(assets);
      document.documentElement.dataset.window = stealth ? "stealth" : "detached";
    })();
    void Windows.list().then(setWindows);
    void Windows.current().then((w) => setMe(w.id));
    void Windows.isTop().then(setTop);
    const offs = [
      events.configChanged.on((c) => void Launcher.info().then((i) => applyAppearance(c, i))),
      events.assetsChanged.on(applyUserStyles),
      events.windowsChanged.on(setWindows),
      events.featureInput.on((f) => {
        setView((v) => ({ ...v, input: f.input, args: f.args ?? v.args }));
        setVersion((n) => n + 1);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const showToast = (text: string, error = false) => {
    setToast({ text, error });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), error ? 4500 : 1600);
  };

  const ctx: FeatureCtx = {
    detached: true,
    stealth,
    platform,
    toast: showToast,
    copy: (t, label) => Launcher.copyText(t).then(() => showToast(label ?? "已复制")),
    open: (feature, input, args) => void Windows.detach({ feature, input, args, title: titles[feature] ?? feature, icon: icons[feature] }),
    close: () => void Windows.control("close", 0),
    detach: () => {},
    remember: () => {},
    openSettings: (section) => void Launcher.openSettings(section),
  };

  if (stealth) {
    return <FeatureHost view={view} ctx={ctx} fill key={version} />;
  }

  const others = windows.filter((w) => w.id !== me);
  return (
    <div class="dt-window">
      <header class="dt-titlebar" style={{ "--app-region": "drag" } as Record<string, string>}>
        <div class="dt-title">
          <Icon icon={view.icon} size={20} />
          <span>{view.title}</span>
        </div>
        <span class="dt-spacer" />
        <div class="dt-tools" style={{ "--app-region": "no-drag" } as Record<string, string>}>
          <div class="dt-switch">
            <button type="button" class={`ui-btn is-small${menu ? " is-on" : ""}`} onClick={() => setMenu(!menu)} title="切换到其他窗口">
              窗口 {windows.length > 1 ? `· ${windows.length}` : ""} <ChevronDown size={13} />
            </button>
            {menu && (
              <div class="dt-menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" onClick={() => { setMenu(false); void Launcher.openSettings(""); }}>
                  <Icon icon="svg:settings" size={18} /> 设置
                </button>
                <button type="button" onClick={() => { setMenu(false); void Windows.showPanel(); }}>
                  <Icon icon="svg:pocket" size={18} /> 主窗口（快捷键唤出）
                </button>
                {others.length > 0 && <div class="dt-menu-sep" />}
                {others.map((w) => (
                  <button type="button" key={w.id} onClick={() => { setMenu(false); void Windows.focus(w.id); }}>
                    <Icon icon={w.icon} size={18} /> {w.title}
                    {!w.visible && <em>已隐藏</em>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" class={`ui-btn is-small is-icon${top ? " is-on" : ""}`} title={top ? "取消置顶" : "置顶"} onClick={() => { void Windows.control("top", top ? 0 : 1); setTop(!top); }}>
            <Pin size={14} />
          </button>
        </div>
      </header>
      <main class="dt-body" key={version}>
        {view.type === "panel" ? <PanelView view={view} onClose={() => void Windows.control("close", 0)} fill /> : <FeatureHost view={view} ctx={ctx} fill />}
      </main>
      {toast && (
        <div class={`dt-toast${toast.error ? " is-error" : ""}`} key={toast.text}>
          {toast.text}
        </div>
      )}
    </div>
  );
}


render(<App />, document.getElementById("app")!);
