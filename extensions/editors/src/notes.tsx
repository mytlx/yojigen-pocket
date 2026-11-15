import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EditorView } from "@codemirror/view";
import { Bold, Check, ChevronDown, ChevronRight, Clock, Code, Copy, ExternalLink, FileOutput, FileText, Folder, FolderOpen, FolderPlus, Heading, Italic, Link, List, ListChecks, MoreHorizontal, Palette, Pencil, Plus, Quote, Search, SpellCheck, SquareArrowOutUpRight, Table, Trash2 } from "lucide-preact";
import { Notes, openExternal, type FeatureProps, type FsChange, type Node } from "./host";
import { CodeEditor, linkOpener } from "./code/editor";
import { Btn, Empty, Seg } from "../../../src/features/ui";
import { frontSummary, joinFrontmatter, splitFrontmatter } from "./notes/frontmatter";
import { RichEditor } from "./notes/rich";
import "./notes/notes.css";

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

/** 代码块的配色方案。具体颜色在 notes.css 里，这里只是名字。 */
const codeThemes = [
  { id: "auto", label: "跟随界面" },
  { id: "github-light", label: "GitHub 浅色" },
  { id: "github-dark", label: "GitHub 深色" },
  { id: "one-dark", label: "One Dark" },
  { id: "solarized-light", label: "Solarized 浅色" },
  { id: "monokai", label: "Monokai" },
] as const;

interface Prefs {
  /** 拼写检查（单词下面的红色波浪线）。默认关。 */
  spell: boolean;
  codeTheme: string;
}
const prefsKey = "pocket.notes.prefs";
const loadPrefs = (): Prefs => {
  const base: Prefs = { spell: false, codeTheme: "auto" };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(prefsKey) ?? "{}") as Partial<Prefs>) };
  } catch {
    return base;
  }
};

