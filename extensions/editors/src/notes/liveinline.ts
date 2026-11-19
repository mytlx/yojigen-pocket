import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { lift, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import type { Fragment, Mark, MarkType, Node as PMNode, ResolvedPos, Slice } from "@milkdown/kit/prose/model";
import { liftListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const liveKey = new PluginKey("pocket-live-inline");

const EXPANDABLE_MARKS = new Set([
  "strong",
  "emphasis",
  "strike_through",
  "inlineCode",
  "pocket_mark",
  "pocket_sup",
  "pocket_sub",
  "pocket_u",
  "pocket_kbd",
  "pocket_html_span",
  "link",
]);

function hasExpandableMark(marks: readonly Mark[]): boolean {
  return marks.some((m) => EXPANDABLE_MARKS.has(m.type.name));
}

function primaryMarkHint(marks: readonly Mark[]): string {
  for (const name of ["strong", "emphasis", "strike_through", "inlineCode", "pocket_mark", "pocket_u", "link", "pocket_sup", "pocket_sub", "pocket_kbd"]) {
    if (marks.some((m) => m.type.name === name)) return name;
  }
  return "";
}

function ancestorOf($pos: ResolvedPos, name: string): { depth: number; pos: number; node: PMNode } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (node.type.name === name) return { depth: d, pos: $pos.before(d), node };
  }
  return null;
}

export type ParsedBlockPrefix =
  | { kind: "paragraph" }
  | { kind: "heading"; level: number }
  | { kind: "blockquote" }
  | { kind: "bullet" }
  | { kind: "ordered" }
  | { kind: "task"; checked: boolean };

/** 解析块前缀输入（# / > / - / 1. / - [ ] / - [x]），用于实时渲染标识符编辑与跨类型互转。 */
export function parseBlockPrefix(raw: string): ParsedBlockPrefix | null {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "paragraph" };
  const heading = /^(#{1,6})$/.exec(trimmed);
  if (heading) return { kind: "heading", level: heading[1]!.length };
  if (trimmed === ">") return { kind: "blockquote" };
  if (/^-\s*\[\s*\]$/.test(trimmed)) return { kind: "task", checked: false };
  if (/^-\s*\[[xX]\]$/.test(trimmed)) return { kind: "task", checked: true };
  if (/^[-*+]$/.test(trimmed)) return { kind: "bullet" };
  if (/^\d+\.?$/.test(trimmed)) return { kind: "ordered" };
  return null;
}

interface RawDelimRange {
  from: number;
  to: number;
  cls: string;
}

/** 分析展开态行内 Markdown 文本中的语法定界符位置，用于等宽强调着色及精确光标映射。 */
function analyzeRawInlineDelimiters(text: string): { openLen: number; ranges: RawDelimRange[] } {
  const ranges: RawDelimRange[] = [];
  let start = 0;
  let end = text.length;
  let guard = 0;

  while (start < end && guard++ < 8) {
    const slice = text.slice(start, end);
    let matched = false;

    // 1) 成对对称定界符（*** / ** / ~~ / == / ` / * / ^ / ~）
    for (const sym of ["***", "**", "~~", "==", "`", "*", "^", "~"]) {
      if (slice.length >= sym.length * 2 + 1 && slice.startsWith(sym) && slice.endsWith(sym)) {
        ranges.push({ from: start, to: start + sym.length, cls: "pocket-raw-delim" });
        ranges.push({ from: end - sym.length, to: end, cls: "pocket-raw-delim" });
        start += sym.length;
        end -= sym.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 2) 成对行内 HTML 标签（<u> / <mark> / <sup> / <sub> / <kbd> / <span ...>）
    const htmlM = /^(<([a-z][a-z0-9-]*)(?:\s+[^>]*)?>)([\s\S]*?)(<\/\2>)$/i.exec(slice);
    if (htmlM) {
      const openTag = htmlM[1]!;
      const closeTag = htmlM[4]!;
      ranges.push({ from: start, to: start + openTag.length, cls: "pocket-raw-delim" });
      ranges.push({ from: end - closeTag.length, to: end, cls: "pocket-raw-delim" });
      start += openTag.length;
      end -= closeTag.length;
      continue;
    }

    // 3) 链接 [text](url)
    const linkM = /^(\[)([^\]]*)(\]\()([^)]*)(\))$/.exec(slice);
    if (linkM) {
      const openBracket = linkM[1]!;
      const innerText = linkM[2]!;
      const mid = linkM[3]!;
      const url = linkM[4]!;
      const closeParen = linkM[5]!;
      const midStart = start + openBracket.length + innerText.length;
      const urlStart = midStart + mid.length;
      ranges.push({ from: start, to: start + openBracket.length, cls: "pocket-raw-delim" });
      ranges.push({ from: midStart, to: urlStart, cls: "pocket-raw-delim" });
      if (url.length > 0) ranges.push({ from: urlStart, to: urlStart + url.length, cls: "pocket-raw-url" });
      ranges.push({ from: end - closeParen.length, to: end, cls: "pocket-raw-delim" });
      start += openBracket.length;
      end = midStart;
      continue;
    }

    break;
  }

  return { openLen: start, ranges };
}

interface MarkCluster {
  from: number;
  to: number;
  hint: string;
}

function collectExpandableClusters(block: PMNode, blockStart: number): MarkCluster[] {
  const clusters: MarkCluster[] = [];
  let offset = blockStart + 1;
  let cur: MarkCluster | null = null;

  block.forEach((child) => {
    const end = offset + child.nodeSize;
    if (child.isText && hasExpandableMark(child.marks)) {
      if (cur && cur.to === offset) {
        cur.to = end;
        if (!cur.hint) cur.hint = primaryMarkHint(child.marks);
      } else {
        cur = { from: offset, to: end, hint: primaryMarkHint(child.marks) };
        clusters.push(cur);
      }
    } else {
      cur = null;
    }
    offset = end;
  });

  return clusters;
}

interface ActiveRawSpan {
  from: number;
  to: number;
  text: string;
  blockStart: number;
  blockEnd: number;
}

