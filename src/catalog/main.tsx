import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ExternalLink, Keyboard, Pencil, PictureInPicture2, Search } from "lucide-preact";
import { Catalog, Launcher, Settings, events, type CatalogItem } from "../mygo";
import "../shared/tokens.css";
import "../shared/motion.css";
import "../shared/controls.css";
import "../settings/settings.css";
import "./catalog.css";
import { Icon } from "../shared/icons";
import { hotkeyInputOptions, normalizeHotkeyInputMode, supportsHotkeyInput, type HotkeyInputMode } from "../shared/hotkey";
import { applyAppearance, applyUserStyles, formatAccelerator } from "../shared/theme";
import { Hotkey } from "../settings/ui";
import { Toggle } from "../features/ui";
import { ExtensionsPanel } from "./extensions";
import { installTooltips } from "../shared/tooltip";
import { installZoom } from "../shared/zoom";

installTooltips();
installZoom();

const MANAGE = "扩展管理";

const categoryIcons: Record<string, string> = {
  效率工具: "svg:sparkles", 开发工具: "svg:code", 内置模块: "svg:app", 扩展: "svg:puzzle", 脚本命令: "svg:terminal",
  系统指令: "svg:power", 网页搜索: "svg:globe", 文本片段: "svg:snippet", Pocket: "svg:pocket",
};
const categoryDesc: Record<string, string> = {
  效率工具: "翻译、截图识别文字、摸鱼阅读",
  开发工具: "写代码时常用的小工具。输入关键词回车打开，关键词加内容回车直接复制结果",
  内置模块: "通过前缀或全局搜索使用",
  扩展: "单独安装的功能包，可以在“扩展管理”里停用和卸载",
  脚本命令: "commands 目录里的脚本，保存后马上生效",
  系统指令: "锁屏、睡眠、系统设置页……",
  网页搜索: "关键词加空格加内容，打开对应的搜索",
  文本片段: "回车粘贴到当前窗口",
  Pocket: "软件本身的命令",
};

