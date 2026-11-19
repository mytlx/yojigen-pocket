import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $ctx, $markSchema, $nodeSchema, $remark, $view } from "@milkdown/kit/utils";

interface MdPos {
  start: { line: number };
  end: { line: number };
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  tag?: string;
  rawOpen?: string;
  openHtml?: string;
  closeHtml?: string;
  summaryHtml?: string;
  attrs?: Record<string, string>;
  position?: MdPos;
}

const spanNodeType = "pocketHtmlSpan";
const blockNodeType = "pocketHtmlBlock";

const BLOCK_HTML_TAGS = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "div",
  "dl", "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "hr",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "ul",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);
const CONTAINER_BLOCK_TAGS = new Set([
  "details", "div", "section", "article", "aside", "header", "footer",
  "main", "nav", "figure", "figcaption", "center", "blockquote", "fieldset",
]);
const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed", "applet", "base", "meta", "link", "form", "noscript"]);
const ALLOWED_INLINE_SPAN_TAGS = new Set([
  "span", "font", "b", "strong", "i", "em", "s", "del", "ins", "a",
  "small", "big", "center", "cite", "q", "code", "var", "samp", "time", "abbr",
  "sup", "sub", "mark", "kbd", "u",
]);
const SKIP_CONTAINERS = new Set(["code", "inlineCode", "math", "inlineMath", "yaml", "definition", "footnoteReference"]);