function findActiveRawSpan(doc: PMNode, rawType: MarkType): ActiveRawSpan | null {
  let found: ActiveRawSpan | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    const blockStart = pos + 1;
    const blockEnd = pos + node.nodeSize - 1;
    let offset = blockStart;
    let from = -1;
    let to = -1;
    let text = "";

    node.forEach((child) => {
      const end = offset + child.nodeSize;
      if (child.isText && rawType.isInSet(child.marks)) {
        if (from < 0) from = offset;
        to = end;
        text += child.text ?? "";
      } else if (from >= 0 && !found) {
        found = { from, to, text, blockStart, blockEnd };
      }
      offset = end;
    });

    if (from >= 0 && !found) {
      found = { from, to, text, blockStart, blockEnd };
    }
    return false;
  });
  return found;
}

function mountTokenInput(
  wrap: HTMLElement,
  view: EditorView,
  text: string,
  opts: {
    label: string;
    initialCaret?: "select" | "end" | "start";
    onCommit: (next: string, returnFocus: boolean) => void;
    onLiveInput?: (next: string) => void;
    onCancel?: () => void;
    onExitForward?: () => void;
    onExitBackward?: () => void;
    onDone: (finalText: string) => void;
  },
) {
  wrap.classList.remove("is-passive");
  const input = document.createElement("input");
  input.type = "text";
  input.size = 1;
  input.tabIndex = -1;
  input.className = "pocket-syntax-input";
  input.value = text;
  input.spellcheck = false;
  input.setAttribute("aria-label", opts.label);

  let closed = false;
  const close = (finalText: string) => {
    if (closed) return;
    closed = true;
    view.dom.classList.remove("pocket-hide-vcursor");
    opts.onDone(finalText);
  };

  input.addEventListener("focus", () => {
    view.dom.classList.add("pocket-hide-vcursor");
  });
  input.addEventListener("input", () => {
    wrap.dataset.text = input.value || " ";
    opts.onLiveInput?.(input.value);
    if (wrap.classList.contains("is-block-prefix")) syncPlaceholderHostOffset(view, wrap);
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(text);
      if (opts.onCancel) opts.onCancel();
      else view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value;
      close(val);
      opts.onCommit(val, true);
    } else if (e.key === "ArrowRight" && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      if (opts.onExitForward) {
        e.preventDefault();
        const val = input.value;
        close(val);
        opts.onCommit(val, false);
        opts.onExitForward();
      }
    } else if (e.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) {
      if (opts.onExitBackward) {
        e.preventDefault();
        const val = input.value;
        close(val);
        opts.onCommit(val, false);
        opts.onExitBackward();
      }
    }
  });
  input.addEventListener("blur", () => {
    if (closed) return;
    const val = input.value;
    close(val);
    opts.onCommit(val, false);
    requestAnimationFrame(() => {
      if (!view.isDestroyed && !view.dom.contains(document.activeElement)) {
        view.dispatch(view.state.tr.setMeta(liveKey, false));
      }
    });
  });

  const placeCaret = () => {
    const mode = opts.initialCaret ?? "select";
    if (mode === "end") input.setSelectionRange(input.value.length, input.value.length);
    else if (mode === "start") input.setSelectionRange(0, 0);
    else input.select();
  };

  wrap.replaceChildren(input);
  if (wrap.classList.contains("is-block-prefix")) syncPlaceholderHostOffset(view, wrap);
  input.focus();
  placeCaret();
  requestAnimationFrame(() => {
    if (!closed && input.isConnected && document.activeElement !== input) {
      input.focus();
      placeCaret();
    }
  });
}

function syncPlaceholderHostOffset(view: EditorView, wrap: HTMLElement | null): void {
  // 必须把 CSS 变量写到 ProseMirror DOM 之外（.milkdown），避免触发 DOMObserver(attributes:true) 导致死循环卡死。
  const outer = view.dom.closest(".milkdown") ?? view.dom.parentElement;
  if (!(outer instanceof HTMLElement) || outer === view.dom || view.dom.contains(outer)) return;
  const parent = wrap?.parentElement;
  if (!wrap || !(parent instanceof HTMLElement) || !parent.classList.contains("crepe-placeholder")) {
    if (outer.style.getPropertyValue("--pocket-ph-x")) outer.style.removeProperty("--pocket-ph-x");
    return;
  }
  const hostRect = parent.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const mr = Number.parseFloat(window.getComputedStyle(wrap).marginRight) || 0;
  const x = Math.max(0, wrapRect.right - hostRect.left - parent.clientLeft + mr);
  const next = `${Math.round(x * 100) / 100}px`;
  if (outer.style.getPropertyValue("--pocket-ph-x") !== next) {
    outer.style.setProperty("--pocket-ph-x", next);
  }
}

/** 创建可点击且支持键盘 ArrowLeft 无缝滑入的块前缀标记。 */
function makeTokenWidget(
  view: EditorView,
  text: string,
  opts: {
    className?: string;
    label: string;
    onCommit: (next: string, returnFocus: boolean) => void;
    onLiveInput?: (next: string) => void;
    onCancel?: () => void;
    onExitForward?: () => void;
    onExitBackward?: () => void;
  },
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = `pocket-syntax-wrap is-passive${opts.className ? ` ${opts.className}` : ""}`;
  wrap.dataset.text = text || " ";
  wrap.title = "点击或在行首按 ← 修改前缀";

  const labelEl = document.createElement("span");
  labelEl.className = "pocket-syntax-text";
  labelEl.textContent = text;
  wrap.appendChild(labelEl);

  let editing = false;
  const startEdit = (initialCaret: "select" | "end" | "start" = "select") => {
    if (!view.editable || editing) return;
    editing = true;
    mountTokenInput(wrap, view, text, {
      ...opts,
      initialCaret,
      onDone: (val) => {
        editing = false;
        wrap.classList.add("is-passive");
        labelEl.textContent = val;
        wrap.dataset.text = val || " ";
        wrap.replaceChildren(labelEl);
        if (wrap.classList.contains("is-block-prefix")) syncPlaceholderHostOffset(view, wrap);
      },
    });
  };

  wrap.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (!view.editable) return;
    if (editing) return;
    e.preventDefault();
    startEdit("select");
  });
  wrap.addEventListener("pocket-edit-token", (e) => {
    const caret = (e as CustomEvent<{ caret?: "select" | "end" | "start" }>).detail?.caret ?? "end";
    startEdit(caret);
  });
  return wrap;
}

