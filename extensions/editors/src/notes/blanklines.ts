import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose, $remark } from "@milkdown/kit/utils";

interface MdPos {
  start: { line: number };
  end: { line: number };
}

export interface MdBlankNode {
  type: string;
  children?: MdBlankNode[];
  position?: MdPos;
}

const isEmptyMdPara = (n?: MdBlankNode) => n?.type === "paragraph" && (!n.children || n.children.length === 0);
const isEmptyPmPara = (n: PMNode | null | undefined) => !!n && n.type.name === "paragraph" && n.content.size === 0;

/**
 * 解析期把源码中的首部、块间以及末尾多余空行还原为空段落节点，
 * 使阅读模式与源码之间切换 1:1 保留用户显式写出的空行。
 */
export function applyBlankLinesToAst(node: MdBlankNode, rawSource?: string) {
  if (!node.children) return;
  if (node.children.length === 0) {
    if (node.type === "root" && typeof rawSource === "string" && rawSource.length > 0 && /^[ \t\r\n]*$/.test(rawSource)) {
      const eols = rawSource.match(/\r?\n/g)?.length ?? 0;
      if (eols > 0) {
        for (let k = 0; k <= eols; k++) node.children.push({ type: "paragraph", children: [] });
      }
    }
    return;
  }

  for (const c of node.children) {
    if (c.type === "blockquote" || c.type === "listItem" || c.type === "pocketHtmlBlock") {
      applyBlankLinesToAst(c);
    }
  }
  if (node.type !== "root" && node.type !== "blockquote" && node.type !== "pocketHtmlBlock") return;

  const expanded: MdBlankNode[] = [];
  if (node.type === "root") {
    const first = node.children[0]!;
    const leadLines = first.position?.start?.line ? first.position.start.line - 1 : 0;
    for (let k = 0; k < leadLines; k++) expanded.push({ type: "paragraph", children: [] });
  }

  for (let i = 0; i < node.children.length; i++) {
    const cur = node.children[i]!;
    if (i > 0) {
      const prev = node.children[i - 1]!;
      if (prev.position && cur.position) {
        const extra = cur.position.start.line - prev.position.end.line - 2;
        for (let k = 0; k < extra; k++) expanded.push({ type: "paragraph", children: [] });
      }
    }
    expanded.push(cur);
  }

  // 还原文档末尾显式多出的空行（超过常规单个结尾换行符的部分）。
  if (node.type === "root" && typeof rawSource === "string") {
    const last = expanded[expanded.length - 1];
    if (last?.position?.end?.line) {
      const tailLines = rawSource.split(/\r?\n/).slice(last.position.end.line);
      if (tailLines.length > 0 && tailLines.every((l) => /^[ \t]*$/.test(l))) {
        const extraTail = tailLines[tailLines.length - 1] === "" ? Math.max(0, tailLines.length - 1) : tailLines.length;
        for (let k = 0; k < extraTail; k++) expanded.push({ type: "paragraph", children: [] });
      }
    } else if (last) {
      const trailing = /(?:[ \t]*\r?\n)+[ \t]*$/.exec(rawSource)?.[0];
      if (trailing) {
        const eols = trailing.match(/\r?\n/g)?.length ?? 0;
        for (let k = 0; k < Math.max(0, eols - 1); k++) expanded.push({ type: "paragraph", children: [] });
      }
    }
  }

  node.children = expanded;
}

export const remarkBlankLines = $remark("remarkBlankLines", () => () => (tree: unknown, file: { value?: unknown }) => {
  const src = typeof file?.value === "string" ? file.value : undefined;
  applyBlankLinesToAst(tree as MdBlankNode, src);
});

const blankLinesKey = new PluginKey<boolean>("pocket-blanklines-trailing");

/** 区分 @milkdown/plugin-trailing 自动补出的尾随光标段落与用户/源文件自带的末尾空行。 */
export const blankLinesPlugin = $prose(
  () =>
    new Plugin<boolean>({
      key: blankLinesKey,
      state: {
        init: () => false,
        apply(tr, prev, oldState, newState) {
          const last = newState.doc.lastChild;
          if (!isEmptyPmPara(last)) return false;
          const lastStart = newState.doc.content.size - last!.nodeSize;
          if (!tr.docChanged) return prev;

          const oldLast = oldState.doc.lastChild;
          const oldWasNonParaOrHead = !!oldLast && oldLast.type.name !== "paragraph" && oldLast.type.name !== "heading";
          if (!prev && oldWasNonParaOrHead && newState.doc.childCount === oldState.doc.childCount + 1 && newState.selection.to <= lastStart) {
            return true;
          }
          if (prev && newState.doc.childCount === oldState.doc.childCount && newState.selection.to <= lastStart) {
            return true;
          }
          return false;
        },
      },
    }),
);

/**
 * 配置序列化时的段落连接间距：空段落不再使用 <br /> 占位，
 * 而是在源码中直接输出对应数量的真实空行（类 Typora，1:1 无损往返）。
 */
export function configureBlankLines(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    join: [
      ...(prev.join ?? []),
      (left: unknown, right: unknown, parent: unknown) => {
        const l = left as MdBlankNode;
        const r = right as MdBlankNode;
        const p = parent as MdBlankNode;
        if (isEmptyMdPara(l)) return 0;
        if (p?.type === "root" && Array.isArray(p.children) && isEmptyMdPara(r)) {
          const idx = p.children.indexOf(r);
          if (idx >= 0 && p.children.slice(idx).every(isEmptyMdPara)) return 0;
        }
        return undefined;
      },
    ],
  }));
}

/** 根据 ProseMirror 文档首尾空段落还原完整的首尾换行符，弥补 mdast-util-to-markdown 吞掉首尾空字符串的问题。 */
export function restoreBlankLinesOnMarkdown(doc: PMNode, md: string, state?: EditorState): string {
  const count = doc.childCount;
  let leadingEmpty = 0;
  while (leadingEmpty < count && isEmptyPmPara(doc.child(leadingEmpty))) leadingEmpty++;

  const syntheticTrailing = !!(state && blankLinesKey.getState(state));
  if (leadingEmpty === count) {
    const effective = syntheticTrailing ? Math.max(1, count - 1) : count;
    return effective <= 1 ? "" : "\n".repeat(effective - 1);
  }

  let trailingEmpty = 0;
  while (trailingEmpty < count && isEmptyPmPara(doc.child(count - 1 - trailingEmpty))) trailingEmpty++;
  if (syntheticTrailing && trailingEmpty > 0) trailingEmpty--;

  const core = md.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
  return `${"\n".repeat(leadingEmpty)}${core}${"\n".repeat(1 + trailingEmpty)}`;
}