/** 一段文字的指纹：判断“这段内容是不是刚才已经存成笔记了”。 */
function fingerprint(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
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
  const [prefs, setPrefs] = useState(loadPrefs);
  const [menuOpen, setMenuOpen] = useState(false);
  const [frontOpen, setFrontOpen] = useState(false);
  const richScroll = useRef(0); // 所见即所得编辑器重建后要恢复到的滚动位置
  const body = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const state = useRef({ path, content, dirty, mode });
  state.current = { path, content, dirty, mode };

  const updatePrefs = (patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(prefsKey, JSON.stringify(next));
      } catch {
        /* 存不了就只在这次生效 */
      }
      return next;
    });
  };

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
      richScroll.current = 0;
      setNonce((n) => n + 1);
      setDirty(false);
      setSaved("");
      setFrontOpen(false);
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

  /**
   * 带着一段内容进来（选中文字后“存成笔记”、关键词后面跟着内容）：存成一篇新笔记。
   * 同一段内容可能被带进来不止一次（面板重新打开、分离成独立窗口），已经存过就打开那一篇，不再新建。
   */
  const importText = async (text: string, files: Node[]) => {
    const key = "pocket.notes.imported";
    const sig = fingerprint(text);
    try {
      const prev = JSON.parse(localStorage.getItem(key) ?? "null") as { sig: string; path: string } | null;
      if (prev?.sig === sig && files.some((f) => f.path === prev.path)) return void openNote(prev.path);
    } catch {
      /* 记录坏了就当没存过 */
    }
    try {
      const p = await Notes.newNote("");
      await Notes.write(p, text);
      try {
        localStorage.setItem(key, JSON.stringify({ sig, path: p }));
      } catch {
        /* 忽略 */
      }
      await refresh();
      await openNote(p);
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
      if (input.trim()) void importText(input, files);
      else {
        const first = files.find((f) => f.path === last) ?? [...files].sort((a, b) => b.modified - a.modified)[0];
        if (first) void openNote(first.path);
      }
    });
    // 分离成独立窗口时带过去的是“输入”。笔记不需要带内容：那边会打开同一篇（最近打开的那篇）。
    ctx.remember("");
    // 页面要没了（面板关掉、分离出去）：把还没存的赶紧存上。
    const leave = () => void flush();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      void flush();
    };
  }, []);

  // 窗口开着的时候又带着内容被叫到。
  const firstInput = useRef(true);
  useEffect(() => {
    if (firstInput.current) {
      firstInput.current = false;
      return;
    }
    if (input.trim()) void importText(input, all.filter((n) => !n.isDir));
  }, [input]);

  // 同一篇笔记可能同时开在主窗口和独立窗口里。别处改了文件，这边跟着变，不会各改各的。
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const off = Notes.onChange((ev: FsChange) => {
      const s = state.current;
      if (ev.op === "write") {
        if (ev.path !== s.path || s.dirty) return;
        void Notes.read(ev.path).then((text) => {
          const now = state.current;
          // 自己刚存的（内容一样）不用管；这边正在改的以这边为准。
          if (now.path !== ev.path || now.dirty || text === now.content) return;
          richScroll.current = body.current?.querySelector(".fx-notes-rich")?.scrollTop ?? 0;
          setContent(text);
          setNonce((n) => n + 1);
        }, () => undefined);
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 120);
      const inside = s.path === ev.path || s.path.startsWith(ev.path + "/");
      if (!inside) return;
      if (ev.op === "rename" && ev.to) {
        const np = s.path === ev.path ? ev.to : ev.to + s.path.slice(ev.path.length);
        setPath(np);
        setTitle(stem(np.slice(np.lastIndexOf("/") + 1)));
      } else if (ev.op === "delete") {
        clearTimeout(timer.current);
        setPath("");
        setContent("");
        setDirty(false);
      }
    });
    return () => {
      clearTimeout(refreshTimer);
      off();
    };
  }, []);

  const edit = (text: string) => {
    if (text === state.current.content) return;
    setContent(text);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };

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

  /** Ctrl / ⌘ + 点击链接：网址用系统浏览器打开；指向另一篇笔记的相对路径就在这里打开那一篇。 */
  const openLink = (href: string) => {
    const target = href.trim();
    if (!target) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return void openExternal(target).catch(fail);
    if (/^www\./i.test(target)) return void openExternal(`https://${target}`).catch(fail);
    if (target.startsWith("#")) return ctx.toast("这是页内链接");
    let rel = target.split("#")[0]!.split("?")[0]!;
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* 不是合法的转义就按原样找 */
    }
    const parts = (rel.startsWith("/") ? rel.slice(1) : `${dirOf(path)}/${rel}`).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p && p !== ".") out.push(p);
    }
    const want = out.join("/");
    const hit = all.find((n) => !n.isDir && (n.path === want || n.path === `${want}.md`));
    if (hit) void openNote(hit.path);
    else ctx.toast(`找不到笔记：${rel}`, true);
  };

  const saveAs = async () => {
    setMenuOpen(false);
    try {
      const target = await Notes.saveAs(`${title || "笔记"}.md`, content);
      if (target) ctx.toast(`已另存为 ${target}`);
    } catch (e) {
      fail(e as Error);
    }
  };
  const openOutside = (how: "open" | "openWith" | "reveal") => {
    setMenuOpen(false);
    void flush()
      .then(() => Notes[how](path))
      .catch(fail);
  };

  // 点菜单外面关掉菜单。
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".fx-notes-more")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", away, true);
    return () => document.removeEventListener("mousedown", away, true);
  }, [menuOpen]);

  // 所见即所得模式下，frontmatter 摘出来单独编辑，编辑器只管正文。
  const split = useMemo(() => splitFrontmatter(content), [content]);
  const front = useRef(split.front);
  front.current = split.front;
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  const sourceExtensions = useMemo(() => [linkOpener((href) => openLinkRef.current(href))], []);

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
            <div class="fx-notes-more">
              <Btn small ghost icon title="更多：用其他应用打开、另存为、设置" onClick={() => setMenuOpen((o) => !o)}>
                <MoreHorizontal size={14} />
              </Btn>
              {menuOpen && (
                <div class="fx-menu" role="menu">
                  <button type="button" role="menuitem" class="fx-menu-item" onClick={() => openOutside("open")}>
                    <ExternalLink size={14} />
                    <span>用默认应用打开</span>
                  </button>
                  <button type="button" role="menuitem" class="fx-menu-item" onClick={() => openOutside("openWith")}>
                    <SquareArrowOutUpRight size={14} />
                    <span>用其他应用打开…</span>
                  </button>
                  <button type="button" role="menuitem" class="fx-menu-item" onClick={() => void saveAs()}>
                    <FileOutput size={14} />
                    <span>另存为…</span>
                  </button>
                  <button type="button" role="menuitem" class="fx-menu-item" onClick={() => openOutside("reveal")}>
                    <FolderOpen size={14} />
                    <span>在文件夹中显示</span>
                  </button>
                  <div class="fx-menu-sep" />
                  <button type="button" role="menuitemcheckbox" aria-checked={prefs.spell} class="fx-menu-item" onClick={() => updatePrefs({ spell: !prefs.spell })}>
                    <SpellCheck size={14} />
                    <span>拼写检查</span>
                    {prefs.spell && <Check size={12} class="fx-menu-check" />}
                  </button>
                  <div class="fx-menu-sep" />
                  <div class="fx-menu-label">
                    <Palette size={12} /> 代码块配色
                  </div>
                  {codeThemes.map((t) => (
                    <button key={t.id} type="button" role="menuitemradio" aria-checked={prefs.codeTheme === t.id} class="fx-menu-item" onClick={() => updatePrefs({ codeTheme: t.id })}>
                      <span class={`fx-code-swatch is-${t.id}`} />
                      <span>{t.label}</span>
                      {prefs.codeTheme === t.id && <Check size={12} class="fx-menu-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
          {mode === "rich" && split.front !== null && (
            <div class={`fx-notes-front${frontOpen ? " is-open" : ""}`}>
              <button type="button" class="fx-notes-front-head" title="文档开头 --- 之间的属性（frontmatter）" onClick={() => setFrontOpen((o) => !o)}>
                {frontOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="fx-notes-front-label">文档属性</span>
                {!frontOpen && <span class="fx-notes-front-keys">{frontSummary(split.front)}</span>}
              </button>
              {frontOpen && (
                <textarea
                  class="fx-notes-front-text"
                  spellcheck={false}
                  rows={Math.min(10, Math.max(2, split.front.split("\n").length))}
                  value={split.front}
                  onInput={(e) => edit(joinFrontmatter((e.target as HTMLTextAreaElement).value, split.body))}
                />
              )}
            </div>
          )}
          <div class="fx-out fx-notes-body" ref={body} data-code-theme={prefs.codeTheme}>
            {mode === "rich" ? (
              <RichEditor
                key={`${path}#${nonce}`}
                value={split.body}
                onChange={(md) => edit(joinFrontmatter(front.current, md))}
                spellcheck={prefs.spell}
                onOpenLink={openLink}
                onToast={ctx.toast}
                scrollTop={richScroll.current}
              />
            ) : (
              <CodeEditor key={path} value={content} lang="markdown" wrap onChange={edit} onReady={(v) => (view.current = v)} onCursor={setCursor} autoFocus extensions={sourceExtensions} />
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