function exitBackwardFromBlock(v: EditorView, tbPos: number) {
  const target = Math.max(0, tbPos - 1);
  const sel = Selection.findFrom(v.state.doc.resolve(target), -1, true);
  if (sel) {
    v.dispatch(v.state.tr.setSelection(sel).setMeta("pocket-selection", true).scrollIntoView());
  }
  v.focus();
}

function commitBlockPrefixEdit(v: EditorView, tbPos: number, val: string, refocus: boolean) {
  const curTb = v.state.doc.nodeAt(tbPos);
  if (!curTb || !curTb.isTextblock) return;
  const refocusAt = (pos: number) => {
    if (!refocus) return;
    const clamped = Math.max(0, Math.min(pos, v.state.doc.content.size));
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(clamped))).setMeta("pocket-selection", true));
    v.focus();
  };

  const parsed = parseBlockPrefix(val);
  if (!parsed) {
    refocusAt(tbPos + 1);
    return;
  }

  const schema = v.state.schema;
  const $inside = v.state.doc.resolve(tbPos + 1);
  const liAnc = ancestorOf($inside, "list_item");
  const bqAnc = ancestorOf($inside, "blockquote");
  const inDirectListItem = !!(liAnc && tbPos === liAnc.pos + 1);
  const inDirectQuote = !!(bqAnc && bqAnc.depth === $inside.depth - 1);

  if (curTb.type.name === "heading" && parsed.kind === "heading") {
    if (Number(curTb.attrs.level) !== parsed.level) {
      v.dispatch(v.state.tr.setNodeMarkup(tbPos, undefined, { ...curTb.attrs, level: parsed.level }));
    }
    refocusAt(tbPos + 1);
    return;
  }
  if (inDirectListItem && liAnc) {
    const parentList = $inside.node(liAnc.depth - 1);
    const isOrdered = parentList?.type.name === "ordered_list";
    if (parsed.kind === "task" && !isOrdered) {
      if (liAnc.node.attrs.checked !== parsed.checked) {
        v.dispatch(v.state.tr.setNodeMarkup(liAnc.pos, undefined, { ...liAnc.node.attrs, checked: parsed.checked }));
      }
      refocusAt(tbPos + 1);
      return;
    }
    if (parsed.kind === "bullet" && !isOrdered) {
      if (liAnc.node.attrs.checked != null) {
        v.dispatch(v.state.tr.setNodeMarkup(liAnc.pos, undefined, { ...liAnc.node.attrs, checked: null }));
      }
      refocusAt(tbPos + 1);
      return;
    }
    if (parsed.kind === "ordered" && isOrdered) {
      refocusAt(tbPos + 1);
      return;
    }
  }
  if (inDirectQuote && parsed.kind === "blockquote") {
    refocusAt(tbPos + 1);
    return;
  }

  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)).setMeta("pocket-selection", true));
  if (inDirectListItem && schema.nodes.list_item) {
    liftListItem(schema.nodes.list_item)(v.state, v.dispatch);
  } else if (inDirectQuote) {
    lift(v.state, v.dispatch);
  }

  const ensurePara = () => {
    const parent = v.state.selection.$from.parent;
    if (parent.type.name !== "paragraph" && schema.nodes.paragraph) {
      setBlockType(schema.nodes.paragraph)(v.state, v.dispatch);
    }
  };

  switch (parsed.kind) {
    case "paragraph":
      ensurePara();
      break;
    case "heading":
      if (schema.nodes.heading) {
        setBlockType(schema.nodes.heading, { level: parsed.level })(v.state, v.dispatch);
      }
      break;
    case "blockquote":
      ensurePara();
      if (schema.nodes.blockquote) {
        wrapIn(schema.nodes.blockquote)(v.state, v.dispatch);
      }
      break;
    case "bullet":
      ensurePara();
      if (schema.nodes.bullet_list) {
        wrapInList(schema.nodes.bullet_list)(v.state, v.dispatch);
      }
      break;
    case "ordered":
      ensurePara();
      if (schema.nodes.ordered_list) {
        wrapInList(schema.nodes.ordered_list)(v.state, v.dispatch);
      }
      break;
    case "task":
      ensurePara();
      if (schema.nodes.bullet_list) {
        wrapInList(schema.nodes.bullet_list)(v.state, v.dispatch);
        const curLi = ancestorOf(v.state.selection.$from, "list_item");
        if (curLi) {
          v.dispatch(v.state.tr.setNodeMarkup(curLi.pos, undefined, { ...curLi.node.attrs, checked: parsed.checked }));
        }
      }
      break;
  }

  if (refocus) {
    refocusAt(v.state.selection.$from.start());
  }
}

const STANDALONE_VOID_HTML_RE = /^<(?:br|hr)\s*\/?>$/i;
const STANDALONE_COMMENT_HTML_RE = /^<!--[\s\S]*-->$/;
const STANDALONE_PAIRED_HTML_RE = /^<([a-z][a-z0-9-]*)(?:\s+[^>]*)?>[\s\S]*<\/\1>$/i;
const DISALLOWED_INLINE_UPGRADE = new Set(["script", "iframe", "object", "embed", "applet", "base", "meta", "link", "form", "noscript"]);

/** 判断整段纯文本是否为手动输入的独立 HTML 片段（用于实时渲染模式输入后自动渲染）。 */
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
 * 实时渲染插件（方案 5A）：
 * - 行内语法（加粗/斜体/删除线/行内代码/高亮/下划线/上下标/链接等）：光标进入后原地展开为真实可编辑文本，
 *   支持左右键逐字移动、Shift+左右键跨语法与文字连选、直接增删 `*`/`~~`/`==`/URL，离开后自动还原富文本；
 * - 块前缀（标题 # / 引用 > / 列表 - / 1. / - [ ]）：行首按 ArrowLeft 无缝滑入前缀编辑（或点击编辑），ArrowRight/Enter 滑回正文；
 * - HTML 节点：单击或光标移入实时编辑源码，输入独立 HTML 片段后失焦/回车自动渲染。
 */
