import { useEffect, useRef, useState } from "preact/hooks";
import { ArrowDown, ArrowLeftRight, ArrowUp, ClipboardPaste, Copy, Eraser, FoldVertical, Sparkles, WrapText } from "lucide-preact";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { loadLanguage, pocketHighlight, pocketTheme } from "../shared/code/editor";
import { LangPicker } from "../shared/code/langpick";
import { guessLang } from "../shared/code/languages";
import { formatCode } from "../shared/code/format";
import { Btn } from "./ui";
import type { FeatureProps } from "./types";

type Side = "a" | "b";

/** 常用的文本处理，对一边的全部内容生效。 */
const textOps: { id: string; label: string; run: (s: string) => string }[] = [
  { id: "trim", label: "去掉行尾空白", run: (s) => s.replace(/[ \t]+$/gm, "") },
  { id: "blank", label: "删除空行", run: (s) => s.split("\n").filter((l) => l.trim()).join("\n") },
  { id: "sort", label: "按行排序", run: (s) => s.split("\n").sort((x, y) => x.localeCompare(y, "zh")).join("\n") },
  { id: "uniq", label: "去掉重复行", run: (s) => [...new Set(s.split("\n"))].join("\n") },
  { id: "lower", label: "转小写", run: (s) => s.toLowerCase() },
  { id: "upper", label: "转大写", run: (s) => s.toUpperCase() },
  { id: "squeeze", label: "压缩连续空白", run: (s) => s.replace(/[ \t]+/g, " ").replace(/^ | $/gm, "") },
  { id: "tabs", label: "制表符转两个空格", run: (s) => s.replace(/\t/g, "  ") },
  { id: "crlf", label: "统一换行符（CRLF → LF）", run: (s) => s.replace(/\r\n?/g, "\n") },
];

interface Stats {
  chunks: number;
  added: number;
  removed: number;
}

