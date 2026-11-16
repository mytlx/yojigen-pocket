import { lift, setBlockType } from "@milkdown/kit/prose/commands";
import type { Mark, Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { liftListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

interface MarkSpan {
  mark: Mark;
  from: number;
  to: number;
}

interface SyntaxSpec {
  open: string;
  close: string;
  kind: "mark" | "link" | "html";
  href?: string;
}

const liveKey = new PluginKey("pocket-live-inline");

function syntaxForMark(mark: Mark): SyntaxSpec | null {
  switch (mark.type.name) {
    case "strong":
      return { open: "**", close: "**", kind: "mark" };
    case "emphasis":
      return { open: "*", close: "*", kind: "mark" };
    case "strike_through":
      return { open: "~~", close: "~~", kind: "mark" };
    case "inlineCode":
      return { open: "`", close: "`", kind: "mark" };
    case "pocket_mark": {
      const m = !!mark.attrs.md;
      return { open: m ? "==" : "<mark>", close: m ? "==" : "</mark>", kind: "mark" };
    }
    case "pocket_sup": {
      const m = !!mark.attrs.md;
      return { open: m ? "^" : "<sup>", close: m ? "^" : "</sup>", kind: "mark" };
    }
    case "pocket_sub": {
      const m = !!mark.attrs.md;
      return { open: m ? "~" : "<sub>", close: m ? "~" : "</sub>", kind: "mark" };
    }
    case "pocket_u":
      return { open: "<u>", close: "</u>", kind: "mark" };
    case "pocket_kbd":
      return { open: "<kbd>", close: "</kbd>", kind: "mark" };
    case "pocket_html_span": {
      const tag = String(mark.attrs.tag || "span");
      return { open: String(mark.attrs.rawOpen || `<${tag}>`), close: `</${tag}>`, kind: "html" };
    }
    case "link":
      return { open: "[", close: `](${String(mark.attrs.href ?? "")})`, kind: "link", href: String(mark.attrs.href ?? "") };
    default:
      return null;
  }
}

/** 收集文本块中连续的同属性 mark 区间。 */
function collectMarkSpans(block: PMNode, blockStart: number): MarkSpan[] {
  const spans: MarkSpan[] = [];
  const open: MarkSpan[] = [];
  let offset = blockStart + 1;

  block.forEach((child) => {
    const end = offset + child.nodeSize;
    const childMarks = child.isText ? child.marks : [];

    for (let i = open.length - 1; i >= 0; i--) {
      if (!childMarks.some((m) => m.eq(open[i]!.mark))) {
        spans.push(open.splice(i, 1)[0]!);
      }
    }
    for (const m of childMarks) {
      if (!syntaxForMark(m)) continue;
      const existing = open.find((o) => o.mark.eq(m));
      if (existing) existing.to = end;
      else open.push({ mark: m, from: offset, to: end });
    }
    offset = end;
  });

  spans.push(...open);
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  return spans;
}

function ancestorOf($pos: ResolvedPos, name: string): { depth: number; pos: number; node: PMNode } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (node.type.name === name) return { depth: d, pos: $pos.before(d), node };
  }
  return null;
}

/** 创建一个可跟随文本宽度自动伸缩的轻量级语法编辑控件。 */
function makeTokenWidget(
  view: EditorView,
  text: string,
  opts: {
    className?: string;
    label: string;
    onCommit: (next: string, returnFocus: boolean) => void;
    onLiveInput?: (next: string) => void;
    onExitForward?: () => void;
  },
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = `pocket-syntax-wrap${opts.className ? ` ${opts.className}` : ""}`;
  wrap.dataset.text = text || " ";

  const input = document.createElement("input");
  input.type = "text";
  input.size = 1;
  input.className = "pocket-syntax-input";
  input.value = text;
  input.spellcheck = false;
  input.setAttribute("aria-label", opts.label);

  const syncSize = () => {
    wrap.dataset.text = input.value || " ";
  };
  input.addEventListener("input", () => {
    syncSize();
    opts.onLiveInput?.(input.value);
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      opts.onCommit(input.value, true);
    } else if (e.key === "ArrowRight" && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      if (opts.onExitForward) {
        e.preventDefault();
        opts.onExitForward();
      }
    }
  });
  input.addEventListener("blur", () => {
    opts.onCommit(input.value, false);
    requestAnimationFrame(() => {
      if (!view.dom.contains(document.activeElement)) {
        view.dispatch(view.state.tr.setMeta(liveKey, false));
      }
    });
  });
  wrap.appendChild(input);
  return wrap;
}

