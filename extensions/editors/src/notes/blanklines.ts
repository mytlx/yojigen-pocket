import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { $remark } from "@milkdown/kit/utils";

interface MdPos {
  start: { line: number };
  end: { line: number };
}

export interface MdBlankNode {
  type: string;
  children?: MdBlankNode[];
  position?: MdPos;
}

const isEmptyPara = (n?: MdBlankNode) => n?.type === "paragraph" && (!n.children || n.children.length === 0);

/**
 * 解析期把源码中相邻块之间的多余空行（以及文档末尾多余空行）还原为空段落节点，
 * 使阅读模式与源码之间切换不会丢失用户手动敲出的空行。
 */
export function applyBlankLinesToAst(node: MdBlankNode, rawSource?: string) {
  if (!node.children || node.children.length === 0) return;
  for (const c of node.children) {
    if (c.type === "blockquote" || c.type === "listItem") applyBlankLinesToAst(c);
  }
  if (node.type !== "root" && node.type !== "blockquote") return;

  const expanded: MdBlankNode[] = [];
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

  // 还原文档末尾显式多出的空行（超过常规单个结尾换行符的空行）。
  if (node.type === "root" && typeof rawSource === "string") {
    const trailing = /(\r?\n)+$/.exec(rawSource)?.[0];
    if (trailing) {
      const eols = trailing.match(/\r?\n/g)?.length ?? 0;
      const last = expanded[expanded.length - 1];
      // 若原文档已有内容且末尾存在多余空行，补对应数量的空段落。
      if (last && eols > 1) {
        for (let k = 0; k < eols - 1; k++) expanded.push({ type: "paragraph", children: [] });
      }
    }
  }

  node.children = expanded;
}

export const remarkBlankLines = $remark("remarkBlankLines", () => () => (tree: unknown, file: { value?: unknown }) => {
  const src = typeof file?.value === "string" ? file.value : undefined;
  applyBlankLinesToAst(tree as MdBlankNode, src);
});

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
        if (isEmptyPara(l)) return 0;
        if (p?.type === "root" && Array.isArray(p.children) && isEmptyPara(r)) {
          const idx = p.children.indexOf(r);
          if (idx >= 0 && p.children.slice(idx).every(isEmptyPara)) return 0;
        }
        return undefined;
      },
    ],
  }));
}
