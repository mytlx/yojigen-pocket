import { useEffect, useRef, useState } from "preact/hooks";
import { Settings, events, type CommandInfo, type CommandTarget, type PluginInfo } from "../mygo";
import { Icon } from "../shared/icons";
import type { SectionProps } from "./app";
import { Button, Hotkey, Row, Section, Text, Toggle } from "./ui";

const languages = [
  { value: "bash", label: "Bash", platforms: ["darwin", "linux", "windows"] },
  { value: "python", label: "Python", platforms: ["darwin", "linux", "windows"] },
  { value: "node", label: "Node.js", platforms: ["darwin", "linux", "windows"] },
  { value: "powershell", label: "PowerShell", platforms: ["windows", "darwin"] },
];

const modeLabel: Record<string, string> = {
  silent: "静默", toast: "通知", text: "文本", detail: "Markdown", list: "列表", filter: "实时过滤", panel: "网页",
};

export function Commands({ info, config, update, arg, view }: SectionProps) {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [bound, setBound] = useState<CommandTarget[]>([]);
  const [hidden, setHidden] = useState<CommandTarget[]>([]);
  const [creating, setCreating] = useState(arg === "new");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState(info.platform === "windows" ? "powershell" : "bash");
  const [createError, setCreateError] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<CommandTarget[]>([]);
  const focusRow = useRef<HTMLDivElement>(null);

  const refresh = () => {
    void Settings.commands().then(setCommands);
    void Settings.plugins().then(setPlugins);
  };
  useEffect(() => {
    refresh();
    return events.resultsChanged.on(refresh);
  }, []);

  useEffect(() => {
    void Settings.resolveCommands(Object.keys(config.hotkeys)).then(setBound);
    void Settings.resolveCommands(config.disabled).then(setHidden);
  }, [config.hotkeys, config.disabled]);

  // 从动作面板的「设置快捷键」跳过来时，直接准备好绑定。
  useEffect(() => {
    if (!arg || arg === "new") {
      setCreating(arg === "new");
      return;
    }
    if (!(arg in config.hotkeys)) {
      void Settings.resolveCommands([arg]).then((list) => {
        setBound((old) => (old.some((b) => b.id === arg) ? old : [...old, ...list]));
        focusRow.current?.scrollIntoView({ block: "center" });
      });
    }
  }, [arg]);

  useEffect(() => {
    if (!adding) return;
    let alive = true;
    const q = search.trim();
    if (!q) {
      setFound([]);
      return;
    }
    void Settings.searchCommands(q).then((list) => {
      if (alive) setFound(list.slice(0, 6));
    });
    return () => {
      alive = false;
    };
  }, [search, adding]);

  const create = async () => {
    try {
      await Settings.createCommand(language, name);
      setCreating(false);
      setName("");
      setCreateError("");
      refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  };

  const setHotkey = (id: string, value: string) =>
    update((c) => {
      if (value) c.hotkeys[id] = value;
      else delete c.hotkeys[id];
    });

  return (
    <>
      <Section
        title="脚本命令"
        description="commands 目录里的任何脚本都是一个命令，保存后马上能搜到。头部写几行 @pocket. 注释就能设置标题、参数和输出方式。"
        actions={
          <>
            <Button onClick={() => void Settings.openFolder("commands")}>打开目录</Button>
            <Button primary onClick={() => setCreating(!creating)}>新建</Button>
          </>
        }
      >
        {creating && (
          <div class="st-create">
            <Text value={name} width={240} placeholder="命令名称，例如：打开项目" onChange={setName} />
            <select class="st-select" aria-label="语言" value={language} onChange={(e) => setLanguage((e.target as HTMLSelectElement).value)}>
              {languages.filter((l) => l.platforms.includes(info.platform)).map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <Button primary disabled={!name.trim()} onClick={() => void create()}>创建并编辑</Button>
            {createError && <span class="st-row-error">{createError}</span>}
          </div>
        )}
        {commands.length === 0 && <div class="st-empty">还没有脚本。点「新建」写第一个。</div>}
        {commands.map((c) => (
          <div class="st-item" key={c.id}>
            <Icon icon={c.icon || "svg:terminal"} size={28} />
            <div class="st-item-text">
              <div class="st-row-label">
                {c.title}
                <span class="st-tag">{modeLabel[c.mode] ?? c.mode}</span>
              </div>
              <div class="st-row-desc">{c.desc || c.path}</div>
              {c.problems?.map((p) => <div class="st-row-error" key={p}>{p}</div>)}
            </div>
            <Hotkey
              value={config.hotkeys[c.id] ?? c.hotkey ?? ""}
              platform={info.platform}
              clearable={!!config.hotkeys[c.id]}
              placeholder="快捷键"
              onChange={(v) => setHotkey(c.id, v)}
            />
            <Button onClick={() => void Settings.editFile(c.path)}>编辑</Button>
          </div>
        ))}
      </Section>

      <Section
        title="网页插件"
        description="plugins 目录下每个文件夹是一个插件：一个 plugin.json 加一个网页。插件运行在隔离的页面里，只能使用剪贴板、通知、存储等受限能力。"
        actions={<Button onClick={() => void Settings.openFolder("plugins")}>打开目录</Button>}
      >
        {plugins.length === 0 && <div class="st-empty">还没有插件。</div>}
        {plugins.map((p) => (
          <div class="st-item" key={p.id}>
            <Icon icon={p.icon} size={28} />
            <div class="st-item-text">
              <div class="st-row-label">{p.title}</div>
              <div class="st-row-desc">{p.description || p.dir}</div>
              {p.problem && <div class="st-row-error">{p.problem}</div>}
            </div>
            <Hotkey
              value={config.hotkeys[`plugins:${p.id}`] ?? ""}
              platform={info.platform}
              clearable
              placeholder="快捷键"
              onChange={(v) => setHotkey(`plugins:${p.id}`, v)}
            />
            <Button onClick={() => void Settings.reveal(p.dir)}>定位</Button>
          </div>
        ))}
      </Section>

      <Section
        title="直达快捷键"
        description="给任何应用或命令绑一个全局快捷键，跳过搜索直接执行。"
        actions={<Button onClick={() => setAdding(!adding)}>添加</Button>}
      >
        {adding && (
          <div class="st-add">
            <Text value={search} width={320} placeholder="搜索应用或命令…" onChange={setSearch} />
            {found.map((t) => (
              <button
                class="st-found"
                key={t.id}
                onClick={() => {
                  setBound((old) => (old.some((b) => b.id === t.id) ? old : [...old, t]));
                  setAdding(false);
                  setSearch("");
                }}
              >
                <Icon icon={t.icon} size={22} />
                <span>{t.title}</span>
                <em>{t.subtitle}</em>
              </button>
            ))}
          </div>
        )}
        {bound.length === 0 && !adding && <div class="st-empty">还没有绑定。也可以在主窗口选中一项后按动作面板里的「设置快捷键」。</div>}
        {bound.map((t) => (
          <div class="st-item" key={t.id} ref={t.id === arg ? focusRow : undefined}>
            <Icon icon={t.icon} size={28} />
            <div class="st-item-text">
              <div class="st-row-label">{t.title}</div>
              <div class="st-row-desc">{t.subtitle}</div>
              {view.hotkeyErrors?.[t.id] && <div class="st-row-error">{view.hotkeyErrors[t.id]}</div>}
            </div>
            {(t.id.startsWith("features:") || t.id.startsWith("plugins:")) && (
              <label class="st-inline st-detach-toggle" title="按快捷键时直接以独立窗口打开">
                独立窗口
                <Toggle label="以独立窗口打开" checked={!!config.detachOnHotkey[t.id]} onChange={(v) => update((c) => {
                  if (v) c.detachOnHotkey[t.id] = true;
                  else delete c.detachOnHotkey[t.id];
                })} />
              </label>
            )}
            <Hotkey value={config.hotkeys[t.id] ?? ""} platform={info.platform} clearable onChange={(v) => setHotkey(t.id, v)} />
          </div>
        ))}
      </Section>

      {hidden.length > 0 && (
        <Section title="已隐藏的项目">
          {hidden.map((t) => (
            <Row key={t.id} label={t.title} description={t.subtitle}>
              <Button onClick={() => update((c) => (c.disabled = c.disabled.filter((id) => id !== t.id)))}>恢复</Button>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}
