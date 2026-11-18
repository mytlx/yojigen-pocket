import { useEffect, useRef } from "preact/hooks";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { tags as t } from "@lezer/highlight";
import { findLang } from "./languages";
import "./code.css";

/** 编辑器的外观：颜色都走 CSS 变量，深浅色跟着应用的主题变。 */
export const pocketTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "calc(12.5px * var(--zoom-code, 1))", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-3)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "28px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(var(--accent-rgb), 0.24)",
  },
  ".cm-selectionMatch": { backgroundColor: "rgba(var(--accent-rgb), 0.14)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(var(--accent-rgb), 0.22)", outline: "none" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--well)", border: "none", color: "var(--text-2)" },
  ".cm-panels": { backgroundColor: "var(--card-solid)", color: "var(--text)", fontFamily: "var(--font-ui)" },
  ".cm-panels.cm-panels-top": { borderBottom: "0.5px solid var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "0.5px solid var(--line)" },
  ".cm-textfield": { backgroundColor: "var(--well)", border: "0.5px solid var(--line)", borderRadius: "6px", color: "var(--text)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--well)", border: "0.5px solid var(--line)", borderRadius: "6px", color: "var(--text)" },
  ".cm-tooltip": { backgroundColor: "var(--card-solid)", color: "var(--text)", border: "0.5px solid var(--line-strong)", borderRadius: "8px", overflow: "hidden" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "rgba(var(--accent-rgb), 0.9)", color: "#fff" },
  ".cm-searchMatch": { backgroundColor: "rgba(255, 200, 0, 0.32)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(255, 150, 0, 0.55)" },
});

export const pocketHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--cm-keyword)" },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--cm-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--cm-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--cm-comment)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--cm-function)" },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--cm-type)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--cm-property)" },
    { tag: [t.tagName, t.angleBracket], color: "var(--cm-tag)" },
    { tag: [t.variableName, t.self], color: "var(--code-text, var(--text))" },
    { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "var(--cm-punct)" },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--cm-meta)" },
    { tag: t.heading, color: "var(--cm-keyword)", fontWeight: "700" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: "var(--cm-function)", textDecoration: "underline" },
    { tag: t.quote, color: "var(--cm-comment)" },
    { tag: t.monospace, color: "var(--cm-string)" },
    { tag: t.invalid, color: "var(--danger)" },
    { tag: [t.inserted], color: "var(--cm-string)" },
    { tag: [t.deleted], color: "var(--danger)" },
  ]),
);

/**
 * 笔记里代码块的外观。颜色走 --code-* 变量，换配色方案只要换一组变量（见 notes.css）。
 * 没有行号以外的装饰：代码块夹在正文里，越安静越好。
 */
export const noteCodeTheme = EditorView.theme({
  "&": { fontSize: "calc(12.5px * var(--zoom-rich, 1))", color: "var(--code-text, var(--text))", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--code-text, var(--text))", padding: "2px 0 4px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--code-dim, var(--text-3))", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 2px", minWidth: "24px" },
  ".cm-foldGutter": { display: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "var(--code-line, rgba(127, 127, 127, 0.08))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-text, var(--text))" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--code-sel, rgba(var(--accent-rgb), 0.22))",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--code-line, rgba(127, 127, 127, 0.12))" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--code-sel, rgba(var(--accent-rgb), 0.22))", outline: "none" },
});

/**
 * Ctrl / ⌘ + 点击网址：交给 open 处理（用系统浏览器打开）。
 * 认 Markdown 链接 [文字](地址) 里的地址，也认裸写的 http(s) 网址。
 */
export function linkOpener(open: (href: string) => void): Extension {
  const pattern = /\]\(\s*<?([^)\s>]+)>?[^)]*\)|(https?:\/\/[^\s<>()\[\]"'`]+)/g;
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      const at = pos - line.from;
      for (const m of line.text.matchAll(pattern)) {
        const start = m.index ?? 0;
        if (at < start || at > start + m[0].length) continue;
        e.preventDefault();
        open(m[1] ?? m[2] ?? "");
        return true;
      }
      return false;
    },
  });
}

/** 按语言 ID 加载高亮，装进一个可以随时替换的隔间里。 */
export function loadLanguage(view: EditorView, compartment: Compartment, lang: string) {
  void findLang(lang)
    .load()
    .then((ext) => view.dispatch({ effects: compartment.reconfigure(ext) }))
    .catch(() => undefined);
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  lang?: string;
  wrap?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  tabSize?: number;
  /** 额外的快捷键，例如 Mod-Enter 运行。返回 true 表示处理了。 */
  keys?: { key: string; run: () => boolean }[];
  /** 拿到编辑器实例（做格式化、插入文字、读光标位置）。 */
  onReady?: (view: EditorView) => void;
  /** 光标或选区变化。 */
  onCursor?: (info: { line: number; col: number; selected: number }) => void;
  autoFocus?: boolean;
  class?: string;
  /** 额外的编辑器扩展（只在创建时读一次）。 */
  extensions?: Extension[];
}

/** 代码编辑器：行号、折叠、括号匹配、查找替换（⌘F / Ctrl+F）、多光标、自动缩进，按语言高亮。 */
export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const comps = useRef({ lang: new Compartment(), wrap: new Compartment(), ro: new Compartment(), tab: new Compartment() });
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!host.current) return;
    const c = comps.current;
    const tab = props.tabSize ?? 2;
    const extensions: Extension[] = [
      keymap.of((props.keys ?? []).map((k) => ({ key: k.key, run: () => latest.current.keys?.find((x) => x.key === k.key)?.run() ?? false }))),
      basicSetup,
      keymap.of([indentWithTab]),
      pocketTheme,
      pocketHighlight,
      c.lang.of([]),
      c.wrap.of(props.wrap ? EditorView.lineWrapping : []),
      c.ro.of(EditorState.readOnly.of(!!props.readOnly)),
      c.tab.of([EditorState.tabSize.of(tab), indentUnit.of(" ".repeat(tab))]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
        if ((u.docChanged || u.selectionSet) && latest.current.onCursor) {
          const sel = u.state.selection.main;
          const line = u.state.doc.lineAt(sel.head);
          latest.current.onCursor({ line: line.number, col: sel.head - line.from + 1, selected: sel.to - sel.from });
        }
      }),
    ];
    if (props.placeholder) extensions.push(placeholderExt(props.placeholder));
    if (props.extensions) extensions.push(...props.extensions);
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: props.value, extensions }) });
    view.current = v;
    // 把编辑器实例挂在它的 DOM 上：自动化测试靠它往里填内容（iframe 里没有焦点时浏览器的 insertText 不生效）。
    (v.dom as unknown as { __cm: EditorView }).__cm = v;
    loadLanguage(v, c.lang, props.lang ?? "text");
    props.onReady?.(v);
    if (props.autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // 外面换了内容（打开另一个文件、格式化）时同步进来；自己打字产生的变化不会绕回来。
  useEffect(() => {
    const v = view.current;
    if (v && props.value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);
  useEffect(() => {
    if (view.current) loadLanguage(view.current, comps.current.lang, props.lang ?? "text");
  }, [props.lang]);
  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []) });
  }, [props.wrap]);
  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.ro.reconfigure(EditorState.readOnly.of(!!props.readOnly)) });
  }, [props.readOnly]);
  useEffect(() => {
    const tab = props.tabSize ?? 2;
    view.current?.dispatch({ effects: comps.current.tab.reconfigure([EditorState.tabSize.of(tab), indentUnit.of(" ".repeat(tab))]) });
  }, [props.tabSize]);

  return <div class={`code-editor ${props.class ?? ""}`} ref={host} />;
}
