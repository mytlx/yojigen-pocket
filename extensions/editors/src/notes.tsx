import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { EditorView } from "@codemirror/view";
import {
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Copy,
  ExternalLink,
  Eye,
  FileOutput,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heading,
  Italic,
  Keyboard,
  Link,
  List,
  ListChecks,
  ListTree,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Pencil,
  Pilcrow,
  Plus,
  Quote,
  RotateCcw,
  Search,
  SpellCheck,
  SquareArrowOutUpRight,
  Table,
  Trash2,
  X,
} from "lucide-preact";
import { editorClipboard, Notes, openExternal, type FeatureProps, type FsChange, type Node } from "./host";
import { CodeEditor, linkOpener } from "./code/editor";
import { Btn, Empty, Seg } from "../../../src/features/ui";
import { applySourceFormat, applySourceParagraph, buildSourceInsert, type BlockKind } from "./notes/blockops";
import { EditorContextMenu, type EditorMenuActions, type EditorMenuTarget } from "./notes/editormenu";
import { frontSummary, joinFrontmatter, splitFrontmatter } from "./notes/frontmatter";
import { defaultShortcuts, noteLineKeys, shortcutOf, type NoteShortcuts } from "./notes/shortcuts";
import { outlineOf, outlineTree, type OutlineNode } from "./notes/outline";
import { RichEditor, type RichViewMode } from "./notes/rich";
import { DEFAULT_TIME_FORMAT, TIME_FORMAT_PRESETS, formatTime } from "./notes/timefmt";
import {
  DEFAULT_OUTLINE_W,
  DEFAULT_SIDEBAR_W,
  clampDragWidth,
  collectNestedDirs,
  compileFileSearch,
  computePanelWidths,
  filterDirPaths,
  normalizeDeleteTargets,
  selectRange,
  visibleTreePaths,
} from "./notes/sidebar";
import { DeleteConfirmModal, SideContextMenu, type PendingDeleteItem, type SideMenuActions, type SideMenuTarget } from "./notes/sidemenu";
import "./notes/notes.css";

const PANEL_ANIM_MS = 140;

/** 管理可收起侧栏的挂载与滑入/滑出动画状态；初始化加载完成前直接贴合当前状态不闪烁。 */
function useAnimatedPanel(open: boolean, animate: boolean) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!animate && !readyRef.current) {
      setMounted(open);
      setShown(open);
      return;
    }
    readyRef.current = true;
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), PANEL_ANIM_MS);
    return () => clearTimeout(t);
  }, [open, animate]);

  return { mounted, shown };
}

type ViewMode = "read" | "live" | "block" | "source";

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

