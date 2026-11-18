import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Copy, ExternalLink, FolderOpen, Info, PanelRight, Search, ShieldAlert } from "lucide-preact";
import { Finder, Settings, type FileHit, type FinderInfo } from "../mygo";
import { Icon } from "../shared/icons";
import { FilePreview } from "../shared/filepreview";
import { Btn, Empty, keepVisible, useDebounced } from "./ui";
import type { FeatureProps } from "./types";

type Sort = "relevance" | "name" | "modified" | "size";
const sorts: { value: Sort; label: string }[] = [
  { value: "relevance", label: "默认顺序" },
  { value: "modified", label: "最近修改" },
  { value: "name", label: "名称" },
  { value: "size", label: "大小" },
];
const engineNames: Record<string, string> = { everything: "Everything", spotlight: "聚焦", index: "内置索引" };

/** 高级搜索：左边按类型筛选，中间是文件，右边是预览和属性。 */
export function FindTool({ input, args, ctx }: FeatureProps) {
  const [query, setQuery] = useState(input);
  const [kind, setKind] = useState(args.kind ?? "all");
  const [info, setInfo] = useState<FinderInfo | null>(null);
  const [scope, setScope] = useState("home");
  const [sort, setSort] = useState<Sort>("relevance");
  // “给完全磁盘访问权限才能搜全”的提示：不想给的人点一次“不再提示”就不再出现。
  const [hideDiskHint, setHideDiskHint] = useState(() => {
    try {
      return localStorage.getItem("pocket.find.noDiskHint") === "1";
    } catch {
      return false;
    }
  });
  const dismissDiskHint = () => {
    setHideDiskHint(true);
    try {
      localStorage.setItem("pocket.find.noDiskHint", "1");
    } catch {
      /* 存不了就只在这次生效 */
    }
  };
  const [hits, setHits] = useState<FileHit[]>([]);
  const [state, setState] = useState<{ busy: boolean; engine: string; note: string; truncated: boolean; searched: boolean; hint?: string }>({ busy: false, engine: "", note: "", truncated: false, searched: false });
  const [selected, setSelected] = useState(0);
  const [panes, setPanes] = useState({ preview: true, meta: true });
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const debounced = useDebounced(query, 220);

  useEffect(() => {
    field.current?.focus();
    void Finder.info().then((i) => {
      setInfo(i);
      setScope(i.scope || "home");
      setPanes({ preview: i.preview, meta: i.meta });
      setState((s) => ({ ...s, engine: i.engine, note: i.note }));
    });
  }, []);
  useEffect(() => {
    if (input && input !== query) setQuery(input);
  }, [input]);
  useEffect(() => ctx.remember(query), [query]);

  useEffect(() => {
    const my = ++seq.current;
    const q = debounced.trim();
    if (!q && kind === "all") {
      setHits([]);
      setState((s) => ({ ...s, busy: false, truncated: false, searched: false }));
      return;
    }
    setState((s) => ({ ...s, busy: true }));
    void Finder.search({ query: q, kind, scope, limit: 300 }).then(
      (r) => {
        if (my !== seq.current) return;
        setHits(r.items ?? []);
        setSelected(0);
        setState({ busy: false, engine: r.engine, note: r.note ?? "", truncated: r.truncated, searched: true, hint: r.hint });
      },
      () => my === seq.current && setState((s) => ({ ...s, busy: false })),
    );
  }, [debounced, kind, scope]);

  const sorted = (() => {
    if (sort === "relevance") return hits;
    const copy = [...hits];
    if (sort === "name") copy.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    if (sort === "modified") copy.sort((a, b) => b.modified - a.modified);
    if (sort === "size") copy.sort((a, b) => b.size - a.size);
    return copy;
  })();
  const current = sorted[Math.min(selected, sorted.length - 1)];
  useEffect(() => keepVisible(list.current), [selected, sorted]);

  const togglePane = useCallback((which: "preview" | "meta") => {
    setPanes((p) => {
      const next = { ...p, [which]: !p[which] };
      void Finder.setPanes("find", next.preview, next.meta);
      return next;
    });
  }, []);
  const open = (h?: FileHit) => h && void Finder.open(h.path).catch((e: Error) => ctx.toast(e.message, true));
  const reveal = (h?: FileHit) => h && void Finder.reveal(h.path);
  const copyPath = (h?: FileHit) => h && void Finder.copyPath(h.path).then(() => ctx.toast("已复制路径"));
  const copyFile = (h?: FileHit) => h && void Finder.copyFile(h.path).then(() => ctx.toast("已复制文件"), (e: Error) => ctx.toast(e.message, true));

  const showPane = (panes.preview || panes.meta) && !!current;
  return (
    <div class={`fx-page fx-find${showPane ? " has-pane" : ""}`}>
      <div class="fx-toolbar">
        <label class="fx-search">
          <Search size={15} />
          <input
            ref={field}
            class="fx-search-input"
            placeholder={state.engine === "everything" ? "文件名，支持 Everything 语法：*.pdf  ext:docx  size:>10mb  dm:today" : "文件名，支持通配符：报告*.pdf   多个词用空格隔开"}
            value={query}
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, sorted.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (mod) reveal(current);
                else open(current);
              } else if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
                e.preventDefault();
                copyPath(current);
              }
            }}
          />
          {state.busy && <span class="ui-spinner" />}
          {state.engine && <span class="fx-find-engine" title={state.note}>{engineNames[state.engine] ?? state.engine}</span>}
        </label>
        {info?.scopes && state.engine === "spotlight" && (
          <select class="ui-select" aria-label="搜索范围" value={scope} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setScope(v); void Finder.setScope(v); }}>
            <option value="home">个人文件夹</option>
            <option value="all">整台电脑</option>
          </select>
        )}
        <select class="ui-select" aria-label="排序" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
          {sorts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <Btn small ghost icon title={panes.preview ? "隐藏预览区" : "显示预览区"} on={panes.preview} onClick={() => togglePane("preview")}>
          <PanelRight size={15} />
        </Btn>
        <Btn small ghost icon title={panes.meta ? "隐藏属性区" : "显示属性区"} on={panes.meta} onClick={() => togglePane("meta")}>
          <Info size={15} />
        </Btn>
      </div>
      {state.searched && state.hint === "disk" && !hideDiskHint && (
        <div class="fx-warn fx-find-hint">
          <ShieldAlert size={15} />
          <span>聚焦能搜到、这里搜不到的文件，多半在其他应用的数据目录里（比如微信收到的文件）。系统只把这部分结果给有“完全磁盘访问权限”的应用。</span>
          <Btn small onClick={() => void Finder.openFullDisk()}>去授权</Btn>
          <Btn small onClick={() => void Settings.relaunch()}>重启应用</Btn>
          <Btn small ghost onClick={dismissDiskHint}>不再提示</Btn>
        </div>
      )}
      <div class="fx-find-body">
        <nav class="fx-find-kinds" aria-label="类型">
          {(info?.kinds ?? []).map((k) => (
            <button key={k.id} type="button" class={`fx-find-kind${k.id === kind ? " is-on" : ""}`} onClick={() => { setKind(k.id); field.current?.focus(); }}>
              <Icon icon={k.icon} size={20} />
              <span>{k.title}</span>
            </button>
          ))}
        </nav>
        <div class="fx-out fx-find-list" ref={list}>
          {sorted.length === 0 ? (
            <Empty
              title={state.busy ? "正在搜索…" : state.searched ? "没有找到文件" : "输入文件名开始搜索"}
              desc={state.searched || state.busy ? undefined : state.note}
            />
          ) : (
            sorted.map((h, i) => (
              <div
                key={h.path}
                class={`fx-find-row${h === current ? " is-selected" : ""}`}
                onClick={() => setSelected(i)}
                onDblClick={() => open(h)}
              >
                <img class="fx-find-icon" src={h.icon} alt="" loading="lazy" draggable={false} />
                <div class="fx-find-text">
                  <div class="fx-find-name">{h.name}</div>
                  <div class="fx-find-dir">{h.dir}</div>
                </div>
                <div class="fx-find-meta">
                  <span>{h.isDir ? "文件夹" : h.sizeText}</span>
                  <span>{h.modText}</span>
                </div>
              </div>
            ))
          )}
        </div>
        {showPane && current && (
          <div class="fx-out fx-find-pane">
            <div class="fx-find-pane-body">
              <FilePreview key={current.path} path={current.path} showPreview={panes.preview} showMeta={panes.meta} />
            </div>
            <div class="fx-out-bar">
              <Btn small primary onClick={() => open(current)}>
                <ExternalLink size={13} /> 打开
              </Btn>
              <Btn small onClick={() => reveal(current)}>
                <FolderOpen size={13} /> 所在文件夹
              </Btn>
              <span class="fx-spacer" />
              <Btn small ghost title="复制路径" onClick={() => copyPath(current)}>
                <Copy size={13} /> 路径
              </Btn>
              {!current.isDir && (
                <Btn small ghost title="复制文件本身，可以粘贴到别的文件夹或聊天窗口" onClick={() => copyFile(current)}>
                  <Copy size={13} /> 文件
                </Btn>
              )}
            </div>
          </div>
        )}
      </div>
      <div class="fx-meta fx-find-status">
        {state.searched ? `${sorted.length} 项${state.truncated ? "（结果较多，只显示了前面的，再输入几个字缩小范围）" : ""} · ` : ""}
        ↑↓ 选择 · 回车打开 · {ctx.platform === "darwin" ? "⌘" : "Ctrl+"}回车在文件夹中显示
        {state.searched && state.note ? ` · ${state.note}` : ""}
      </div>
    </div>
  );
}