function mapTokenToMark(token: string): { name: string; attrs?: Record<string, unknown> } | null {
  switch (token) {
    case "**":
      return { name: "strong" };
    case "*":
      return { name: "emphasis" };
    case "~~":
      return { name: "strike_through" };
    case "`":
      return { name: "inlineCode" };
    case "==":
      return { name: "pocket_mark", attrs: { md: true } };
    case "<mark>":
    case "</mark>":
      return { name: "pocket_mark", attrs: { md: false } };
    case "^":
      return { name: "pocket_sup", attrs: { md: true } };
    case "<sup>":
    case "</sup>":
      return { name: "pocket_sup", attrs: { md: false } };
    case "~":
      return { name: "pocket_sub", attrs: { md: true } };
    case "<sub>":
    case "</sub>":
      return { name: "pocket_sub", attrs: { md: false } };
    case "<u>":
    case "</u>":
      return { name: "pocket_u", attrs: { md: false } };
    case "<kbd>":
    case "</kbd>":
      return { name: "pocket_kbd", attrs: { md: false } };
    default:
      return null;
  }
}

const STANDALONE_VOID_HTML_RE = /^<(?:br|hr)\s*\/?>$/i;
const STANDALONE_COMMENT_HTML_RE = /^<!--[\s\S]*-->$/;
const STANDALONE_PAIRED_HTML_RE = /^<([a-z][a-z0-9-]*)(?:\s+[^>]*)?>[\s\S]*<\/\1>$/i;
const DISALLOWED_INLINE_UPGRADE = new Set(["script", "iframe", "object", "embed", "applet", "base", "meta", "link", "form", "noscript"]);

/** 判断整段纯文本是否为手动输入的独立 HTML 片段（用于阅读模式输入后实时渲染）。 */
export function matchStandaloneHtmlSnippet(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;
  if (STANDALONE_VOID_HTML_RE.test(trimmed) || STANDALONE_COMMENT_HTML_RE.test(trimmed)) return trimmed;
  const paired = STANDALONE_PAIRED_HTML_RE.exec(trimmed);
  if (!paired) return null;
  const tag = paired[1]!.toLowerCase();
  if (DISALLOWED_INLINE_UPGRADE.has(tag)) return null;
  return trimmed;
}

function paragraphPlainTextIfUnmarked(node: PMNode): string | null {
  if (node.type.name !== "paragraph" || node.childCount === 0) return null;
  let text = "";
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c.isText || c.marks.length > 0) return null;
    text += c.text ?? "";
  }
  return text;
}

function singleHtmlNodePos(state: EditorView["state"]): number {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === "html") return sel.from;
  if (sel instanceof TextSelection && sel.empty) {
    const $from = sel.$from;
    for (let d = $from.depth; d >= 1; d--) {
      const n = $from.node(d);
      if (n.type.name === "paragraph") {
        return n.childCount === 1 && n.firstChild?.type.name === "html" ? $from.before(d) + 1 : -1;
      }
      if (n.isTextblock) return -1;
    }
  }
  return -1;
}

/**
 * 模式一（Typora 式实时渲染）：
 * - 行内块：光标点到加粗/斜体/代码/高亮/上标/下标/链接等行内格式时，仅在两侧展开语法符号；
 * - 块前缀：光标进入标题、单个列表项或引用段落时，仅展示/替换当前行的 # / - / 1. / - [ ] / > 前缀；
 * - HTML 节点：单击或光标移入 HTML 节点实时编辑源码，输入独立 HTML 片段后失焦/回车自动渲染。
 */
