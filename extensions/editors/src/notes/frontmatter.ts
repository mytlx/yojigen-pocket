/**
 * 文档开头的 frontmatter（--- 包起来的 YAML）。
 *
 * 所见即所得的编辑器不认识它：会把第一条 --- 当成分割线、把最后一行属性当成标题，保存时文件就被改坏了。
 * 所以打开时把它摘出来单独放着，编辑器只看正文，保存时再原样拼回去。
 */
export interface Split {
  /** frontmatter 的内容（不含两条 ---）；没有时是 null。 */
  front: string | null;
  body: string;
  header?: string;
}

const re = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(md: string): Split {
  const m = re.exec(md);
  if (!m) return { front: null, body: md };
  const front = m[1] ?? "";
  // 开头是分割线、后面又有一条分割线的普通文档不算：第一行得像一个 YAML 键（或注释）。
  const first = front.split(/\r?\n/).find((l) => l.trim() !== "");
  if (first !== undefined && !/^(#|[^\s:#][^:]*:(\s|$))/.test(first)) return { front: null, body: md };
  return { front, body: md.slice(m[0].length), header: m[0] };
}

export function joinFrontmatter(front: string | null, body: string, original?: Split): string {
  if (front === null) return body;
  if (original?.front === front && original.header) return original.header + (body && !original.header.endsWith("\n") ? "\n" : "") + body;
  return `---\n${front.replace(/\s+$/, "")}${front.trim() ? "\n" : ""}---\n${body}`;
}

/** 给折叠着的属性块用的一行摘要：列出键名。 */
export function frontSummary(front: string): string {
  const keys = front
    .split(/\r?\n/)
    .map((l) => /^([^\s:#][^:]*):/.exec(l)?.[1]?.trim())
    .filter((k): k is string => !!k);
  if (keys.length === 0) return "空";
  return keys.length > 5 ? `${keys.slice(0, 5).join("、")} 等 ${keys.length} 项` : keys.join("、");
}
