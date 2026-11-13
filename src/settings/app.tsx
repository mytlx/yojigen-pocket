import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Blocks, Globe, Info as InfoIcon, Keyboard, Languages, LayoutGrid, Palette, SlidersHorizontal, TextQuote, Volume2 } from "lucide-preact";
import { Settings, events, type AppInfo, type Config, type ConfigView } from "../mygo";
import { applyAppearance, applyUserStyles } from "../shared/theme";
import { Launcher } from "../mygo";
import { General } from "./general";
import { Appearance } from "./appearance";
import { Modules } from "./modules";
import { Commands } from "./commands";
import { WebSearch } from "./web";
import { Snippets } from "./snippets";
import { About } from "./about";
import { TranslateSettings } from "./translate";
import { SpeechSettings } from "./speech";

export interface SectionProps {
  view: ConfigView;
  info: AppInfo;
  config: Config;
  update: (fn: (c: Config) => void) => void;
  arg: string;
}

const sections = [
  { id: "general", title: "通用", icon: SlidersHorizontal, render: General },
  { id: "appearance", title: "外观", icon: Palette, render: Appearance },
  { id: "modules", title: "功能模块", icon: Blocks, render: Modules },
  { id: "commands", title: "指令与插件", icon: Keyboard, render: Commands },
  { id: "translate", title: "翻译与识别", icon: Languages, render: TranslateSettings },
  { id: "speech", title: "发音", icon: Volume2, render: SpeechSettings },
  { id: "web", title: "网页搜索", icon: Globe, render: WebSearch },
  { id: "snippets", title: "文本片段", icon: TextQuote, render: Snippets },
  { id: "about", title: "关于", icon: InfoIcon, render: About },
] as const;

export function App() {
  const params = new URLSearchParams(location.search);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [view, setView] = useState<ConfigView | null>(null);
  const [section, setSection] = useState(params.get("section") || "general");
  const [arg, setArg] = useState(params.get("arg") || "");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const statusTimer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<Config | null>(null);
  const viewRef = useRef<ConfigView | null>(null);
  viewRef.current = view;
  const infoRef = useRef<AppInfo | null>(null);
  infoRef.current = info;

  const flash = useCallback((text: string, error = false) => {
    setStatus({ text, error });
    clearTimeout(statusTimer.current);
    if (!error) statusTimer.current = setTimeout(() => setStatus(null), 1500);
  }, []);

  useEffect(() => {
    void (async () => {
      const [i, v, assets] = await Promise.all([Settings.info(), Settings.get(), Launcher.assets()]);
      setInfo(i);
      setView(v);
      applyAppearance(v, i);
      applyUserStyles(assets);
    })();
    const offs = [
      events.configChanged.on((v) => {
        // 正在编辑还没保存时，不要用外部的值盖掉界面。
        if (pending.current) return;
        setView(v);
        if (infoRef.current) applyAppearance(v, infoRef.current);
      }),
      events.assetsChanged.on(applyUserStyles),
      events.settingsNavigate.on((t) => {
        setSection(t.section);
        setArg(t.arg ?? "");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  /** 改动立刻反映在界面上，停手 300 ms 后保存。不需要保存按钮。 */
  const update = useCallback(
    (fn: (c: Config) => void) => {
      const current = pending.current ?? viewRef.current?.config;
      if (!current) return;
      const next: Config = structuredClone(current);
      fn(next);
      pending.current = next;
      setView((v) => {
        if (!v) return v;
        const merged = { ...v, config: next };
        if (infoRef.current) applyAppearance(merged, infoRef.current);
        return merged;
      });
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const toSave = pending.current;
        if (!toSave) return;
        try {
          const saved = await Settings.save(toSave);
          if (pending.current === toSave) {
            pending.current = null;
            setView(saved);
          }
          const errors = Object.values(saved.hotkeyErrors ?? {});
          flash(errors.length ? errors[0]! : "已保存", errors.length > 0);
        } catch (err) {
          pending.current = null;
          flash(err instanceof Error ? err.message : String(err), true);
        }
      }, 300);
    },
    [flash],
  );

  const nav = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const btn = nav.current?.querySelector<HTMLElement>(".st-nav.is-active");
    if (btn && cursor.current) {
      cursor.current.style.transform = `translateY(${btn.offsetTop}px)`;
      cursor.current.style.height = `${btn.offsetHeight}px`;
    }
  }, [section, info, view === null]);

  if (!info || !view) return <div class="st-loading" />;
  const active = sections.find((s) => s.id === section) ?? sections[0];
  const Body = active.render;

  return (
    <div class="st-window">
      <aside class="st-sidebar">
        <div class="st-titlebar" style={{ "--app-region": "drag" } as never} />
        <nav ref={nav} class="st-nav-list">
          <div class="st-nav-cursor" ref={cursor} />
          {sections.map((s) => (
            <button
              key={s.id}
              class={`st-nav${s.id === active.id ? " is-active" : ""}`}
              onClick={() => {
                setSection(s.id);
                setArg("");
              }}
            >
              <s.icon size={16} strokeWidth={1.9} />
              <span>{s.title}</span>
            </button>
          ))}
        </nav>
        <button class="st-catalog-btn q-press" onClick={() => void Settings.openCatalog()}>
          <LayoutGrid size={16} strokeWidth={1.9} />
          <span>
            <b>道具库</b>
            <em>分类查看全部功能、插件和脚本</em>
          </span>
        </button>
        <div class={`st-status${status?.error ? " is-error" : ""}`} key={status?.text ?? ""}>{status?.text}</div>
      </aside>
      <main class="st-main">
        <div class="st-main-titlebar" style={{ "--app-region": "drag" } as never}>
          <h1>{active.title}</h1>
        </div>
        <div class="st-content" key={active.id}>
          {view.loadError && <div class="st-banner">配置文件有误，正在使用上一份有效配置：{view.loadError}</div>}
          <Body view={view} info={info} config={view.config} update={update} arg={arg} />
        </div>
      </main>
    </div>
  );
}
