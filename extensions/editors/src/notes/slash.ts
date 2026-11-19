export type SlashItemId =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "quote"
  | "divider"
  | "bullet"
  | "ordered"
  | "task"
  | "time"
  | "code"
  | "table"
  | "math"
  | "image"
  | "footnote"
  | "toc";

export type SlashGroupId = "text" | "list" | "advanced";

export interface SlashCommandItem {
  id: SlashItemId;
  group: SlashGroupId;
  groupLabel: string;
  label: string;
  hint: string;
  keywords: string[];
  markdown?: string;
  richKind?: "code" | "table" | "math" | "image" | "footnote" | "toc";
}

export const SLASH_ITEMS: readonly SlashCommandItem[] = [
  { id: "text", group: "text", groupLabel: "文字", label: "正文", hint: "¶", keywords: ["text", "paragraph", "p", "zhengwen", "正文"], markdown: "" },
  { id: "h1", group: "text", groupLabel: "文字", label: "标题 1", hint: "#", keywords: ["h1", "heading1", "title", "biaoti", "标题"], markdown: "# " },
  { id: "h2", group: "text", groupLabel: "文字", label: "标题 2", hint: "##", keywords: ["h2", "heading2", "biaoti", "标题"], markdown: "## " },
  { id: "h3", group: "text", groupLabel: "文字", label: "标题 3", hint: "###", keywords: ["h3", "heading3", "biaoti", "标题"], markdown: "### " },
  { id: "h4", group: "text", groupLabel: "文字", label: "标题 4", hint: "####", keywords: ["h4", "heading4", "biaoti", "标题"], markdown: "#### " },
  { id: "h5", group: "text", groupLabel: "文字", label: "标题 5", hint: "#####", keywords: ["h5", "heading5", "biaoti", "标题"], markdown: "##### " },
  { id: "h6", group: "text", groupLabel: "文字", label: "标题 6", hint: "######", keywords: ["h6", "heading6", "biaoti", "标题"], markdown: "###### " },
  { id: "quote", group: "text", groupLabel: "文字", label: "引用", hint: ">", keywords: ["quote", "blockquote", "yinyong", "引用"], markdown: "> " },
  { id: "divider", group: "text", groupLabel: "文字", label: "水平分割线", hint: "---", keywords: ["divider", "hr", "line", "fengexian", "分割线"], markdown: "---" },
  { id: "bullet", group: "list", groupLabel: "列表", label: "无序列表", hint: "-", keywords: ["bullet", "ul", "list", "liebiao", "无序列表", "列表"], markdown: "- " },
  { id: "ordered", group: "list", groupLabel: "列表", label: "有序列表", hint: "1.", keywords: ["ordered", "ol", "list", "liebiao", "有序列表", "列表"], markdown: "1. " },
  { id: "task", group: "list", groupLabel: "列表", label: "待办", hint: "- [ ]", keywords: ["task", "todo", "checkbox", "daiban", "待办"], markdown: "- [ ] " },
  { id: "time", group: "advanced", groupLabel: "插入", label: "当前时间", hint: "时间", keywords: ["time", "now", "date", "shijian", "时间", "日期", "当前时间"] },
  { id: "code", group: "advanced", groupLabel: "插入", label: "代码块", hint: "```", keywords: ["code", "codeblock", "daima", "代码块"], richKind: "code" },
  { id: "table", group: "advanced", groupLabel: "插入", label: "表格", hint: "| |", keywords: ["table", "biaoge", "表格"], richKind: "table" },
  { id: "math", group: "advanced", groupLabel: "插入", label: "公式块", hint: "$$", keywords: ["math", "latex", "formula", "gongshi", "公式"], richKind: "math" },
  { id: "image", group: "advanced", groupLabel: "插入", label: "图像", hint: "![]", keywords: ["image", "img", "pic", "photo", "tupian", "tuxiang", "图像", "图片"], richKind: "image" },
  { id: "footnote", group: "advanced", groupLabel: "插入", label: "脚注", hint: "[^1]", keywords: ["footnote", "fn", "jiaozhu", "脚注"], richKind: "footnote" },
  { id: "toc", group: "advanced", groupLabel: "插入", label: "内容目录", hint: "[TOC]", keywords: ["toc", "outline", "mulu", "目录", "内容目录"], richKind: "toc" },
];

export const CLOCK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

const LINE_SLASH_RE = /(?:^|\n)(\/([^\s\n/]*))$/;

/** 仅当当前行首出现 `/` 时触发斜线菜单，避免 URL（https://）或路径（a/b）误触发。 */
export function matchBlockSlash(text: string, cursor: number): { from: number; query: string } | null {
  const before = text.slice(0, Math.max(0, cursor));
  const m = LINE_SLASH_RE.exec(before);
  if (!m) return null;
  return {
    from: before.length - m[1]!.length,
    query: m[2] ?? "",
  };
}

export function filterSlashItems(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.some((kw) => kw.toLowerCase().includes(q)),
  );
}