const OPEN_TAG_RE = /^<([a-z][a-z0-9-]*)(\s+[^>]*)?>\s*$/i;
const LEADING_TAG_RE = /^\s*<([a-z][a-z0-9-]*)(\s+[^>]*)?>/i;
const URL_ATTR_RE = /^(?:href|src|poster|cite)$/i;
const SAFE_URL_RE = /^(?:https?:|mailto:|tel:|data:image\/|#|\.?\/)/i;

const BR_ONLY_RE = /^\s*<br\s*\/?\s*>\s*$/i;
const STYLE_ONLY_RE = /^\s*<style\b[^>]*>([\s\S]*?)<\/style>\s*$/i;
const COMMENT_ONLY_RE = /^\s*<!--[\s\S]*-->\s*$/;

export const pocketHtmlLiveCtx = $ctx<() => boolean, "pocketHtmlLive">(() => false, "pocketHtmlLive");

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
  if (tag === "font") {
    const extra: string[] = [];
    if (out.color) extra.push(`color: ${out.color}`);
    if (out.face) extra.push(`font-family: ${out.face}`);
    if (extra.length) out.style = out.style ? `${out.style}; ${extra.join("; ")}` : extra.join("; ");
  }
  if (out.align) {
    const alignCss = `text-align: ${out.align}`;
    out.style = out.style ? `${out.style}; ${alignCss}` : alignCss;
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

function tagBalance(html: string, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "gi");
  let balance = 0;
  for (const m of html.matchAll(re)) {
    const isClose = m[1] === "/";
    const attrs = m[2] ?? "";
    if (isClose) balance--;
    else if (!/\/\s*$/.test(attrs)) balance++;
  }
  return balance;
}

function unclosedBlockTag(html: string): { tag: string; openTag: string } | null {
  if (COMMENT_ONLY_RE.test(html) || STYLE_ONLY_RE.test(html)) return null;
  const m = LEADING_TAG_RE.exec(html);
  if (!m) return null;
  const tag = m[1]!.toLowerCase();
  if (!CONTAINER_BLOCK_TAGS.has(tag)) return null;
  if (/\/\s*>$/.test(m[0])) return null;
  if (tagBalance(html, tag) <= 0) return null;
  return { tag, openTag: m[0].trim() };
}

function extractSummaryHtml(tag: string, openHtml: string): string {
  if (tag !== "details") return "";
  const m = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(openHtml);
  return m?.[1] ?? "";
}

function singleBlockHtmlValue(n: MdNode): string | null {
  if (n.type === "html") return n.value ?? "";
  if (n.type === "paragraph" && n.children?.length === 1 && n.children[0]!.type === "html") {
    return n.children[0]!.value ?? "";
  }
  return null;
}

function pairBlockHtml(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const cur = children[i]!;
    const curHtml = singleBlockHtmlValue(cur);
    if (curHtml) {
      const opener = unclosedBlockTag(curHtml);
      if (opener) {
        const { tag, openTag } = opener;
        let depth = tagBalance(curHtml, tag);
        let j = i + 1;
        for (; j < children.length; j++) {
          const candHtml = singleBlockHtmlValue(children[j]!);
          if (!candHtml) continue;
          depth += tagBalance(candHtml, tag);
          if (depth <= 0) break;
        }
        if (j < children.length) {
          const closeHtml = (singleBlockHtmlValue(children[j]!) ?? `</${tag}>`).trim();
          const inner = children.slice(i + 1, j);
          let openHtml = curHtml;
          const firstInnerHtml = inner[0] ? singleBlockHtmlValue(inner[0]) : null;
          if (tag === "details" && !extractSummaryHtml(tag, openHtml) && firstInnerHtml && /^\s*<summary\b/i.test(firstInnerHtml)) {
            openHtml = `${openHtml}\n${firstInnerHtml}`;
            inner.shift();
          }
          const pos = cur.position && children[j]!.position
            ? { start: cur.position.start, end: children[j]!.position!.end }
            : undefined;
          if (inner.every((c) => singleBlockHtmlValue(c) !== null)) {
            const mergedValue = [openHtml, ...inner.map((c) => singleBlockHtmlValue(c) ?? ""), closeHtml].filter(Boolean).join("\n\n");
            const htmlLeaf: MdNode = { type: "html", value: mergedValue, position: pos };
            out.push(cur.type === "paragraph" ? { type: "paragraph", children: [htmlLeaf], position: pos } : htmlLeaf);
          } else {
            out.push({
              type: blockNodeType,
              tag,
              openHtml,
              closeHtml,
              attrs: sanitizeAttrMap(openTag, tag),
              summaryHtml: extractSummaryHtml(tag, openHtml),
              children: pairBlockHtml(inner),
              position: pos,
            });
          }
          i = j;
          continue;
        }
      }
    }
    if (cur.children && !SKIP_CONTAINERS.has(cur.type)) {
      cur.children = pairBlockHtml(cur.children);
    }
    out.push(cur);
  }
  return out;
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

function walkHtml(node: MdNode) {
  if (!node.children || SKIP_CONTAINERS.has(node.type)) return;
  if (node.type === "root" || node.type === "blockquote" || node.type === "listItem") {
    node.children = pairBlockHtml(node.children);
  }
  node.children = pairInlineHtml(node.children);
  for (const c of node.children) walkHtml(c);
}

const remarkPairHtml = $remark("remarkPairHtml", () => () => (tree: unknown) => walkHtml(tree as MdNode));

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

export const pocketHtmlBlockSchema = $nodeSchema("pocket_html_block", () => ({
  group: "block",
  content: "block+",
  defining: true,
  attrs: {
    tag: { default: "div" },
    openHtml: { default: "<div>" },
    closeHtml: { default: "</div>" },
    attrs: { default: {} },
    summaryHtml: { default: "" },
  },
  parseDOM: [],
  toDOM: (node) => {
    const tag = CONTAINER_BLOCK_TAGS.has(String(node.attrs.tag)) ? String(node.attrs.tag) : "div";
    const attrs = (node.attrs.attrs && typeof node.attrs.attrs === "object" ? node.attrs.attrs : {}) as Record<string, string>;
    const safeAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== "class") safeAttrs[k] = v;
    }
    safeAttrs.class = attrs.class ? `pocket-html-block ${attrs.class}` : "pocket-html-block";
    if (tag === "details") {
      const summaryText = String(node.attrs.summaryHtml ?? "").replace(/<[^>]+>/g, "").trim();
      return summaryText ? ["details", safeAttrs, ["summary", summaryText], 0] : ["details", safeAttrs, 0];
    }
    return [tag, safeAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === blockNodeType,
    runner: (state, node, type) => {
      state.openNode(type, {
        tag: node.tag ?? "div",
        openHtml: node.openHtml ?? "<div>",
        closeHtml: node.closeHtml ?? "</div>",
        attrs: node.attrs ?? {},
        summaryHtml: node.summaryHtml ?? "",
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "pocket_html_block",
    runner: (state, node) => {
      state.addNode("html", undefined, String(node.attrs.openHtml ?? `<${node.attrs.tag}>`));
      state.next(node.content);
      state.addNode("html", undefined, String(node.attrs.closeHtml ?? `</${node.attrs.tag}>`));
    },
  },
}));

export const pocketHtmlBlockView = $view(pocketHtmlBlockSchema.node, () => {
  return (initialNode: PMNode): NodeView => {
    const tag = CONTAINER_BLOCK_TAGS.has(String(initialNode.attrs.tag)) ? String(initialNode.attrs.tag) : "div";
    const attrs = (initialNode.attrs.attrs && typeof initialNode.attrs.attrs === "object" ? initialNode.attrs.attrs : {}) as Record<string, string>;
    const outer = document.createElement(tag === "details" ? "details" : tag === "blockquote" ? "div" : tag);
    outer.className = `pocket-html-block pocket-html-live is-block${attrs.class ? ` ${attrs.class}` : ""}`;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") continue;
      if (k === "open" && outer instanceof HTMLDetailsElement) outer.open = true;
      else outer.setAttribute(k, v);
    }

    if (outer instanceof HTMLDetailsElement && initialNode.attrs.summaryHtml) {
      const summary = document.createElement("summary");
      summary.contentEditable = "false";
      if (typeof DOMParser !== "undefined") {
        const parsed = new DOMParser().parseFromString(String(initialNode.attrs.summaryHtml), "text/html");
        sanitizeDomTree(parsed.body);
        while (parsed.body.firstChild) summary.appendChild(parsed.body.firstChild);
      } else {
        summary.textContent = String(initialNode.attrs.summaryHtml);
      }
      outer.appendChild(summary);
    }

    const body = document.createElement("div");
    body.className = "pocket-html-block-body";
    outer.appendChild(body);

    return {
      dom: outer,
      contentDOM: body,
      update: (node) => node.type === initialNode.type && node.attrs.tag === initialNode.attrs.tag && node.attrs.openHtml === initialNode.attrs.openHtml,
      ignoreMutation: (m) => m.type === "attributes" && m.attributeName === "open",
    };
  };
});

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

function sanitizeCss(css: string): string {
  const cleaned = css.replace(/@import\b[^;]+;/gi, "").replace(/expression\s*\(|javascript:/gi, "");
  return `@scope (.fx-notes-rich .milkdown .ProseMirror) {\n${cleaned}\n}`;
}

/**
 * 在阅读模式下直接把 <br>、安全 HTML 标签和限定作用域的 <style> 渲染出视觉效果；
 * 模式一（实时渲染）下点击或键盘光标进入即可就地切换 HTML 源码编辑并在离开后立即重渲染；
 * 保留 htmlSchema.toDOM 供 HTML 预览使用。
 */
export const pocketHtmlNodeView = $view(htmlSchema.node, (ctx) => {
  return (initialNode: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    let cur = initialNode;
    let editing = false;

    const dom = document.createElement("span");
    dom.className = "pocket-html-node";
    dom.contentEditable = "false";

    const renderLive = () => {
      if (editing) view.dom.classList.remove("pocket-hide-vcursor-html");
      editing = false;
      dom.replaceChildren();
      const val = String(cur.attrs.value ?? "");

      if (BR_ONLY_RE.test(val)) {
        dom.className = "pocket-html-br";
        if (view.editable) dom.title = "换行 <br />（点击编辑）";
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

      if (typeof DOMParser !== "undefined") {
        const parsed = new DOMParser().parseFromString(val, "text/html");
        sanitizeDomTree(parsed.body);
        const firstTag = parsed.body.firstElementChild?.tagName.toLowerCase() ?? "";
        const isBlock = BLOCK_HTML_TAGS.has(firstTag);
        dom.className = isBlock ? "pocket-html-live is-block" : "pocket-html-live";
        if (view.editable) dom.title = "HTML 内容（点击编辑源码）";
        if (parsed.body.childNodes.length === 0) {
          dom.textContent = val;
        } else {
          while (parsed.body.firstChild) dom.appendChild(parsed.body.firstChild);
        }
      } else {
        dom.className = "pocket-html-live";
        dom.textContent = val;
      }
    };

    const openEditor = () => {
      if (editing || !view.editable) return;
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

      const commit = (dismiss = false) => {
        const pos = getPos();
        if (typeof pos === "number" && input.value !== cur.attrs.value) {
          if (!input.value.trim()) {
            view.dispatch(view.state.tr.delete(pos, pos + cur.nodeSize));
          } else {
            view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, value: input.value }));
          }
        }
        if (dismiss && typeof pos === "number") {
          dom.dispatchEvent(new CustomEvent("pocket-html-dismiss", { bubbles: true, detail: { pos } }));
        }
        renderLive();
      };
      (input as HTMLElement).addEventListener("keydown", (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && !(input instanceof HTMLTextAreaElement && (e.shiftKey || !e.ctrlKey && !e.metaKey)))) {
          e.preventDefault();
          commit(e.key === "Escape");
          view.focus();
        }
      });
      input.addEventListener("focus", () => view.dom.classList.add("pocket-hide-vcursor-html"));
      input.addEventListener("blur", () => {
        view.dom.classList.remove("pocket-hide-vcursor-html");
        commit(false);
      });
      dom.appendChild(input);
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.focus();
        input.select();
      });
    };

    dom.addEventListener("pocket-open-html-edit", () => openEditor());
    dom.addEventListener("click", (e) => {
      if (!view.editable) return;
      const target = e.target as Element | null;
      if (target?.closest("summary, a")) return;
      if (ctx.get(pocketHtmlLiveCtx.key)()) {
        e.preventDefault();
        e.stopPropagation();
        openEditor();
      }
    });
    dom.addEventListener("dblclick", (e) => {
      if (!view.editable) return;
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
      selectNode() {
        dom.classList.add("ProseMirror-selectednode");
      },
      deselectNode() {
        dom.classList.remove("ProseMirror-selectednode");
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
      destroy() {
        if (editing) view.dom.classList.remove("pocket-hide-vcursor-html");
      },
    };
  };
});

export const pocketHtmlPlugins = [
  pocketHtmlLiveCtx,
  remarkPairHtml,
  pocketHtmlSpanSchema,
  pocketHtmlBlockSchema,
  pocketHtmlBlockView,
  pocketHtmlNodeView,
].flat();

export function configurePocketHtml(ctx: Ctx, opts?: { isLive?: () => boolean }) {
  if (opts?.isLive) ctx.set(pocketHtmlLiveCtx.key, opts.isLive);
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...prev.handlers, [spanNodeType]: stringifySpan as never },
  }));
}
