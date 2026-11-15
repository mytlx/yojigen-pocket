import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EditorView } from "@codemirror/view";
import { Bold, ChevronDown, ChevronRight, Clock, Code, Copy, FileText, Folder, FolderOpen, FolderPlus, Heading, Italic, Link, List, ListChecks, Pencil, Plus, Quote, Search, Table, Trash2 } from "lucide-preact";
import { Notes, type FeatureProps, type Node } from "./host";
import { CodeEditor } from "./code/editor";
import { Btn, Empty, Seg } from "../../../src/features/ui";

type Mode = "rich" | "source";

const stem = (name: string) => name.replace(/\.md$/i, "");
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function flatten(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

/** 字数统计：中日韩文字按字算，其他按词算；另外给出字符数和行数。 */
function count(text: string) {
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) ?? []).length;
  const words = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, " ").match(/[\p{L}\p{N}_'-]+/gu) ?? []).length;
  const total = cjk + words;
  return { total, chars: Array.from(text.replace(/\s/g, "")).length, lines: text ? text.split("\n").length : 0, minutes: Math.max(1, Math.round(total / 400)) };
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 所见即所得的编辑器（Milkdown）。打开笔记时才加载，换一篇就重建。 */
function RichEditor({ value, onChange }: { value: string; onChange: (md: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const [{ Crepe }] = await Promise.all([import("@milkdown/crepe"), import("@milkdown/crepe/theme/common/style.css"), import("@milkdown/crepe/theme/frame.css")]);
        if (!alive || !host.current) return;
        const crepe = new Crepe({
          root: host.current,
          defaultValue: value,
          features: {
            [Crepe.Feature.Latex]: false,
            [Crepe.Feature.AI]: false,
            [Crepe.Feature.ImageBlock]: false,
            [Crepe.Feature.TopBar]: false,
          },
          featureConfigs: { [Crepe.Feature.Placeholder]: { text: "写点什么…  输入 / 插入标题、列表、表格、代码块" } },
        });
        crepe.on((l) => l.markdownUpdated((_ctx, md) => latest.current(md)));
        await crepe.create();
        destroy = () => void crepe.destroy();
        if (!alive) destroy();
      } catch (e) {
        if (alive) setFailed((e as Error).message || "编辑器加载失败");
      }
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, []);
  if (failed) return <div class="pk-empty">所见即所得编辑器加载失败（{failed}），可以先切到源码模式。</div>;
  return <div class="fx-notes-rich" ref={host} />;
}

/** Markdown 笔记：左边是文件夹和笔记，右边编辑。笔记就是用户目录 notes 里的 .md 文件。 */
export function NotesTool({ input, ctx }: FeatureProps) {
  const [tree, setTree] = useState<Node[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [nonce, setNonce] = useState(0); // 换一篇、或源码模式改过内容后，让所见即所得编辑器重建
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem("pocket.notes.mode") === "source" ? "source" : "rich";
    } catch {
      return "rich";
    }
  });
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState("");
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
  const [loaded, setLoaded] = useState(false);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const state = useRef({ path, content, dirty });
  state.current = { path, content, dirty };

  const all = useMemo(() => flatten(tree), [tree]);
  const refresh = () => Notes.tree().then((t) => setTree(t ?? []));
  const fail = (e: Error) => ctx.toast(e.message, true);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const s = state.current;
    if (!s.path || !s.dirty) return Promise.resolve();
    return Notes.write(s.path, s.content).then(() => {
      setDirty(false);
      setSaved(stamp().slice(11));
    }, fail);
  }, []);

  const openNote = async (p: string) => {
    await flush();
    try {
      const text = await Notes.read(p);
      setPath(p);
      setContent(text);
      setTitle(stem(p.slice(p.lastIndexOf("/") + 1)));
      setNonce((n) => n + 1);
      setDirty(false);
      setSaved("");
      // 把它所在的文件夹都展开。
      setOpen((o) => {
        const next = { ...o };
        let d = dirOf(p);
        while (d) {
          next[d] = true;
          d = dirOf(d);
        }
        return next;
      });
      try {
        localStorage.setItem("pocket.notes.last", p);
      } catch {
        /* 存不了也不影响使用 */
      }
    } catch (e) {
      fail(e as Error);
    }
  };

  /** 新建时放在哪：选中的是文件夹就放里面，否则和当前笔记放一起。 */
  const targetDir = () => dirOf(path);
  const newNote = async (dir = targetDir(), text = "") => {
    try {
      const p = await Notes.newNote(dir);
      if (text) await Notes.write(p, text);
      await refresh();
      await openNote(p);
    } catch (e) {
      fail(e as Error);
    }
  };
  const newFolder = async (dir = targetDir()) => {
    try {
      const p = await Notes.newFolder(dir);
      await refresh();
      setOpen((o) => ({ ...o, [p]: true, ...(dir ? { [dir]: true } : {}) }));
      setRenaming(p);
    } catch (e) {
      fail(e as Error);
    }
  };

  useEffect(() => {
    void Notes.tree().then((t) => {
      const list = t ?? [];
      setTree(list);
      setLoaded(true);
      const files = flatten(list).filter((n) => !n.isDir);
      let last = "";
      try {
        last = localStorage.getItem("pocket.notes.last") ?? "";
      } catch {
        /* 忽略 */
      }
      if (input.trim()) void newNote("", input);
      else {
        const first = files.find((f) => f.path === last) ?? [...files].sort((a, b) => b.modified - a.modified)[0];
        if (first) void openNote(first.path);
      }
    });
    return () => void flush();
  }, []);

  const edit = (text: string) => {
    if (text === state.current.content) return;
    setContent(text);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };
  useEffect(() => ctx.remember(content), [content]);

  const switchMode = (m: Mode) => {
    setMode(m);
    if (m === "rich") setNonce((n) => n + 1); // 带着源码模式里改过的内容重建
    try {
      localStorage.setItem("pocket.notes.mode", m);
    } catch {
      /* 忽略 */
    }
  };

  const applyPath = (from: string, to: string) => {
    // 改名或移动之后，当前打开的笔记如果在它下面，路径跟着变。
    const cur = state.current.path;
    if (cur === from) setPath(to);
    else if (cur.startsWith(from + "/")) setPath(to + cur.slice(from.length));
  };
  const rename = async (p: string, name: string) => {
    setRenaming("");
    const node = all.find((n) => n.path === p);
    if (!node || !name.trim() || name.trim() === (node.isDir ? node.name : stem(node.name))) return;
    if (p === path) await flush();
    try {
      const np = await Notes.rename(p, name.trim());
      applyPath(p, np);
      if (p === path) setTitle(stem(np.slice(np.lastIndexOf("/") + 1)));
      await refresh();
    } catch (e) {
      fail(e as Error);
      if (p === path) setTitle(stem(node.name));
    }
  };
  const move = async (p: string, dir: string) => {
    if (dirOf(p) === dir || p === dir) return;
    if (p === path) await flush();
    try {
      const np = await Notes.move(p, dir);
      applyPath(p, np);
      if (dir) setOpen((o) => ({ ...o, [dir]: true }));
      await refresh();
    } catch (e) {
      fail(e as Error);
    }
  };
  const remove = async (p: string) => {
    setConfirmDelete("");
    try {
      await Notes.delete(p);
      if (path === p || path.startsWith(p + "/")) {
        clearTimeout(timer.current);
        setPath("");
        setContent("");
        setDirty(false);
      }
      await refresh();
      ctx.toast("已移到废纸篓");
    } catch (e) {
      fail(e as Error);
    }
  };

  /** 源码模式的工具栏：给选中的文字两边加符号，或者在行首加前缀。 */
  const wrapSel = (before: string, after = before, placeholder = "文字") => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const text = v.state.sliceDoc(from, to) || placeholder;
    v.dispatch({ changes: { from, to, insert: before + text + after }, selection: { anchor: from + before.length, head: from + before.length + text.length } });
    v.focus();
  };
  const prefixLines = (prefix: string) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const first = v.state.doc.lineAt(from).number;
    const last = v.state.doc.lineAt(to).number;
    const changes = [];
    for (let n = first; n <= last; n++) changes.push({ from: v.state.doc.line(n).from, insert: prefix });
    v.dispatch({ changes });
    v.focus();
  };
  const insert = (text: string) => {
    const v = view.current;
    if (v && mode === "source") {
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    } else {
      edit(content + (content.endsWith("\n") || !content ? "" : "\n") + text);
      setNonce((n) => n + 1);
    }
  };

  const stats = useMemo(() => count(content), [content]);
  const q = filter.trim().toLowerCase();
  const matches = q ? all.filter((n) => !n.isDir && n.name.toLowerCase().includes(q)) : null;

  const item = (n: Node, depth: number) => {
    const selected = n.path === path;
    const expanded = !!open[n.path];
    return (
      <div key={n.path}>
        <div
          class={`fx-side-item${selected ? " is-selected" : ""}${dragOver === n.path ? " is-drop" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          draggable={renaming !== n.path}
          onDragStart={(e) => e.dataTransfer?.setData("text/pocket-note", n.path)}
          onDragOver={(e) => {
            if (!n.isDir) return;
            e.preventDefault();
            setDragOver(n.path);
          }}
          onDragLeave={() => setDragOver((d) => (d === n.path ? null : d))}
          onDrop={(e) => {
            if (!n.isDir) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOver(null);
            const from = e.dataTransfer?.getData("text/pocket-note");
            if (from) void move(from, n.path);
          }}
          onClick={() => (n.isDir ? setOpen((o) => ({ ...o, [n.path]: !expanded })) : !selected && void openNote(n.path))}
        >
          {n.isDir ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span class="fx-side-indent" />}
          {n.isDir ? <Folder size={13} /> : <FileText size={13} />}
          {renaming === n.path ? (
            <input
              class="fx-side-rename"
              defaultValue={n.isDir ? n.name : stem(n.name)}
              autoFocus
              spellcheck={false}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
              onBlur={(e) => void rename(n.path, (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming("");
                }
              }}
            />
          ) : (
            <>
              <span class="fx-side-name" title={n.name}>{n.isDir ? n.name : stem(n.name)}</span>
              {confirmDelete === n.path ? (
                <Btn small danger onClick={() => void remove(n.path)}>删除</Btn>
              ) : (
                <span class="fx-side-tools" onClick={(e) => e.stopPropagation()}>
                  {n.isDir && (
                    <button type="button" class="fx-side-del" title="在这个文件夹里新建笔记" onClick={() => { setOpen((o) => ({ ...o, [n.path]: true })); void newNote(n.path); }}>
                      <Plus size={12} />
                    </button>
                  )}
                  <button type="button" class="fx-side-del" title="改名" onClick={() => setRenaming(n.path)}>
                    <Pencil size={11} />
                  </button>
                  <button type="button" class="fx-side-del" title="删除（移到废纸篓）" onClick={() => { setConfirmDelete(n.path); setTimeout(() => setConfirmDelete((c) => (c === n.path ? "" : c)), 2500); }}>
                    <Trash2 size={12} />
                  </button>
                </span>
              )}
            </>
          )}
        </div>
        {n.isDir && expanded && (n.children ?? []).map((c) => item(c, depth + 1))}
        {n.isDir && expanded && (n.children ?? []).length === 0 && (
          <div class="fx-side-empty" style={{ paddingLeft: `${30 + depth * 14}px`, textAlign: "left" }}>空文件夹</div>
        )}
      </div>
    );
  };

  return (
    <div class="fx-page fx-notes">
      <aside class="fx-out fx-side">
        <div class="fx-side-head">
          <label class="fx-side-search">
            <Search size={12} />
            <input placeholder="搜索笔记" value={filter} spellcheck={false} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          </label>
          <Btn small ghost icon title="新建文件夹" onClick={() => void newFolder()}>
            <FolderPlus size={14} />
          </Btn>
          <Btn small ghost icon title="新建笔记" onClick={() => void newNote()}>
            <Plus size={14} />
          </Btn>
        </div>
        <div
          class={`fx-side-list${dragOver === "" ? " is-drop" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver("");
          }}
          onDragLeave={() => setDragOver((d) => (d === "" ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const from = e.dataTransfer?.getData("text/pocket-note");
            if (from) void move(from, "");
          }}
        >
          {matches ? matches.map((n) => item({ ...n, children: undefined }, 0)) : tree.map((n) => item(n, 0))}
          {loaded && (matches ? matches.length === 0 : tree.length === 0) && <div class="fx-side-empty">{matches ? "没有匹配的笔记" : "还没有笔记"}</div>}
        </div>
        <div class="fx-side-foot">
          <button type="button" class="fx-side-link" title="笔记就是这个文件夹里的 .md 文件" onClick={() => void Notes.reveal("")}>
            <FolderOpen size={12} /> 打开笔记文件夹
          </button>
        </div>
      </aside>

      {!path ? (
        <div class="fx-out fx-grow-1 fx-scratch-empty">
          {loaded && (
            <Empty title="随手记点什么" desc="笔记自动保存成 Markdown 文件，文件名带着日期。">
              <Btn primary onClick={() => void newNote("")}>
                <Plus size={14} /> 新建笔记
              </Btn>
            </Empty>
          )}
        </div>
      ) : (
        <div class="fx-notes-main">
          <div class="fx-notes-head">
            <input
              class="fx-notes-title"
              value={title}
              spellcheck={false}
              aria-label="笔记名称"
              title="点击改名"
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onBlur={() => void rename(path, title)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setTitle(stem(path.slice(path.lastIndexOf("/") + 1)));
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <Btn small ghost icon title="插入当前时间" onClick={() => insert(stamp())}>
              <Clock size={14} />
            </Btn>
            <Btn small ghost icon title="复制全文（Markdown）" onClick={() => void ctx.copy(content)}>
              <Copy size={14} />
            </Btn>
            <Btn small ghost icon title="在文件夹中显示" onClick={() => void flush().then(() => Notes.reveal(path))}>
              <FolderOpen size={14} />
            </Btn>
            <Seg value={mode} options={[{ value: "rich", label: "所见即所得" }, { value: "source", label: "源码" }]} onChange={switchMode} />
          </div>
          {mode === "source" && (
            <div class="fx-notes-bar">
              <Btn small ghost icon title="标题" onClick={() => prefixLines("## ")}><Heading size={14} /></Btn>
              <Btn small ghost icon title="加粗" onClick={() => wrapSel("**")}><Bold size={14} /></Btn>
              <Btn small ghost icon title="斜体" onClick={() => wrapSel("*")}><Italic size={14} /></Btn>
              <Btn small ghost icon title="行内代码" onClick={() => wrapSel("`", "`", "code")}><Code size={14} /></Btn>
              <Btn small ghost icon title="链接" onClick={() => wrapSel("[", "](https://)", "链接文字")}><Link size={14} /></Btn>
              <Btn small ghost icon title="列表" onClick={() => prefixLines("- ")}><List size={14} /></Btn>
              <Btn small ghost icon title="待办" onClick={() => prefixLines("- [ ] ")}><ListChecks size={14} /></Btn>
              <Btn small ghost icon title="引用" onClick={() => prefixLines("> ")}><Quote size={14} /></Btn>
              <Btn small ghost icon title="表格" onClick={() => insert("| 列一 | 列二 |\n| --- | --- |\n|  |  |\n")}><Table size={14} /></Btn>
            </div>
          )}
          <div class="fx-out fx-notes-body">
            {mode === "rich" ? (
              <RichEditor key={`${path}#${nonce}`} value={content} onChange={edit} />
            ) : (
              <CodeEditor key={path} value={content} lang="markdown" wrap onChange={edit} onReady={(v) => (view.current = v)} onCursor={setCursor} autoFocus />
            )}
          </div>
          <div class="fx-meta fx-notes-status">
            <span>
              {stats.total} 字 · {stats.chars} 字符 · {stats.lines} 行 · 约 {stats.minutes} 分钟读完
              {mode === "source" ? ` · 第 ${cursor.line} 行，第 ${cursor.col} 列${cursor.selected ? `（选中 ${cursor.selected}）` : ""}` : ""}
            </span>
            <span class="fx-spacer" />
            <span>{dirty ? "正在保存…" : saved ? `已保存 ${saved}` : "自动保存"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
