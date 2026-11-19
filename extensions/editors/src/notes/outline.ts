import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type { Nodes, PhrasingContent } from "mdast";

export type OutlineInlineTag = "strong" | "em" | "del" | "code" | "mark" | "u" | "sup" | "sub";

export type OutlineInline =
  | { type: "text"; value: string }
  | { type: OutlineInlineTag; children: OutlineInline[] };

export interface OutlineHeading {
  level: number;
  text: string;
  from: number;
}

export interface RichOutlineHeading extends OutlineHeading {
  inlines: OutlineInline[];
}

export interface OutlineNode<T extends OutlineHeading = RichOutlineHeading> {
  heading: T;
  index: number;
  children: OutlineNode<T>[];
}

const CUSTOM_INLINE_RE = /\^([^\s^[\]]+)\^|~([^\s~]+)~|(?<![\w=])==([^\s=](?:[^=\n]*[^\s=])?)==(?![\w=])/g;
const HTML_OPEN_RE = /^<(strong|b|em|i|del|s|mark|u|sup|sub|code|kbd)\b[^>]*>$/i;
const HTML_CLOSE_RE = /^<\/(strong|b|em|i|del|s|mark|u|sup|sub|code|kbd)\s*>$/i;

function mapHtmlTag(raw: string): OutlineInlineTag | null {
  switch (raw.toLowerCase()) {
    case "strong":
    case "b":
      return "strong";
    case "em":
    case "i":
      return "em";
    case "del":
    case "s":
      return "del";
    case "mark":
      return "mark";
    case "u":
      return "u";
    case "sup":
      return "sup";
    case "sub":
      return "sub";
    case "code":
    case "kbd":
      return "code";
    default:
      return null;
  }
}

function splitCustomSyntax(text: string): OutlineInline[] {
  if (!/[\^~=]/.test(text)) return text ? [{ type: "text", value: text }] : [];
  const out: OutlineInline[] = [];
  let last = 0;
  for (const m of text.matchAll(CUSTOM_INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ type: "sup", children: [{ type: "text", value: m[1] }] });
    else if (m[2] !== undefined) out.push({ type: "sub", children: [{ type: "text", value: m[2] }] });
    else if (m[3] !== undefined) out.push({ type: "mark", children: [{ type: "text", value: m[3] }] });
    last = at + m[0].length;
  }
  if (out.length === 0) return text ? [{ type: "text", value: text }] : [];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function convertPhrasing(nodes: PhrasingContent[]): OutlineInline[] {
  const out: OutlineInline[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === "html") {
      const val = n.value ?? "";
      const openM = HTML_OPEN_RE.exec(val.trim());
      if (openM) {
        const tagName = openM[1]!.toLowerCase();
        const mapped = mapHtmlTag(tagName);
        let depth = 1;
        let j = i + 1;
        for (; j < nodes.length; j++) {
          const c = nodes[j]!;
          if (c.type !== "html") continue;
          const cv = (c.value ?? "").trim();
          const nestedOpen = HTML_OPEN_RE.exec(cv);
          const nestedClose = HTML_CLOSE_RE.exec(cv);
          if (nestedOpen && nestedOpen[1]!.toLowerCase() === tagName) depth++;
          else if (nestedClose && nestedClose[1]!.toLowerCase() === tagName && --depth === 0) break;
        }
        if (j < nodes.length && mapped) {
          out.push({ type: mapped, children: convertPhrasing(nodes.slice(i + 1, j)) });
          i = j;
          continue;
        }
      }
      // 忽略未闭合或不支持的原始 HTML 标签（如 <br>、<span>），不把标签文本带入大纲。
      continue;
    }
    switch (n.type) {
      case "text":
        out.push(...splitCustomSyntax(n.value));
        break;
      case "inlineCode":
        out.push({ type: "code", children: [{ type: "text", value: n.value }] });
        break;
      case "strong":
        out.push({ type: "strong", children: convertPhrasing(n.children) });
        break;
      case "emphasis":
        out.push({ type: "em", children: convertPhrasing(n.children) });
        break;
      case "delete":
        out.push({ type: "del", children: convertPhrasing(n.children) });
        break;
      case "link":
      case "linkReference":
        // 大纲里不嵌套链接跳转，仅提取内部文字和样式。
        out.push(...convertPhrasing(n.children));
        break;
      case "image":
      case "imageReference":
        if (n.alt) out.push({ type: "text", value: n.alt });
        break;
      case "break":
        out.push({ type: "text", value: " " });
        break;
      default:
        if ("children" in n && Array.isArray(n.children)) {
          out.push(...convertPhrasing(n.children as PhrasingContent[]));
        } else if ("value" in n && typeof n.value === "string") {
          out.push({ type: "text", value: n.value });
        }
        break;
    }
  }
  return out;
}