export function liveInlinePlugin(options: () => { enabled: boolean }) {
  return $prose((ctx) => {
    let pointerDown = false;
    let pointerRefreshTimer = 0;
    let dismissedHtmlPos: number | null = null;
    let lastAutoHtmlPos: number | null = null;
    let editedParaPos: number | null = null;
    let activeRawInitial = "";
    let suppressedPos: number | null = null;
    let lastClickInMark = false;
    let prevCaretPos = -1;

    const getRawMarkType = (state: EditorView["state"]): MarkType | null => state.schema.marks.pocket_raw_inline ?? null;

    const parseInlineMarkdown = (state: EditorView["state"], rawText: string): PMNode[] => {
      const schema = state.schema;
      if (!rawText) return [];
      const leadWs = /^[ \t]+/.exec(rawText)?.[0] ?? "";
      const restAfterLead = rawText.slice(leadWs.length);
      const trailWs = /[ \t]+$/.exec(restAfterLead)?.[0] ?? "";
      const core = restAfterLead.slice(0, restAfterLead.length - trailWs.length);

      const out: PMNode[] = [];
      if (leadWs) out.push(schema.text(leadWs));

      if (core) {
        try {
          const parsed = ctx.get(parserCtx)(core);
          if (parsed && parsed.childCount === 1 && parsed.firstChild?.type.name === "paragraph") {
            parsed.firstChild.forEach((child) => {
              if (child.isInline) out.push(child);
            });
          } else {
            out.push(schema.text(core));
          }
        } catch {
          out.push(schema.text(core));
        }
      }

      if (trailWs) out.push(schema.text(trailWs));
      return out;
    };

    const collapseRawInline = (
      view: EditorView,
      opts?: { clearStoredMarks?: boolean; forceCaretAt?: "start" | "end"; suppressAfter?: boolean; revertToInitial?: boolean },
    ): boolean => {
      const rawType = getRawMarkType(view.state);
      if (!rawType) return false;
      const active = findActiveRawSpan(view.state.doc, rawType);
      if (!active) return false;

      const rawText = opts?.revertToInitial && activeRawInitial ? activeRawInitial : active.text;
      const unchanged = rawText === activeRawInitial || !!opts?.revertToInitial;
      const replacement = parseInlineMarkdown(view.state, rawText);
      const newSize = replacement.reduce((sum, n) => sum + n.nodeSize, 0);
      const oldSize = active.to - active.from;
      const sel = view.state.selection;
      const { openLen } = analyzeRawInlineDelimiters(active.text);

      const mapPos = (p: number): number => {
        if (p < active.from) return p;
        if (p > active.to) return p + (newSize - oldSize);
        if (opts?.forceCaretAt === "start") return active.from;
        if (opts?.forceCaretAt === "end") return active.from + newSize;
        const inner = Math.max(0, p - active.from - openLen);
        return active.from + Math.min(newSize, inner);
      };

      const tr = view.state.tr;
      if (replacement.length > 0) tr.replaceWith(active.from, active.to, replacement);
      else tr.delete(active.from, active.to);

      const nextFrom = Math.max(0, Math.min(tr.doc.content.size, mapPos(sel.from)));
      const nextTo = Math.max(0, Math.min(tr.doc.content.size, mapPos(sel.to)));
      if (sel instanceof TextSelection) {
        tr.setSelection(TextSelection.create(tr.doc, nextFrom, nextTo));
      } else {
        tr.setSelection(Selection.near(tr.doc.resolve(nextFrom)));
      }
      if (opts?.clearStoredMarks) tr.setStoredMarks([]);
      if (unchanged) tr.setMeta("addToHistory", false);
      tr.setMeta("pocket-raw-sync", true);
      tr.setMeta("pocket-selection", true);

      activeRawInitial = "";
      if (opts?.suppressAfter) suppressedPos = nextFrom;
      view.dispatch(tr);
      return true;
    };

    const expandClusterAt = (view: EditorView, cluster: MarkCluster, cursorPos: number): boolean => {
      const rawType = getRawMarkType(view.state);
      if (!rawType) return false;
      const schema = view.state.schema;
      const paraType = schema.nodes.paragraph;
      if (!paraType) return false;

      const slice = view.state.doc.slice(cluster.from, cluster.to);
      let rawMd = "";
      try {
        const tempDoc = schema.topNodeType.create(null, paraType.create(null, slice.content));
        rawMd = ctx.get(serializerCtx)(tempDoc).replace(/\n+$/, "");
      } catch {
        return false;
      }
      if (!rawMd) return false;

      const plainBefore = view.state.doc.textBetween(cluster.from, Math.max(cluster.from, Math.min(cursorPos, cluster.to)));
      const { openLen } = analyzeRawInlineDelimiters(rawMd);
      let caretOffset = openLen + plainBefore.length;
      if (plainBefore && rawMd.slice(openLen, openLen + plainBefore.length) !== plainBefore) {
        const foundIdx = rawMd.indexOf(plainBefore);
        if (foundIdx >= 0) caretOffset = foundIdx + plainBefore.length;
      }
      caretOffset = Math.max(0, Math.min(rawMd.length, caretOffset));

      const tr = view.state.tr;
      const rawTextNode = schema.text(rawMd, [rawType.create({ hint: cluster.hint })]);
      tr.replaceWith(cluster.from, cluster.to, rawTextNode);
      const nextCaret = cluster.from + caretOffset;
      tr.setSelection(TextSelection.create(tr.doc, nextCaret));
      tr.setMeta("addToHistory", false);
      tr.setMeta("pocket-raw-sync", true);
      tr.setMeta("pocket-selection", true);

      activeRawInitial = rawMd;
      suppressedPos = null;
      view.dispatch(tr);
      return true;
    };

    const syncRawInlineState = (view: EditorView): boolean => {
      if (view.isDestroyed || view.composing || pointerDown) return false;
      const rawType = getRawMarkType(view.state);
      if (!rawType) return false;

      const active = findActiveRawSpan(view.state.doc, rawType);
      if (!options().enabled || !view.editable || !view.hasFocus()) {
        if (active) return collapseRawInline(view);
        return false;
      }

      const sel = view.state.selection;
      if (active) {
        // 只要光标或选区仍与当前展开的 raw span 有交集（包括 Shift+左右键跨语法与正文连选），保持展开态！
        const disjoint = sel.to < active.from || sel.from > active.to;
        if (disjoint) {
          return collapseRawInline(view);
        }
        return false;
      }

      if (!(sel instanceof TextSelection) || !sel.empty) {
        lastClickInMark = false;
        return false;
      }

      if (suppressedPos !== null) {
        if (sel.from === suppressedPos) {
          lastClickInMark = false;
          return false;
        }
        suppressedPos = null;
      }

      const $from = sel.$from;
      const tbDepth = (() => {
        for (let d = $from.depth; d >= 1; d--) {
          if ($from.node(d).isTextblock) return d;
        }
        return -1;
      })();
      if (tbDepth < 0) return false;
      const tb = $from.node(tbDepth);
      if (tb.type.name === "code_block") return false;
      const tbPos = $from.before(tbDepth);

      const clusters = collectExpandableClusters(tb, tbPos);
      const clicked = lastClickInMark;
      lastClickInMark = false;

      const hit = clusters.find((c) => {
        if (sel.from > c.from && sel.from < c.to) return true;
        if (clicked && sel.from >= c.from && sel.from <= c.to) return true;
        if (c.to - c.from === 1 && ((prevCaretPos === c.from && sel.from === c.to) || (prevCaretPos === c.to && sel.from === c.from))) {
          return true;
        }
        return false;
      });
      if (!hit) return false;
      return expandClusterAt(view, hit, sel.from);
    };

    const buildDecorations = (view: EditorView | null, state: EditorView["state"]): DecorationSet | null => {
      if (!options().enabled || pointerDown) return null;
      const sel = state.selection;
      if (!(sel instanceof TextSelection)) return null;

      const activeEl = typeof document !== "undefined" ? document.activeElement : null;
      const inWidget = !!(
        activeEl &&
        view?.dom.contains(activeEl) &&
        (activeEl.closest(".pocket-syntax-wrap") || activeEl.closest(".pocket-html-editing") || activeEl.closest(".label-wrapper.is-editing"))
      );
      const hasFocus = view ? view.hasFocus() || inWidget : false;
      if (!hasFocus && !inWidget) return null;

      const decos: Decoration[] = [];

      // 1) 为展开态的行内原生语法文本着色定界符（** / * / ~~ / == / [ ] (url) / <u> 等）
      const rawType = getRawMarkType(state);
      if (rawType) {
        const activeRaw = findActiveRawSpan(state.doc, rawType);
        if (activeRaw) {
          const { ranges } = analyzeRawInlineDelimiters(activeRaw.text);
          for (const r of ranges) {
            if (r.to > r.from) {
              decos.push(Decoration.inline(activeRaw.from + r.from, activeRaw.from + r.to, { class: r.cls }));
            }
          }
        }
      }

      const $from = sel.$from;
      const textblockDepth = (() => {
        for (let d = $from.depth; d >= 1; d--) {
          if ($from.node(d).isTextblock) return d;
        }
        return -1;
      })();
      if (textblockDepth < 0) return decos.length ? DecorationSet.create(state.doc, decos) : null;

      const tb = $from.node(textblockDepth);
      if (tb.type.name === "code_block") return decos.length ? DecorationSet.create(state.doc, decos) : null;
      const tbPos = $from.before(textblockDepth);

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
                  onCommit: (val, refocus) => commitBlockPrefixEdit(v, tbPos, val, refocus),
                  onExitForward: () => {
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)).setMeta("pocket-selection", true));
                    v.focus();
                  },
                  onExitBackward: () => exitBackwardFromBlock(v, tbPos),
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

          decos.push(
            Decoration.node(liPos, liPos + liNode.nodeSize, {
              class: "pocket-active-prefix-li",
              style: `--pocket-prefix: ${JSON.stringify(prefix)}`,
              "data-pocket-prefix": prefix,
              "data-pocket-li": String(liPos),
              "data-pocket-tb": String(tbPos),
              "data-pocket-ordered": isOrdered ? "1" : "0",
            }),
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
                  onCommit: (val, refocus) => commitBlockPrefixEdit(v, tbPos, val, refocus),
                  onExitForward: () => {
                    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, tbPos + 1)).setMeta("pocket-selection", true));
                    v.focus();
                  },
                  onExitBackward: () => exitBackwardFromBlock(v, tbPos),
                }),
              { key: `live-prefix:quote:${tbPos}`, side: -200, ignoreSelection: true, stopEvent: () => true },
            ),
          );
        }
      }

      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    };

    let boundView: EditorView | null = null;
    let viewDestroyed = false;
    let cachedDecos: DecorationSet | null = null;
    let cachedState: EditorView["state"] | null = null;
    let dirtyDuringCompose = false;
    let composeRefreshTimer = 0;

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

    const GUTTER_SEL = ".milkdown-list-item-block.pocket-active-prefix-li > .list-item > .label-wrapper";
    let openGutterFn: ((labelWrap: HTMLElement, caret: "select" | "end") => void) | null = null;

    return new Plugin({
      key: liveKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, prev, oldState, newState) {
          prevCaretPos = oldState.selection.from;
          if (boundView?.composing) {
            dirtyDuringCompose = true;
            const mapped = (cachedDecos ?? prev).map(tr.mapping, newState.doc);
            cachedDecos = mapped;
            cachedState = newState;
            return mapped;
          }
          return prev;
        },
      },
      view(editorView) {
        boundView = editorView;
        viewDestroyed = false;
        const onDismiss = (e: Event) => {
          const detail = (e as CustomEvent<{ pos?: number }>).detail;
          dismissedHtmlPos = typeof detail?.pos === "number" ? detail.pos : null;
        };
        let justOpenedGutter = false;
        const clearJustOpened = () => {
          justOpenedGutter = false;
        };
        const openGutterInput = (labelWrap: HTMLElement, caret: "select" | "end") => {
          if (!options().enabled || !editorView.editable || labelWrap.classList.contains("is-editing")) return;
          const liBlock = labelWrap.closest(".milkdown-list-item-block.pocket-active-prefix-li") as HTMLElement | null;
          if (!liBlock) return;
          const tbPos = Number(liBlock.dataset.pocketTb);
          const prefix = liBlock.dataset.pocketPrefix ?? "- ";
          if (!Number.isFinite(tbPos)) return;

          labelWrap.classList.add("is-editing");
          const wrap = document.createElement("span");
          wrap.className = "pocket-syntax-wrap is-block-prefix is-gutter-prefix";
          wrap.dataset.text = prefix || " ";
          labelWrap.appendChild(wrap);
          mountTokenInput(wrap, editorView, prefix, {
            label: "列表前缀",
            initialCaret: caret,
            onCommit: (val, refocus) => commitBlockPrefixEdit(editorView, tbPos, val, refocus),
            onExitForward: () => {
              const nextPos = Math.min(tbPos + 1, editorView.state.doc.content.size);
              editorView.dispatch(editorView.state.tr.setSelection(TextSelection.near(editorView.state.doc.resolve(nextPos))).setMeta("pocket-selection", true));
              editorView.focus();
            },
            onExitBackward: () => exitBackwardFromBlock(editorView, tbPos),
            onDone: () => {
              justOpenedGutter = false;
              wrap.remove();
              labelWrap.classList.remove("is-editing");
            },
          });
        };
        openGutterFn = openGutterInput;

        const onGutterPointerDown = (e: PointerEvent) => {
          if (!options().enabled || !editorView.editable || e.button !== 0) return;
          const labelWrap = (e.target as Element | null)?.closest(GUTTER_SEL) as HTMLElement | null;
          if (!labelWrap) return;
          if (labelWrap.classList.contains("is-editing")) {
            e.stopPropagation();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          justOpenedGutter = true;
          window.addEventListener("mouseup", clearJustOpened, { once: true });
          openGutterInput(labelWrap, "select");
        };
        const onGutterMouseDown = (e: MouseEvent) => {
          if (!options().enabled || !editorView.editable || e.button !== 0) return;
          const labelWrap = (e.target as Element | null)?.closest(GUTTER_SEL);
          if (!labelWrap) return;
          e.stopPropagation();
          if (justOpenedGutter || !(e.target as Element).closest(".pocket-syntax-input")) {
            justOpenedGutter = false;
            e.preventDefault();
          }
        };
        const onGutterClick = (e: MouseEvent) => {
          const labelWrap = (e.target as Element | null)?.closest(`${GUTTER_SEL}.is-editing`);
          if (!labelWrap) return;
          e.stopPropagation();
          if (!(e.target as Element).closest(".pocket-syntax-input")) {
            e.preventDefault();
          }
        };
        const syncPlaceholderOffset = (view: EditorView) => {
          if (view.isDestroyed) return;
          const sel = view.state.selection;
          const wrap =
            sel.empty && sel.$from.parent.content.size === 0
              ? view.dom.querySelector<HTMLElement>(".crepe-placeholder > .pocket-syntax-wrap.is-block-prefix")
              : null;
          syncPlaceholderHostOffset(view, wrap);
        };
        editorView.dom.addEventListener("pocket-html-dismiss", onDismiss);
        editorView.dom.addEventListener("pointerdown", onGutterPointerDown, true);
        editorView.dom.addEventListener("mousedown", onGutterMouseDown, true);
        editorView.dom.addEventListener("click", onGutterClick, true);
        syncPlaceholderOffset(editorView);
        return {
          update(view, prevState) {
            syncPlaceholderOffset(view);
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

            if (syncRawInlineState(view)) return;

            if (!options().enabled || pointerDown || !view.hasFocus() || view.composing) return;
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
            viewDestroyed = true;
            if (composeRefreshTimer) {
              window.clearTimeout(composeRefreshTimer);
              composeRefreshTimer = 0;
            }
            if (pointerRefreshTimer) {
              window.clearTimeout(pointerRefreshTimer);
              pointerRefreshTimer = 0;
            }
            syncPlaceholderHostOffset(editorView, null);
            editorView.dom.removeEventListener("pocket-html-dismiss", onDismiss);
            editorView.dom.removeEventListener("pointerdown", onGutterPointerDown, true);
            editorView.dom.removeEventListener("mousedown", onGutterMouseDown, true);
            editorView.dom.removeEventListener("click", onGutterClick, true);
            window.removeEventListener("mouseup", clearJustOpened);
            openGutterFn = null;
            boundView = null;
            cachedDecos = null;
            cachedState = null;
          },
        };
      },
      props: {
        decorations(state) {
          if (boundView?.composing && cachedDecos) return cachedDecos;
          if (cachedState === state && cachedDecos) return cachedDecos;
          dirtyDuringCompose = false;
          cachedState = state;
          cachedDecos = buildDecorations(boundView, state);
          return cachedDecos;
        },
        handleKeyDown(view, event) {
          if (!options().enabled || event.isComposing) return false;
          const sel = view.state.selection;
          const rawType = getRawMarkType(view.state);
          const activeRaw = rawType ? findActiveRawSpan(view.state.doc, rawType) : null;

          // 1) 在展开态行内原始语法边缘按 Esc 撤销/收起，或到达段落首尾时顺滑退出展开态
          if (activeRaw && sel instanceof TextSelection) {
            if (event.key === "Escape") {
              event.preventDefault();
              collapseRawInline(view, { revertToInitial: true, suppressAfter: true });
              return true;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              collapseRawInline(view, { suppressAfter: true });
              return false;
            }
            if (sel.empty && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              if (event.key === "ArrowRight" && sel.from === activeRaw.to && activeRaw.to === activeRaw.blockEnd) {
                event.preventDefault();
                collapseRawInline(view, { clearStoredMarks: true, forceCaretAt: "end", suppressAfter: true });
                return true;
              }
              if (event.key === "ArrowLeft" && sel.from === activeRaw.from && activeRaw.from === activeRaw.blockStart) {
                event.preventDefault();
                collapseRawInline(view, { clearStoredMarks: true, forceCaretAt: "start", suppressAfter: true });
                return true;
              }
            }
          }

          // 2) 标题 / 引用 / 列表行首按 ArrowLeft 无缝滑入块前缀编辑（手不离键盘）
          if (event.key === "ArrowLeft" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (sel instanceof TextSelection && sel.empty && sel.$from.parentOffset === 0) {
              const parent = sel.$from.parent;
              if (parent.type.name === "heading" || (parent.type.name === "paragraph" && ancestorOf(sel.$from, "blockquote"))) {
                const prefixWrap = view.dom.querySelector<HTMLElement>(".pocket-syntax-wrap.is-block-prefix.is-passive");
                if (prefixWrap) {
                  event.preventDefault();
                  prefixWrap.dispatchEvent(new CustomEvent("pocket-edit-token", { detail: { caret: "end" } }));
                  return true;
                }
              }
              if (parent.type.name === "paragraph" && ancestorOf(sel.$from, "list_item")) {
                const labelWrap = view.dom.querySelector<HTMLElement>(GUTTER_SEL);
                if (labelWrap && openGutterFn) {
                  event.preventDefault();
                  openGutterFn(labelWrap, "end");
                  return true;
                }
              }
            }
          }

          // 3) 独立 HTML 片段回车自动升级渲染
          if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
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

          // 4) 标题行首 Backspace 逐级降级（### -> ## -> # -> 正文）
          if (event.key === "Backspace" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (sel instanceof TextSelection && sel.empty && sel.$from.parent.type.name === "heading" && sel.$from.parentOffset === 0) {
              event.preventDefault();
              const level = Number(sel.$from.parent.attrs.level || 1);
              const hPos = sel.$from.before();
              if (level > 1) {
                view.dispatch(view.state.tr.setNodeMarkup(hPos, undefined, { ...sel.$from.parent.attrs, level: level - 1 }));
              } else if (view.state.schema.nodes.paragraph) {
                setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch);
              }
              return true;
            }
          }
          return false;
        },
        handleDOMEvents: {
          compositionstart() {
            if (composeRefreshTimer) {
              window.clearTimeout(composeRefreshTimer);
              composeRefreshTimer = 0;
            }
            return false;
          },
          compositionend(view) {
            if (composeRefreshTimer) window.clearTimeout(composeRefreshTimer);
            composeRefreshTimer = window.setTimeout(() => {
              composeRefreshTimer = 0;
              if (!view.isDestroyed && !view.composing && options().enabled && dirtyDuringCompose) {
                dirtyDuringCompose = false;
                view.dispatch(view.state.tr.setMeta(liveKey, true));
              }
            }, 32);
            return false;
          },
          mousedown(_view, event) {
            const target = event.target as Element | null;
            if (!options().enabled || target?.closest(".pocket-syntax-wrap, .label-wrapper, .pocket-html-editing") || (event as MouseEvent).button === 2) {
              return false;
            }
            lastClickInMark = !!target?.closest("strong, b, em, i, del, s, code, mark, u, sup, sub, kbd, a[href], .pocket-raw-inline");
            pointerDown = true;
            if (pointerRefreshTimer) {
              window.clearTimeout(pointerRefreshTimer);
              pointerRefreshTimer = 0;
            }
            window.addEventListener(
              "mouseup",
              () => {
                pointerDown = false;
                pointerRefreshTimer = window.setTimeout(() => {
                  pointerRefreshTimer = 0;
                  if (boundView && !boundView.isDestroyed && !pointerDown && options().enabled) {
                    if (!syncRawInlineState(boundView) && !cachedDecos) {
                      boundView.dispatch(boundView.state.tr.setMeta(liveKey, true));
                    }
                  }
                }, 35);
              },
              { capture: true, once: true },
            );
            return false;
          },
          focus(view) {
            if (options().enabled && !pointerDown) view.dispatch(view.state.tr.setMeta(liveKey, true));
            return false;
          },
          blur(view, event) {
            if (viewDestroyed || view.isDestroyed || !view.dom.isConnected) return false;
            const next = event.relatedTarget as Node | null;
            if (next && view.dom.contains(next)) return false;
            if (document.querySelector(".fx-editor-menu")) return false;
            try {
              if (options().enabled) {
                collapseRawInline(view);
                if (editedParaPos !== null) {
                  const targetPos = editedParaPos;
                  editedParaPos = null;
                  upgradeEditedPara(view, targetPos);
                }
              }
              if (!viewDestroyed && !view.isDestroyed && view.dom.isConnected) {
                view.dispatch(view.state.tr.setMeta(liveKey, false));
              }
            } catch {
              /* 编辑器正在卸载时（如切换源码模式）Milkdown 上下文可能已清理，忽略此期间的失焦刷新 */
            }
            return false;
          },
        },
      },
    });
  });
}

