import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $markSchema, $remark, $view } from "@milkdown/kit/utils";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  tag?: string;
  rawOpen?: string;
  attrs?: Record<string, string>;
}

const spanNodeType = "pocketHtmlSpan";
const BLOCK_HTML_TAGS = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "div",
  "dl", "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "hr",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "ul",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);
const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed", "applet", "base", "meta", "link", "form", "noscript"]);
const ALLOWED_INLINE_SPAN_TAGS = new Set([
  "span", "font", "b", "strong", "i", "em", "s", "del", "ins", "a",
  "small", "big", "center", "cite", "q", "code", "var", "samp", "time", "abbr",
  "sup", "sub", "mark", "kbd", "u",
]);
const SKIP_CONTAINERS = new Set(["code", "inlineCode", "math", "inlineMath", "yaml", "definition", "footnoteReference"]);

const OPEN_TAG_RE = /^<([a-z][a-z0-9-]*)(\s+[^>]*)?>\s*$/i;
const URL_ATTR_RE = /^(?:href|src|poster|cite)$/i;
const SAFE_URL_RE = /^(?:https?:|mailto:|tel:|data:image\/|#|\.?\/)/i;

function sanitizeAttrMap(rawOpen: string, tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof DOMParser === "undefined") return out;
  const doc = new DOMParser().parseFromString(`${rawOpen}</${tag}>`, "text/html");
  const el = doc.body.firstElementChild;
  if (!el) return out;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const val = attr.value.trim();
    if (name.startsWith("on") || name === "srcdoc") continue;
    if (URL_ATTR_RE.test(name) && val && !SAFE_URL_RE.test(val) && !/^[^:]+$/.test(val)) continue;
    if (name === "style" && /expression\s*\(|javascript:|url\s*\(\s*["']?\s*javascript:/i.test(val)) continue;
    out[name] = attr.value;
  }
  // 将经典 <font color="..." size="..."> 映射补充至行内样式，增强兼容。
  if (tag === "font") {
    const extra: string[] = [];
    if (out.color) extra.push(`color: ${out.color}`);
    if (out.face) extra.push(`font-family: ${out.face}`);
    if (extra.length) out.style = out.style ? `${out.style}; ${extra.join("; ")}` : extra.join("; ");
  }
  return out;
}

function sanitizeDomTree(root: Element) {
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) {
      child.remove();
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith("on") || name === "srcdoc") {
        child.removeAttribute(attr.name);
      } else if (URL_ATTR_RE.test(name) && val && !SAFE_URL_RE.test(val) && !/^[^:]+$/.test(val)) {
        child.removeAttribute(attr.name);
      } else if (name === "style" && /expression\s*\(|javascript:|url\s*\(\s*["']?\s*javascript:/i.test(val)) {
        child.removeAttribute(attr.name);
      }
    }
    sanitizeDomTree(child);
  }
}

function pairInlineHtml(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const n = children[i]!;
    const m = n.type === "html" ? OPEN_TAG_RE.exec(n.value ?? "") : null;
    if (m) {
      const tag = m[1]!.toLowerCase();
      if (ALLOWED_INLINE_SPAN_TAGS.has(tag)) {
        let depth = 1;
        let j = i + 1;
        const openRe = new RegExp(`^<${tag}(?:\\s+[^>]*)?>\\s*$`, "i");
        const closeRe = new RegExp(`^<\\/${tag}>\\s*$`, "i");
        for (; j < children.length; j++) {
          const c = children[j]!;
          if (c.type !== "html") continue;
          const v = c.value ?? "";
          if (openRe.test(v)) depth++;
          else if (closeRe.test(v) && --depth === 0) break;
        }
        if (j < children.length) {
          const rawOpen = (n.value ?? "").trim();
          out.push({
            type: spanNodeType,
            tag,
            rawOpen,
            attrs: sanitizeAttrMap(rawOpen, tag),
            children: pairInlineHtml(children.slice(i + 1, j)),
          });
          i = j;
          continue;
        }
      }
    }
    out.push(n);
  }
  return out;
}

function walkInlineHtml(node: MdNode) {
  if (!node.children || SKIP_CONTAINERS.has(node.type)) return;
  node.children = pairInlineHtml(node.children);
  for (const c of node.children) walkInlineHtml(c);
}

const remarkPairInlineHtml = $remark("remarkPairInlineHtml", () => () => (tree: unknown) => walkInlineHtml(tree as MdNode));

export const pocketHtmlSpanSchema = $markSchema("pocket_html_span", () => ({
  attrs: {
    tag: { default: "span" },
    rawOpen: { default: "<span>" },
    attrs: { default: {} },
  },
  parseDOM: [],
  toDOM: (mark) => {
    const tag = ALLOWED_INLINE_SPAN_TAGS.has(String(mark.attrs.tag)) ? String(mark.attrs.tag) : "span";
    const attrs = (mark.attrs.attrs && typeof mark.attrs.attrs === "object" ? mark.attrs.attrs : {}) as Record<string, string>;
    return [tag, { ...attrs, "data-pocket-html": "1" }, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === spanNodeType,
    runner: (state, node, markType) => {
      state.openMark(markType, { tag: node.tag ?? "span", rawOpen: node.rawOpen ?? "<span>", attrs: node.attrs ?? {} });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === spanNodeType || mark.type.name === "pocket_html_span",
    runner: (state, mark) => {
      state.withMark(mark, spanNodeType, undefined, {
        tag: mark.attrs.tag,
        rawOpen: mark.attrs.rawOpen,
        attrs: mark.attrs.attrs,
      });
    },
  },
}));

interface ToMarkdownState {
  containerPhrasing(node: unknown, info: Record<string, unknown>): string;
  createTracker(info: unknown): { move(text: string): string; current(): Record<string, unknown> };
}

function stringifySpan(node: MdNode, _parent: unknown, state: ToMarkdownState, info: unknown): string {
  const tag = node.tag ?? "span";
  const open = node.rawOpen ?? `<${tag}>`;
  const close = `</${tag}>`;
  const tracker = state.createTracker(info);
  let value = tracker.move(open);
  value += tracker.move(state.containerPhrasing(node, { before: value, after: close, ...tracker.current() }));
  return value + tracker.move(close);
}

const BR_ONLY_RE = /^\s*<br\s*\/?\s*>\s*$/i;
const STYLE_ONLY_RE = /^\s*<style\b[^>]*>([\s\S]*?)<\/style>\s*$/i;
const COMMENT_ONLY_RE = /^\s*<!--[\s\S]*-->\s*$/;

function sanitizeCss(css: string): string {
  const cleaned = css.replace(/@import\b[^;]+;/gi, "").replace(/expression\s*\(|javascript:/gi, "");
  return `@scope (.fx-notes-rich .milkdown .ProseMirror) {\n${cleaned}\n}`;
}

/**
 * 在阅读模式下直接把 <br>、安全 HTML 标签和限定作用域的 <style> 渲染出视觉效果，
 * 双击或按需时可内联编辑其 HTML 源码；同时保留原始 htmlSchema.toDOM 供 HTML 预览使用。
 */
export const pocketHtmlNodeView = $view(htmlSchema.node, () => {
  return (initialNode: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    let cur = initialNode;
    let editing = false;

    const dom = document.createElement("span");
    dom.className = "pocket-html-node";
    dom.contentEditable = "false";

    const renderLive = () => {
      editing = false;
      dom.replaceChildren();
      const val = String(cur.attrs.value ?? "");

      if (BR_ONLY_RE.test(val)) {
        dom.className = "pocket-html-br";
        dom.title = "换行 <br />（双击编辑）";
        dom.appendChild(document.createElement("br"));
        return;
      }

      const styleMatch = STYLE_ONLY_RE.exec(val);
      if (styleMatch) {
        dom.className = "pocket-html-style";
        const styleEl = document.createElement("style");
        styleEl.textContent = sanitizeCss(styleMatch[1] ?? "");
        dom.appendChild(styleEl);
        return;
      }

      if (COMMENT_ONLY_RE.test(val)) {
        dom.className = "pocket-html-comment";
        return;
      }

      const parsed = new DOMParser().parseFromString(val, "text/html");
      sanitizeDomTree(parsed.body);
      const firstTag = parsed.body.firstElementChild?.tagName.toLowerCase() ?? "";
      const isBlock = BLOCK_HTML_TAGS.has(firstTag);
      dom.className = isBlock ? "pocket-html-live is-block" : "pocket-html-live";
      dom.title = "HTML 内容（双击编辑源码）";
      if (parsed.body.childNodes.length === 0) {
        dom.textContent = val;
      } else {
        while (parsed.body.firstChild) dom.appendChild(parsed.body.firstChild);
      }
    };

    const openEditor = () => {
      if (editing) return;
      editing = true;
      dom.replaceChildren();
      dom.className = "pocket-html-editing";
      const val = String(cur.attrs.value ?? "");
      const useArea = val.includes("\n") || val.length > 60;
      const input = document.createElement(useArea ? "textarea" : "input") as HTMLInputElement | HTMLTextAreaElement;
      input.className = "pocket-html-input";
      input.value = val;
      input.spellcheck = false;
      if (input instanceof HTMLTextAreaElement) input.rows = Math.min(8, Math.max(2, val.split("\n").length));
      else input.size = Math.max(8, Math.min(60, val.length + 1));

      const commit = () => {
        const pos = getPos();
        if (typeof pos === "number" && input.value !== cur.attrs.value) {
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, value: input.value }));
        }
        renderLive();
      };
      (input as HTMLElement).addEventListener("keydown", (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && !(input instanceof HTMLTextAreaElement && e.shiftKey))) {
          e.preventDefault();
          commit();
          view.focus();
        }
      });
      input.addEventListener("blur", commit);
      dom.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    };

    dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor();
    });

    renderLive();

    return {
      dom,
      update(node) {
        if (node.type !== cur.type) return false;
        cur = node;
        if (!editing) renderLive();
        return true;
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
    };
  };
});

export const pocketHtmlPlugins = [remarkPairInlineHtml, pocketHtmlSpanSchema, pocketHtmlNodeView].flat();

export function configurePocketHtml(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...prev.handlers, [spanNodeType]: stringifySpan as never },
  }));
}
