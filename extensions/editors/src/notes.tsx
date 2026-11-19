import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { EditorView } from "@codemirror/view";
import {
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  Eye,
  File as FileIcon,
  FileOutput,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heading,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListChecks,
  ListTree,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Pencil,
  Pilcrow,
  Plus,
  Quote,
  RotateCcw,
  Search,
  Settings,
  SpellCheck,
  SquareArrowOutUpRight,
  Table,
  Trash2,
  X,
} from "lucide-preact";
import { editorClipboard, isImageFile, isMarkdownFile, Notes, openExternal, type FeatureProps, type FsChange, type Node } from "./host";
import { CodeEditor, linkOpener } from "./code/editor";
import { Btn, Empty, Seg } from "../../../src/features/ui";
import { applySourceFormat, applySourceParagraph, buildSourceInsert, type BlockKind } from "./notes/blockops";
import { EditorContextMenu, type EditorMenuActions, type EditorMenuTarget } from "./notes/editormenu";
import { FindReplaceBar } from "./notes/findbar";
import {
  codeFindExtension,
  getCodeFindStats,
  replaceAllCode,
  replaceCurrentCode,
  setCodeFindQuery,
  stepCodeFind,
  type FindQuery,
  type FindStats,
} from "./notes/findreplace";
import { frontSummary, joinFrontmatter, splitFrontmatter } from "./notes/frontmatter";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  normalizeHighlightColor,
  normalizeHighlightHistory,
  normalizeHighlightOpacity,
  pushHighlightHistory,
  resolveHighlightVars,
  type HighlightColorId,
} from "./notes/highlights";
import {
  ImageRenameModal,
  blobToBase64,
  buildImageFilename,
  defaultImagePrefs,
  normalizeImagePrefs,
  persistImage,
  resolveImageDir,
  type ImagePrefs,
  type PendingImageInput,
} from "./notes/images";
import {
  applySourceIndent,
  defaultShortcuts,
  insertLine,
  matchShortcutAction,
  normalizeShortcuts,
  noteLineKeys,
  type NoteShortcuts,
  type ShortcutActionId,
} from "./notes/shortcuts";
import {
  formatOutlineItemCopy,
  formatOutlineTreeCopy,
  outlineTree,
  richOutlineOf,
  type OutlineInline,
  type OutlineNode,
  type RichOutlineHeading,
} from "./notes/outline";
import { RichEditor, type RichHandle, type RichViewMode } from "./notes/rich";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_MAX_WIDTH,
  DEFAULT_OUTLINE_FONT_SIZE,
  DEFAULT_SIDEBAR_FONT_SIZE,
  NotesSettingsModal,
  type SettingsTabId,
} from "./notes/settingsmodal";
import { anchorToSourceOffset, sourceOffsetToAnchor, type EditorAnchor } from "./notes/syncpos";
import { DEFAULT_TIME_FORMAT, formatTime } from "./notes/timefmt";
import {
  DEFAULT_OUTLINE_BOUNDS,
  DEFAULT_OUTLINE_W,
  DEFAULT_SIDEBAR_BOUNDS,
  DEFAULT_SIDEBAR_W,
  clampDragWidth,
  collectNestedDirs,
  compileFileSearch,
  computePanelWidths,
  filterDirPaths,
  normalizeDeleteTargets,
  normalizePanelBounds,
  selectRange,
  visibleTreePaths,
  type PanelBounds,
} from "./notes/sidebar";
import {
  DeleteConfirmModal,
  OutlineContextMenu,
  SideContextMenu,
  type OutlineMenuTarget,
  type PendingDeleteItem,
  type SideMenuActions,
  type SideMenuTarget,
} from "./notes/sidemenu";
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

const STATUS_WIDTH_PRESETS: readonly { label: string; desc: string; value: number }[] = [
  { label: "紧凑", desc: "680px", value: 680 },
  { label: "标准（默认）", desc: "820px", value: 820 },
  { label: "宽屏", desc: "960px", value: 960 },
  { label: "超宽", desc: "1120px", value: 1120 },
  { label: "铺满", desc: "无限制", value: 0 },
];
const WIDTH_SLIDER_MIN = 480;
const WIDTH_SLIDER_MAX = 1600;
const WIDTH_SLIDER_TICKS: readonly { label: string; value: number; pct: number }[] = [
  { label: "680px", value: 680, pct: ((680 - WIDTH_SLIDER_MIN) / (WIDTH_SLIDER_MAX - WIDTH_SLIDER_MIN)) * 100 },
  { label: "820px", value: 820, pct: ((820 - WIDTH_SLIDER_MIN) / (WIDTH_SLIDER_MAX - WIDTH_SLIDER_MIN)) * 100 },
  { label: "960px", value: 960, pct: ((960 - WIDTH_SLIDER_MIN) / (WIDTH_SLIDER_MAX - WIDTH_SLIDER_MIN)) * 100 },
  { label: "1120px", value: 1120, pct: ((1120 - WIDTH_SLIDER_MIN) / (WIDTH_SLIDER_MAX - WIDTH_SLIDER_MIN)) * 100 },
  { label: "铺满", value: 0, pct: 100 },
];

