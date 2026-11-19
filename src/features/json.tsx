import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  placeholder,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { Splitter } from "./json/splitter";
import { Output } from "./json/output";
import { json } from "@codemirror/lang-json";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  Braces,
  Plus,
  X,
  Pencil,
  Copy,
  Save,
  Search,
  ListTree,
  ChevronRight,
  ChevronDown,
  FileCode2,
  Crosshair,
  PanelRightClose,
  PanelRightOpen,
  Layers3,
  Code2,
} from "lucide-preact";
import { DevTools } from "../mygo";
import { Btn } from "./ui";
import type { FeatureProps } from "./types";
import JsonWorker from "./json/worker?worker&inline";
import {
  pageSize,
  type Result,
  type Options,
  type Mode,
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
// Previous proportions were 1 : .88 : 1.12. Give one fifth of the
// inspector's width back to the two equally sized editing panes.
const defaultWidths = [1.052, 1.052, 0.896] as const;
const empty: Result = { rows: [], preview: "", size: 0, count: 0, hits: 0 };
interface Tab {
  id: number;
  name: string;
  initial: string;
}
export function JsonTool(props: FeatureProps) {
  function incoming(firstId: number) {
    let tabs: Tab[] = [
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
            (t: Tab) =>
              typeof t.name === "string" && typeof t.initial === "string",
          )
        ) {
          active += saved.active;
          tabs = saved.tabs.map((t: Tab, i: number) => ({
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
    [rename, setRename] = useState(0);
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
  const remember = (id: number, text: string) => {
    documents.current.set(id, text);
    if (id === active)
      props.ctx.remember(text, () => ({
        jsonTabs: JSON.stringify({
          active: tabs.findIndex((t) => t.id === active),
          tabs: tabs.map((t) => ({
            name: t.name,
            initial:
              t.id === active ? "" : (documents.current.get(t.id) ?? t.initial),
          })),
        }),
      }));
  };
  useEffect(() => {
    const t = tabs.find((t) => t.id === active)!;
    remember(active, documents.current.get(active) ?? t.initial);
  }, [tabs, active]);
  useEffect(() => () => props.ctx.remember(""), []);
  function close(id: number) {
    if (tabs.length <= 1) return;
    documents.current.delete(id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (active === id)
      select(next[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]!.id);
  }
  return (
    <div class="jx fx-page">
      <nav class="jx-tabs" aria-label="JSON 文档">
        {tabs.map((t) => (
          <div
            key={t.id}
            class={"jx-tab " + (active === t.id ? "current" : "")}
          >
            <Braces size={14} />
            {rename === t.id ? (
              <input
                ref={(node) => {
                  if (node && document.activeElement !== node) {
                    node.focus();
                    node.select();
                  }
                }}
                aria-label="标签名称"
                defaultValue={t.name}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim() || t.name;
                  setTabs((ts) =>
                    ts.map((x) => (x.id === t.id ? { ...x, name } : x)),
                  );
                  setRename(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    e.currentTarget.value = t.name;
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                onClick={() => select(t.id)}
                onDblClick={() => setRename(t.id)}
              >
                {t.name}
              </button>
            )}
            {active === t.id && (
              <button title="重命名标签" onClick={() => setRename(t.id)}>
                <Pencil size={12} />
              </button>
            )}
            {tabs.length > 1 && (
              <button title={"关闭 " + t.name} onClick={() => close(t.id)}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        <Btn icon small title="新建标签" onClick={() => add()}>
          <Plus size={16} />
        </Btn>
      </nav>
      {tabs.map((t) => (
        <Workspace
          key={t.id}
          {...props}
          tab={t}
          active={active === t.id}
          remember={remember}
        />
      ))}
    </div>
  );
}
function Workspace({
  tab,
  active,
  remember,
  ctx,
  args,
}: FeatureProps & {
  tab: Tab;
  active: boolean;
  remember: (id: number, text: string) => void;
}) {
  const [text, setText] = useState(() => tab.initial.replace(/\r\n?/g, "\n")),
    [mode, setMode] = useState<Mode>(
      args.action === "minify" ? "minify" : "tree",
    );
  const [expanded, expand] = useState([0]),
    [pages, setPages] = useState<Record<number, number>>({}),
    [selected, select] = useState(0),
    [query, find] = useState(""),
    [page, setPage] = useState(0);
  const [detailPage, setDetailPage] = useState(0),
    [collapsed, collapse] = useState(false),
    [autoEscape, setAutoEscape] = useState(true);
  const [scope, setScope] = useState<"text" | "node">("text");
  const dialog = useRef<HTMLDialogElement>(null),
    searchInput = useRef<HTMLInputElement>(null);
  function showSearch(kind: "text" | "node") {
    setScope(kind);
    setPage(0);
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
  function inspect(id: number) {
    select(id);
    setDetailPage(0);
    collapse(false);
  }
  const [widths, setWidths] = useState<readonly number[]>(defaultWidths);
  function divider(index: 0 | 1) {
    const weight = widths[index]! + widths[index + 1]!;
    return (
      <Splitter
        label={index === 0 ? "源码与节点树宽度" : "节点树与节点详情宽度"}
        ratio={widths[index]! / weight}
        resize={(fraction) =>
          setWidths((previous) => {
            const next = [...previous],
              sum = previous[index]! + previous[index + 1]!;
            next[index] = sum * fraction;
            next[index + 1] = sum - next[index];
            return next;
          })
        }
        reset={() => setWidths(defaultWidths)}
      />
    );
  }
  const [r, result] = useState<Result>(empty),
    [busy, working] = useState(true);
  const mount = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView>(),
    worker = useRef<Worker>(),
    seq = useRef(0),
    sent = useRef<string>(),
    options = useRef<Options>(),
    operation = useRef<"save" | "copy">();
  const live = useRef({ ctx, tab, mode });
  live.current = { ctx, tab, mode };
  const [ready, setReady] = useState(false);
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
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.contentAttributes.of({
            "aria-label": "JSON 源码",
            spellcheck: "false",
          }),
          placeholder("粘贴或输入 JSON…"),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setText(u.state.doc.toString());
              select(0);
              setDetailPage(0);
              expand([0]);
              setPages({});
              setPage(0);
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
      w.onmessage = async (e) => {
        if (e.data.id !== seq.current) return;
        if (typeof e.data.full === "string") {
          const op = operation.current;
          operation.current = undefined;
          const { ctx, tab, mode } = live.current;
          try {
            if (op === "copy") await ctx.copy(e.data.full);
            else if (
              op === "save" &&
              (await DevTools.saveText(
                tab.name +
                  (mode === "xml"
                    ? ".xml"
                    : mode === "unescape"
                      ? ".txt"
                      : ".json"),
                e.data.full,
              ))
            )
              ctx.toast("文件已保存");
          } catch (err) {
            ctx.toast(String(err), true);
          }
        } else {
          result(e.data.result);
          working(false);
        }
      };
      w.onerror = () => {
        working(false);
        result({
          ...empty,
          error: { offset: 0, message: "后台解析失败，请重新打开标签" },
        });
      };
      setReady(true);
    } catch (err) {
      working(false);
      result({ ...empty, error: { offset: 0, message: String(err) } });
    }
    return () => {
      view.destroy();
      w?.terminate();
    };
  }, []);
  useEffect(() => {
    if (active) remember(tab.id, text);
  }, [active, text]);
  useLayoutEffect(() => {
    if (!ready) return;
    const id = ++seq.current;
    operation.current = undefined;
    working(true);
    const o = {
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
  function full(op: "save" | "copy") {
    if (busy || r.error || !worker.current) return;
    operation.current = op;
    worker.current.postMessage({
      id: ++seq.current,
      options: options.current,
      full: true,
    });
  }
  function jump(from: number, to = from) {
    const v = editor.current;
    if (!v) return;
    v.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    v.focus();
  }
  const err = r.error,
    doc = editor.current?.state.doc,
    line = err && doc?.lineAt(Math.min(err.offset, doc.length));
  const pager = (n: number, total: number, change: (p: number) => void) => (
    <div class="jx-pager">
      <button disabled={!n} onClick={() => change(n - 1)}>
        上一页
      </button>
      <span>
        {n + 1} / {Math.ceil(total / pageSize)}
      </span>
      <button
        disabled={(n + 1) * pageSize >= total}
        onClick={() => change(n + 1)}
      >
        下一页
      </button>
    </div>
  );
  return (
    <section class="jx-work" hidden={!active}>
      <div class="jx-tools">
        <div class="jx-modes">
          {(Object.keys(modes) as Mode[]).map((m) => (
            <button aria-pressed={mode === m} onClick={() => setMode(m)}>
              {modes[m]}
            </button>
          ))}
        </div>
        <div class="jx-actions">
          {mode !== "escape" && mode !== "unescape" && (
            <label
              class="jx-switch"
              title="解析粘贴文本中的换行和 Markdown 转义，保留源码"
            >
              <input
                type="checkbox"
                checked={autoEscape}
                onChange={(e) => {
                  setAutoEscape(e.currentTarget.checked);
                  select(0);
                  setDetailPage(0);
                  setPages({});
                  expand([0]);
                }}
              />
              自动转义
            </label>
          )}
          <Btn
            small
            title="复制当前结果"
            disabled={busy || !!err || !text.length}
            onClick={() => full("copy")}
          >
            <Copy size={14} />
            复制
          </Btn>
          <Btn
            small
            primary
            title="保存当前结果到文件"
            disabled={busy || !!err || !text.length}
            onClick={() => full("save")}
          >
            <Save size={14} />
            保存
          </Btn>
        </div>
      </div>
      <div
        style={{
          "--jx-source": widths[0] + "fr",
          "--jx-tree": widths[1] + "fr",
          "--jx-details": widths[2] + "fr",
        }}
        class={
          "jx-grid " +
          (mode === "tree" ? (collapsed ? "tree folded" : "tree") : "output")
        }
      >
        <section class="jx-panel">
          <header>
            <FileCode2 />
            源码
            <button
              title="查找源码文本（Ctrl / ⌘ + F）"
              onClick={() => {
                showSearch("text");
              }}
            >
              <Search />
            </button>
          </header>
          <div class="jx-editor" ref={mount} />
          {err && (
            <div class="jx-diagnostic">
              <button
                class="jx-err"
                onClick={() =>
                  jump(err.offset, Math.min(text.length, err.offset + 1))
                }
              >
                <Crosshair size={14} />
                {line
                  ? "第 " +
                    line.number +
                    " 行，第 " +
                    (err.offset - line.from + 1) +
                    " 列 · "
                  : ""}
                {err.message}
              </button>
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
            </div>
          )}
        </section>
        {mode === "tree" ? (
          <>
            {divider(0)}
            <section class="jx-panel">
              <header>
                <ListTree />
                节点树
                <small>
                  {r.rootCount ? r.rootCount.toLocaleString() + " 项" : ""}
                </small>
                <button title="查找节点" onClick={() => showSearch("node")}>
                  <Search />
                </button>
                {collapsed && (
                  <button title="展开节点详情" onClick={() => collapse(false)}>
                    <PanelRightOpen />
                  </button>
                )}
              </header>
              <div class="jx-scroll">
                {r.rows.map((n) => (
                  <div key={n.id}>
                    <div
                      class={"jx-row " + (selected === n.id ? "current" : "")}
                      style={{ paddingLeft: 6 + Math.min(n.level, 8) * 12 }}
                    >
                      {n.count > 0 ? (
                        <button
                          aria-label={
                            (expanded.includes(n.id) ? "折叠 " : "展开 ") +
                            n.key
                          }
                          onClick={() =>
                            expand(
                              expanded.includes(n.id)
                                ? expanded.filter((i) => i !== n.id)
                                : [...expanded, n.id],
                            )
                          }
                        >
                          {expanded.includes(n.id) ? (
                            <ChevronDown />
                          ) : (
                            <ChevronRight />
                          )}
                        </button>
                      ) : (
                        <span class="jx-indent" />
                      )}
                      <button
                        class="jx-key"
                        onClick={() => inspect(n.id)}
                        title={n.key}
                      >
                        {n.key}
                        <em>{n.preview}</em>
                      </button>
                    </div>
                    {expanded.includes(n.id) &&
                      n.count > pageSize &&
                      pager(pages[n.id] ?? 0, n.count, (p) =>
                        setPages({ ...pages, [n.id]: p }),
                      )}
                  </div>
                ))}
                {!r.rows.length && (
                  <p class="jx-empty">
                    {busy
                      ? "解析中…"
                      : err
                        ? "请修正源码"
                        : r.detail
                          ? r.detail.kind === "array"
                            ? "空数组"
                            : "空对象"
                          : "等待 JSON"}
                  </p>
                )}
              </div>
              {!!r.rootCount &&
                r.rootCount > pageSize &&
                pager(pages[0] ?? 0, r.rootCount, (p) =>
                  setPages({ ...pages, 0: p }),
                )}
            </section>
            {!collapsed && divider(1)}
            {!collapsed && (
              <section class="jx-panel jx-inspector">
                <header>
                  <Layers3 />
                  节点详情
                  <button title="折叠节点详情" onClick={() => collapse(true)}>
                    <PanelRightClose />
                  </button>
                </header>
                {r.detail ? (
                  <>
                    <div class="jx-path">
                      <code>{r.path}</code>
                      <button
                        title="定位源码"
                        onClick={() => jump(r.detail!.start, r.detail!.end)}
                      >
                        <Crosshair size={14} />
                      </button>
                    </div>
                    <div class="jx-detail">
                      <table>
                        <thead>
                          <tr>
                            <th>Key</th>
                            <th>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.entries?.map((item) => (
                            <tr key={item.id}>
                              <th>{item.key}</th>
                              <td class={"jx-v-" + item.kind}>
                                {item.count > 0 && item.id !== selected ? (
                                  <button
                                    title="查看子节点"
                                    onClick={() => inspect(item.id)}
                                  >
                                    {item.preview}
                                    <ChevronRight size={12} />
                                  </button>
                                ) : (
                                  item.preview
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!r.entries?.length && (
                        <p class="jx-empty">
                          {r.detail.kind === "array" ? "空数组" : "空对象"}
                        </p>
                      )}
                    </div>
                    {r.detail.count > pageSize &&
                      pager(detailPage, r.detail.count, setDetailPage)}
                  </>
                ) : (
                  <p class="jx-empty">选择节点查看键和值</p>
                )}
              </section>
            )}
          </>
        ) : (
          <section class="jx-panel">
            <header>
              <Braces />
              {modes[mode]}结果
            </header>
            <Output mode={mode} text={r.preview} />
          </section>
        )}
      </div>
      <dialog
        class="jx-searchbox"
        ref={dialog}
        aria-label="查找"
        onClose={() => {
          find("");
          setPage(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            dialog.current?.close();
          }
        }}
      >
        <header>
          <Search size={18} />
          <strong>查找</strong>
          <button aria-label="关闭查找" onClick={() => dialog.current?.close()}>
            <X size={16} />
          </button>
        </header>
        <div class="jx-searchmodes">
          {(["text", "node"] as const).map((k) => (
            <button
              aria-pressed={k === scope}
              disabled={k === "node" && mode !== "tree"}
              onClick={() => showSearch(k)}
            >
              {k === "text" ? <Code2 size={14} /> : <ListTree size={14} />}{" "}
              {k === "text" ? "源码文本" : "节点"}
            </button>
          ))}
        </div>
        <input
          ref={searchInput}
          class="jx-searchinput"
          aria-label="搜索内容"
          placeholder={scope === "node" ? "输入键名或值" : "输入要查找的文本"}
          value={query}
          onInput={(e) => {
            find(e.currentTarget.value);
            setPage(0);
          }}
        />
        {query && (
          <>
            <small role="status">
              {busy ? "正在查找…" : r.hits + " 处匹配"}
            </small>
            <div class="jx-hits">
              {!busy &&
                r.matches?.map((m) => (
                  <button
                    onClick={() => {
                      dialog.current?.close();
                      if (m.id !== undefined) {
                        inspect(m.id);
                        expand([
                          ...new Set([
                            ...expanded,
                            ...(m.trail ?? []).map((t) => t[0]),
                          ]),
                        ]);
                        setPages({
                          ...pages,
                          ...Object.fromEntries(m.trail ?? []),
                        });
                      }
                      jump(m.start, m.end);
                    }}
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