function sourceLineKind(lineText: string): BlockKind {
  const h = /^(#{1,6})\s/.exec(lineText);
  if (h) return `h${h[1]!.length}` as BlockKind;
  if (/^>\s?/.test(lineText)) return "quote";
  if (/^\s*-\s\[[\sxX]\]\s/.test(lineText)) return "task";
  if (/^\s*\d+\.\s/.test(lineText)) return "ordered";
  if (/^\s*[-*+]\s/.test(lineText)) return "bullet";
  return "text";
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
  sidebarHidden: boolean;
  outline: boolean;
  sidebarWidth: number;
  outlineWidth: number;
  revealSource: boolean;
  strictLineBreaks: boolean;
  timeFormat: string;
  shortcuts: NoteShortcuts;
}
const defaultPrefs: Prefs = {
  spell: false,
  codeTheme: "auto",
  sidebarHidden: false,
  outline: false,
  sidebarWidth: DEFAULT_SIDEBAR_W,
  outlineWidth: DEFAULT_OUTLINE_W,
  revealSource: false,
  strictLineBreaks: false,
  timeFormat: DEFAULT_TIME_FORMAT,
  shortcuts: defaultShortcuts,
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
  const [nonce, setNonce] = useState(0); // 换一篇、或源码模式/换行设置改过后，让所见即所得编辑器重建
  const [mode, setMode] = useState<ViewMode>("live");
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState("");
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");
  const [searchRegex, setSearchRegex] = useState(false);
  const [renaming, setRenaming] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState("");
  const [ctxTarget, setCtxTarget] = useState("");
  const [sideMenu, setSideMenu] = useState<SideMenuTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteItem[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
  const [loaded, setLoaded] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(defaultPrefs);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [timeFormatOpen, setTimeFormatOpen] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [sourceMenu, setSourceMenu] = useState<EditorMenuTarget | null>(null);
  const [resizing, setResizing] = useState<"sidebar" | "outline" | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerWidthRef = useRef(0);
  containerWidthRef.current = containerWidth;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [frontOpen, setFrontOpen] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState<Record<string, boolean>>({});
  const richScroll = useRef(0); // 所见即所得编辑器重建后要恢复到的滚动位置
  const notesRef = useRef<HTMLDivElement>(null);
  const sideListRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const state = useRef({ path, content, dirty, mode });
  state.current = { path, content, dirty, mode };

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      Notes.setPrefs(next);
      return next;
    });
  }, []);

  const all = useMemo(() => flatten(tree), [tree]);
  const hasDirs = useMemo(() => all.some((n) => n.isDir), [all]);
  const refresh = useCallback(
    () =>
      Notes.tree().then((t) => {
        const list = t ?? [];
        setTree(list);
        const valid = new Set(flatten(list).map((n) => n.path));
        setSelected((sel) => sel.filter((p) => valid.has(p)));
      }),
    [],
  );
  const fail = (e: Error) => ctx.toast(e.message, true);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const s = state.current;
    if (!s.path || !s.dirty) return Promise.resolve();
    return Notes.write(s.path, s.content).then(() => {
      if (state.current.path === s.path && state.current.content === s.content) {
        state.current = { ...state.current, dirty: false };
        setDirty(false);
        setSaved(formatTime(new Date(), "HH:mm"));
      }
    }, fail);
  }, []);

  const openNote = async (p: string) => {
    await flush();
    try {
      const text = await Notes.read(p);
      setSourceMenu(null);
      setPath(p);
      setSelected([p]);
      setAnchorPath(p);
      setContent(text);
      setTitle(stem(p.slice(p.lastIndexOf("/") + 1)));
      richScroll.current = 0;
      setNonce((n) => n + 1);
      setDirty(false);
      setSaved("");
      setFrontOpen(false);
      setOutlineCollapsed({});
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
      Notes.setLast(p);
    } catch (e) {
      fail(e as Error);
    }
  };

  /** 新建时放在哪：和当前笔记放一起。 */
  const targetDir = () => dirOf(path);
  const newNote = async (dir = targetDir(), text = "") => {
    try {
      setFilter("");
      const p = await Notes.newNote(dir);
      if (text) await Notes.write(p, text);
      if (dir) setOpen((o) => ({ ...o, [dir]: true }));
      await refresh();
      await openNote(p);
    } catch (e) {
      fail(e as Error);
    }
  };
  const newFolder = async (dir = targetDir()) => {
    try {
      setFilter("");
      const p = await Notes.newFolder(dir);
      await refresh();
      setOpen((o) => ({ ...o, [p]: true, ...(dir ? { [dir]: true } : {}) }));
      setSelected([p]);
      setAnchorPath(p);
      setRenaming(p);
    } catch (e) {
      fail(e as Error);
    }
  };
  const duplicateNote = async (target: string) => {
    if (target === state.current.path) await flush();
    try {
      const text = await Notes.read(target);
      const dir = dirOf(target);
      const base = stem(target.slice(target.lastIndexOf("/") + 1));
      setFilter("");
      const created = await Notes.createNote(dir, `${base} 副本`, text);
      await refresh();
      await openNote(created);
    } catch (e) {
      fail(e as Error);
    }
  };

  /**
   * 带着一段内容进来（选中文字后“存成笔记”、关键词后面跟着内容）：存成一篇新笔记。
   * 同一段内容可能被带进来不止一次（面板重新打开、分离成独立窗口），已经存过就打开那一篇，不再新建。
   */
  const importText = async (text: string, files: Node[]) => {
    const sig = fingerprint(text);
    const prev = await Notes.getImported();
    if (prev?.sig === sig && files.some((f) => f.path === prev.path)) return void openNote(prev.path);
    try {
      const p = await Notes.newNote("");
      await Notes.write(p, text);
      Notes.setImported({ sig, path: p });
      await refresh();
      await openNote(p);
    } catch (e) {
      fail(e as Error);
    }
  };

  useEffect(() => {
    void Promise.all([Notes.tree(), Notes.getMode(), Notes.getPrefs<Partial<Prefs>>(), Notes.getLast()]).then(([t, savedMode, savedPrefs, last]) => {
      if (savedMode === "read" || savedMode === "live" || savedMode === "block" || savedMode === "source") {
        setMode(savedMode);
      } else if (savedMode === "rich") {
        setMode(savedPrefs?.revealSource ? "block" : "live");
      }
      if (savedPrefs && typeof savedPrefs === "object") {
        setPrefs((p) => ({
          ...p,
          ...savedPrefs,
          sidebarWidth: savedPrefs.sidebarWidth ?? DEFAULT_SIDEBAR_W,
          outlineWidth: savedPrefs.outlineWidth ?? DEFAULT_OUTLINE_W,
          strictLineBreaks: savedPrefs.strictLineBreaks ?? false,
          timeFormat: savedPrefs.timeFormat || DEFAULT_TIME_FORMAT,
          shortcuts: { ...defaultShortcuts, ...savedPrefs.shortcuts },
        }));
      }
      const list = t ?? [];
      setTree(list);
      setLoaded(true);
      const files = flatten(list).filter((n) => !n.isDir);
      if (input.trim()) void importText(input, files);
      else {
        const first = files.find((f) => f.path === (last ?? "")) ?? [...files].sort((a, b) => b.modified - a.modified)[0];
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
    state.current = { ...state.current, content: text, dirty: true };
    setContent(text);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };

  const switchMode = (next: ViewMode) => {
    const prev = state.current.mode;
    setHtmlPreview(false);
    setSourceMenu(null);
    if (prev !== "source" && next === "source") {
      richScroll.current = body.current?.querySelector(".fx-notes-rich")?.scrollTop ?? 0;
    }
    setMode(next);
    if (prev === "source" && next !== "source") {
      setNonce((n) => n + 1); // 带着源码模式里改过的内容重建
    }
    if (next === "live" || next === "block") {
      updatePrefs({ revealSource: next === "block" });
    }
    Notes.setMode(next);
  };
  const toggleStrictLineBreaks = () => {
    if (state.current.mode !== "source") {
      richScroll.current = body.current?.querySelector(".fx-notes-rich")?.scrollTop ?? 0;
      setNonce((n) => n + 1);
    }
    updatePrefs({ strictLineBreaks: !prefs.strictLineBreaks });
  };
  const toggleHtmlPreview = () => {
    setMenuOpen(false);
    setSourceMenu(null);
    if (!htmlPreview && state.current.mode === "source") {
      setMode("read");
      setNonce((n) => n + 1);
      Notes.setMode("read");
    }
    setHtmlPreview((v) => !v);
  };

  const applyPath = (from: string, to: string) => {
    const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    // 改名或移动之后，当前打开的笔记和选中状态如果在它下面，路径跟着变。
    const cur = state.current.path;
    if (cur === from || cur.startsWith(from + "/")) {
      const next = remap(cur);
      setPath(next);
      Notes.setLast(next);
    }
    setSelected((sel) => sel.map(remap));
    setAnchorPath((a) => remap(a));
  };
  const rename = async (p: string, name: string) => {
    setRenaming("");
    const node = all.find((n) => n.path === p);
    if (!node || !name.trim() || name.trim() === (node.isDir ? node.name : stem(node.name))) return;
    if (p === path) await flush();
    try {
      const np = await Notes.rename(p, name.trim());
      applyPath(p, np);
      if (node.isDir) {
        setOpen((o) => {
          const next = { ...o };
          for (const [k, v] of Object.entries(o)) {
            if (k === p || k.startsWith(p + "/")) {
              delete next[k];
              next[np + k.slice(p.length)] = v;
            }
          }
          return next;
        });
      }
      if (p === path) setTitle(stem(np.slice(np.lastIndexOf("/") + 1)));
      await refresh();
    } catch (e) {
      fail(e as Error);
      if (p === path) setTitle(stem(node.name));
    }
  };
  const move = async (p: string, dir: string) => {
    if (dirOf(p) === dir || p === dir || (dir && dir.startsWith(p + "/"))) return;
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
  const removePaths = async (paths: string[]) => {
    const removed: string[] = [];
    for (const p of paths) {
      if (state.current.path === p || state.current.path.startsWith(p + "/")) {
        clearTimeout(timer.current);
        state.current = { ...state.current, path: "", content: "", dirty: false };
        setPath("");
        setContent("");
        setDirty(false);
      }
      await Notes.delete(p);
      removed.push(p);
    }
    return removed;
  };
  const finalizeDeleted = async (removed: string[]) => {
    if (removed.length === 0) return;
    setSelected((sel) => sel.filter((p) => !removed.some((r) => p === r || p.startsWith(r + "/"))));
    await refresh();
    ctx.toast(removed.length === 1 ? "已移到废纸篓" : `已将 ${removed.length} 项移到废纸篓`);
  };
  const deleteInline = async (p: string) => {
    clearTimeout(confirmTimer.current);
    setConfirmDelete("");
    try {
      const removed = await removePaths([p]);
      await finalizeDeleted(removed);
    } catch (e) {
      fail(e as Error);
    }
  };
  const askInlineDelete = (p: string) => {
    clearTimeout(confirmTimer.current);
    setConfirmDelete(p);
    confirmTimer.current = setTimeout(() => setConfirmDelete((cur) => (cur === p ? "" : cur)), 2500);
  };
  const requestDelete = (paths: string[]) => {
    clearTimeout(confirmTimer.current);
    setConfirmDelete("");
    const targets = normalizeDeleteTargets(paths);
    if (!targets.length) return;
    const byPath = new Map(all.map((n) => [n.path, n]));
    setPendingDelete(
      targets.map((p) => {
        const node = byPath.get(p);
        return { path: p, label: node ? (node.isDir ? node.name : stem(node.name)) : p, isDir: !!node?.isDir };
      }),
    );
  };
  const confirmBatchDelete = async () => {
    const items = pendingDelete;
    if (!items || items.length === 0 || deleting) return;
    setDeleting(true);
    let removed: string[] = [];
    try {
      removed = await removePaths(items.map((it) => it.path));
    } catch (e) {
      fail(e as Error);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
    await finalizeDeleted(removed);
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
  const pasteToSource = async () => {
    const v = view.current;
    if (!v) return;
    const clip = await editorClipboard.read();
    if (!clip) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: clip }, selection: { anchor: from + clip.length } });
    v.focus();
  };
  const openSourceContextMenu = (e: MouseEvent) => {
    if (mode !== "source") return;
    const v = view.current;
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = v.state.selection.main;
    const clickPos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    const line = v.state.doc.lineAt(clickPos ?? sel.head);
    let linkHref: string | undefined;
    if (clickPos != null) {
      const col = clickPos - line.from;
      const urlRe = /https?:\/\/[^\s<>()[\]"'`]+/g;
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(line.text))) {
        if (col >= m.index && col <= m.index + m[0].length) {
          linkHref = m[0];
          break;
        }
      }
    }
    setSourceMenu({
      x: e.clientX,
      y: e.clientY,
      readonly: false,
      hasSelection: sel.from !== sel.to,
      canCopyMarkdown: false,
      linkHref,
      currentBlockKind: sourceLineKind(line.text),
      canConvertBlock: true,
    });
  };
  const sourceMenuActions: EditorMenuActions = {
    onOpenLink: (href) => openLink(href),
    onCopyLink: (href) => void ctx.copy(href, "已复制链接"),
    onCut: () => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      if (from === to) return;
      void editorClipboard.write(v.state.sliceDoc(from, to));
      v.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
      v.focus();
    },
    onCopy: () => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      if (from !== to) void editorClipboard.write(v.state.sliceDoc(from, to));
      v.focus();
    },
    onPaste: () => void pasteToSource(),
    onPastePlain: () => void pasteToSource(),
    onSelectAll: () => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
      v.focus();
    },
    onFormat: (kind) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const res = applySourceFormat(v.state.doc.toString(), from, to, kind);
      v.dispatch({ changes: { from: res.from, to: res.to, insert: res.insert }, selection: { anchor: res.anchor, head: res.head } });
      v.focus();
    },
    onParagraph: (kind) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const res = applySourceParagraph(v.state.doc.toString(), from, to, kind);
      v.dispatch({ changes: { from: res.from, to: res.to, insert: res.insert }, selection: { anchor: res.anchor, head: res.head } });
      v.focus();
    },
    onInsert: (kind) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const line = v.state.doc.lineAt(from);
      const emptyLine = v.state.sliceDoc(line.from, from).trim() === "";
      const { insert: snippet, cursorOffset } = buildSourceInsert(kind, prefs.timeFormat, emptyLine);
      v.dispatch({ changes: { from, to, insert: snippet }, selection: { anchor: from + cursorOffset } });
      v.focus();
    },
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
  const openOutside = (how: "open" | "openWith" | "reveal", target = path) => {
    setMenuOpen(false);
    const ready = target === state.current.path ? flush() : Promise.resolve();
    void ready.then(() => Notes[how](target)).catch(fail);
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

  // 监测整体容器宽度，窗口缩窄时自动钳位左右两栏宽而不破坏已保存的偏好宽度。
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setContainerWidth(Math.max(0, Math.round(w)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sidebarOpen = !prefs.sidebarHidden;
  const outlineOpen = prefs.outline && !!path;
  const sideAnim = useAnimatedPanel(sidebarOpen, loaded);
  const outlineAnim = useAnimatedPanel(outlineOpen, loaded);

  const savedSideW = prefs.sidebarWidth || DEFAULT_SIDEBAR_W;
  const savedOutlineW = prefs.outlineWidth || DEFAULT_OUTLINE_W;
  const canResetWidths = savedSideW !== DEFAULT_SIDEBAR_W || savedOutlineW !== DEFAULT_OUTLINE_W;
  const widths = computePanelWidths({
    containerWidth,
    sidebarOpen,
    outlineOpen,
    sidebarWidth: resizing === "sidebar" && dragWidth !== null ? dragWidth : savedSideW,
    outlineWidth: resizing === "outline" && dragWidth !== null ? dragWidth : savedOutlineW,
  });

  const resetWidths = () => {
    setMenuOpen(false);
    updatePrefs({ sidebarWidth: DEFAULT_SIDEBAR_W, outlineWidth: DEFAULT_OUTLINE_W });
    ctx.toast("已恢复默认栏宽");
  };

  const startResize = (which: "sidebar" | "outline", e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = which === "sidebar" ? widths.sidebar : widths.outline;
    const otherW = which === "sidebar" ? widths.outline : widths.sidebar;
    const otherOpen = which === "sidebar" ? outlineOpen : sidebarOpen;
    let latest = startW;
    setResizing(which);
    setDragWidth(startW);

    const onMove = (ev: PointerEvent) => {
      const delta = which === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
      latest = clampDragWidth({
        which,
        rawWidth: startW + delta,
        containerWidth: containerWidthRef.current,
        otherWidth: otherW,
        otherOpen,
      });
      setDragWidth(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setResizing(null);
      setDragWidth(null);
      if (latest !== startW) {
        updatePrefs(which === "sidebar" ? { sidebarWidth: latest } : { outlineWidth: latest });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // 所见即所得模式下，frontmatter 摘出来单独编辑，编辑器只管正文。
  const split = useMemo(() => splitFrontmatter(content), [content]);
  const front = useRef(split);
  front.current = split;
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  const sourceExtensions = useMemo(() => [linkOpener((href) => openLinkRef.current(href)), noteLineKeys(() => prefsRef.current.shortcuts)], []);
  const outlineActive = outlineOpen || outlineAnim.mounted;
  const [derivedBody, setDerivedBody] = useState(() => split.body);
  const [derivedContent, setDerivedContent] = useState(() => content);
  const derivedKeyRef = useRef(`${path}#${nonce}`);
  useEffect(() => {
    const nextKey = `${path}#${nonce}`;
    if (derivedKeyRef.current !== nextKey) {
      derivedKeyRef.current = nextKey;
      setDerivedBody(split.body);
      setDerivedContent(content);
      return;
    }
    const timer = window.setTimeout(() => {
      setDerivedBody(split.body);
      setDerivedContent(content);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [content, split.body, path, nonce]);
  const splitBodyRef = useRef(split.body);
  splitBodyRef.current = split.body;
  useEffect(() => {
    if (outlineOpen) setDerivedBody(splitBodyRef.current);
  }, [outlineOpen]);

  const headings = useMemo(() => (outlineActive ? outlineOf(derivedBody) : []), [outlineActive, derivedBody]);
  const jumpRef = useRef<{ seq: number; raf1: number; raf2: number }>({ seq: 0, raf1: 0, raf2: 0 });
  useEffect(
    () => () => {
      cancelAnimationFrame(jumpRef.current.raf1);
      cancelAnimationFrame(jumpRef.current.raf2);
    },
    [],
  );
  const jumpHeading = (index: number) => {
    const heading = headings[index];
    if (!heading) return;
    if (mode === "source" && view.current) {
      const at = Math.min(content.length, content.length - split.body.length + heading.from);
      view.current.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
      view.current.focus();
      return;
    }
    setHtmlPreview(false);
    const seq = ++jumpRef.current.seq;
    cancelAnimationFrame(jumpRef.current.raf1);
    cancelAnimationFrame(jumpRef.current.raf2);
    const align = (settleLeft: number) => {
      if (seq !== jumpRef.current.seq) return;
      const root = body.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6"),
      ).filter((el) => !el.closest(".pocket-html-live:not(.pocket-html-block)"));
      const el = items[index];
      if (!el) return;
      const target =
        el.style.display === "none" && el.previousElementSibling?.classList.contains("pocket-block-source")
          ? (el.previousElementSibling as HTMLElement)
          : el;
      const scroller = root.querySelector<HTMLElement>(".fx-notes-rich");
      if (!scroller) {
        target.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const delta = target.getBoundingClientRect().top - scrollerRect.top - 10;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.max(0, Math.min(maxTop, scroller.scrollTop + delta));
      if (Math.abs(nextTop - scroller.scrollTop) < 1) return;
      scroller.scrollTo({ top: nextTop, behavior: "instant" });
      if (settleLeft > 0) {
        jumpRef.current.raf2 = requestAnimationFrame(() => align(settleLeft - 1));
      }
    };
    jumpRef.current.raf1 = requestAnimationFrame(() => align(2));
  };

  useEffect(() => {
    if (!renaming) return;
    let raf1 = 0;
    let raf2 = 0;
    const focusRename = () => {
      const el = renameRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, el.value.length, "forward");
    };
    raf1 = requestAnimationFrame(() => {
      focusRename();
      raf2 = requestAnimationFrame(focusRename);
    });
    const onOutsideMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.(".fx-side-rename")) {
        renameRef.current?.blur();
      }
    };
    document.addEventListener("mousedown", onOutsideMouseDown, true);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      document.removeEventListener("mousedown", onOutsideMouseDown, true);
    };
  }, [renaming]);

  const stats = useMemo(() => count(derivedContent), [derivedContent]);
  const outlineNodes = useMemo(() => outlineTree(headings), [headings]);
  const searchMatcher = useMemo(() => compileFileSearch(filter, searchRegex), [filter, searchRegex]);
  const matches = useMemo(
    () => (searchMatcher ? all.filter((n) => !n.isDir && (searchMatcher.test(n.name) || searchMatcher.test(stem(n.name)))) : null),
    [all, searchMatcher],
  );
  const visiblePaths = useMemo(() => visibleTreePaths(tree, open, matches), [tree, open, matches]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const setDirsOpen = (roots: string[], expand: boolean) => {
    const targets = collectNestedDirs(tree, roots);
    if (targets.length === 0) return;
    setOpen((o) => {
      const next = { ...o };
      for (const d of targets) {
        if (expand) next[d] = true;
        else delete next[d];
      }
      return next;
    });
  };
  const expandAllDirs = (expand: boolean) => {
    if (!expand) {
      setOpen({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const n of all) if (n.isDir) next[n.path] = true;
    setOpen(next);
  };

  const handleItemClick = (n: Node, e: MouseEvent) => {
    if (renaming === n.path) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      sideListRef.current?.focus();
      setSelected((sel) => (sel.includes(n.path) ? sel.filter((p) => p !== n.path) : [...sel, n.path]));
      setAnchorPath(n.path);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      sideListRef.current?.focus();
      const anchor = anchorPath || path || n.path;
      setSelected(selectRange(visiblePaths, anchor, n.path));
      if (!anchorPath) setAnchorPath(anchor);
      return;
    }
    setSelected([n.path]);
    setAnchorPath(n.path);
    if (n.isDir) setOpen((o) => ({ ...o, [n.path]: !open[n.path] }));
    else if (n.path !== path) void openNote(n.path);
  };

  const handleItemContextMenu = (n: Node, e: MouseEvent) => {
    if ((e.target as Element)?.closest?.(".fx-side-rename")) return;
    e.preventDefault();
    e.stopPropagation();
    sideListRef.current?.focus();
    if (selectedSet.has(n.path) && selected.length > 1) {
      const dirRoots = filterDirPaths(tree, selected);
      setCtxTarget("");
      setSideMenu({ kind: "batch", paths: selected, dirRoots, nestedDirs: collectNestedDirs(tree, dirRoots), x: e.clientX, y: e.clientY });
      return;
    }
    setCtxTarget(n.path);
    if (n.isDir) setSideMenu({ kind: "dir", node: n, nestedDirs: collectNestedDirs(tree, [n.path]), x: e.clientX, y: e.clientY });
    else setSideMenu({ kind: "file", node: n, x: e.clientX, y: e.clientY });
  };

  const sideMenuActions: SideMenuActions = {
    onNewNote: (dir) => void newNote(dir),
    onNewFolder: (dir) => void newFolder(dir),
    onExpandAll: expandAllDirs,
    onSetDirsOpen: setDirsOpen,
    onOpenNote: (p) => void openNote(p),
    onRename: (p) => setRenaming(p),
    onDuplicate: (p) => void duplicateNote(p),
    onMoveToRoot: (p) => void move(p, ""),
    onCopyName: (node) => void ctx.copy(node.isDir ? node.name : stem(node.name), "已复制文件名"),
    onCopyPath: (p) => void ctx.copy(p, "已复制路径"),
    onCopyFullPath: (p) => void Notes.abs(p).then((abs) => ctx.copy(abs, "已复制完整路径"), fail),
    onCopyContent: (p) => {
      if (p === state.current.path) void ctx.copy(state.current.content, "已复制 Markdown");
      else void Notes.read(p).then((text) => ctx.copy(text, "已复制 Markdown"), fail);
    },
    onOpenOutside: (p, how) => openOutside(how, p),
    onRevealRoot: () => void Notes.reveal(""),
    onRefresh: () => void refresh(),
    onResetWidths: resetWidths,
    onDelete: requestDelete,
    onClearSelection: () => setSelected(path ? [path] : []),
  };

  const item = (n: Node, depth: number) => {
    const active = n.path === path;
    const picked = selectedSet.has(n.path) && (selected.length > 1 || n.isDir || !active);
    const expanded = !!open[n.path];
    const confirming = confirmDelete === n.path;
    const ctxFocused = ctxTarget === n.path;
    return (
      <div key={n.path}>
        <div
          class={`fx-side-item${active ? " is-selected" : ""}${picked ? " is-picked" : ""}${ctxFocused ? " is-ctx-target" : ""}${confirming ? " is-confirming" : ""}${dragOver === n.path ? " is-drop" : ""}`}
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
          onClick={(e) => handleItemClick(n, e as unknown as MouseEvent)}
          onContextMenu={(e) => handleItemContextMenu(n, e as unknown as MouseEvent)}
        >
          {n.isDir ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span class="fx-side-indent" />}
          {n.isDir ? <Folder size={13} /> : <FileText size={13} />}
          {renaming === n.path ? (
            <input
              ref={renameRef}
              class="fx-side-rename"
              defaultValue={n.isDir ? n.name : stem(n.name)}
              spellcheck={false}
              onClick={(e) => e.stopPropagation()}
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
              <span class="fx-side-tools" onClick={(e) => e.stopPropagation()}>
                {n.isDir && (
                  <button type="button" class="fx-side-del" title="在这个文件夹里新建笔记" onClick={() => { setOpen((o) => ({ ...o, [n.path]: true })); void newNote(n.path); }}>
                    <Plus size={12} />
                  </button>
                )}
                <button type="button" class="fx-side-del" title="改名" onClick={() => setRenaming(n.path)}>
                  <Pencil size={11} />
                </button>
                <button
                  type="button"
                  class={`fx-side-del${confirming ? " is-confirm" : ""}`}
                  title={confirming ? "再点一次确认移到废纸篓" : "删除（移到废纸篓）"}
                  onClick={() => (confirming ? void deleteInline(n.path) : askInlineDelete(n.path))}
                >
                  {confirming ? "确认" : <Trash2 size={12} />}
                </button>
              </span>
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
    <div class={`fx-page fx-notes${resizing ? " is-resizing" : ""}`} ref={notesRef}>
      <aside
        class={`fx-out fx-side${sideAnim.shown ? "" : " is-collapsed"}`}
        hidden={!sideAnim.mounted}
        style={{ width: `${widths.sidebar}px` }}
      >
        <div class="fx-side-head fx-side-toolbar">
          <Btn small ghost icon title="收起文件栏" onClick={() => updatePrefs({ sidebarHidden: true })}>
            <PanelLeftClose size={15} />
          </Btn>
          <span class="fx-spacer" />
          <Btn small ghost icon title="新建文件夹" onClick={() => void newFolder()}>
            <FolderPlus size={14} />
          </Btn>
          <Btn small ghost icon title="新建笔记" onClick={() => void newNote()}>
            <Plus size={14} />
          </Btn>
        </div>
        <div class="fx-side-search-row">
          <label class={`fx-side-search${searchMatcher?.invalid ? " is-invalid" : ""}`}>
            <Search size={12} />
            <input
              placeholder="搜索笔记"
              value={filter}
              spellcheck={false}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              class={`fx-side-regex${searchRegex ? " is-active" : ""}`}
              title="使用正则表达式搜索"
              aria-label="使用正则表达式搜索"
              aria-pressed={searchRegex}
              onClick={(e) => {
                e.preventDefault();
                setSearchRegex((v) => !v);
              }}
            >
              .*
            </button>
            {filter && (
              <button type="button" class="fx-side-clear" title="清空搜索" aria-label="清空搜索" onClick={() => setFilter("")}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        <div
          ref={sideListRef}
          tabIndex={0}
          class={`fx-side-list${dragOver === "" ? " is-drop" : ""}`}
          onClick={(e) => {
            setConfirmDelete("");
            if (e.target === e.currentTarget) setSelected(path ? [path] : []);
          }}
          onContextMenu={(e) => {
            if ((e.target as Element)?.closest?.(".fx-side-rename")) return;
            e.preventDefault();
            sideListRef.current?.focus();
            setCtxTarget("");
            setConfirmDelete("");
            setSideMenu({ kind: "empty", x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => {
            if (renaming || pendingDelete || sideMenu) return;
            if ((e.target as Element)?.closest?.("input, textarea, [contenteditable]")) return;
            if (e.key === "Delete" || (ctx.platform === "darwin" && e.metaKey && e.key === "Backspace")) {
              const targets = selected.length > 0 ? selected : path ? [path] : [];
              if (targets.length > 0) {
                e.preventDefault();
                requestDelete(targets);
              }
            }
          }}
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
          {selected.length > 1 && <span class="fx-side-selcount">已选 {selected.length} 项</span>}
        </div>
      </aside>
      <div
        class={`fx-notes-resizer${sideAnim.shown ? "" : " is-collapsed"}${resizing === "sidebar" ? " is-active" : ""}`}
        hidden={!sideAnim.mounted}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件栏宽度"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={(e) => startResize("sidebar", e as unknown as PointerEvent)}
        onDblClick={() => updatePrefs({ sidebarWidth: DEFAULT_SIDEBAR_W })}
      />

      {!path ? (
        <div class="fx-notes-main">
          {prefs.sidebarHidden && (
            <div class="fx-notes-empty-head">
              <Btn small ghost icon title="展开文件栏" onClick={() => updatePrefs({ sidebarHidden: false })}>
                <PanelLeftOpen size={15} />
              </Btn>
            </div>
          )}
          <div class="fx-out fx-grow-1 fx-scratch-empty">
            {loaded && (
              <Empty title="随手记点什么" desc="笔记自动保存成 Markdown 文件，文件名带着日期。">
                <Btn primary onClick={() => void newNote("")}>
                  <Plus size={14} /> 新建笔记
                </Btn>
              </Empty>
            )}
          </div>
        </div>
      ) : (
        <div class="fx-notes-main">
          <div class="fx-notes-head">
            {prefs.sidebarHidden && (
              <Btn small ghost icon title="展开文件栏" onClick={() => updatePrefs({ sidebarHidden: false })}>
                <PanelLeftOpen size={15} />
              </Btn>
            )}
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
            <div class="fx-notes-head-tools">
              <Btn small ghost icon title="复制全文（Markdown）" onClick={() => void ctx.copy(content)}>
                <Copy size={14} />
              </Btn>
              <div class="fx-notes-more">
                <Btn small ghost icon title="更多：打开方式、另存为、排版与设置" onClick={() => setMenuOpen((o) => !o)}>
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
                    <button type="button" role="menuitem" class="fx-menu-item" disabled={!canResetWidths} onClick={resetWidths}>
                      <RotateCcw size={14} />
                      <span>恢复默认栏宽</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="fx-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setTimeFormatOpen(false);
                        setShortcutOpen((o) => !o);
                      }}
                    >
                      <Keyboard size={14} />
                      <span>自定义快捷键…</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="fx-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setShortcutOpen(false);
                        setTimeFormatOpen((o) => !o);
                      }}
                    >
                      <Clock size={14} />
                      <span>时间格式…</span>
                    </button>
                    <div class="fx-menu-sep" />
                    <button type="button" role="menuitemcheckbox" aria-checked={prefs.strictLineBreaks} class="fx-menu-item" onClick={toggleStrictLineBreaks}>
                      <Pilcrow size={14} />
                      <span>严格换行</span>
                      {prefs.strictLineBreaks && <Check size={12} class="fx-menu-check" />}
                    </button>
                    <button type="button" role="menuitemcheckbox" aria-checked={prefs.spell} class="fx-menu-item" onClick={() => updatePrefs({ spell: !prefs.spell })}>
                      <SpellCheck size={14} />
                      <span>拼写检查</span>
                      {prefs.spell && <Check size={12} class="fx-menu-check" />}
                    </button>
                    <button type="button" role="menuitemcheckbox" aria-checked={htmlPreview} class="fx-menu-item" onClick={toggleHtmlPreview}>
                      <Eye size={14} />
                      <span>HTML 沙箱预览</span>
                      {htmlPreview && <Check size={12} class="fx-menu-check" />}
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
              <Seg
                value={mode}
                options={[
                  { value: "read", label: "阅读" },
                  { value: "live", label: "实时" },
                  { value: "block", label: "整块" },
                  { value: "source", label: "源码" },
                ]}
                onChange={switchMode}
              />
              {!prefs.outline && (
                <Btn small ghost icon title="大纲" onClick={() => updatePrefs({ outline: true })}>
                  <ListTree size={15} />
                </Btn>
              )}
            </div>
          </div>
          {shortcutOpen && <div class="pocket-note-shortcuts" role="region" aria-label="笔记快捷键设置">
            {(["above", "below"] as const).map((action) => <label key={action}>
              <span>{action === "above" ? "在上方插入新行" : "在下方插入新行"}</span>
              <input readOnly value={prefs.shortcuts[action]} aria-label={action === "above" ? "上方插行快捷键" : "下方插行快捷键"} title="点击后按下新快捷键，Esc 取消" onKeyDown={(e) => {
                e.preventDefault(); e.stopPropagation();
                if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); return; }
                if (e.isComposing) return;
                const key = shortcutOf(e);
                if (!key) return;
                if (!e.ctrlKey && !e.metaKey && !e.altKey) return ctx.toast("快捷键需要包含 Ctrl、⌘ 或 Alt", true);
                if (key === prefs.shortcuts[action === "above" ? "below" : "above"]) return ctx.toast("两个动作不能使用同一个快捷键", true);
                updatePrefs({ shortcuts: { ...prefs.shortcuts, [action]: key } });
              }} />
            </label>)}
            <Btn small onClick={() => updatePrefs({ shortcuts: defaultShortcuts })}>恢复默认</Btn>
            <Btn small onClick={() => setShortcutOpen(false)}>完成</Btn>
          </div>}
          {timeFormatOpen && (
            <div class="pocket-note-shortcuts pocket-time-format" role="region" aria-label="时间格式设置">
              <label>
                <span>时间格式</span>
                <input
                  value={prefs.timeFormat}
                  placeholder={DEFAULT_TIME_FORMAT}
                  aria-label="时间格式模板"
                  title="支持 YYYY YY MM M DD D HH H mm m ss s ddd dddd"
                  onInput={(e) => updatePrefs({ timeFormat: (e.target as HTMLInputElement).value })}
                />
              </label>
              <span class="pocket-time-preview">示例：{formatTime(new Date(), prefs.timeFormat)}</span>
              <div class="pocket-time-presets">
                {TIME_FORMAT_PRESETS.map((preset) => (
                  <Btn
                    key={preset}
                    small
                    primary={(prefs.timeFormat || DEFAULT_TIME_FORMAT) === preset}
                    onClick={() => updatePrefs({ timeFormat: preset })}
                  >
                    {preset}
                  </Btn>
                ))}
              </div>
              <Btn small onClick={() => updatePrefs({ timeFormat: DEFAULT_TIME_FORMAT })}>恢复默认</Btn>
              <Btn small onClick={() => setTimeFormatOpen(false)}>完成</Btn>
            </div>
          )}
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
          {mode !== "source" && split.front !== null && (
            <div class={`fx-notes-front${frontOpen ? " is-open" : ""}`}>
              <button type="button" class="fx-notes-front-head" title="文档开头 --- 之间的属性（frontmatter）" onClick={() => setFrontOpen((o) => !o)}>
                {frontOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="fx-notes-front-label">文档属性</span>
                {!frontOpen && <span class="fx-notes-front-keys">{frontSummary(split.front)}</span>}
              </button>
              {frontOpen && (
                <textarea
                  class="fx-notes-front-text"
                  readOnly={mode === "read"}
                  spellcheck={false}
                  rows={Math.min(10, Math.max(2, split.front.split("\n").length))}
                  value={split.front}
                  onInput={(e) => edit(joinFrontmatter((e.target as HTMLTextAreaElement).value, split.body, split))}
                />
              )}
            </div>
          )}
          <div class="fx-out fx-notes-body" ref={body} data-code-theme={prefs.codeTheme} onContextMenu={openSourceContextMenu}>
            {mode !== "source" ? (
              <RichEditor
                key={`${path}#${nonce}`}
                value={split.body}
                viewMode={mode as RichViewMode}
                strictLineBreaks={prefs.strictLineBreaks}
                timeFormat={prefs.timeFormat}
                platform={ctx.platform}
                shortcuts={prefs.shortcuts}
                htmlPreview={htmlPreview}
                onChange={(md) => edit(joinFrontmatter(front.current.front, md, front.current))}
                spellcheck={prefs.spell}
                onOpenLink={openLink}
                onCopy={ctx.copy}
                onToast={ctx.toast}
                onExitHtmlPreview={() => setHtmlPreview(false)}
                scrollTop={richScroll.current}
              />
            ) : (
              <CodeEditor key={path} value={content} lang="markdown" wrap onChange={edit} onReady={(v) => (view.current = v)} onCursor={setCursor} autoFocus extensions={sourceExtensions} />
            )}
            {mode === "source" && sourceMenu && (
              <EditorContextMenu
                menu={sourceMenu}
                platform={ctx.platform}
                timeFormat={prefs.timeFormat}
                actions={sourceMenuActions}
                onClose={() => setSourceMenu(null)}
              />
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
      <div
        class={`fx-notes-resizer${outlineAnim.shown ? "" : " is-collapsed"}${resizing === "outline" ? " is-active" : ""}`}
        hidden={!outlineAnim.mounted}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整大纲宽度"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={(e) => startResize("outline", e as unknown as PointerEvent)}
        onDblClick={() => updatePrefs({ outlineWidth: DEFAULT_OUTLINE_W })}
      />
      <nav
        class={`fx-out pocket-note-outline${outlineAnim.shown ? "" : " is-collapsed"}`}
        aria-label="笔记大纲"
        hidden={!outlineAnim.mounted}
        style={{ width: `${widths.outline}px` }}
      >
        <div class="fx-side-head">
          <span>大纲</span>
          <span class="fx-spacer" />
          <Btn small ghost icon title="收起大纲" onClick={() => updatePrefs({ outline: false })}>
            <PanelRightClose size={14} />
          </Btn>
        </div>
        <div class="fx-side-list">
          {outlineNodes.length ? (
            <div class="pocket-outline-tree">
              {(() => {
                const renderNodes = (nodes: OutlineNode[]) =>
                  nodes.map((node) => {
                    const nodeKey = `${node.heading.level}:${node.index}`;
                    const hasChildren = node.children.length > 0;
                    const collapsed = !!outlineCollapsed[nodeKey];
                    const toggle = () => setOutlineCollapsed((prev) => ({ ...prev, [nodeKey]: !prev[nodeKey] }));
                    return (
                      <div key={`${node.heading.from}-${node.index}`} class="pocket-outline-node">
                        <div class="pocket-outline-row">
                          {hasChildren ? (
                            <span
                              role="button"
                              tabIndex={0}
                              class="pocket-outline-toggle"
                              aria-label={collapsed ? "展开子标题" : "折叠子标题"}
                              aria-expanded={!collapsed}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggle();
                                }
                              }}
                            >
                              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                            </span>
                          ) : (
                            <span class="pocket-outline-spacer" />
                          )}
                          <button type="button" class="pocket-outline-label" onClick={() => jumpHeading(node.index)} title={node.heading.text}>
                            {node.heading.text || "（空标题）"}
                          </button>
                        </div>
                        {hasChildren && !collapsed && <div class="pocket-outline-children">{renderNodes(node.children)}</div>}
                      </div>
                    );
                  });
                return renderNodes(outlineNodes);
              })()}
            </div>
          ) : (
            <div class="fx-side-empty">使用 # 标题后会显示在这里</div>
          )}
        </div>
      </nav>
      {sideMenu && (
        <SideContextMenu
          menu={sideMenu}
          currentPath={path}
          openDirs={open}
          hasDirs={hasDirs}
          canResetWidths={canResetWidths}
          actions={sideMenuActions}
          onClose={() => {
            setSideMenu(null);
            setCtxTarget("");
          }}
        />
      )}
      {pendingDelete && (
        <DeleteConfirmModal
          items={pendingDelete}
          busy={deleting}
          onConfirm={() => void confirmBatchDelete()}
          onCancel={() => !deleting && setPendingDelete(null)}
        />
      )}
    </div>
  );
}