interface Prefs {
  /** 拼写检查（单词下面的红色波浪线）。默认关。 */
  spell: boolean;
  codeTheme: string;
  highlightColor: HighlightColorId;
  highlightOpacity: number;
  highlightHistory: string[];
  sidebarFontSize: number;
  editorFontSize: number;
  outlineFontSize: number;
  /** 编辑区正文最大宽度（px）；0 表示铺满窗口。 */
  editorMaxWidth: number;
  sidebarHidden: boolean;
  outline: boolean;
  sidebarWidth: number;
  outlineWidth: number;
  sidebarBounds: PanelBounds;
  outlineBounds: PanelBounds;
  revealSource: boolean;
  strictLineBreaks: boolean;
  timeFormat: string;
  imagePrefs: ImagePrefs;
  shortcuts: NoteShortcuts;
}
const defaultPrefs: Prefs = {
  spell: false,
  codeTheme: "auto",
  highlightColor: DEFAULT_HIGHLIGHT_COLOR,
  highlightOpacity: DEFAULT_HIGHLIGHT_OPACITY,
  highlightHistory: [],
  sidebarFontSize: DEFAULT_SIDEBAR_FONT_SIZE,
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
  outlineFontSize: DEFAULT_OUTLINE_FONT_SIZE,
  editorMaxWidth: DEFAULT_EDITOR_MAX_WIDTH,
  sidebarHidden: false,
  outline: false,
  sidebarWidth: DEFAULT_SIDEBAR_W,
  outlineWidth: DEFAULT_OUTLINE_W,
  sidebarBounds: { ...DEFAULT_SIDEBAR_BOUNDS },
  outlineBounds: { ...DEFAULT_OUTLINE_BOUNDS },
  revealSource: false,
  strictLineBreaks: false,
  timeFormat: DEFAULT_TIME_FORMAT,
  imagePrefs: { ...defaultImagePrefs },
  shortcuts: { ...defaultShortcuts },
};

function positiveFontSize(val: unknown, fallback: number): number {
  return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : fallback;
}

function normalizeEditorMaxWidth(val: unknown): number {
  if (val === 0) return 0;
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return Math.round(val);
  return DEFAULT_EDITOR_MAX_WIDTH;
}

interface FilteredOutlineNode {
  node: OutlineNode<RichOutlineHeading>;
  matched: boolean;
  children: FilteredOutlineNode[];
}

function filterOutlineNodes(nodes: OutlineNode<RichOutlineHeading>[], rawQuery: string): FilteredOutlineNode[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    const wrap = (list: OutlineNode<RichOutlineHeading>[]): FilteredOutlineNode[] =>
      list.map((node) => ({ node, matched: false, children: wrap(node.children) }));
    return wrap(nodes);
  }
  const walk = (list: OutlineNode<RichOutlineHeading>[]): FilteredOutlineNode[] => {
    const out: FilteredOutlineNode[] = [];
    for (const node of list) {
      const matched = node.heading.text.toLowerCase().includes(q);
      const children = walk(node.children);
      if (matched || children.length > 0) out.push({ node, matched, children });
    }
    return out;
  };
  return walk(nodes);
}

interface PendingImageRename {
  input: PendingImageInput;
  initialName: string;
  previewDataUrl: string;
  targetHint: string;
  insert: (markdownUrl: string, alt: string) => void;
}

