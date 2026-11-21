import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  EditorState,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  placeholder,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  Crosshair,
  FileCode2,
  Layers3,
  ListTree,
  Minimize2,
  MoreHorizontal,
  Quote,
  Save,
  Search,
  Sparkles,
  Trash2,
  Unlink,
  Wrench,
  X,
} from "lucide-preact";
import { DevTools } from "../mygo";
import { Btn, formatBytes } from "./ui";
import { Splitter } from "./json/splitter";
import { Output } from "./json/output";
import {
  SlidingModes,
  SlidingScope,
  SlidingSwitch,
  SlidingTabs,
  type TabHealth,
  type TabItem,
} from "./json/sliding";
import type { FeatureProps } from "./types";
import JsonWorker from "./json/worker?worker&inline";
import {
  pageSize,
  type CopyFormat,
  type Kind,
  type Mode,
  type Options,
  type Result,
  type Row,
} from "./json/document";
import "./json/style.css";

const modes: Record<Mode, string> = {
  tree: "解析",
  format: "格式化",
  minify: "压缩",
  escape: "转义",
  unescape: "去转义",
  xml: "转 XML",
};

const kindLabels: Record<Kind, string> = {
  object: "Object",
  array: "Array",
  string: "String",
  number: "Number",
  boolean: "Boolean",
  null: "Null",
};

const kindTags: Record<Kind, string> = {
  object: "{}",
  array: "[]",
  string: "Aa",
  number: "#",
  boolean: "TF",
  null: "∅",
};

const copyLabels: Record<CopyFormat, string> = {
  value: "已复制值",
  pretty: "已复制格式化 JSON",
  minify: "已复制压缩 JSON",
  pair: "已复制键值对",
  key: "已复制键名",
  path: "已复制 JSON 路径",
};

const sourcePalette = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName], class: "jx-token-key" },
  { tag: [tags.string, tags.attributeValue], class: "jx-token-string" },
  { tag: tags.number, class: "jx-token-number" },
  { tag: [tags.bool, tags.null, tags.tagName], class: "jx-token-literal" },
  { tag: tags.punctuation, class: "jx-token-punctuation" },
]);

const setDiagEffect = StateEffect.define<{ from: number; to: number } | null>();
const setFlashEffect = StateEffect.define<number | null>();

class CaretErrorWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "jx-cm-err-caret";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const diagField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const e of tr.effects) {
      if (e.is(setDiagEffect)) {
        if (!e.value) return Decoration.none;
        const len = tr.state.doc.length;
        const from = Math.max(0, Math.min(len, e.value.from));
        const to = Math.max(from, Math.min(len, e.value.to));
        const decos: Range<Decoration>[] = [];
        const line = tr.state.doc.lineAt(from);
        decos.push(
          Decoration.line({ class: "jx-cm-err-line" }).range(line.from),
        );
        if (to > from) {
          decos.push(Decoration.mark({ class: "jx-cm-err-mark" }).range(from, to));
        } else {
          decos.push(
            Decoration.widget({
              widget: new CaretErrorWidget(),
              side: 1,
            }).range(from),
          );
        }
        return Decoration.set(decos, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const e of tr.effects) {
      if (e.is(setFlashEffect)) {
        if (e.value === null) return Decoration.none;
        const pos = Math.max(0, Math.min(tr.state.doc.length, e.value));
        const line = tr.state.doc.lineAt(pos);
        return Decoration.set([
          Decoration.line({ class: "jx-cm-flash-line" }).range(line.from),
        ]);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const defaultColRatio = 0.47;
const defaultExplorerRatio = 0.56;
const empty: Result = { rows: [], preview: "", size: 0, count: 0, hits: 0 };

function modeIcon(m: Mode) {
  switch (m) {
    case "format":
      return <Sparkles size={14} />;
    case "minify":
      return <Minimize2 size={14} />;
    case "escape":
      return <Quote size={14} />;
    case "unescape":
      return <Unlink size={14} />;
    case "xml":
      return <Code2 size={14} />;
    default:
      return <Braces size={14} />;
  }
}

export function JsonTool(props: FeatureProps) {
  function incoming(firstId: number) {
    let tabs: TabItem[] = [
      { id: firstId, name: "文档 " + firstId, initial: props.input },
    ];
    let active = firstId;
    if (props.args.jsonTabs) {
      try {
        const saved = JSON.parse(props.args.jsonTabs);
        if (
          Array.isArray(saved.tabs) &&
          saved.tabs.length &&
          Number.isInteger(saved.active) &&
          saved.tabs[saved.active] &&
          saved.tabs.every(
            (t: TabItem) =>
              typeof t.name === "string" && typeof t.initial === "string",
          )
        ) {
          active += saved.active;
          tabs = saved.tabs.map((t: TabItem, i: number) => ({
            id: firstId + i,
            name: t.name,
            initial: i === saved.active ? props.input : t.initial,
          }));
        }
      } catch {
        /* External launch arguments can be plain text. */
      }
    }
    return { tabs, active };
  }

  const [initial] = useState(() => incoming(1));
  const [tabs, setTabs] = useState(initial.tabs),
    [active, select] = useState(initial.active),
    [rename, setRename] = useState(0),
    [health, setHealth] = useState<Record<number, TabHealth>>({});
  const documents = useRef(new Map<number, string>()),
    serial = useRef(initial.tabs.length),
    last = useRef(props);

  function add(text = "") {
    const id = ++serial.current;
    setTabs((ts) => [...ts, { id, name: "文档 " + id, initial: text }]);
    select(id);
  }

  useEffect(() => {
    if (
      last.current.input !== props.input ||
      last.current.args.jsonTabs !== props.args.jsonTabs
    ) {
      const next = incoming(serial.current + 1);
      serial.current += next.tabs.length;
      setTabs((ts) => [...ts, ...next.tabs]);
      select(next.active);
    }
    last.current = props;
  }, [props.input, props.args.jsonTabs]);

  const remember = useCallback(
    (id: number, text: string) => {
      documents.current.set(id, text);
      if (id === active)
        props.ctx.remember(text, () => ({
          jsonTabs: JSON.stringify({
            active: tabs.findIndex((t) => t.id === active),
            tabs: tabs.map((t) => ({
              name: t.name,
              initial:
                t.id === active
                  ? ""
                  : (documents.current.get(t.id) ?? t.initial),
            })),
          }),
        }));
    },
    [active, tabs, props.ctx],
  );

  useEffect(() => {
    const t = tabs.find((t) => t.id === active)!;
    remember(active, documents.current.get(active) ?? t.initial);
  }, [tabs, active, remember]);

  useEffect(() => () => props.ctx.remember(""), []);

  const reportHealth = useCallback((id: number, st: TabHealth) => {
    setHealth((prev) => (prev[id] === st ? prev : { ...prev, [id]: st }));
  }, []);

  function close(id: number) {
    if (tabs.length <= 1) return;
    documents.current.delete(id);
    setHealth((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (active === id)
      select(next[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]!.id);
  }

  return (
    <div class="jx fx-page">
      <header class="jx-chrome">
        <div class="jx-brand" aria-hidden="true">
          <span class="jx-brand-badge">
            <Braces size={14} />
          </span>
          <span class="jx-brand-title">JSON Studio</span>
        </div>
        <span class="jx-chrome-sep" aria-hidden="true" />
        <SlidingTabs
          tabs={tabs}
          active={active}
          rename={rename}
          health={health}
          onSelect={select}
          onStartRename={setRename}
          onCommitRename={(id, name) => {
            setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, name } : x)));
            setRename(0);
          }}
          onClose={close}
          onAdd={() => add()}
        />
      </header>
      {tabs.map((t) => (
        <Workspace
          key={t.id}
          {...props}
          tab={t}
          active={active === t.id}
          remember={remember}
          reportHealth={reportHealth}
        />
      ))}
    </div>
  );
}

interface RowMenu {
  row: Row;
  x: number;
  y: number;
}

function Workspace({
  tab,
  active,
  remember,
  reportHealth,
  ctx,
  args,
}: FeatureProps & {
  tab: TabItem;
  active: boolean;
  remember: (id: number, text: string) => void;
  reportHealth: (id: number, st: TabHealth) => void;
}) {
  const [text, setText] = useState(() => tab.initial.replace(/\r\n?/g, "\n")),
    [mode, setMode] = useState<Mode>(
      args.action === "minify" ? "minify" : "tree",
    );
  const [expanded, expand] = useState([0]),
    [pages, setPages] = useState<Record<number, number>>({}),
    [selected, select] = useState(0),
    [query, find] = useState(""),
    [page, setPage] = useState(0),
    [hitIndex, setHitIndex] = useState(0);
  const [detailPage, setDetailPage] = useState(0),
    [collapsed, collapse] = useState(false),
    [autoEscape, setAutoEscape] = useState(true),
    [wrapOutput, setWrapOutput] = useState(false);
  const [scope, setScope] = useState<"text" | "node">("text");
  const [copiedTag, setCopiedTag] = useState("");
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const dialog = useRef<HTMLDialogElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    treeScrollRef = useRef<HTMLDivElement>(null);

  const [colRatio, setColRatio] = useState(defaultColRatio);
  const [explorerRatio, setExplorerRatio] = useState(defaultExplorerRatio);

  function showSearch(kind: "text" | "node") {
    setScope(kind);
    setPage(0);
    setHitIndex(0);
    if (!dialog.current?.open) dialog.current?.showModal();
    searchInput.current?.focus();
    searchInput.current?.select();
  }

  useEffect(() => {
    if (!active) return;
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        showSearch("text");
      }
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [active]);

  useEffect(() => {
    if (!menu) return;
    const closeMenu = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".jx-ctx-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  function inspect(id: number) {
    select(id);
    setDetailPage(0);
  }

  const [r, result] = useState<Result>(empty),
    [busy, working] = useState(true);
  const mount = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView>(),
    worker = useRef<Worker>(),
    seq = useRef(0),
    rpcSeq = useRef(-1),
    pendingRpc = useRef(new Map<number, (data: any) => void>()),
    sent = useRef<string>(),
    options = useRef<Options>();
  const live = useRef({ ctx, tab, mode });
  live.current = { ctx, tab, mode };
  const [ready, setReady] = useState(false);

  const markCopied = useCallback((tag: string) => {
    setCopiedTag(tag);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedTag(""), 1400);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(copyTimer.current);
      clearTimeout(flashTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const view = new EditorView({
      parent: mount.current!,
      state: EditorState.create({
        doc: tab.initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          json(),
          syntaxHighlighting(sourcePalette),
          diagField,
          flashField,
          EditorView.contentAttributes.of({
            "aria-label": "JSON 源码",
            spellcheck: "false",
          }),
          placeholder("粘贴或输入 JSON，支持多标签、精准纠错与节点复制…"),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setText(u.state.doc.toString());
              select(0);
              setDetailPage(0);
              expand([0]);
              setPages({});
              setPage(0);
              setMenu(null);
            }
          }),
        ],
      }),
    });
    editor.current = view;
    let w: Worker | undefined;
    try {
      w = new JsonWorker();
      worker.current = w;
      w.onmessage = (e) => {
        const msgId = e.data.id as number;
        const cb = pendingRpc.current.get(msgId);
        if (cb) {
          pendingRpc.current.delete(msgId);
          cb(e.data);
          return;
        }
        if (msgId !== seq.current) return;
        result(e.data.result);
        working(false);
      };
      w.onerror = () => {
        working(false);
        result({
          ...empty,
          error: {
            offset: 0,
            end: 0,
            line: 1,
            column: 1,
            message: "后台解析失败，请重新打开标签",
          },
        });
      };
      setReady(true);
    } catch (err) {
      working(false);
      result({
        ...empty,
        error: {
          offset: 0,
          end: 0,
          line: 1,
          column: 1,
          message: String(err),
        },
      });
    }
    return () => {
      pendingRpc.current.clear();
      view.destroy();
      w?.terminate();
    };
  }, []);

  useEffect(() => {
    if (active) remember(tab.id, text);
  }, [active, text, remember, tab.id]);

  useLayoutEffect(() => {
    if (!ready) return;
    const id = ++seq.current;
    working(true);
    const o: Options = {
      mode,
      expanded,
      pages,
      selected,
      query,
      page,
      detailPage,
      autoEscape,
      scope,
    };
    options.current = o;
    const changed = sent.current !== text;
    if (changed) result(empty);
    const timer = setTimeout(
      () => {
        worker.current?.postMessage({
          id,
          source: changed ? text : undefined,
          options: o,
        });
        sent.current = text;
      },
      changed || query ? 130 : 0,
    );
    return () => clearTimeout(timer);
  }, [
    ready,
    text,
    mode,
    expanded,
    pages,
    selected,
    query,
    page,
    detailPage,
    autoEscape,
    scope,
  ]);

  useEffect(() => {
    const v = editor.current;
    const err = r.error;
    if (v) {
      v.dispatch({
        effects: setDiagEffect.of(
          err ? { from: err.offset, to: err.end } : null,
        ),
      });
    }
    if (!text.trim()) {
      reportHealth(tab.id, "empty");
    } else if (err) {
      reportHealth(tab.id, "error");
    } else if (!busy) {
      reportHealth(tab.id, "valid");
    }
  }, [r.error, busy, text, tab.id, reportHealth]);

  function callWorker<T>(
    payload: Record<string, unknown>,
    customOptions?: Options,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!worker.current) {
        reject(new Error("解析线程未就绪"));
        return;
      }
      const id = rpcSeq.current--;
      pendingRpc.current.set(id, (data) => resolve(data as T));
      worker.current.postMessage({
        id,
        options: customOptions ?? options.current,
        ...payload,
      });
    });
  }

  async function full(op: "save" | "copy") {
    if (busy || r.error || !worker.current) return;
    try {
      const res = await callWorker<{ full?: string }>({ full: true });
      if (typeof res.full !== "string") return;
      const { ctx: c, tab: t, mode: m } = live.current;
      if (op === "copy") {
        await c.copy(res.full);
        markCopied("toolbar-copy");
      } else if (
        await DevTools.saveText(
          t.name + (m === "xml" ? ".xml" : m === "unescape" ? ".txt" : ".json"),
          res.full,
        )
      ) {
        c.toast("文件已保存");
      }
    } catch (err) {
      live.current.ctx.toast(String(err), true);
    }
  }

  async function copyNode(nodeId: number, format: CopyFormat, tag?: string) {
    if (r.error || !worker.current) return;
    try {
      const res = await callWorker<{ copied?: string; copiedError?: string }>({
        copyNode: { nodeId, format },
      });
      if (res.copiedError) {
        ctx.toast(res.copiedError, true);
        return;
      }
      if (typeof res.copied === "string") {
        await ctx.copy(res.copied, copyLabels[format]);
        if (tag) markCopied(tag);
      }
    } catch (err) {
      ctx.toast(String(err), true);
    }
  }

  async function beautifySource() {
    if (busy || r.error || !text.trim() || !editor.current) return;
    try {
      const res = await callWorker<{ full?: string }>(
        { full: true },
        { ...options.current!, mode: "format" },
      );
      if (typeof res.full === "string") {
        const v = editor.current;
        if (res.full === v.state.doc.toString()) {
          ctx.toast("源码已是规范格式");
          return;
        }
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: res.full },
        });
        ctx.toast("已美化源码");
      }
    } catch (err) {
      ctx.toast(String(err), true);
    }
  }

  async function repairAll() {
    if (!editor.current || !worker.current) return;
    try {
      const res = await callWorker<{
        repaired: string;
        fixes: number;
        complete: boolean;
      }>({ repairAll: true });
      const v = editor.current;
      if (res.fixes > 0) {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: res.repaired },
          scrollIntoView: true,
        });
        v.focus();
      }
      ctx.toast(
        res.complete
          ? `已自动修复 ${res.fixes} 处问题`
          : `已修复 ${res.fixes} 处，仍有部分问题需手动检查`,
        !res.complete,
      );
    } catch (err) {
      ctx.toast(String(err), true);
    }
  }

  async function expandAllNodes() {
    if (busy || r.error || !worker.current) return;
    const res = await callWorker<{ expandedIds?: number[] }>({
      expandAll: true,
    });
    if (res.expandedIds?.length) expand(res.expandedIds);
  }

  function clearSource() {
    const v = editor.current;
    if (!v || !v.state.doc.length) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: "" },
    });
    v.focus();
  }

  function jump(from: number, to = from) {
    const v = editor.current;
    if (!v) return;
    const len = v.state.doc.length;
    const a = Math.max(0, Math.min(len, from));
    const b = Math.max(a, Math.min(len, to));
    v.dispatch({
      selection: { anchor: a, head: b },
      effects: [
        EditorView.scrollIntoView(a, { y: "center" }),
        setFlashEffect.of(a),
      ],
    });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      editor.current?.dispatch({ effects: setFlashEffect.of(null) });
    }, 900);
    v.focus();
  }

  const err = r.error;
  const outputLines = useMemo(
    () => (r.preview ? r.preview.split("\n").length : 0),
    [r.preview],
  );
  const canJsonTransform = mode !== "escape" && mode !== "unescape";
  const allExpanded = expanded.length > 1;

  const pager = (n: number, total: number, change: (p: number) => void) => (
    <div class="jx-pager">
      <button type="button" disabled={!n} onClick={() => change(n - 1)}>
        <ChevronLeft size={12} />
        上一页
      </button>
      <span>
        {n + 1} / {Math.ceil(total / pageSize)}
      </span>
      <button
        type="button"
        disabled={(n + 1) * pageSize >= total}
        onClick={() => change(n + 1)}
      >
        下一页
        <ChevronRight size={12} />
      </button>
    </div>
  );

  function selectMatch(m: NonNullable<Result["matches"]>[number]) {
    dialog.current?.close();
    if (m.id !== undefined) {
      inspect(m.id);
      collapse(false);
      expand([
        ...new Set([...expanded, ...(m.trail ?? []).map((t) => t[0])]),
      ]);
      setPages({
        ...pages,
        ...Object.fromEntries(m.trail ?? []),
      });
    }
    jump(m.start, m.end);
  }

  function onTreeKeyDown(e: KeyboardEvent) {
    if (!r.rows.length) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      const selText = window.getSelection()?.toString();
      if (!selText) {
        e.preventDefault();
        void copyNode(selected, "value", `row-${selected}`);
      }
      return;
    }
    const idx = r.rows.findIndex((row) => row.id === selected);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = r.rows[Math.min(r.rows.length - 1, idx < 0 ? 0 : idx + 1)];
      if (next) {
        inspect(next.id);
        treeScrollRef.current
          ?.querySelector<HTMLElement>(`[data-row-id="${next.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = r.rows[Math.max(0, idx <= 0 ? 0 : idx - 1)];
      if (prev) {
        inspect(prev.id);
        treeScrollRef.current
          ?.querySelector<HTMLElement>(`[data-row-id="${prev.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowRight") {
      const cur = idx >= 0 ? r.rows[idx] : undefined;
      if (!cur || cur.count === 0) return;
      e.preventDefault();
      if (!expanded.includes(cur.id)) {
        expand([...expanded, cur.id]);
      } else if (r.rows[idx + 1] && r.rows[idx + 1]!.level > cur.level) {
        inspect(r.rows[idx + 1]!.id);
      }
    } else if (e.key === "ArrowLeft") {
      const cur = idx >= 0 ? r.rows[idx] : undefined;
      if (!cur) return;
      e.preventDefault();
      if (cur.count > 0 && expanded.includes(cur.id)) {
        expand(expanded.filter((id) => id !== cur.id));
      } else if (cur.level > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          if (r.rows[i]!.level < cur.level) {
            inspect(r.rows[i]!.id);
            break;
          }
        }
      }
    }
  }

  return (
    <section class="jx-work" hidden={!active}>
      <div class="jx-tools">
        <SlidingModes mode={mode} modes={modes} onChange={setMode} />
        <div class="jx-actions">
          {canJsonTransform && (
            <SlidingSwitch
              checked={autoEscape}
              label="自动转义"
              title="解析粘贴文本中的换行和 Markdown 转义，同时保留源码"
              onChange={(checked) => {
                setAutoEscape(checked);
                select(0);
                setDetailPage(0);
                setPages({});
                expand([0]);
              }}
            />
          )}
          <Btn
            small
            title="复制当前结果"
            disabled={busy || !!err || !text.length}
            onClick={() => void full("copy")}
          >
            {copiedTag === "toolbar-copy" ? (
              <Check size={14} class="jx-ok-pop" />
            ) : (
              <Copy size={14} />
            )}
            复制
          </Btn>
          <Btn
            small
            primary
            title="保存当前结果到文件"
            disabled={busy || !!err || !text.length}
            onClick={() => void full("save")}
          >
            <Save size={14} />
            保存
          </Btn>
        </div>
      </div>

      <div
        class="jx-stage"
        style={{
          "--jx-col-left": `${colRatio}fr`,
          "--jx-col-right": `${1 - colRatio}fr`,
        }}
      >
        <section class="jx-card jx-source-panel">
          <header class="jx-card-head">
            <span class="jx-head-icon is-source">
              <FileCode2 size={13} />
            </span>
            <span class="jx-head-title">源码</span>
            {!text.trim() ? (
              <span class="jx-status-pill is-idle">空白</span>
            ) : err ? (
              <button
                type="button"
                class="jx-status-pill is-err"
                title="跳转到错误位置"
                onClick={() => jump(err.offset, err.end)}
              >
                <AlertTriangle size={11} />第 {err.line} 行有误
              </button>
            ) : busy ? (
              <span class="jx-status-pill is-idle">解析中…</span>
            ) : (
              <span class="jx-status-pill is-ok">
                <CheckCircle2 size={11} />
                {canJsonTransform
                  ? `${r.count.toLocaleString()} 节点`
                  : `${text.length.toLocaleString()} 字符`}
              </span>
            )}
            <div class="jx-head-tools">
              {canJsonTransform && (
                <button
                  type="button"
                  title="美化源码（缩进 2 空格）"
                  disabled={busy || !!err || !text.trim()}
                  onClick={() => void beautifySource()}
                >
                  <Sparkles size={13} />
                </button>
              )}
              <button
                type="button"
                title="清空源码"
                disabled={!text.length}
                onClick={clearSource}
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                title="查找源码文本（Ctrl / ⌘ + F）"
                onClick={() => showSearch("text")}
              >
                <Search size={13} />
              </button>
            </div>
          </header>
          <div class="jx-editor" ref={mount} />
          {err && (
            <div class="jx-diagnostic" role="alert">
              <button
                type="button"
                class="jx-err"
                onClick={() =>
                  jump(err.offset, Math.min(text.length, err.end || err.offset))
                }
              >
                <span class="jx-err-badge">
                  <Crosshair size={12} />L{err.line}:{err.column}
                </span>
                <div class="jx-err-body">
                  <span class="jx-err-title">
                    第 {err.line} 行，第 {err.column} 列 · {err.message}
                  </span>
                  {err.hint && <span class="jx-err-hint">{err.hint}</span>}
                </div>
              </button>
              <div class="jx-diag-actions">
                {err.fix && (
                  <Btn
                    small
                    onClick={() => {
                      const fix = err.fix!;
                      editor.current?.dispatch({
                        changes: {
                          from: fix.from,
                          to: fix.to,
                          insert: fix.insert,
                        },
                        selection: { anchor: fix.from + fix.insert.length },
                        scrollIntoView: true,
                      });
                      editor.current?.focus();
                    }}
                  >
                    {err.fix.label}
                  </Btn>
                )}
                {err.repairAllCount && err.repairAllCount > 1 && (
                  <Btn
                    small
                    primary
                    title="自动修复所有可修复的语法问题"
                    onClick={() => void repairAll()}
                  >
                    <Wrench size={12} />
                    修复全部 ({err.repairAllCount})
                  </Btn>
                )}
              </div>
            </div>
          )}
        </section>

        <Splitter
          label="源码与右侧面板宽度"
          ratio={colRatio}
          resize={setColRatio}
          reset={() => setColRatio(defaultColRatio)}
        />

        {mode === "tree" ? (
          <div
            class={"jx-explorer" + (collapsed ? " is-folded" : "")}
            key="tree-stage"
            style={{
              "--jx-exp-top": `${explorerRatio}fr`,
              "--jx-exp-bottom": `${1 - explorerRatio}fr`,
            }}
          >
            <section class="jx-card jx-tree-panel">
              <header class="jx-card-head">
                <span class="jx-head-icon is-tree">
                  <ListTree size={13} />
                </span>
                <span class="jx-head-title">节点树</span>
                {!!r.rootCount && (
                  <span class="jx-meta-chip">
                    {r.rootCount.toLocaleString()} 项
                  </span>
                )}
                <div class="jx-head-tools">
                  {!!r.rows.length && (
                    <button
                      type="button"
                      title={allExpanded ? "全部折叠" : "展开全部（前 500 项）"}
                      onClick={() =>
                        allExpanded ? expand([0]) : void expandAllNodes()
                      }
                    >
                      {allExpanded ? (
                        <ChevronsDownUp size={13} />
                      ) : (
                        <ChevronsUpDown size={13} />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    title="查找节点"
                    disabled={!!err || !r.rows.length}
                    onClick={() => showSearch("node")}
                  >
                    <Search size={13} />
                  </button>
                </div>
              </header>
              <div
                class="jx-scroll"
                ref={treeScrollRef}
                tabIndex={0}
                aria-label="JSON 节点树"
                onScroll={() => menu && setMenu(null)}
                onKeyDown={onTreeKeyDown}
              >
                {r.rows.map((n) => {
                  const isOpen = expanded.includes(n.id);
                  const isSelected = selected === n.id;
                  const rowCopyTag = `row-${n.id}`;
                  return (
                    <div key={n.id}>
                      <div
                        data-row-id={n.id}
                        class={
                          "jx-row" +
                          (isSelected ? " current" : "") +
                          (menu?.row.id === n.id ? " is-menu" : "")
                        }
                        style={{
                          paddingLeft: 8 + Math.min(n.level, 8) * 16,
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          inspect(n.id);
                          setMenu({ row: n, x: e.clientX, y: e.clientY });
                        }}
                      >
                        {n.level > 0 && (
                          <span class="jx-guides" aria-hidden="true">
                            {Array.from({ length: Math.min(n.level, 8) }).map(
                              (_, i) => (
                                <i key={i} style={{ left: 16 + i * 16 }} />
                              ),
                            )}
                          </span>
                        )}
                        {n.count > 0 ? (
                          <button
                            type="button"
                            class={"jx-chev" + (isOpen ? " is-open" : "")}
                            aria-label={(isOpen ? "折叠 " : "展开 ") + n.key}
                            onClick={() =>
                              expand(
                                isOpen
                                  ? expanded.filter((i) => i !== n.id)
                                  : [...expanded, n.id],
                              )
                            }
                          >
                            <ChevronRight size={13} />
                          </button>
                        ) : (
                          <span class="jx-indent" />
                        )}
                        <span
                          class={`jx-type-pill is-${n.kind}`}
                          aria-hidden="true"
                        >
                          {kindTags[n.kind]}
                        </span>
                        <div
                          class="jx-key"
                          onClick={() => {
                            const sel = window.getSelection();
                            if (sel && !sel.isCollapsed && sel.toString().length)
                              return;
                            inspect(n.id);
                          }}
                          onDblClick={() => {
                            if (n.count > 0) {
                              expand(
                                isOpen
                                  ? expanded.filter((i) => i !== n.id)
                                  : [...expanded, n.id],
                              );
                            }
                          }}
                          title={`${n.key} (${kindLabels[n.kind]})`}
                        >
                          <span class="jx-key-text">{n.key}</span>
                          <em class={`jx-v-${n.kind}`}>{n.preview}</em>
                        </div>
                        <div class="jx-row-actions">
                          <button
                            type="button"
                            title="复制值"
                            aria-label={"复制 " + n.key + " 的值"}
                            onClick={(e) => {
                              e.stopPropagation();
                              void copyNode(n.id, "value", rowCopyTag);
                            }}
                          >
                            {copiedTag === rowCopyTag ? (
                              <Check size={12} class="jx-ok-pop" />
                            ) : (
                              <Copy size={12} />
                            )}
                          </button>
                          <button
                            type="button"
                            title="更多复制与操作"
                            aria-label="更多操作"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect =
                                e.currentTarget.getBoundingClientRect();
                              inspect(n.id);
                              setMenu({
                                row: n,
                                x: rect.right - 170,
                                y: rect.bottom + 4,
                              });
                            }}
                          >
                            <MoreHorizontal size={12} />
                          </button>
                        </div>
                      </div>
                      {isOpen &&
                        n.count > pageSize &&
                        pager(pages[n.id] ?? 0, n.count, (p) =>
                          setPages({ ...pages, [n.id]: p }),
                        )}
                    </div>
                  );
                })}
                {!r.rows.length && (
                  <div class="jx-empty-card">
                    <span class="jx-empty-orb">
                      <Braces size={20} />
                    </span>
                    <p>
                      {busy
                        ? "正在解析 JSON…"
                        : err
                          ? "源码存在语法错误，请修正后查看节点树"
                          : r.detail
                            ? r.detail.kind === "array"
                              ? "空数组 []"
                              : "空对象 {}"
                            : "在左侧输入或粘贴 JSON"}
                    </p>
                  </div>
                )}
              </div>
              {!!r.rootCount &&
                r.rootCount > pageSize &&
                pager(pages[0] ?? 0, r.rootCount, (p) =>
                  setPages({ ...pages, 0: p }),
                )}
            </section>

            {!collapsed && (
              <Splitter
                orientation="horizontal"
                label="节点树与节点详情高度"
                ratio={explorerRatio}
                resize={setExplorerRatio}
                reset={() => setExplorerRatio(defaultExplorerRatio)}
              />
            )}

            <section
              class={
                "jx-card jx-inspector" + (collapsed ? " is-folded" : "")
              }
            >
              <header class="jx-card-head">
                <span class="jx-head-icon is-detail">
                  <Layers3 size={13} />
                </span>
                <span class="jx-head-title">节点详情</span>
                {r.detail && (
                  <span class={`jx-kind-badge is-${r.detail.kind}`}>
                    {kindLabels[r.detail.kind]}
                  </span>
                )}
                {r.detail && (
                  <code class="jx-path-inline" title={r.path}>
                    {r.path}
                  </code>
                )}
                <div class="jx-head-tools">
                  {r.detail && (
                    <>
                      <button
                        type="button"
                        title="复制路径"
                        onClick={() =>
                          void copyNode(r.detail!.id, "path", "detail-path")
                        }
                      >
                        {copiedTag === "detail-path" ? (
                          <Check size={13} class="jx-ok-pop" />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                      <button
                        type="button"
                        title="复制当前节点值"
                        onClick={() =>
                          void copyNode(r.detail!.id, "value", "detail-node")
                        }
                      >
                        {copiedTag === "detail-node" ? (
                          <Check size={13} class="jx-ok-pop" />
                        ) : (
                          <Braces size={13} />
                        )}
                      </button>
                      <button
                        type="button"
                        title="定位源码"
                        onClick={() => jump(r.detail!.start, r.detail!.end)}
                      >
                        <Crosshair size={13} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    title={collapsed ? "展开节点详情" : "折叠节点详情"}
                    onClick={() => collapse(!collapsed)}
                  >
                    {collapsed ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                </div>
              </header>
              {!collapsed &&
                (r.detail ? (
                  <>
                    <div class="jx-detail">
                      <table>
                        <thead>
                          <tr>
                            <th>Key</th>
                            <th>Value</th>
                            <th aria-label="操作" />
                          </tr>
                        </thead>
                        <tbody>
                          {r.entries?.map((item) => {
                            const cellTag = `cell-${item.id}`;
                            return (
                              <tr key={item.id}>
                                <th title={item.key}>{item.key}</th>
                                <td class={"jx-v-" + item.kind}>
                                  {item.count > 0 && item.id !== selected ? (
                                    <button
                                      type="button"
                                      class="jx-drill"
                                      title="查看子节点"
                                      onClick={() => inspect(item.id)}
                                    >
                                      <span class="jx-drill-chip">
                                        {item.kind === "array"
                                          ? `[ ${item.count} ]`
                                          : `{ ${item.count} }`}
                                      </span>
                                      <span class="jx-drill-text">
                                        {item.preview.replace(/\s+/g, " ")}
                                      </span>
                                      <ChevronRight size={12} />
                                    </button>
                                  ) : (
                                    item.preview
                                  )}
                                </td>
                                <td class="jx-td-act">
                                  <button
                                    type="button"
                                    title="复制值"
                                    aria-label={"复制 " + item.key + " 的值"}
                                    onClick={() =>
                                      void copyNode(item.id, "value", cellTag)
                                    }
                                  >
                                    {copiedTag === cellTag ? (
                                      <Check size={12} class="jx-ok-pop" />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {!r.entries?.length && (
                        <div class="jx-empty-card">
                          <p>
                            {r.detail.kind === "array" ? "空数组 []" : "空对象 {}"}
                          </p>
                        </div>
                      )}
                    </div>
                    {r.detail.count > pageSize &&
                      pager(detailPage, r.detail.count, setDetailPage)}
                  </>
                ) : (
                  <div class="jx-empty-card">
                    <span class="jx-empty-orb">
                      <Layers3 size={18} />
                    </span>
                    <p>点击上方节点树查看键值详情</p>
                  </div>
                ))}
            </section>
          </div>
        ) : (
          <section class="jx-card jx-output-panel" key={`out-${mode}`}>
            <header class="jx-card-head">
              <span class="jx-head-icon is-output">{modeIcon(mode)}</span>
              <span class="jx-head-title">{modes[mode]}结果</span>
              {!!r.preview && (
                <span class="jx-meta-chip">
                  {formatBytes(r.size)} · {outputLines.toLocaleString()} 行
                </span>
              )}
              <div class="jx-head-tools">
                <SlidingSwitch
                  checked={wrapOutput}
                  label="换行"
                  title="自动折行显示长文本"
                  onChange={setWrapOutput}
                />
                <button
                  type="button"
                  title="复制输出结果"
                  disabled={busy || !!err || !r.preview}
                  onClick={() => void full("copy")}
                >
                  {copiedTag === "toolbar-copy" ? (
                    <Check size={13} class="jx-ok-pop" />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
              </div>
            </header>
            {err ? (
              <div class="jx-empty-card is-error">
                <span class="jx-empty-orb is-error">
                  <AlertTriangle size={20} />
                </span>
                <strong>无法生成{modes[mode]}结果</strong>
                <p>
                  第 {err.line} 行，第 {err.column} 列：{err.message}
                </p>
                {err.fix && (
                  <Btn
                    small
                    primary
                    onClick={() => {
                      const fix = err.fix!;
                      editor.current?.dispatch({
                        changes: {
                          from: fix.from,
                          to: fix.to,
                          insert: fix.insert,
                        },
                        selection: { anchor: fix.from + fix.insert.length },
                        scrollIntoView: true,
                      });
                      editor.current?.focus();
                    }}
                  >
                    {err.fix.label}
                  </Btn>
                )}
              </div>
            ) : (
              <Output mode={mode} text={r.preview} wrap={wrapOutput} />
            )}
          </section>
        )}
      </div>

      {menu && (
        <div
          class="jx-ctx-menu"
          role="menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 196)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 250)),
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const row = menu.row;
              setMenu(null);
              void copyNode(row.id, "value", `row-${row.id}`);
            }}
          >
            <Copy size={13} />
            <span>复制值</span>
          </button>
          {menu.row.parentKind === "object" && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  void copyNode(row.id, "key");
                }}
              >
                <Code2 size={13} />
                <span>复制键名</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  void copyNode(row.id, "pair");
                }}
              >
                <Braces size={13} />
                <span>复制键值对</span>
              </button>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const row = menu.row;
              setMenu(null);
              void copyNode(row.id, "path");
            }}
          >
            <ListTree size={13} />
            <span>复制 JSON 路径</span>
          </button>
          {menu.row.count > 0 ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  void copyNode(row.id, "pretty");
                }}
              >
                <Sparkles size={13} />
                <span>复制格式化 JSON</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = menu.row;
                  setMenu(null);
                  void copyNode(row.id, "minify");
                }}
              >
                <Minimize2 size={13} />
                <span>复制压缩 JSON</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const row = menu.row;
                setMenu(null);
                void copyNode(row.id, "minify");
              }}
            >
              <Minimize2 size={13} />
              <span>复制原始 JSON 值</span>
            </button>
          )}
          <div class="jx-ctx-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const row = menu.row;
              setMenu(null);
              jump(row.start, row.end);
            }}
          >
            <Crosshair size={13} />
            <span>定位到源码</span>
          </button>
        </div>
      )}

      <dialog
        class="jx-searchbox"
        ref={dialog}
        aria-label="查找"
        onClose={() => {
          find("");
          setPage(0);
          setHitIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            dialog.current?.close();
          } else if (e.key === "ArrowDown" && r.matches?.length) {
            e.preventDefault();
            setHitIndex((i) => Math.min(r.matches!.length - 1, i + 1));
          } else if (e.key === "ArrowUp" && r.matches?.length) {
            e.preventDefault();
            setHitIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && r.matches?.[hitIndex]) {
            e.preventDefault();
            selectMatch(r.matches[hitIndex]!);
          }
        }}
      >
        <header>
          <span class="jx-head-icon is-source">
            <Search size={13} />
          </span>
          <strong>快速查找</strong>
          <button
            type="button"
            aria-label="关闭查找"
            onClick={() => dialog.current?.close()}
          >
            <X size={15} />
          </button>
        </header>
        <SlidingScope
          scope={scope}
          treeAvailable={mode === "tree"}
          options={[
            { key: "text", label: "源码文本", icon: <Code2 size={13} /> },
            { key: "node", label: "节点", icon: <ListTree size={13} /> },
          ]}
          onSelect={(k) => showSearch(k)}
        />
        <div class="jx-searchfield">
          <input
            ref={searchInput}
            class="jx-searchinput"
            aria-label="搜索内容"
            placeholder={scope === "node" ? "输入键名或值" : "输入要查找的文本"}
            value={query}
            onInput={(e) => {
              find(e.currentTarget.value);
              setPage(0);
              setHitIndex(0);
            }}
          />
          {query && (
            <button
              type="button"
              class="jx-searchclear"
              aria-label="清空搜索"
              onClick={() => {
                find("");
                setPage(0);
                setHitIndex(0);
                searchInput.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {query && (
          <>
            <small role="status">
              {busy ? "正在查找…" : `共 ${r.hits.toLocaleString()} 处匹配`}
            </small>
            <div class="jx-hits">
              {!busy &&
                r.matches?.map((m, i) => (
                  <button
                    type="button"
                    key={`${m.start}-${m.id ?? i}`}
                    class={i === hitIndex ? "is-active" : ""}
                    onMouseEnter={() => setHitIndex(i)}
                    onClick={() => selectMatch(m)}
                  >
                    <b>{m.label}</b>
                    <span>
                      {m.context ||
                        "第 " +
                          editor.current?.state.doc.lineAt(
                            Math.min(m.start, editor.current.state.doc.length),
                          ).number +
                          " 行"}
                    </span>
                  </button>
                ))}
            </div>
            {r.hits > pageSize && pager(page, r.hits, setPage)}
          </>
        )}
      </dialog>
    </section>
  );
}
