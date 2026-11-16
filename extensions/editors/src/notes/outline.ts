import { markdownLanguage } from "@codemirror/lang-markdown";
export interface OutlineHeading { level: number; text: string; from: number }
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