function renderOutlineInlines(inlines: OutlineInline[]) {
  return inlines.map((node, i) => {
    if (node.type === "text") return node.value;
    const children = renderOutlineInlines(node.children);
    switch (node.type) {
      case "strong":
        return <strong key={i}>{children}</strong>;
      case "em":
        return <em key={i}>{children}</em>;
      case "del":
        return <del key={i}>{children}</del>;
      case "code":
        return <code key={i}>{children}</code>;
      case "mark":
        return <mark key={i} class="md-mark">{children}</mark>;
      case "u":
        return <u key={i}>{children}</u>;
      case "sup":
        return <sup key={i}>{children}</sup>;
      case "sub":
        return <sub key={i}>{children}</sub>;
    }
  });
}

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
  const [settingsTab, setSettingsTab] = useState<SettingsTabId | null>(null);
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
  const [outlineQuery, setOutlineQuery] = useState("");
  const [outlineSelected, setOutlineSelected] = useState<number | null>(null);
  const [outlineMenu, setOutlineMenu] = useState<OutlineMenuTarget | null>(null);
  const [widthMenuOpen, setWidthMenuOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [findQuery, setFindQuery] = useState<FindQuery>({ query: "", caseSensitive: false, wholeWord: false, regex: false });
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;
  const [findReplaceText, setFindReplaceText] = useState("");
  const [findStats, setFindStats] = useState<FindStats>({ total: 0, current: 0 });
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [pendingImgRename, setPendingImgRename] = useState<PendingImageRename | null>(null);
  const lastWrittenRef = useRef<{ path: string; content: string; at: number } | null>(null);
  const richScroll = useRef(0); // 所见即所得编辑器重建后要恢复到的滚动位置
  const richHandleRef = useRef<RichHandle | null>(null);
  const pendingRichAnchor = useRef<EditorAnchor | null>(null);
  const pendingSourceOffset = useRef<number | null>(null);
  const frontInputRef = useRef<HTMLTextAreaElement>(null);
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
    lastWrittenRef.current = { path: s.path, content: s.content, at: Date.now() };
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
      pendingRichAnchor.current = null;
      pendingSourceOffset.current = null;
      setNonce((n) => n + 1);
      setDirty(false);
      setSaved("");
      setFrontOpen(false);
      setOutlineCollapsed({});
      setOutlineSelected(null);
      setOutlineMenu(null);
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
        const sb = normalizePanelBounds(savedPrefs.sidebarBounds, DEFAULT_SIDEBAR_BOUNDS);
        const ob = normalizePanelBounds(savedPrefs.outlineBounds, DEFAULT_OUTLINE_BOUNDS);
        setPrefs((p) => ({
          ...p,
          ...savedPrefs,
          sidebarBounds: sb,
          outlineBounds: ob,
          sidebarWidth: savedPrefs.sidebarWidth ?? sb.defaultWidth,
          outlineWidth: savedPrefs.outlineWidth ?? ob.defaultWidth,
          sidebarFontSize: positiveFontSize(savedPrefs.sidebarFontSize, DEFAULT_SIDEBAR_FONT_SIZE),
          editorFontSize: positiveFontSize(savedPrefs.editorFontSize, DEFAULT_EDITOR_FONT_SIZE),
          outlineFontSize: positiveFontSize(savedPrefs.outlineFontSize, DEFAULT_OUTLINE_FONT_SIZE),
          editorMaxWidth: normalizeEditorMaxWidth(savedPrefs.editorMaxWidth),
          highlightColor: normalizeHighlightColor(savedPrefs.highlightColor),
          highlightOpacity: normalizeHighlightOpacity(savedPrefs.highlightOpacity),
          highlightHistory: normalizeHighlightHistory(savedPrefs.highlightHistory),
          strictLineBreaks: savedPrefs.strictLineBreaks ?? false,
          timeFormat: savedPrefs.timeFormat || DEFAULT_TIME_FORMAT,
          imagePrefs: normalizeImagePrefs(savedPrefs.imagePrefs),
          shortcuts: normalizeShortcuts(savedPrefs.shortcuts),
        }));
      }
      const list = t ?? [];
      setTree(list);
      setLoaded(true);
      const mdFiles = flatten(list).filter((n) => !n.isDir && isMarkdownFile(n.name));
      if (input.trim()) void importText(input, mdFiles);
      else {
        const first = mdFiles.find((f) => f.path === (last ?? "")) ?? [...mdFiles].sort((a, b) => b.modified - a.modified)[0];
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
    if (input.trim()) void importText(input, all.filter((n) => !n.isDir && isMarkdownFile(n.name)));
  }, [input]);

  // 同一篇笔记可能同时开在主窗口和独立窗口里。别处改了文件，这边跟着变，不会各改各的。
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const off = Notes.onChange((ev: FsChange) => {
      const s = state.current;
      if (ev.op === "write") {
        if (ev.path !== s.path || s.dirty) return;
        const lw = lastWrittenRef.current;
        if (lw && lw.path === ev.path && lw.content === s.content && Date.now() - lw.at < 1500) return;
        void Notes.read(ev.path).then((text) => {
          const now = state.current;
          // 自己刚存的（内容一样或仅换行符规范化差异）不用管；这边正在改的以这边为准。
          if (now.path !== ev.path || now.dirty || text === now.content || text.replace(/\r\n/g, "\n") === now.content.replace(/\r\n/g, "\n")) return;
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
      const anchor = richHandleRef.current?.captureAnchor() ?? null;
      pendingSourceOffset.current = anchor ? anchorToSourceOffset(state.current.content, anchor) : null;
      pendingRichAnchor.current = null;
    } else if (prev === "source" && next !== "source") {
      const head = view.current?.state.selection.main.head;
      pendingRichAnchor.current = typeof head === "number" ? sourceOffsetToAnchor(state.current.content, head) : null;
      pendingSourceOffset.current = null;
    }
    setMode(next);
    if (prev === "source" && next !== "source") {
      setNonce((n) => n + 1); // 带着源码模式里改过的内容重建并定位到原光标块
    }
    if (next === "live" || next === "block") {
      updatePrefs({ revealSource: next === "block" });
    }
    Notes.setMode(next);
  };
  const insertFrontmatter = () => {
    const cur = splitFrontmatter(state.current.content);
    if (cur.front !== null) {
      if (state.current.mode === "source" && view.current) {
        view.current.dispatch({ selection: { anchor: 4 }, effects: EditorView.scrollIntoView(0, { y: "start" }) });
        view.current.focus();
      } else {
        setFrontOpen(true);
        requestAnimationFrame(() => frontInputRef.current?.focus());
      }
      return;
    }
    const yaml = `---\ntitle: ${title || "未命名"}\n---\n\n`;
    const nextContent = yaml + state.current.content;
    edit(nextContent);
    if (state.current.mode === "source" && view.current) {
      const v = view.current;
      v.dispatch({
        changes: { from: 0, to: 0, insert: yaml },
        selection: { anchor: 4 + "title: ".length, head: 4 + "title: ".length + (title || "未命名").length },
        effects: EditorView.scrollIntoView(0, { y: "start" }),
      });
      v.focus();
    } else {
      setFrontOpen(true);
      requestAnimationFrame(() => frontInputRef.current?.focus());
    }
  };
  const toggleStrictLineBreaks = () => {
    if (state.current.mode !== "source") {
      richScroll.current = body.current?.querySelector(".fx-notes-rich")?.scrollTop ?? 0;
      pendingRichAnchor.current = richHandleRef.current?.captureAnchor() ?? null;
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
        return { path: p, label: node ? (node.isDir ? node.name : isMarkdownFile(node.name) ? stem(node.name) : node.name) : p, isDir: !!node?.isDir };
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
  const runPersistImage = useCallback(
    async (input: PendingImageInput, finalName: string, insert: (url: string, alt: string) => void) => {
      try {
        const res = await persistImage(input, finalName, state.current.path, prefsRef.current.imagePrefs);
        insert(res.markdownUrl, res.alt);
        if (res.fallbackNotice) ctx.toast(res.fallbackNotice, true);
      } catch (e) {
        fail(e as Error);
      }
    },
    [],
  );

  const handlePasteImage = useCallback(
    (input: PendingImageInput, insert: (markdownUrl: string, alt: string) => void) => {
      const imgPrefs = prefsRef.current.imagePrefs;
      const defaultName = buildImageFilename(input.originalName, input.mime, imgPrefs.renameMode);
      if (imgPrefs.promptRename) {
        const { storeDir, mdPrefix } = resolveImageDir(imgPrefs.dir, state.current.path || "note.md");
        const targetHint =
          imgPrefs.mode === "upload" && imgPrefs.uploadUrl.trim()
            ? `图床 ${imgPrefs.uploadUrl.trim()}`
            : `${mdPrefix}（目录：${storeDir || "."}）`;
        setPendingImgRename({
          input,
          initialName: defaultName,
          previewDataUrl: `data:${input.mime || "image/png"};base64,${input.base64}`,
          targetHint,
          insert,
        });
        return;
      }
      void runPersistImage(input, defaultName, insert);
    },
    [runPersistImage],
  );

  const pasteToSource = async () => {
    const v = view.current;
    if (!v) return;
    const clip = await editorClipboard.read();
    if (!clip) {
      const imgB64 = await editorClipboard.readImage().catch(() => "");
      if (imgB64) {
        handlePasteImage({ base64: imgB64, mime: "image/png", originalName: "clipboard.png" }, (url, alt) => {
          const cur = view.current;
          if (!cur) return;
          const { from, to } = cur.state.selection.main;
          const md = `![${alt}](${url})`;
          cur.dispatch({ changes: { from, to, insert: md }, selection: { anchor: from + md.length } });
          cur.focus();
        });
      }
      return;
    }
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
      if (kind === "frontmatter") {
        insertFrontmatter();
        return;
      }
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const docText = v.state.doc.toString();
      if (kind === "paraAbove" || kind === "paraBelow") {
        const res = insertLine(docText, from, kind === "paraAbove" ? "above" : "below");
        v.dispatch({ changes: { from: res.from, to: res.from, insert: res.insert }, selection: { anchor: res.anchor } });
        v.focus();
        return;
      }
      const line = v.state.doc.lineAt(from);
      const emptyLine = v.state.sliceDoc(line.from, from).trim() === "";
      const res = buildSourceInsert(kind, prefs.timeFormat, emptyLine, docText);
      const changes: { from: number; to: number; insert: string }[] = [{ from, to, insert: res.insert }];
      if (res.appendDoc) {
        const prefix = docText.endsWith("\n\n") ? "" : docText.endsWith("\n") ? "\n" : "\n\n";
        changes.push({ from: docText.length, to: docText.length, insert: `${prefix}${res.appendDoc}\n` });
      }
      const anchor = from + res.cursorOffset;
      const head = anchor + (res.selectLen ?? 0);
      v.dispatch({ changes, selection: { anchor, head } });
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
    if (hit) {
      if (isMarkdownFile(hit.name)) void openNote(hit.path);
      else void Notes.open(hit.path).catch(fail);
    } else ctx.toast(`找不到笔记：${rel}`, true);
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

  useEffect(() => {
    if (!widthMenuOpen) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".fx-status-width")) setWidthMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setWidthMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [widthMenuOpen]);

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

  const sidebarBounds = prefs.sidebarBounds;
  const outlineBounds = prefs.outlineBounds;
  const savedSideW = prefs.sidebarWidth || sidebarBounds.defaultWidth;
  const savedOutlineW = prefs.outlineWidth || outlineBounds.defaultWidth;
  const canResetWidths = savedSideW !== sidebarBounds.defaultWidth || savedOutlineW !== outlineBounds.defaultWidth;
  const widths = computePanelWidths({
    containerWidth,
    sidebarOpen,
    outlineOpen,
    sidebarWidth: resizing === "sidebar" && dragWidth !== null ? dragWidth : savedSideW,
    outlineWidth: resizing === "outline" && dragWidth !== null ? dragWidth : savedOutlineW,
    sidebarBounds,
    outlineBounds,
  });

  const resetWidths = () => {
    setMenuOpen(false);
    updatePrefs({ sidebarWidth: sidebarBounds.defaultWidth, outlineWidth: outlineBounds.defaultWidth });
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
        bounds: which === "sidebar" ? prefsRef.current.sidebarBounds : prefsRef.current.outlineBounds,
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

  // 查找与替换控制（覆盖阅读、实时、整块与源码四种模式）
  const applyFindQueryToActive = useCallback((q: FindQuery, scroll = true) => {
    if (state.current.mode === "source") {
      setFindStats(setCodeFindQuery(view.current, q, scroll));
    } else if (richHandleRef.current) {
      setFindStats(richHandleRef.current.setFindQuery(q, scroll));
    } else {
      setFindStats({ total: 0, current: 0 });
    }
  }, []);

  const openFindBar = useCallback((withReplace: boolean) => {
    if (!state.current.path) return;
    let picked = "";
    if (state.current.mode === "source" && view.current) {
      const sel = view.current.state.selection.main;
      if (sel.from !== sel.to) picked = view.current.state.sliceDoc(sel.from, sel.to);
    } else if (richHandleRef.current) {
      picked = richHandleRef.current.getSelectedText();
    }
    const cleanPicked = picked && !picked.includes("\n") && picked.length <= 80 ? picked : "";
    setFindOpen(true);
    setFindShowReplace(withReplace && state.current.mode !== "read");
    setFindFocusNonce((n) => n + 1);
    if (cleanPicked) {
      setFindQuery((prev) => {
        const next = { ...prev, query: cleanPicked };
        requestAnimationFrame(() => applyFindQueryToActive(next, true));
        return next;
      });
    } else {
      setFindQuery((prev) => {
        if (prev.query) requestAnimationFrame(() => applyFindQueryToActive(prev, false));
        return prev;
      });
    }
  }, [applyFindQueryToActive]);

  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    const cleared: FindQuery = { query: "", caseSensitive: false, wholeWord: false, regex: false };
    setCodeFindQuery(view.current, cleared, false);
    richHandleRef.current?.setFindQuery(cleared, false);
    setFindStats({ total: 0, current: 0 });
    if (state.current.mode === "source") view.current?.focus();
    else richHandleRef.current?.focus();
  }, []);

  const updateFindQuery = useCallback(
    (patch: Partial<FindQuery>) => {
      setFindQuery((prev) => {
        const next = { ...prev, ...patch };
        applyFindQueryToActive(next, true);
        return next;
      });
    },
    [applyFindQueryToActive],
  );

  const stepFind = useCallback((dir: 1 | -1) => {
    if (state.current.mode === "source") setFindStats(stepCodeFind(view.current, dir));
    else if (richHandleRef.current) setFindStats(richHandleRef.current.stepFind(dir));
  }, []);

  const replaceOneFind = useCallback(() => {
    if (state.current.mode === "read") return;
    if (state.current.mode === "source") setFindStats(replaceCurrentCode(view.current, findReplaceText));
    else if (richHandleRef.current) setFindStats(richHandleRef.current.replaceFind(findReplaceText));
  }, [findReplaceText]);

  const replaceAllFind = useCallback(() => {
    if (state.current.mode === "read") return;
    if (state.current.mode === "source") {
      const { count: n, stats: next } = replaceAllCode(view.current, findReplaceText);
      setFindStats(next);
      if (n > 0) ctx.toast(`已替换 ${n} 处`);
    } else if (richHandleRef.current) {
      const { count: n, stats: next } = richHandleRef.current.replaceAllFind(findReplaceText);
      setFindStats(next);
      if (n > 0) ctx.toast(`已替换 ${n} 处`);
    }
  }, [findReplaceText]);

  // 切换模式或内容更新时，保持打开的查找条命中计数与高亮同步。
  useEffect(() => {
    if (!findOpen) return;
    if (mode === "read") setFindShowReplace(false);
    const id = window.setTimeout(() => {
      const q = findQueryRef.current;
      if (state.current.mode === "source") {
        setFindStats(setCodeFindQuery(view.current, q, false));
      } else if (richHandleRef.current) {
        setFindStats(richHandleRef.current.setFindQuery(q, false));
      }
    }, 60);
    return () => window.clearTimeout(id);
  }, [findOpen, mode, path, nonce]);

  useEffect(() => {
    if (!findOpen || !findQueryRef.current.query) return;
    const id = window.setTimeout(() => {
      if (state.current.mode === "source") setFindStats(getCodeFindStats(view.current));
      else if (richHandleRef.current) setFindStats(richHandleRef.current.getFindStats());
    }, 120);
    return () => window.clearTimeout(id);
  }, [content, findOpen]);

  // 全局查找/替换快捷键（保证阅读模式、焦点在顶栏/侧栏时也能直接呼出查找条）。
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if (settingsTab || pendingDelete || pendingImgRename) return;
      const act = matchShortcutAction(e, prefsRef.current.shortcuts, ctx.platform);
      if (act === "find" || act === "replace") {
        if (!state.current.path) return;
        e.preventDefault();
        e.stopPropagation();
        openFindBar(act === "replace");
      }
    };
    document.addEventListener("keydown", onGlobalKey, true);
    return () => document.removeEventListener("keydown", onGlobalKey, true);
  }, [openFindBar, settingsTab, pendingDelete, pendingImgRename, ctx.platform]);

  // 所见即所得模式下，frontmatter 摘出来单独编辑，编辑器只管正文。
  const split = useMemo(() => splitFrontmatter(content), [content]);
  const front = useRef(split);
  front.current = split;
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  const openFindRef = useRef(openFindBar);
  openFindRef.current = openFindBar;
  const handlePasteImageRef = useRef(handlePasteImage);
  handlePasteImageRef.current = handlePasteImage;
  const runSourceShortcut = useCallback((act: ShortcutActionId, v: EditorView): boolean => {
    if (act === "find" || act === "replace") {
      openFindRef.current(act === "replace");
      return true;
    }
    const { from, to } = v.state.selection.main;
    const docText = v.state.doc.toString();
    if (act === "above" || act === "below") {
      const ch = insertLine(docText, from, act);
      v.dispatch({ changes: { from: ch.from, insert: ch.insert }, selection: { anchor: ch.anchor }, scrollIntoView: true });
      return true;
    }
    if (act === "indent" || act === "outdent") {
      const ch = applySourceIndent(docText, from, to, act);
      v.dispatch({ changes: { from: ch.from, to: ch.to, insert: ch.insert }, selection: { anchor: ch.anchor, head: ch.head }, scrollIntoView: true });
      return true;
    }
    if (act === "codeBlock" || act === "mathBlock") {
      const line = v.state.doc.lineAt(from);
      const emptyLine = v.state.sliceDoc(line.from, from).trim() === "";
      const res = buildSourceInsert(act === "codeBlock" ? "code" : "math", prefsRef.current.timeFormat, emptyLine, docText);
      const anchor = from + res.cursorOffset;
      v.dispatch({ changes: { from, to, insert: res.insert }, selection: { anchor }, scrollIntoView: true });
      return true;
    }
    const paraMap: Partial<Record<ShortcutActionId, BlockKind>> = {
      h1: "h1",
      h2: "h2",
      h3: "h3",
      h4: "h4",
      h5: "h5",
      h6: "h6",
      quote: "quote",
      orderedList: "ordered",
      bulletList: "bullet",
      taskList: "task",
    };
    const kind = paraMap[act];
    if (kind) {
      const res = applySourceParagraph(docText, from, to, kind);
      v.dispatch({ changes: { from: res.from, to: res.to, insert: res.insert }, selection: { anchor: res.anchor, head: res.head }, scrollIntoView: true });
      return true;
    }
    return false;
  }, []);

  const sourceExtensions = useMemo(
    () => [
      codeFindExtension,
      linkOpener((href) => openLinkRef.current(href)),
      noteLineKeys(() => prefsRef.current.shortcuts, { platform: ctx.platform, onAction: runSourceShortcut }),
      EditorView.domEventHandlers({
        paste(e, v) {
          const dt = e.clipboardData;
          if (!dt) return false;
          const imgFile = Array.from(dt.items)
            .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
            .map((it) => it.getAsFile())
            .find((f): f is File => !!f);
          if (!imgFile) return false;
          e.preventDefault();
          const sel = v.state.selection.main;
          void blobToBase64(imgFile).then((base64) => {
            handlePasteImageRef.current({ base64, mime: imgFile.type || "image/png", originalName: imgFile.name || "image.png" }, (url, alt) => {
              const cur = view.current;
              if (!cur) return;
              const from = Math.min(sel.from, cur.state.doc.length);
              const to = Math.min(sel.to, cur.state.doc.length);
              const md = `![${alt}](${url})`;
              cur.dispatch({ changes: { from, to, insert: md }, selection: { anchor: from + md.length } });
              cur.focus();
            });
          });
          return true;
        },
        drop(e, v) {
          const imgFile = e.dataTransfer?.files ? Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/")) : undefined;
          if (!imgFile) return false;
          e.preventDefault();
          const dropPos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
          void blobToBase64(imgFile).then((base64) => {
            handlePasteImageRef.current({ base64, mime: imgFile.type || "image/png", originalName: imgFile.name || "image.png" }, (url, alt) => {
              const cur = view.current;
              if (!cur) return;
              const at = Math.min(dropPos, cur.state.doc.length);
              const md = `![${alt}](${url})`;
              cur.dispatch({ changes: { from: at, to: at, insert: md }, selection: { anchor: at + md.length } });
              cur.focus();
            });
          });
          return true;
        },
      }),
    ],
    [ctx.platform, runSourceShortcut],
  );
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

  const headings = useMemo(() => (outlineActive ? richOutlineOf(derivedBody) : []), [outlineActive, derivedBody]);
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
      const dot = el.value.lastIndexOf(".");
      const end = !isMarkdownFile(renaming) && dot > 0 ? dot : el.value.length;
      el.setSelectionRange(0, end, "forward");
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
  const outlineNodeByIndex = useMemo(() => {
    const map = new Map<number, OutlineNode<RichOutlineHeading>>();
    const walk = (list: readonly OutlineNode<RichOutlineHeading>[]) => {
      for (const n of list) {
        map.set(n.index, n);
        if (n.children.length > 0) walk(n.children);
      }
    };
    walk(outlineNodes);
    return map;
  }, [outlineNodes]);
  const filteredOutline = useMemo(() => filterOutlineNodes(outlineNodes, outlineQuery), [outlineNodes, outlineQuery]);
  const hiVars = useMemo(() => resolveHighlightVars(prefs.highlightColor, prefs.highlightOpacity), [prefs.highlightColor, prefs.highlightOpacity]);
  const rootStyle = useMemo(
    () =>
      ({
        "--note-mark-hi-light": hiVars.light,
        "--note-mark-hi-dark": hiVars.dark,
        "--note-side-fs": `${prefs.sidebarFontSize}px`,
        "--note-editor-fs": `${prefs.editorFontSize}px`,
        "--note-source-fs": `${Math.max(10, Math.round(prefs.editorFontSize * 0.86 * 10) / 10)}px`,
        "--note-outline-fs": `${prefs.outlineFontSize}px`,
        "--note-editor-max-w": prefs.editorMaxWidth > 0 ? `${prefs.editorMaxWidth}px` : "none",
      }) as Record<string, string>,
    [hiVars, prefs.sidebarFontSize, prefs.editorFontSize, prefs.outlineFontSize, prefs.editorMaxWidth],
  );
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
    else if (isMarkdownFile(n.name) && n.path !== path) void openNote(n.path);
  };

  const handleItemDblClick = (n: Node, e: MouseEvent) => {
    if (renaming === n.path || n.isDir || isMarkdownFile(n.name)) return;
    e.preventDefault();
    e.stopPropagation();
    void Notes.open(n.path).catch(fail);
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
    onCopyName: (node) => void ctx.copy(node.isDir ? node.name : isMarkdownFile(node.name) ? stem(node.name) : node.name, "已复制文件名"),
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
    const isMd = !n.isDir && isMarkdownFile(n.name);
    const isNonMd = !n.isDir && !isMd;
    const active = n.path === path;
    const picked = selectedSet.has(n.path) && (selected.length > 1 || n.isDir || !active);
    const expanded = !!open[n.path];
    const confirming = confirmDelete === n.path;
    const ctxFocused = ctxTarget === n.path;
    const displayName = n.isDir ? n.name : isMd ? stem(n.name) : n.name;
    return (
      <div key={n.path}>
        <div
          class={`fx-side-item${isNonMd ? " is-non-md" : ""}${active ? " is-selected" : ""}${picked ? " is-picked" : ""}${ctxFocused ? " is-ctx-target" : ""}${confirming ? " is-confirming" : ""}${dragOver === n.path ? " is-drop" : ""}`}
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
          onDblClick={(e) => handleItemDblClick(n, e as unknown as MouseEvent)}
          onContextMenu={(e) => handleItemContextMenu(n, e as unknown as MouseEvent)}
        >
          {n.isDir ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span class="fx-side-indent" />}
          {n.isDir ? <Folder size={13} /> : isMd ? <FileText size={13} /> : isImageFile(n.name) ? <ImageIcon size={13} /> : <FileIcon size={13} />}
          {renaming === n.path ? (
            <input
              ref={renameRef}
              class="fx-side-rename"
              defaultValue={displayName}
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
              <span class="fx-side-name" title={isNonMd ? `${n.name}（双击使用系统默认应用打开）` : n.name}>
                {displayName}
              </span>
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
    <div class={`fx-page fx-notes${resizing ? " is-resizing" : ""}`} ref={notesRef} data-mark-color={prefs.highlightColor} style={rootStyle}>
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
        onDblClick={() => updatePrefs({ sidebarWidth: sidebarBounds.defaultWidth })}
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
              <div class="fx-notes-tool-icons">
                <Btn small ghost icon title="查找与替换 (Ctrl+F)" onClick={() => openFindBar(false)}>
                  <Search size={14} />
                </Btn>
                <Btn small ghost icon title="复制全文（Markdown）" onClick={() => void ctx.copy(content)}>
                  <Copy size={14} />
                </Btn>
                <Btn small ghost icon title="笔记设置" onClick={() => { setMenuOpen(false); setSettingsTab("appearance"); }}>
                  <Settings size={14} />
                </Btn>
                <div class="fx-notes-more">
                  <Btn small ghost icon title="更多：打开方式、另存为、排版与预览" onClick={() => setMenuOpen((o) => !o)}>
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
                    </div>
                  )}
                </div>
              </div>
              <div class="fx-notes-mode-group">
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
          {mode !== "source" && split.front !== null && (
            <div class={`fx-notes-front${frontOpen ? " is-open" : ""}`}>
              <button type="button" class="fx-notes-front-head" title="文档开头 --- 之间的属性（frontmatter）" onClick={() => setFrontOpen((o) => !o)}>
                {frontOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="fx-notes-front-label">文档属性</span>
                {!frontOpen && <span class="fx-notes-front-keys">{frontSummary(split.front)}</span>}
              </button>
              {frontOpen && (
                <textarea
                  ref={frontInputRef}
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
            {findOpen && (
              <FindReplaceBar
                query={findQuery}
                replaceText={findReplaceText}
                showReplace={findShowReplace}
                canReplace={mode !== "read"}
                stats={findStats}
                focusNonce={findFocusNonce}
                onChangeQuery={updateFindQuery}
                onChangeReplaceText={setFindReplaceText}
                onToggleReplace={() => setFindShowReplace((v) => !v)}
                onNext={() => stepFind(1)}
                onPrev={() => stepFind(-1)}
                onReplaceOne={replaceOneFind}
                onReplaceAll={replaceAllFind}
                onClose={closeFindBar}
              />
            )}
            {mode !== "source" ? (
              <RichEditor
                key={`${path}#${nonce}`}
                value={split.body}
                notePath={path}
                viewMode={mode as RichViewMode}
                strictLineBreaks={prefs.strictLineBreaks}
                highlightColor={prefs.highlightColor}
                highlightOpacity={prefs.highlightOpacity}
                editorMaxWidth={prefs.editorMaxWidth}
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
                onInsertFrontmatter={insertFrontmatter}
                onOpenFind={openFindBar}
                onPasteImage={handlePasteImage}
                scrollTop={richScroll.current}
                initialAnchor={pendingRichAnchor.current}
                handleRef={richHandleRef}
              />
            ) : (
              <CodeEditor
                key={path}
                value={content}
                lang="markdown"
                wrap
                onChange={edit}
                onReady={(v) => {
                  view.current = v;
                  const target = pendingSourceOffset.current;
                  if (target !== null) {
                    pendingSourceOffset.current = null;
                    const clamped = Math.max(0, Math.min(v.state.doc.length, target));
                    v.dispatch({
                      selection: { anchor: clamped },
                      effects: EditorView.scrollIntoView(clamped, { y: "center" }),
                    });
                    v.focus();
                  }
                }}
                onDestroy={() => {
                  view.current = null;
                }}
                onCursor={setCursor}
                autoFocus
                extensions={sourceExtensions}
              />
            )}
            {mode === "source" && sourceMenu && (
              <EditorContextMenu
                menu={sourceMenu}
                platform={ctx.platform}
                timeFormat={prefs.timeFormat}
                shortcuts={prefs.shortcuts}
                actions={sourceMenuActions}
                onClose={() => setSourceMenu(null)}
              />
            )}
          </div>
          <div class="fx-meta fx-notes-status">
            <span class="fx-notes-stat-text">
              {stats.total} 字 · {stats.chars} 字符 · {stats.lines} 行 · 约 {stats.minutes} 分钟读完
              {mode === "source" ? ` · 第 ${cursor.line} 行，第 ${cursor.col} 列${cursor.selected ? `（选中 ${cursor.selected}）` : ""}` : ""}
            </span>
            <span class="fx-spacer" />
            <div class="fx-status-width">
              <div class="fx-width-picker">
                <button
                  type="button"
                  class={`fx-status-width-btn${widthMenuOpen ? " is-open" : ""}`}
                  title="点击选择默认编辑区宽度"
                  aria-haspopup="menu"
                  aria-expanded={widthMenuOpen}
                  onClick={() => setWidthMenuOpen((v) => !v)}
                >
                  <span>{prefs.editorMaxWidth > 0 ? `宽 ${prefs.editorMaxWidth}px` : "铺满"}</span>
                  <ChevronDown size={11} />
                </button>
                {widthMenuOpen && (
                  <div class="fx-menu fx-width-menu" role="menu" aria-label="编辑区宽度预设">
                    {STATUS_WIDTH_PRESETS.map((p) => {
                      const active = prefs.editorMaxWidth === p.value;
                      return (
                        <button
                          key={p.label}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          class={`fx-menu-item${active ? " is-current" : ""}`}
                          onClick={() => {
                            updatePrefs({ editorMaxWidth: p.value });
                            setWidthMenuOpen(false);
                          }}
                        >
                          <span>{p.label}</span>
                          <span class="fx-width-menu-val">{p.desc}</span>
                          {active && <Check size={12} class="fx-menu-check" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div class="fx-status-slider-wrap" title="拖动调整编辑区文字显示宽度（自动记住）">
                <input
                  type="range"
                  class="fx-thin-range"
                  min={WIDTH_SLIDER_MIN}
                  max={WIDTH_SLIDER_MAX}
                  step={20}
                  aria-label="编辑区文字宽度"
                  value={prefs.editorMaxWidth > 0 ? Math.max(WIDTH_SLIDER_MIN, Math.min(WIDTH_SLIDER_MAX, prefs.editorMaxWidth)) : WIDTH_SLIDER_MAX}
                  onInput={(e) => {
                    const val = Number((e.target as HTMLInputElement).value);
                    updatePrefs({ editorMaxWidth: val >= WIDTH_SLIDER_MAX ? 0 : val });
                  }}
                />
                <div class="fx-slider-ticks" aria-hidden="true">
                  {WIDTH_SLIDER_TICKS.map((t) => (
                    <span
                      key={t.label}
                      class={`fx-slider-tick${prefs.editorMaxWidth === t.value ? " is-active" : ""}`}
                      style={{ left: `${t.pct}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <span class="fx-notes-saved">{dirty ? "正在保存…" : saved ? `已保存 ${saved}` : "自动保存"}</span>
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
        onDblClick={() => updatePrefs({ outlineWidth: outlineBounds.defaultWidth })}
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
        <div class="fx-side-search-row pocket-outline-search-row">
          <label class="fx-side-search">
            <Search size={12} />
            <input
              placeholder="搜索大纲"
              aria-label="搜索大纲"
              value={outlineQuery}
              spellcheck={false}
              onInput={(e) => setOutlineQuery((e.target as HTMLInputElement).value)}
            />
            {outlineQuery && (
              <button type="button" class="fx-side-clear" title="清空大纲搜索" aria-label="清空大纲搜索" onClick={() => setOutlineQuery("")}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        <div
          class="fx-side-list"
          onClick={(e) => {
            if (!(e.target as Element)?.closest?.(".pocket-outline-label, .pocket-outline-toggle")) {
              setOutlineSelected(null);
            }
          }}
          onContextMenu={(e) => {
            if ((e.target as Element)?.closest?.(".pocket-outline-row")) return;
            e.preventDefault();
            e.stopPropagation();
            setOutlineSelected(null);
            setOutlineMenu({ kind: "all", hasItems: outlineNodes.length > 0, x: e.clientX, y: e.clientY });
          }}
        >
          {filteredOutline.length ? (
            <div class="pocket-outline-tree">
              {(() => {
                const searching = !!outlineQuery.trim();
                const renderNodes = (items: FilteredOutlineNode[]) =>
                  items.map(({ node, matched, children }) => {
                    const nodeKey = `${node.heading.level}:${node.index}`;
                    const hasChildren = children.length > 0;
                    const collapsed = !searching && !!outlineCollapsed[nodeKey];
                    const selectedItem = outlineSelected === node.index;
                    const toggle = () => setOutlineCollapsed((prev) => ({ ...prev, [nodeKey]: !prev[nodeKey] }));
                    return (
                      <div key={`${node.heading.from}-${node.index}`} class="pocket-outline-node">
                        <div
                          class={`pocket-outline-row${selectedItem ? " is-selected" : ""}`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOutlineSelected(node.index);
                            const fullNode = outlineNodeByIndex.get(node.index) ?? node;
                            setOutlineMenu({
                              kind: "item",
                              index: node.index,
                              hasChildren: fullNode.children.length > 0,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                        >
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
                          <button
                            type="button"
                            class={`pocket-outline-label${matched ? " is-hit" : ""}${selectedItem ? " is-selected" : ""}`}
                            onClick={() => {
                              setOutlineSelected(node.index);
                              jumpHeading(node.index);
                            }}
                            title={node.heading.text}
                          >
                            {node.heading.text ? renderOutlineInlines(node.heading.inlines) : "（空标题）"}
                          </button>
                        </div>
                        {hasChildren && !collapsed && <div class="pocket-outline-children">{renderNodes(children)}</div>}
                      </div>
                    );
                  });
                return renderNodes(filteredOutline);
              })()}
            </div>
          ) : (
            <div class="fx-side-empty">{outlineQuery.trim() ? "没有匹配的标题" : "使用 # 标题后会显示在这里"}</div>
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
      {pendingImgRename && (
        <ImageRenameModal
          previewDataUrl={pendingImgRename.previewDataUrl}
          initialName={pendingImgRename.initialName}
          targetHint={pendingImgRename.targetHint}
          onConfirm={(finalName) => {
            const cur = pendingImgRename;
            setPendingImgRename(null);
            void runPersistImage(cur.input, finalName, cur.insert);
          }}
          onCancel={() => setPendingImgRename(null)}
        />
      )}
      {outlineMenu && (
        <OutlineContextMenu
          menu={outlineMenu}
          onCopyItem={(index, includeChildren) => {
            const target = outlineNodeByIndex.get(index);
            if (!target) return;
            const text = formatOutlineItemCopy(target, includeChildren);
            if (text) void ctx.copy(text, includeChildren ? "已复制大纲及子项" : "已复制标题");
          }}
          onCopyAll={() => {
            const text = formatOutlineTreeCopy(outlineNodes);
            if (text) void ctx.copy(text, "已复制全部大纲");
          }}
          onClose={() => setOutlineMenu(null)}
        />
      )}
      {settingsTab && (
        <NotesSettingsModal
          initialTab={settingsTab}
          notePath={path}
          codeTheme={prefs.codeTheme}
          codeThemes={codeThemes}
          highlightColor={prefs.highlightColor}
          highlightOpacity={prefs.highlightOpacity}
          highlightHistory={prefs.highlightHistory}
          sidebarFontSize={prefs.sidebarFontSize}
          editorFontSize={prefs.editorFontSize}
          outlineFontSize={prefs.outlineFontSize}
          editorMaxWidth={prefs.editorMaxWidth}
          sidebarBounds={prefs.sidebarBounds}
          outlineBounds={prefs.outlineBounds}
          imagePrefs={prefs.imagePrefs}
          timeFormat={prefs.timeFormat}
          shortcuts={prefs.shortcuts}
          onChangeCodeTheme={(id) => updatePrefs({ codeTheme: id })}
          onChangeHighlightColor={(color, recordHistory) => {
            if (recordHistory) {
              updatePrefs({
                highlightColor: color,
                highlightHistory: pushHighlightHistory(prefsRef.current.highlightHistory, color),
              });
            } else {
              updatePrefs({ highlightColor: color });
            }
          }}
          onChangeHighlightOpacity={(highlightOpacity) => updatePrefs({ highlightOpacity })}
          onChangeFontSizes={(patch) => updatePrefs(patch)}
          onChangeEditorMaxWidth={(editorMaxWidth) => updatePrefs({ editorMaxWidth })}
          onChangeSidebarBounds={(sb) =>
            updatePrefs({
              sidebarBounds: sb,
              sidebarWidth: Math.max(sb.minWidth, Math.min(sb.maxWidth, prefsRef.current.sidebarWidth)),
            })
          }
          onChangeOutlineBounds={(ob) =>
            updatePrefs({
              outlineBounds: ob,
              outlineWidth: Math.max(ob.minWidth, Math.min(ob.maxWidth, prefsRef.current.outlineWidth)),
            })
          }
          onChangeImagePrefs={(patch) => updatePrefs({ imagePrefs: { ...prefsRef.current.imagePrefs, ...patch } })}
          onChangeTimeFormat={(fmt) => updatePrefs({ timeFormat: fmt })}
          onChangeShortcuts={(shortcuts) => updatePrefs({ shortcuts })}
          onResetAll={() => {
            updatePrefs({
              ...defaultPrefs,
              sidebarHidden: prefsRef.current.sidebarHidden,
              outline: prefsRef.current.outline,
            });
            ctx.toast("已恢复全部默认设置");
          }}
          onToast={ctx.toast}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
  );
}