export function liveInlinePlugin(options: () => { enabled: boolean }) {
  return $prose(() => {
    let pointerDown = false;
    let dismissedHtmlPos: number | null = null;
    let lastAutoHtmlPos: number | null = null;
    let editedParaPos: number | null = null;

    const buildDecorations = (view: EditorView | null, state: EditorView["state"]): DecorationSet | null => {
      if (!options().enabled || pointerDown) return null;
      const sel = state.selection;
      if (!(sel instanceof TextSelection)) return null;

      // 仅当编辑器拥有焦点（含子孙内联输入框正被编辑）时激活实时标记揭示。
      const activeEl = typeof document !== "undefined" ? document.activeElement : null;
      const inWidget = !!(activeEl && view?.dom.contains(activeEl) && (activeEl.closest(".pocket-syntax-wrap") || activeEl.closest(".pocket-html-editing")));
      const hasFocus = view ? view.hasFocus() || inWidget : false;
      if (!hasFocus && !inWidget) return null;

      const $from = sel.$from;
      const textblockDepth = (() => {
        for (let d = $from.depth; d >= 1; d--) {
          if ($from.node(d).isTextblock) return d;
        }
        return -1;
      })();
      if (textblockDepth < 0) return null;

      const tb = $from.node(textblockDepth);
      if (tb.type.name === "code_block") return null;
      const tbPos = $from.before(textblockDepth);
      const decos: Decoration[] = [];

      // 1) 行内标记与链接两侧符号显隐
      const spans = collectMarkSpans(tb, tbPos);
      spans.forEach((span, order) => {
        if (sel.from > span.to || sel.to < span.from) return;
        const spec = syntaxForMark(span.mark);
        if (!spec) return;

        const openSide = -100 + order;
        const closeSide = 100 - order;

        if (spec.kind === "link") {
          decos.push(
            Decoration.widget(
              span.from,
              (v) => {
                const s = document.createElement("span");
                s.className = "pocket-syntax-static";
                s.textContent = "[";
                s.addEventListener("mousedown", (e) => {
                  e.preventDefault();
                  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, span.from)));
                  v.focus();
                });
                return s;
              },
              { key: `live-open:link:${span.from}:${span.to}`, side: openSide, ignoreSelection: true, stopEvent: () => true },
            ),
            Decoration.widget(
              span.to,
              (v) => {
                const container = document.createElement("span");
                container.className = "pocket-syntax-link-tail";
                const mid = document.createElement("span");
                mid.className = "pocket-syntax-static";
                mid.textContent = "](";
                const end = document.createElement("span");
                end.className = "pocket-syntax-static";
                end.textContent = ")";
                const updateHref = (href: string, refocus: boolean) => {
                  const trimmed = href.trim();
                  const curMark = v.state.schema.marks.link!;
                  const tr = v.state.tr.removeMark(span.from, span.to, curMark);
                  if (trimmed) tr.addMark(span.from, span.to, curMark.create({ ...span.mark.attrs, href: trimmed }));
                  v.dispatch(tr);
                  if (refocus) v.focus();
                };
                const urlInput = makeTokenWidget(v, spec.href ?? "", {
                  className: "is-url",
                  label: "链接地址",
                  onLiveInput: (val) => {
                    const trimmed = val.trim();
                    const curMark = v.state.schema.marks.link!;
                    if (!trimmed) return;
                    const tr = v.state.tr.removeMark(span.from, span.to, curMark).addMark(span.from, span.to, curMark.create({ ...span.mark.attrs, href: trimmed }));
                    v.dispatch(tr);
                  },
                  onCommit: (val, refocus) => updateHref(val, refocus),
                });
                container.append(mid, urlInput, end);
                return container;
              },
              { key: `live-close:link:${span.from}:${span.to}`, side: closeSide, ignoreSelection: true, stopEvent: () => true },
            ),
          );
          return;
        }

        const applyTokenEdit = (v: EditorView, nextText: string, refocus: boolean) => {
          const t = nextText.trim();
          const curFrom = span.from;
          const curTo = span.to;
          if (!t) {
            v.dispatch(v.state.tr.removeMark(curFrom, curTo, span.mark.type));
            if (refocus) v.focus();
            return;
          }
          if (t === spec.open || t === spec.close) {
            if (refocus) v.focus();
            return;
          }
          const mapped = mapTokenToMark(t);
          if (mapped && v.state.schema.marks[mapped.name]) {
            const tr = v.state.tr.removeMark(curFrom, curTo, span.mark.type);
            tr.addMark(curFrom, curTo, v.state.schema.marks[mapped.name]!.create(mapped.attrs));
            v.dispatch(tr);
          }
          if (refocus) v.focus();
        };

        decos.push(
          Decoration.widget(
            span.from,
            (v) =>
              makeTokenWidget(v, spec.open, {
                label: "行内语法前缀",
                onCommit: (val, refocus) => applyTokenEdit(v, val, refocus),
                onExitForward: () => {
                  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, span.from)));
                  v.focus();
                },
              }),
            { key: `live-open:${span.mark.type.name}:${span.from}:${span.to}`, side: openSide, ignoreSelection: true, stopEvent: () => true },
          ),
          Decoration.widget(
            span.to,
            (v) =>
              makeTokenWidget(v, spec.close, {
                label: "行内语法后缀",
                onCommit: (val, refocus) => applyTokenEdit(v, val, refocus),
              }),
            { key: `live-close:${span.mark.type.name}:${span.from}:${span.to}`, side: closeSide, ignoreSelection: true, stopEvent: () => true },
          ),
        );
      });

      // 2) 块级前缀实时渲染（标题 # 、单条列表项 - / 1. / - [ ] 、引用 > ）
      if (sel.empty) {
        const listAncestor = ancestorOf($from, "list_item");
        const quoteAncestor = ancestorOf($from, "blockquote");

        if (tb.type.name === "heading") {
          const level = Number(tb.attrs.level || 1);
          const hashes = "#".repeat(Math.max(1, Math.min(6, level))) + " ";
          decos.push(
            Decoration.widget(
              tbPos + 1,
              (v) =>
                makeTokenWidget(v, hashes, {
                  className: "is-block-prefix is-heading",
                  label: "标题级别前缀",
                  onLiveInput: (val) => {
                    const m = /^(#{1,6})\s*$/.exec(val);
                    if (!m) return;
                    const nextLevel = m[1]!.length;
                    const cur = v.state.doc.nodeAt(tbPos);
                    if (cur?.type.name === "heading" && Number(cur.attrs.level) !== nextLevel) {
                      v.dispatch(v.state.tr.setNodeMarkup(tbPos, undefined, { ...cur.attrs, level: nextLevel }));
                    }
                  },
                  onCommit: (val, refocus) => {
                    const cur = v.state.doc.nodeAt(tbPos);
                    if (!cur) return;
                    const m = /^(#{1,6})\s*$/.exec(val);
                    if (m) {
                      const nextLevel = m[1]!.length;
                      if (Number(cur.attrs.level) !== nextLevel) {
                        v.dispatch(v.state.tr.setNodeMarkup(tbPos, undefined, { ...cur.attrs, level: nextLevel }));
                      }
                    } else if (!val.trim()) {
                      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                      setBlockType(v.state.schema.nodes.paragraph!)(v.state, v.dispatch);
                    }
                    if (refocus) {
                      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                      v.focus();
                    }
                  },
                  onExitForward: () => {
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                    v.focus();
                  },
                }),
              { key: `live-prefix:h:${tbPos}`, side: -200, ignoreSelection: true, stopEvent: () => true },
            ),
          );
        } else if (listAncestor && tbPos === listAncestor.pos + 1 && tb.type.name === "paragraph") {
          const liNode = listAncestor.node;
          const liPos = listAncestor.pos;
          const parentList = $from.node(listAncestor.depth - 1);
          const isOrdered = parentList?.type.name === "ordered_list";
          const checked = liNode.attrs.checked as boolean | null | undefined;
          const prefix =
            checked === true
              ? "- [x] "
              : checked === false
                ? "- [ ] "
                : isOrdered
                  ? `${String(liNode.attrs.label || "1.").replace(/\.?$/, ".")} `
                  : "- ";

          decos.push(Decoration.node(liPos, liPos + liNode.nodeSize, { class: "pocket-active-prefix-li" }));
          decos.push(
            Decoration.widget(
              tbPos + 1,
              (v) =>
                makeTokenWidget(v, prefix, {
                  className: "is-block-prefix is-list",
                  label: "列表前缀",
                  onCommit: (val, refocus) => {
                    const curLi = v.state.doc.nodeAt(liPos);
                    if (!curLi) return;
                    const trimmed = val.trim();
                    if (!trimmed) {
                      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                      liftListItem(v.state.schema.nodes.list_item!)(v.state, v.dispatch);
                    } else if (/^-\s*\[\s*\]$/.test(trimmed)) {
                      v.dispatch(v.state.tr.setNodeMarkup(liPos, undefined, { ...curLi.attrs, checked: false }));
                    } else if (/^-\s*\[[xX]\]$/.test(trimmed)) {
                      v.dispatch(v.state.tr.setNodeMarkup(liPos, undefined, { ...curLi.attrs, checked: true }));
                    } else if (/^[-*+]$/.test(trimmed)) {
                      if (isOrdered) {
                        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                        liftListItem(v.state.schema.nodes.list_item!)(v.state, v.dispatch);
                        wrapInList(v.state.schema.nodes.bullet_list!)(v.state, v.dispatch);
                      } else if (curLi.attrs.checked != null) {
                        v.dispatch(v.state.tr.setNodeMarkup(liPos, undefined, { ...curLi.attrs, checked: null }));
                      }
                    } else if (/^\d+\.?$/.test(trimmed) && !isOrdered) {
                      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                      liftListItem(v.state.schema.nodes.list_item!)(v.state, v.dispatch);
                      wrapInList(v.state.schema.nodes.ordered_list!)(v.state, v.dispatch);
                    }
                    if (refocus) {
                      const nextPos = Math.min(tbPos + 1, v.state.doc.content.size);
                      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(nextPos))));
                      v.focus();
                    }
                  },
                  onExitForward: () => {
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                    v.focus();
                  },
                }),
              { key: `live-prefix:li:${tbPos}`, side: -200, ignoreSelection: true, stopEvent: () => true },
            ),
          );
        } else if (quoteAncestor && quoteAncestor.depth === textblockDepth - 1 && tb.type.name === "paragraph") {
          decos.push(Decoration.node(tbPos, tbPos + tb.nodeSize, { class: "pocket-active-prefix-quote" }));
          decos.push(
            Decoration.widget(
              tbPos + 1,
              (v) =>
                makeTokenWidget(v, "> ", {
                  className: "is-block-prefix is-quote",
                  label: "引用前缀",
                  onCommit: (val, refocus) => {
                    if (!val.trim()) {
                      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                      lift(v.state, v.dispatch);
                    }
                    if (refocus) {
                      const nextPos = Math.min(tbPos + 1, v.state.doc.content.size);
                      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(nextPos))));
                      v.focus();
                    }
                  },
                  onExitForward: () => {
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)));
                    v.focus();
                  },
                }),
              { key: `live-prefix:quote:${tbPos}`, side: -200, ignoreSelection: true, stopEvent: () => true },
            ),
          );
        }
      }

      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    };

    let boundView: EditorView | null = null;

    const currentParaPos = (state: EditorView["state"]): number | null => {
      const $from = state.selection.$from;
      for (let d = $from.depth; d >= 1; d--) {
        if ($from.node(d).type.name === "paragraph") return $from.before(d);
      }
      return null;
    };

    const upgradeEditedPara = (view: EditorView, pos: number): boolean => {
      const node = view.state.doc.nodeAt(pos);
      if (!node) return false;
      const plain = paragraphPlainTextIfUnmarked(node);
      if (!plain) return false;
      const snippet = matchStandaloneHtmlSnippet(plain);
      const htmlType = view.state.schema.nodes.html;
      if (!snippet || !htmlType) return false;
      const tr = view.state.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, htmlType.create({ value: snippet }));
      view.dispatch(tr.setMeta("pocket-html-upgrade", true));
      return true;
    };

    return new Plugin({
      key: liveKey,
      view(editorView) {
        boundView = editorView;
        const onDismiss = (e: Event) => {
          const detail = (e as CustomEvent<{ pos?: number }>).detail;
          dismissedHtmlPos = typeof detail?.pos === "number" ? detail.pos : null;
        };
        editorView.dom.addEventListener("pocket-html-dismiss", onDismiss);
        return {
          update(view, prevState) {
            if (!view.state.doc.eq(prevState.doc)) {
              const p = currentParaPos(view.state);
              if (p !== null) editedParaPos = p;
            }
            const curP = currentParaPos(view.state);
            if (editedParaPos !== null && curP !== editedParaPos && !pointerDown) {
              const targetPos = editedParaPos;
              editedParaPos = null;
              if (options().enabled && upgradeEditedPara(view, targetPos)) return;
            }

            if (!options().enabled || pointerDown || !view.hasFocus()) return;
            if (view.dom.querySelector(".pocket-html-editing")) return;

            const htmlPos = singleHtmlNodePos(view.state);
            if (htmlPos < 0) {
              dismissedHtmlPos = null;
              lastAutoHtmlPos = null;
              return;
            }
            if (htmlPos === dismissedHtmlPos || htmlPos === lastAutoHtmlPos) return;
            lastAutoHtmlPos = htmlPos;
            const nodeDom = view.nodeDOM(htmlPos);
            if (nodeDom instanceof Element) {
              requestAnimationFrame(() => {
                if (!boundView || boundView.isDestroyed || pointerDown) return;
                if (singleHtmlNodePos(boundView.state) === htmlPos && boundView.hasFocus()) {
                  nodeDom.dispatchEvent(new CustomEvent("pocket-open-html-edit"));
                }
              });
            }
          },
          destroy() {
            editorView.dom.removeEventListener("pocket-html-dismiss", onDismiss);
            boundView = null;
          },
        };
      },
      props: {
        decorations(state) {
          return buildDecorations(boundView, state);
        },
        handleKeyDown(view, event) {
          if (!options().enabled || event.isComposing) return false;
          if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const sel = view.state.selection;
            if (sel instanceof TextSelection && sel.empty && sel.$from.parent.type.name === "paragraph" && sel.$from.parentOffset === sel.$from.parent.content.size) {
              const plain = paragraphPlainTextIfUnmarked(sel.$from.parent);
              const snippet = plain ? matchStandaloneHtmlSnippet(plain) : null;
              const htmlType = view.state.schema.nodes.html;
              const paraType = view.state.schema.nodes.paragraph;
              if (snippet && htmlType && paraType) {
                event.preventDefault();
                const pPos = sel.$from.before();
                const htmlPara = paraType.create(null, htmlType.create({ value: snippet }));
                const nextPara = paraType.create();
                const tr = view.state.tr.replaceWith(pPos, pPos + sel.$from.parent.nodeSize, [htmlPara, nextPara]);
                tr.setSelection(TextSelection.create(tr.doc, pPos + htmlPara.nodeSize + 1));
                editedParaPos = null;
                view.dispatch(tr.scrollIntoView());
                return true;
              }
            }
          }
          return false;
        },
        handleDOMEvents: {
          mousedown() {
            pointerDown = true;
            window.addEventListener(
              "mouseup",
              () => {
                pointerDown = false;
                if (boundView) boundView.dispatch(boundView.state.tr.setMeta(liveKey, true));
              },
              { once: true },
            );
            return false;
          },
          focus(view) {
            if (options().enabled) view.dispatch(view.state.tr.setMeta(liveKey, true));
            return false;
          },
          blur(view, event) {
            const next = event.relatedTarget as Node | null;
            if (next && view.dom.contains(next)) return false;
            if (options().enabled && editedParaPos !== null) {
              const targetPos = editedParaPos;
              editedParaPos = null;
              upgradeEditedPara(view, targetPos);
            }
            view.dispatch(view.state.tr.setMeta(liveKey, false));
            return false;
          },
        },
      },
    });
  });
}
