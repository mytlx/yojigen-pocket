import { markdownLanguage } from "@codemirror/lang-markdown";
export interface OutlineHeading { level: number; text: string; from: number }
export interface OutlineNode { heading: OutlineHeading; index: number; children: OutlineNode[] }
/** 用 Markdown 语法树排除代码块中的 #，支持 ATX 和 Setext 标题。 */
export function outlineOf(text: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  markdownLanguage.parser.parse(text).iterate({ enter(node) {
    const m = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!m) return;
    const raw = text.slice(node.from, node.to);
    const label = raw.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").replace(/\n[ \t]*[=-]+[ \t]*$/, "");
    headings.push({ level: Number(m[1]), text: label, from: node.from });
  } });
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