export function flattenOutlineInlines(inlines: OutlineInline[]): string {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text") out += node.value;
    else out += flattenOutlineInlines(node.children);
  }
  return out;
}

/** 用 Markdown 语法树提取大纲（保留克制行内样式与纯文本），排除代码块中的 #，支持 ATX 和 Setext 标题。 */
export function richOutlineOf(text: string): RichOutlineHeading[] {
  const headings: RichOutlineHeading[] = [];
  const doc = fromMarkdown(text, {
    extensions: [gfmStrikethrough({ singleTilde: false })],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });
  function collect(node: Nodes) {
    if (node.type === "heading") {
      const inlines = convertPhrasing(node.children);
      headings.push({
        level: node.depth,
        text: flattenOutlineInlines(inlines),
        from: node.position!.start.offset!,
        inlines,
      });
    } else if ("children" in node) {
      node.children.forEach(collect);
    }
  }
  collect(doc);
  return headings;
}

/** 仅返回纯文本结构的大纲列表（兼容旧调用与单测）。 */
export function outlineOf(text: string): OutlineHeading[] {
  return richOutlineOf(text).map(({ level, text: t, from }) => ({ level, text: t, from }));
}

/** 将行内大纲节点树转为安全 DOM 片段（供 [TOC] 等非 Preact 场景复用）。 */
export function renderOutlineInlinesDOM(inlines: OutlineInline[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of inlines) {
    if (node.type === "text") {
      frag.appendChild(document.createTextNode(node.value));
      continue;
    }
    const el = document.createElement(node.type);
    el.appendChild(renderOutlineInlinesDOM(node.children));
    frag.appendChild(el);
  }
  return frag;
}

/** 按标题级别组装大纲树，保留每个标题在原扁平列表中的 index。 */
export function outlineTree<T extends OutlineHeading>(headings: T[]): OutlineNode<T>[] {
  const roots: OutlineNode<T>[] = [];
  const stack: OutlineNode<T>[] = [];
  headings.forEach((heading, index) => {
    const node: OutlineNode<T> = { heading, index, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.heading.level >= heading.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

/** 将大纲节点树按层级缩进格式化为纯大纲文本（仅标题内容，不含正文）。 */
export function formatOutlineTreeCopy<T extends OutlineHeading>(nodes: readonly OutlineNode<T>[], indent = "  "): string {
  const lines: string[] = [];
  const walk = (list: readonly OutlineNode<T>[], depth: number) => {
    for (const node of list) {
      const label = node.heading.text.trim() || "（空标题）";
      lines.push(`${indent.repeat(depth)}${label}`);
      if (node.children.length > 0) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

/** 格式化单个大纲条目（仅自身，或连带其全部子节点，仅大纲不含正文）。 */
export function formatOutlineItemCopy<T extends OutlineHeading>(node: OutlineNode<T>, includeChildren: boolean, indent = "  "): string {
  if (!includeChildren) return node.heading.text.trim() || "（空标题）";
  return formatOutlineTreeCopy([node], indent);
}
