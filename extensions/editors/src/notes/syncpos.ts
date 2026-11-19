import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { splitFrontmatter } from "./frontmatter";

export interface EditorAnchor {
  /** 顶层块在正文中的序号（与 ProseMirror doc.child(index) 对齐）。 */
  blockIndex: number;
  /** 光标在块内纯文本或源码中的大致字符偏移。 */
  offsetInBlock: number;
  /** 光标前一小段纯文本片段，用于跨 Markdown 标记精确落位。 */
  beforeSnippet?: string;
  /** 光标后一小段纯文本片段，用于在块内定位。 */
  afterSnippet?: string;
  /** 切回目标模式后是否聚焦编辑器（阅读模式切走时可为 false）。 */
  focus: boolean;
}

export interface BlockRange {
  start: number;
  end: number;
  raw: string;
}

/** 剥离行内常见 Markdown 符号，便于在源码与富文本纯文本之间做近似位置映射。 */
function stripInlineSyntax(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(?:u|mark|sup|sub|kbd|strong|em|b|i|s|del)>/gi, "")
    .replace(/(\*\*|~~|==|`|\*|\^|~)/g, "");
}

/** 解析正文（不含 frontmatter）中所有顶层块在源码字符串中的精确字节偏移区间。 */
export function topLevelBlockRanges(body: string): BlockRange[] {
  if (!body) return [];
  const tree = fromMarkdown(body, {
    extensions: [gfmStrikethrough({ singleTilde: false }), gfmTable()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown()],
  });
  const ranges: BlockRange[] = [];
  for (const child of tree.children) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (typeof start === "number" && typeof end === "number") {
      ranges.push({ start, end, raw: body.slice(start, end) });
    }
  }
  return ranges;
}

function anchorNeedles(anchor: EditorAnchor): string[] {
  const out: string[] = [];
  const before = (anchor.beforeSnippet ?? "").trim();
  const after = (anchor.afterSnippet ?? "").trim();
  if (before.length >= 2) {
    out.push(before);
    const tail = before.slice(-6).trim();
    if (tail.length >= 2 && tail !== before) out.push(tail);
  }
  if (after.length >= 2) {
    out.push(after);
    const head = after.slice(0, 6).trim();
    if (head.length >= 2 && head !== after) out.push(head);
  }
  return out;
}

function textMatchesNeedles(text: string, needles: readonly string[]): boolean {
  if (!text || needles.length === 0) return false;
  const stripped = stripInlineSyntax(text);
  return needles.some((n) => text.includes(n) || stripped.includes(n));
}

/**
 * 结合序号与上下文片段挑选最匹配的顶层块下标：
 * 即使文档含空段落、Frontmatter、HTML 块或列表拆分导致块数轻微漂移，也能精准落到同一段。
 */
export function pickBestBlockIndex<T>(items: readonly T[], textOf: (item: T) => string, anchor: EditorAnchor): number {
  if (items.length === 0) return 0;
  const base = Math.max(0, Math.min(anchor.blockIndex, items.length - 1));
  const needles = anchorNeedles(anchor);
  if (needles.length === 0) return base;
  if (textMatchesNeedles(textOf(items[base]!), needles)) return base;

  const maxRadius = Math.min(16, items.length);
  for (let delta = 1; delta <= maxRadius; delta++) {
    const lo = base - delta;
    if (lo >= 0 && textMatchesNeedles(textOf(items[lo]!), needles)) return lo;
    const hi = base + delta;
    if (hi < items.length && textMatchesNeedles(textOf(items[hi]!), needles)) return hi;
  }
  return base;
}

function findOffsetInRaw(raw: string, anchor: EditorAnchor): number {
  const before = (anchor.beforeSnippet ?? "").trim();
  const after = (anchor.afterSnippet ?? "").trim();

  if (before.length >= 2) {
    const idx = raw.indexOf(before);
    if (idx >= 0) return idx + before.length;
    // 尝试取光标前最后 6 个非空字符（避开中间夹杂 Markdown 符号）
    const tail = before.slice(-6);
    if (tail.length >= 2) {
      const idx2 = raw.indexOf(tail);
      if (idx2 >= 0) return idx2 + tail.length;
    }
  }
  if (after.length >= 2) {
    const head = after.slice(0, 6);
    const idx = raw.indexOf(head);
    if (idx >= 0) return idx;
  }

  const plainLen = Math.max(1, stripInlineSyntax(raw).length);
  const ratio = Math.max(0, Math.min(1, anchor.offsetInBlock / plainLen));
  return Math.round(ratio * raw.length);
}

/** 将富文本（阅读 / 实时 / 整块）的锚点映射回完整 Markdown 源码中的字符偏移。 */
export function anchorToSourceOffset(content: string, anchor: EditorAnchor): number {
  const split = splitFrontmatter(content);
  const bodyOffset = content.length - split.body.length;
  const ranges = topLevelBlockRanges(split.body);
  if (ranges.length === 0) return Math.min(content.length, bodyOffset);

  const bestIdx = pickBestBlockIndex(ranges, (r) => r.raw, anchor);
  const target = ranges[bestIdx]!;
  const local = findOffsetInRaw(target.raw, anchor);
  return Math.max(0, Math.min(content.length, bodyOffset + target.start + local));
}

/** 将源码模式中的字符偏移映射为富文本可用的顶层块锚点。 */
export function sourceOffsetToAnchor(content: string, sourceOffset: number): EditorAnchor {
  const split = splitFrontmatter(content);
  const bodyOffset = content.length - split.body.length;
  const bodyPos = Math.max(0, sourceOffset - bodyOffset);
  const ranges = topLevelBlockRanges(split.body);
  if (ranges.length === 0) {
    return { blockIndex: 0, offsetInBlock: 0, focus: true };
  }

  let idx = ranges.length - 1;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (bodyPos <= r.end) {
      idx = i;
      break;
    }
  }

  const target = ranges[idx]!;
  const localRawOffset = Math.max(0, Math.min(target.raw.length, bodyPos - target.start));
  const beforeRaw = target.raw.slice(0, localRawOffset);
  const afterRaw = target.raw.slice(localRawOffset);
  const beforePlain = stripInlineSyntax(beforeRaw);
  const afterPlain = stripInlineSyntax(afterRaw);

  return {
    blockIndex: idx,
    offsetInBlock: beforePlain.length,
    beforeSnippet: beforePlain.slice(-14),
    afterSnippet: afterPlain.slice(0, 14),
    focus: true,
  };
}

/** 在已知某顶层块纯文本内容时，根据锚点算出最贴合的块内纯文本字符偏移。 */
export function resolveOffsetInBlockText(blockText: string, anchor: EditorAnchor): number {
  if (!blockText) return 0;
  const before = (anchor.beforeSnippet ?? "").trim();
  const after = (anchor.afterSnippet ?? "").trim();

  if (before.length >= 2) {
    const idx = blockText.indexOf(before);
    if (idx >= 0) return Math.min(blockText.length, idx + before.length);
    const tail = before.slice(-6);
    if (tail.length >= 2) {
      const idx2 = blockText.indexOf(tail);
      if (idx2 >= 0) return Math.min(blockText.length, idx2 + tail.length);
    }
  }
  if (after.length >= 2) {
    const head = after.slice(0, 6);
    const idx = blockText.indexOf(head);
    if (idx >= 0) return idx;
  }
  return Math.max(0, Math.min(blockText.length, anchor.offsetInBlock));
}