/** 道具库：分类展示所有功能、插件和脚本，可以直接打开、分离、绑快捷键、停用。 */
function App() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [platform, setPlatform] = useState("darwin");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = () => void Catalog.items().then(setItems);
  useEffect(() => {
    void (async () => {
      const [i, v, assets] = await Promise.all([Settings.info(), Settings.get(), Launcher.assets()]);
      setPlatform(i.platform);
      applyAppearance(v, i);
      applyUserStyles(assets);
    })();
    refresh();
    const offs = [
      events.resultsChanged.on(refresh),
      events.configChanged.on((v) => {
        refresh();
        void Settings.info().then((i) => applyAppearance(v, i));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const flash = (text: string, error = false) => {
    setMessage({ text, error });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), error ? 5000 : 1800);
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    return Array.from(counts.entries());
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== "全部" && it.category !== category) return false;
      if (!q) return true;
      return [it.title, it.subtitle ?? "", it.prefix ?? "", ...(it.keywords ?? [])].some((s) => s.toLowerCase().includes(q));
    });
  }, [items, category, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const it of visible) {
      if (!map.has(it.category)) map.set(it.category, []);
      map.get(it.category)!.push(it);
    }
    return Array.from(map.entries());
  }, [visible]);

  useLayoutEffect(() => {
    const btn = nav.current?.querySelector<HTMLElement>(".st-nav.is-active");
    if (btn && cursor.current) {
      cursor.current.style.transform = `translateY(${btn.offsetTop}px)`;
      cursor.current.style.height = `${btn.offsetHeight}px`;
    }
  }, [category, categories.length]);

  const act = (p: Promise<unknown>, ok?: string) =>
    p.then(
      () => ok && flash(ok),
      (e: Error) => flash(e.message, true),
    );

  let index = 0;
  return (
    <div class="st-window">
      <aside class="st-sidebar">
        <div class="st-titlebar" style={{ "--app-region": "drag" } as Record<string, string>} />
        <nav ref={nav} class="ct-nav">
          <div class="ct-nav-cursor" ref={cursor} />
          {[["全部", items.length] as [string, number], ...categories].map(([name, count]) => (
            <button key={name} class={`st-nav${category === name ? " is-active" : ""}`} onClick={() => setCategory(name)}>
              <Icon icon={name === "全部" ? "svg:layout-grid" : categoryIcons[name]} size={22} />
              <span>{name}</span>
              <em>{count}</em>
            </button>
          ))}
          <button class={`st-nav${category === MANAGE ? " is-active" : ""}`} onClick={() => setCategory(MANAGE)}>
            <Icon icon="svg:download" size={22} />
            <span>{MANAGE}</span>
          </button>
        </nav>
        <div class={`st-status${message?.error ? " is-error" : ""}`}>{message?.text}</div>
      </aside>
      <main class="st-main">
        <div class="st-main-titlebar ct-titlebar" style={{ "--app-region": "drag" } as Record<string, string>}>
          <h1>道具库</h1>
          <label class="ct-search" style={{ "--app-region": "no-drag" } as Record<string, string>}>
            <Search size={15} />
            <input placeholder="搜索功能、关键词、前缀…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} spellcheck={false} autoFocus />
          </label>
        </div>
        <div class="st-content" key={category}>
          {category === MANAGE && <ExtensionsPanel flash={flash} />}
          {category !== MANAGE && grouped.length === 0 && <div class="st-empty">没有找到匹配的功能</div>}
          {category !== MANAGE && grouped.map(([cat, list]) => (
            <section class="ct-section" key={cat}>
              <div class="st-section-head">
                <div>
                  <h2>{cat}</h2>
                  <p>{categoryDesc[cat]}</p>
                </div>
              </div>
              <div class="ct-grid">
                {list.map((it) => (
                  <article
                    key={it.id}
                    class={`ct-card${it.enabled ? "" : " is-off"}`}
                    style={{ animationDelay: `${Math.min(index++, 24) * 18}ms` }}
                    onDblClick={(e) => {
                      if (!it.enabled) return;
                      if ((e.target as HTMLElement | null)?.closest("button, input, select, textarea, label, a, .ct-actions, .ct-hotkey")) return;
                      void act(Catalog.open(it.id));
                    }}
                  >
                    <div class="ct-card-head">
                      <Icon icon={it.icon} size={34} />
                      <div class="ct-card-title">
                        <b>{it.title}</b>
                        {it.subtitle && <span>{it.subtitle}</span>}
                      </div>
                      <Toggle checked={it.enabled} label={`${it.enabled ? "停用" : "启用"}${it.title}`} onChange={(v) => void act(Catalog.setEnabled(it.id, v), v ? "已启用" : "已停用")} />
                    </div>
                    <div class="ct-tags">
                      {it.prefix && <span class="ct-tag is-prefix">前缀 {it.prefix}</span>}
                      {(it.keywords ?? []).slice(0, 6).map((k) => (
                        <span class="ct-tag" key={k}>{k}</span>
                      ))}
                      {it.hotkey && (
                        <span class="ct-tag is-hotkey">
                          {formatAccelerator(it.hotkey, platform).map((k) => <kbd key={k}>{k}</kbd>)}
                        </span>
                      )}
                    </div>
                    <div class="ct-actions">
                      <button class="ui-btn is-small q-press" disabled={!it.enabled} onClick={() => void act(Catalog.open(it.id))}>
                        <ExternalLink size={13} /> 打开
                      </button>
                      {it.canDetach && (
                        <button class="ui-btn is-small q-press" disabled={!it.enabled} onClick={() => void act(Catalog.detach(it.id))}>
                          <PictureInPicture2 size={13} /> 独立窗口
                        </button>
                      )}
                      {it.canHotkey && (
                        <button class={`ui-btn is-small q-press${editing === it.id ? " is-on" : ""}`} onClick={() => setEditing(editing === it.id ? null : it.id)}>
                          <Keyboard size={13} /> 快捷键
                        </button>
                      )}
                      {it.path && (
                        <button class="ui-btn is-small is-icon q-press" title="编辑源文件" onClick={() => void act(Catalog.edit(it.path!))}>
                          <Pencil size={13} />
                        </button>
                      )}
                    </div>
                    {editing === it.id && (
                      <HotkeyEditor item={it} platform={platform} onDone={(msg, err) => { flash(msg, err); refresh(); }} />
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function HotkeyEditor({ item, platform, onDone }: { item: CatalogItem; platform: string; onDone: (msg: string, error?: boolean) => void }) {
  const [detach, setDetach] = useState(false);
  const [inputMode, setInputMode] = useState<HotkeyInputMode>("selection");
  useEffect(() => {
    void Settings.get().then((v) => {
      setDetach(!!v.config.detachOnHotkey?.[item.id]);
      setInputMode(normalizeHotkeyInputMode(v.config.hotkeyInput?.[item.id]));
    });
  }, [item.id]);
  const save = (accel: string, d: boolean, m: string, okText: string) =>
    void Catalog.setHotkey(item.id, accel, d, m).then(
      (err) => onDone(err ? `快捷键被占用：${err}` : okText, !!err),
      (e: Error) => onDone(e.message, true),
    );
  return (
    <div class="ct-hotkey">
      <Hotkey
        value={item.hotkey ?? ""}
        platform={platform}
        clearable
        onChange={(v) => save(v, detach, inputMode, v ? "已设置快捷键" : "已清除快捷键")}
        placeholder="点击后按下快捷键"
      />
      {item.canDetach && (
        <label class="ct-inline">
          以独立窗口打开 <Toggle checked={detach} onChange={(v) => { setDetach(v); save(item.hotkey ?? "", v, inputMode, "已保存"); }} />
        </label>
      )}
      {supportsHotkeyInput(item.id) && (
        <label class="ct-inline">
          带入
          <select
            class="ui-select"
            aria-label="按快捷键时带入的内容"
            value={inputMode}
            onChange={(e) => {
              const m = normalizeHotkeyInputMode((e.target as HTMLSelectElement).value);
              setInputMode(m);
              save(item.hotkey ?? "", detach, m, "已保存");
            }}
          >
            {hotkeyInputOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
