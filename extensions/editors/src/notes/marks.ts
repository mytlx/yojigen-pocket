import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { markRule } from "@milkdown/kit/prose";
import { $inputRule, $markSchema, $remark } from "@milkdown/kit/utils";

/**
 * 标准 Markdown 没有、但笔记里常用的几种行内样式：
 *
 *   上标  x^2^        或 <sup>2</sup>
 *   下标  H~2~O       或 <sub>2</sub>
 *   高亮  ==重点==     或 <mark>重点</mark>
 *   按键  <kbd>Ctrl</kbd>
 *   下划线 <u>文字</u>
 *
 * 做法：解析时把成对的行内 HTML 标签、以及 ^ ~ == 包起来的文字换成一个自定义节点，
 * 编辑器里对应一个 mark；保存时按原来的写法写回去（原来是 ^2^ 就还是 ^2^，不会变成 <sup>）。
 */
const tags = ["sup", "sub", "mark", "kbd", "u"] as const;
type Tag = (typeof tags)[number];

const mdSyntax: Partial<Record<Tag, string>> = { sup: "^", sub: "~", mark: "==" };
const nodeType = "pocketMark";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  tag?: string;
  md?: boolean;
}

const openTag = /^<(sup|sub|mark|kbd|u)>$/i;

/** 把同一层里成对的 <tag> … </tag> 收成一个节点。 */
function pairHtml(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const n = children[i]!;
    const m = n.type === "html" ? openTag.exec(n.value ?? "") : null;
    if (m) {
      const tag = m[1]!.toLowerCase();
      let depth = 1;
      let j = i + 1;
      for (; j < children.length; j++) {
        const c = children[j]!;
        if (c.type !== "html") continue;
        const v = (c.value ?? "").toLowerCase();
        if (v === `<${tag}>`) depth++;
        else if (v === `</${tag}>` && --depth === 0) break;
      }
      if (j < children.length) {
        out.push({ type: nodeType, tag, md: false, children: pairHtml(children.slice(i + 1, j)) });
        i = j;
        continue;
      }
    }
    out.push(n);
  }
  return out;
}

// 上标、下标里不能有空白（和 Pandoc、Typora 一致），这样 "2^10 和 3^5"、"~/a 和 ~/b" 不会被误认。
// 高亮前后不能紧挨着字母数字或等号，这样 "a==1 && b==2" 不会被误认。
const inline = /\^([^\s^[\]]+)\^|~([^\s~]+)~|(?<![\w=])==([^\s=](?:[^=\n]*[^\s=])?)==(?![\w=])/g;

function splitText(n: MdNode): MdNode[] {
  const text = n.value ?? "";
  if (!/[\^~=]/.test(text)) return [n];
  const out: MdNode[] = [];
  let last = 0;
  for (const m of text.matchAll(inline)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    const [tag, value] = m[1] !== undefined ? (["sup", m[1]] as const) : m[2] !== undefined ? (["sub", m[2]] as const) : (["mark", m[3]!] as const);
    out.push({ type: nodeType, tag, md: true, children: [{ type: "text", value }] });
    last = at + m[0].length;
  }
  if (out.length === 0) return [n];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

const skip = new Set(["code", "inlineCode", "math", "inlineMath", "yaml", "definition", "footnoteReference"]);

function transform(node: MdNode) {
  if (!node.children || skip.has(node.type)) return;
  node.children = pairHtml(node.children).flatMap((c) => (c.type === "text" ? splitText(c) : [c]));
  for (const c of node.children) transform(c);
}

const remarkPocketMarks = $remark("remarkPocketMarks", () => () => (tree: unknown) => transform(tree as MdNode));

const schemas = tags.map((tag) =>
  $markSchema(`pocket_${tag}`, () => ({
    attrs: { md: { default: false } },
    // 脚注的角标也是 <sup>，它带 data-type，不归这里管。
    parseDOM: [{ tag: tag === "sup" ? "sup:not([data-type])" : tag }],
    toDOM: () => [tag, { class: `md-${tag}` }, 0],
    parseMarkdown: {
      match: (node) => node.type === nodeType && node.tag === tag,
      runner: (state, node, markType) => {
        state.openMark(markType, { md: !!node.md });
        state.next(node.children);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === `pocket_${tag}`,
      runner: (state, mark) => {
        state.withMark(mark, nodeType, undefined, { tag, md: !!mark.attrs.md });
      },
    },
  })),
);

// 在编辑器里直接打出这些写法时，立刻变成对应的样式。
const rules = tags.flatMap((tag, i) => {
  const schema = schemas[i]!;
  const html = $inputRule((ctx) => markRule(new RegExp(`<${tag}>([^<]+)</${tag}>$`), schema.type(ctx)));
  if (tag === "sup") return [html, $inputRule((ctx) => markRule(/\^([^\s^[\]]+)\^$/, schema.type(ctx), { getAttr: () => ({ md: true }) }))];
  if (tag === "mark") return [html, $inputRule((ctx) => markRule(/(?<![\w=])==([^\s=](?:[^=]*[^\s=])?)==$/, schema.type(ctx), { getAttr: () => ({ md: true }) }))];
  return [html];
});

interface ToMarkdownState {
  containerPhrasing(node: unknown, info: Record<string, unknown>): string;
  createTracker(info: unknown): { move(text: string): string; current(): Record<string, unknown> };
}

/** 写回 Markdown：原来是简写就用简写，否则用 HTML 标签。 */
function stringify(node: MdNode, _parent: unknown, state: ToMarkdownState, info: unknown): string {
  const tag = (node.tag ?? "u") as Tag;
  const short = node.md ? mdSyntax[tag] : undefined;
  const open = short ?? `<${tag}>`;
  const close = short ?? `</${tag}>`;
  const tracker = state.createTracker(info);
  let value = tracker.move(open);
  value += tracker.move(state.containerPhrasing(node, { before: value, after: close, ...tracker.current() }));
  return value + tracker.move(close);
}

export const pocketMarks = [remarkPocketMarks, ...schemas, ...rules].flat();

export function configurePocketMarks(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    // 列表用 - 、分割线用 ---：最常见的写法，别的编辑器打开也不会被改来改去。
    bullet: "-" as const,
    rule: "-" as const,
    handlers: { ...prev.handlers, [nodeType]: stringify as never },
  }));
}