const listGuardKey = new PluginKey("pocket-list-selection-guard");
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Escape"]);
const CJK_PUNCT_RE = /^[\u2014\u2018-\u201F\u2026\u00B7\u3000-\u303F\uFF01-\uFF5E]{1,4}$/;

function txChangedRange(tr: Transaction, targetFrom: number, targetTo: number): boolean {
  for (let i = 0; i < tr.mapping.maps.length; i++) {
    let hit = false;
    const tail = tr.mapping.slice(i + 1);
    tr.mapping.maps[i]!.forEach((_os, _oe, newStart, newEnd) => {
      if (hit) return;
      const from = tail.map(newStart, -1);
      const to = tail.map(newEnd, 1);
      if (from <= targetFrom && to >= targetTo) hit = true;
    });
    if (hit) return true;
  }
  return false;
}

/**
 * 拦截 @milkdown/components 列表项在 onMount 下一帧异步执行 scheduleRestore 时的过期选区回退，
 * 同时防止中文输入法在写入中文标点符号（如 ， 。 ？ ！ 等）时短暂带出的选区残留并触发浮动工具栏。
 */
export const listSelectionGuardPlugin = $prose(() => {
  let boundView: EditorView | null = null;
  let armedAt = typeof performance !== "undefined" ? performance.now() : 0;
  let armedAnchor: number | null = null;
  let dirtySinceArm = false;
  let lastNavAt = 0;
  let lastManualSelAt = 0;
  let composeStartPos: number | null = null;
  let composeCheckTimer1 = 0;
  let composeCheckTimer2 = 0;

  const clearComposeTimers = () => {
    if (composeCheckTimer1) {
      window.clearTimeout(composeCheckTimer1);
      composeCheckTimer1 = 0;
    }
    if (composeCheckTimer2) {
      window.clearTimeout(composeCheckTimer2);
      composeCheckTimer2 = 0;
    }
  };

  const collapseSpuriousCjkSymbolSelection = (view: EditorView) => {
    if (view.isDestroyed || view.composing) return;
    if (performance.now() - lastManualSelAt < 200) return;
    const sel = view.state.selection;
    if (!(sel instanceof TextSelection) || sel.empty || !sel.$from.sameParent(sel.$to)) return;
    if (composeStartPos !== null && sel.from < composeStartPos) return;
    const len = sel.to - sel.from;
    if (len < 1 || len > 4) return;
    const text = view.state.doc.textBetween(sel.from, sel.to);
    if (!CJK_PUNCT_RE.test(text)) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.to)).setMeta("pocket-selection", true));
  };

  return new Plugin({
    key: listGuardKey,
    view(editorView) {
      boundView = editorView;
      armedAt = performance.now();
      armedAnchor = editorView.state.selection.from;
      dirtySinceArm = false;
      const onNav = (e: KeyboardEvent) => {
        if (NAV_KEYS.has(e.key)) {
          lastNavAt = performance.now();
          if (e.shiftKey) lastManualSelAt = lastNavAt;
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          lastManualSelAt = performance.now();
        }
      };
      const onPointer = () => {
        const now = performance.now();
        lastNavAt = now;
        lastManualSelAt = now;
      };
      editorView.dom.addEventListener("keydown", onNav, true);
      editorView.dom.addEventListener("pointerdown", onPointer, true);
      return {
        destroy() {
          clearComposeTimers();
          composeStartPos = null;
          editorView.dom.removeEventListener("keydown", onNav, true);
          editorView.dom.removeEventListener("pointerdown", onPointer, true);
          boundView = null;
        },
      };
    },
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          clearComposeTimers();
          composeStartPos = view.state.selection.from;
          return false;
        },
        compositionend(view) {
          clearComposeTimers();
          composeCheckTimer1 = window.setTimeout(() => {
            composeCheckTimer1 = 0;
            collapseSpuriousCjkSymbolSelection(view);
          }, 0);
          composeCheckTimer2 = window.setTimeout(() => {
            composeCheckTimer2 = 0;
            collapseSpuriousCjkSymbolSelection(view);
            composeStartPos = null;
          }, 28);
          return false;
        },
      },
    },
    filterTransaction(tr, state) {
      if (
        !tr.docChanged &&
        tr.selectionSet &&
        tr.selection.empty &&
        !tr.getMeta("pointer") &&
        !tr.getMeta("uiEvent") &&
        !tr.getMeta("composition") &&
        !tr.getMeta("pocket-selection") &&
        !tr.getMeta("pocket-raw-sync") &&
        !tr.scrolledIntoView
      ) {
        const now = performance.now();
        const navFresh = now - lastNavAt < 80;
        if (!navFresh && !tr.selection.eq(state.selection)) {
          if (boundView?.composing && tr.selection.from < state.selection.to) return false;
          if (tr.selection.from < state.selection.from) {
            const curFrom = state.selection.$from;
            const nextFrom = tr.selection.$from;
            if (nextFrom.parentOffset === 0 && curFrom.parentOffset > 0) return false;
            if (dirtySinceArm && now - armedAt < 1500 && armedAnchor !== null && Math.abs(tr.selection.from - armedAnchor) <= 2) {
              return false;
            }
          }
        }
      }
      return true;
    },
    appendTransaction(transactions, _oldState, newState) {
      if (boundView?.composing) return null;
      if (performance.now() - lastManualSelAt < 200) return null;
      if (transactions.some((tr) => tr.getMeta("history$") || tr.getMeta("pointer") || tr.getMeta("pocket-raw-sync"))) return null;
      const sel = newState.selection;
      if (!(sel instanceof TextSelection) || sel.empty || !sel.$from.sameParent(sel.$to)) return null;
      const len = sel.to - sel.from;
      if (len < 1 || len > 4) return null;
      const text = newState.doc.textBetween(sel.from, sel.to);
      if (!CJK_PUNCT_RE.test(text)) return null;
      if (!transactions.some((tr) => tr.docChanged && txChangedRange(tr, sel.from, sel.to))) return null;
      return newState.tr.setSelection(TextSelection.create(newState.doc, sel.to)).setMeta("pocket-selection", true);
    },
    state: {
      init: () => null,
      apply(tr, _prev, oldState, newState) {
        if (!tr.docChanged) {
          if (tr.selectionSet && !tr.selection.eq(oldState.selection)) dirtySinceArm = true;
          return null;
        }
        lastNavAt = 0;
        const oldItems = oldState.doc.childCount;
        const newItems = newState.doc.childCount;
        const $from = newState.selection.$from;
        const inList = (() => {
          for (let d = $from.depth; d >= 1; d--) {
            if ($from.node(d).type.name === "list_item") return true;
          }
          return false;
        })();
        let stepTouchesListItem = false;
        if (tr.docChanged && newItems === oldItems) {
          const hasListItemNode = (frag: Fragment): boolean => {
            for (let i = 0; i < frag.childCount; i++) {
              const child = frag.child(i);
              if (child.type.name === "list_item" || hasListItemNode(child.content)) return true;
            }
            return false;
          };
          for (let i = 0; i < tr.steps.length && !stepTouchesListItem; i++) {
            const stepSlice = (tr.steps[i] as { slice?: Slice }).slice;
            if (stepSlice && hasListItemNode(stepSlice.content)) {
              stepTouchesListItem = true;
              break;
            }
            const beforeDoc = tr.docs[i];
            const tailMap = tr.mapping.slice(i + 1);
            tr.mapping.maps[i]?.forEach((oldStart, oldEnd, newStart, newEnd) => {
              if (stepTouchesListItem) return;
              if (beforeDoc) {
                const oFrom = Math.max(0, Math.min(oldStart, beforeDoc.content.size));
                const oTo = Math.max(oFrom, Math.min(oldEnd, beforeDoc.content.size));
                beforeDoc.nodesBetween(oFrom, oTo, (node, pos) => {
                  if (node.type.name === "list_item" && (pos >= oFrom || pos + node.nodeSize <= oTo)) {
                    stepTouchesListItem = true;
                    return false;
                  }
                });
              }
              if (stepTouchesListItem) return;
              const from = Math.max(0, Math.min(tailMap.map(newStart, -1), tr.doc.content.size));
              const to = Math.max(from, Math.min(tailMap.map(newEnd, 1), tr.doc.content.size));
              tr.doc.nodesBetween(from, to, (node, pos) => {
                if (node.type.name === "list_item" && (pos >= from || pos + node.nodeSize <= to)) {
                  stepTouchesListItem = true;
                  return false;
                }
              });
            });
          }
        }
        const structuralSplit =
          inList &&
          $from.parentOffset === 0 &&
          $from.parent.content.size === 0 &&
          (newItems !== oldItems || stepTouchesListItem);
        if (structuralSplit) {
          armedAt = performance.now();
          armedAnchor = newState.selection.from;
          dirtySinceArm = false;
        } else {
          dirtySinceArm = true;
        }
        return null;
      },
    },
  });
});
