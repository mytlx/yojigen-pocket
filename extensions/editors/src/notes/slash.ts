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
  | "math";

export type SlashGroupId = "text" | "list" | "advanced";

export interface SlashCommandItem {
  id: SlashItemId;
  group: SlashGroupId;
  groupLabel: string;
  label: string;
  keywords: string[];
  markdown?: string;
  richKind?: "code" | "table" | "math";
}

export const SLASH_ITEMS: readonly SlashCommandItem[] = [
  { id: "text", group: "text", groupLabel: "文字", label: "正文", keywords: ["text", "paragraph", "p", "zhengwen", "正文"], markdown: "" },
  { id: "h1", group: "text", groupLabel: "文字", label: "标题 1", keywords: ["h1", "heading1", "title", "biaoti", "标题"], markdown: "# " },
  { id: "h2", group: "text", groupLabel: "文字", label: "标题 2", keywords: ["h2", "heading2", "biaoti", "标题"], markdown: "## " },
  { id: "h3", group: "text", groupLabel: "文字", label: "标题 3", keywords: ["h3", "heading3", "biaoti", "标题"], markdown: "### " },
  { id: "h4", group: "text", groupLabel: "文字", label: "标题 4", keywords: ["h4", "heading4", "biaoti", "标题"], markdown: "#### " },
  { id: "h5", group: "text", groupLabel: "文字", label: "标题 5", keywords: ["h5", "heading5", "biaoti", "标题"], markdown: "##### " },
  { id: "h6", group: "text", groupLabel: "文字", label: "标题 6", keywords: ["h6", "heading6", "biaoti", "标题"], markdown: "###### " },
  { id: "quote", group: "text", groupLabel: "文字", label: "引用", keywords: ["quote", "blockquote", "yinyong", "引用"], markdown: "> " },
  { id: "divider", group: "text", groupLabel: "文字", label: "分割线", keywords: ["divider", "hr", "line", "fengexian", "分割线"], markdown: "---" },
  { id: "bullet", group: "list", groupLabel: "列表", label: "无序列表", keywords: ["bullet", "ul", "list", "liebiao", "无序列表", "列表"], markdown: "- " },
  { id: "ordered", group: "list", groupLabel: "列表", label: "有序列表", keywords: ["ordered", "ol", "list", "liebiao", "有序列表", "列表"], markdown: "1. " },
  { id: "task", group: "list", groupLabel: "列表", label: "待办", keywords: ["task", "todo", "checkbox", "daiban", "待办"], markdown: "- [ ] " },
  { id: "time", group: "advanced", groupLabel: "更多", label: "当前时间", keywords: ["time", "now", "date", "shijian", "时间", "日期", "当前时间"] },
  { id: "code", group: "advanced", groupLabel: "更多", label: "代码块", keywords: ["code", "codeblock", "daima", "代码块"], richKind: "code" },
  { id: "table", group: "advanced", groupLabel: "更多", label: "表格", keywords: ["table", "biaoge", "表格"], richKind: "table" },
  { id: "math", group: "advanced", groupLabel: "更多", label: "公式", keywords: ["math", "latex", "formula", "gongshi", "公式"], richKind: "math" },
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