/** 文本对比：两边都能直接编辑，差异实时高亮；中间的箭头把一处改动从左边搬到右边。 */
export function DiffTool({ input, ctx }: FeatureProps) {
  const host = useRef<HTMLDivElement>(null);
  const mv = useRef<MergeView | null>(null);
  const comps = useRef({ langA: new Compartment(), langB: new Compartment(), wrapA: new Compartment(), wrapB: new Compartment() });
  const [lang, setLang] = useState("text");
  const [wrap, setWrap] = useState(false);
  const [collapse, setCollapse] = useState(false);
  const [stats, setStats] = useState<Stats>({ chunks: 0, added: 0, removed: 0 });
  const [empty, setEmpty] = useState({ a: !input, b: true });
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const guessed = useRef(false);

  const text = (side: Side) => mv.current?.[side].state.doc.toString() ?? "";
  const setText = (side: Side, value: string) => {
    const v = mv.current?.[side];
    if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  };

  const measure = () => {
    const m = mv.current;
    if (!m) return;
    const info = getChunks(m.b.state);
    let added = 0;
    let removed = 0;
    for (const c of info?.chunks ?? []) {
      // 一处改动两边各占若干行；空的一边（纯新增或纯删除）起止位置相同。
      const lines = (doc: EditorState["doc"], from: number, to: number) => (to > from ? doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(from).number + 1 : 0);
      removed += lines(m.a.state.doc, c.fromA, c.toA);
      added += lines(m.b.state.doc, c.fromB, c.toB);
    }
    setStats({ chunks: info?.chunks.length ?? 0, added, removed });
    setEmpty({ a: m.a.state.doc.length === 0, b: m.b.state.doc.length === 0 });
    ctx.remember(m.a.state.doc.toString());
  };

  const build = (a: string, b: string, collapsed: boolean) => {
    if (!host.current) return;
    mv.current?.destroy();
    const c = comps.current;
    const onChange = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(measure, 120);
      // 第一次粘进内容时猜一下语言，省得手动选。
      if (!guessed.current) {
        const g = guessLang(u.state.doc.toString());
        if (g) {
          guessed.current = true;
          setLang(g);
        }
      }
    });
    const common: Extension[] = [basicSetup, keymap.of([indentWithTab]), pocketTheme, pocketHighlight, onChange];
    const view = new MergeView({
      parent: host.current,
      a: { doc: a, extensions: [...common, c.langA.of([]), c.wrapA.of(wrap ? EditorView.lineWrapping : [])] },
      b: { doc: b, extensions: [...common, c.langB.of([]), c.wrapB.of(wrap ? EditorView.lineWrapping : [])] },
      highlightChanges: true,
      gutter: true,
      revertControls: "a-to-b",
      collapseUnchanged: collapsed ? { margin: 3, minSize: 4 } : undefined,
    });
    mv.current = view;
    loadLanguage(view.a, c.langA, lang);
    loadLanguage(view.b, c.langB, lang);
    measure();
  };

  useEffect(() => {
    build(input, "", collapse);
    mv.current?.a.focus();
    return () => {
      clearTimeout(timer.current);
      mv.current?.destroy();
      mv.current = null;
    };
  }, []);
  useEffect(() => {
    if (input && mv.current && input !== text("a")) setText("a", input);
  }, [input]);
  useEffect(() => {
    const m = mv.current;
    if (!m) return;
    loadLanguage(m.a, comps.current.langA, lang);
    loadLanguage(m.b, comps.current.langB, lang);
  }, [lang]);
  useEffect(() => {
    const m = mv.current;
    if (!m) return;
    const ext = wrap ? EditorView.lineWrapping : [];
    m.a.dispatch({ effects: comps.current.wrapA.reconfigure(ext) });
    m.b.dispatch({ effects: comps.current.wrapB.reconfigure(ext) });
  }, [wrap]);

  const format = async () => {
    setBusy(true);
    try {
      for (const side of ["a", "b"] as Side[]) {
        const src = text(side);
        if (src.trim()) setText(side, await formatCode(lang, src));
      }
      ctx.toast("已格式化");
    } catch (e) {
      ctx.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const jump = (dir: 1 | -1) => {
    const v = mv.current?.b;
    if (!v) return;
    v.focus();
    (dir > 0 ? goToNextChunk : goToPreviousChunk)(v);
  };
  const paste = async (side: Side) => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(side, t);
    } catch {
      mv.current?.[side].focus();
      ctx.toast(`点一下这边，再按 ${ctx.platform === "darwin" ? "⌘V" : "Ctrl+V"} 粘贴`);
    }
  };
  const applyOp = (id: string, side: Side | "both") => {
    const op = textOps.find((o) => o.id === id);
    if (!op) return;
    for (const s of side === "both" ? (["a", "b"] as Side[]) : [side]) setText(s, op.run(text(s)));
  };

  const same = stats.chunks === 0;
  const sideBar = (side: Side, title: string) => (
    <div class="fx-diff-head">
      <b>{title}</b>
      <span class="fx-spacer" />
      <Btn small ghost icon title="粘贴剪贴板里的内容" onClick={() => void paste(side)}>
        <ClipboardPaste size={13} />
      </Btn>
      <Btn small ghost icon title="复制这一边" disabled={empty[side]} onClick={() => void ctx.copy(text(side))}>
        <Copy size={13} />
      </Btn>
      <Btn small ghost icon title="清空这一边" disabled={empty[side]} onClick={() => setText(side, "")}>
        <Eraser size={13} />
      </Btn>
    </div>
  );

  return (
    <div class="fx-page fx-diff2">
      <div class="fx-toolbar">
        <LangPicker value={lang} onChange={(l) => { guessed.current = true; setLang(l); }} />
        <Btn small disabled={busy || (empty.a && empty.b)} title="按所选语言格式化两边，再比较就只剩真正的差异" onClick={() => void format()}>
          <Sparkles size={13} /> 格式化
        </Btn>
        <select
          class="ui-select"
          aria-label="文本处理"
          value=""
          onChange={(e) => {
            const el = e.target as HTMLSelectElement;
            applyOp(el.value, "both");
            el.value = "";
          }}
        >
          <option value="">文本处理…</option>
          {textOps.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <span class="fx-spacer" />
        <Btn small ghost icon title="上一处差异" disabled={same} onClick={() => jump(-1)}>
          <ArrowUp size={14} />
        </Btn>
        <Btn small ghost icon title="下一处差异" disabled={same} onClick={() => jump(1)}>
          <ArrowDown size={14} />
        </Btn>
        <Btn small ghost icon title="左右交换" onClick={() => { const [a, b] = [text("a"), text("b")]; setText("a", b); setText("b", a); }}>
          <ArrowLeftRight size={14} />
        </Btn>
        <Btn small ghost icon title={collapse ? "展开相同的部分" : "折叠相同的部分，只看差异"} on={collapse} onClick={() => { const next = !collapse; setCollapse(next); build(text("a"), text("b"), next); }}>
          <FoldVertical size={14} />
        </Btn>
        <Btn small ghost icon title="自动换行" on={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={14} />
        </Btn>
      </div>
      <div class="fx-out fx-grow-1 fx-diff-box">
        <div class="fx-diff-heads">
          {sideBar("a", "原文")}
          {sideBar("b", "修改后")}
        </div>
        <div class="fx-diff-merge" ref={host} />
      </div>
      <div class="fx-meta fx-diff-status">
        {empty.a && empty.b ? (
          "把两段内容分别粘到左右两边；两边都能直接改，差异会实时标出来"
        ) : same ? (
          <span class="fx-diff-same">两边完全相同</span>
        ) : (
          <>
            {stats.chunks} 处差异 · <span class="fx-diff-add">+{stats.added} 行</span> · <span class="fx-diff-del">−{stats.removed} 行</span> · 点中间的箭头把那一处从左边搬到右边
          </>
        )}
      </div>
    </div>
  );
}
