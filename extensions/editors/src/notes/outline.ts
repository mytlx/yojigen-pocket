import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type { Nodes } from "mdast";
export interface OutlineHeading { level: number; text: string; from: number }
export interface OutlineNode { heading: OutlineHeading; index: number; children: OutlineNode[] }
/** 用 Markdown 语法树排除代码块中的 #，支持 ATX 和 Setext 标题。 */
export function outlineOf(text: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const doc = fromMarkdown(text, { extensions: [gfmStrikethrough()], mdastExtensions: [gfmStrikethroughFromMarkdown()] });
  function collect(node: Nodes) {
    if (node.type === "heading") {
      headings.push({ level: node.depth, text: toString(node, { includeHtml: false }), from: node.position!.start.offset! });
    } else if ("children" in node) {
      node.children.forEach(collect);
    }
  }
  collect(doc);
  return headings;
}

/** 按标题级别组装大纲树，保留每个标题在原扁平列表中的 index。 */
export function outlineTree(headings: OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  headings.forEach((heading, index) => {
    const node: OutlineNode = { heading, index, children: [] };
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
