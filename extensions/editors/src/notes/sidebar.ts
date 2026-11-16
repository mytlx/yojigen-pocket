export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  children?: TreeNode[];
}

export const DEFAULT_SIDEBAR_W = 210;
export const MIN_SIDEBAR_W = 150;
export const MAX_SIDEBAR_W = 380;

export const DEFAULT_OUTLINE_W = 180;
export const MIN_OUTLINE_W = 130;
export const MAX_OUTLINE_W = 360;

export const MIN_EDITOR_W = 260;
export const RESIZER_W = 10;

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)));

/** 根据容器总宽计算文件栏与大纲栏本次渲染的可用宽度，窄窗口时临时压窄但不改写持久化偏好。 */
export function computePanelWidths(params: {
  containerWidth: number;
  sidebarOpen: boolean;
  outlineOpen: boolean;
  sidebarWidth: number;
  outlineWidth: number;
}): { sidebar: number; outline: number } {
  let side = clamp(params.sidebarWidth || DEFAULT_SIDEBAR_W, MIN_SIDEBAR_W, MAX_SIDEBAR_W);
  let outline = clamp(params.outlineWidth || DEFAULT_OUTLINE_W, MIN_OUTLINE_W, MAX_OUTLINE_W);
  if (params.containerWidth <= 0) return { sidebar: side, outline };

  const resizers = (params.sidebarOpen ? RESIZER_W : 0) + (params.outlineOpen ? RESIZER_W : 0);
  const budget = Math.max(0, params.containerWidth - resizers - MIN_EDITOR_W);
  if (params.sidebarOpen && params.outlineOpen) {
    if (side + outline > budget) {
      const ratio = budget > 0 ? budget / (side + outline) : 0;
      const nextSide = Math.max(Math.min(MIN_SIDEBAR_W, Math.floor(params.containerWidth * 0.32)), Math.floor(side * ratio));
      const nextOutline = Math.max(Math.min(MIN_OUTLINE_W, Math.floor(params.containerWidth * 0.28)), budget - nextSide);
      side = Math.min(side, nextSide);
      outline = Math.min(outline, nextOutline);
    }
  } else if (params.sidebarOpen) {
    side = Math.min(side, Math.max(Math.min(MIN_SIDEBAR_W, Math.floor(params.containerWidth * 0.4)), budget));
  } else if (params.outlineOpen) {
    outline = Math.min(outline, Math.max(Math.min(MIN_OUTLINE_W, Math.floor(params.containerWidth * 0.4)), budget));
  }
  return { sidebar: side, outline };
}

/** 拖动单侧分隔条时计算该栏允许的新宽度，保证编辑区至少保留 MIN_EDITOR_W。 */
export function clampDragWidth(params: {
  which: "sidebar" | "outline";
  rawWidth: number;
  containerWidth: number;
  otherWidth: number;
  otherOpen: boolean;
}): number {
  const [minW, maxW] = params.which === "sidebar" ? [MIN_SIDEBAR_W, MAX_SIDEBAR_W] : [MIN_OUTLINE_W, MAX_OUTLINE_W];
  let limit = maxW;
  if (params.containerWidth > 0) {
    const resizers = RESIZER_W + (params.otherOpen ? RESIZER_W : 0);
    const other = params.otherOpen ? params.otherWidth : 0;
    limit = Math.min(maxW, Math.max(minW, params.containerWidth - resizers - MIN_EDITOR_W - other));
  }
  return clamp(params.rawWidth, minW, limit);
}

/** 计算当前文件栏里从上到下可见的条目路径，供 Shift 范围选择使用。 */
export function visibleTreePaths(tree: TreeNode[], open: Record<string, boolean>, matches: TreeNode[] | null): string[] {
  if (matches) return matches.map((n) => n.path);
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.isDir && open[n.path] && n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** 按当前可见列表顺序返回 anchor 到 target 之间的连续路径切片。 */
export function selectRange(visible: string[], anchor: string, target: string): string[] {
  const to = visible.indexOf(target);
  if (to < 0) return [target];
  const from = visible.indexOf(anchor);
  if (from < 0) return [target];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return visible.slice(start, end + 1);
}

/**
 * 归一化待删除路径：去重，并去掉已被选中的祖先文件夹覆盖的子路径，
 * 避免父目录移到废纸篓后子文件报错，也能保持废纸篓里的目录完整。
 */
export function normalizeDeleteTargets(paths: string[]): string[] {
  const unique = Array.from(new Set(paths.filter(Boolean))).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out: string[] = [];
  for (const p of unique) {
    if (!out.some((parent) => p.startsWith(parent + "/"))) out.push(p);
  }
  return out;
}

export interface FileSearchMatcher {
  test: (name: string) => boolean;
  invalid: boolean;
}

/**
 * 编译文件搜索匹配器：
 * - forceRegex 为 true 或形如 /pattern/flags 时按正则表达式匹配；
 * - 包含 * 或 ? 时按通配符（* 匹配任意长度，? 匹配单字符）匹配；
 * - 其余按不区分大小写的子串匹配。
 */
export function compileFileSearch(raw: string, forceRegex: boolean): FileSearchMatcher | null {
  const q = raw.trim();
  if (!q) return null;

  const compileRegex = (pattern: string, flags: string): FileSearchMatcher => {
    try {
      const normalizedFlags = flags.includes("i") ? flags : `${flags}i`;
      const re = new RegExp(pattern, normalizedFlags.replace(/g/g, ""));
      return { test: (name) => re.test(name), invalid: false };
    } catch {
      return { test: () => false, invalid: true };
    }
  };

  if (forceRegex) return compileRegex(q, "i");

  const literalRegex = /^\/(.+)\/([a-z]*)$/i.exec(q);
  if (literalRegex) return compileRegex(literalRegex[1]!, literalRegex[2] ?? "");

  if (/[*?]/.test(q)) {
    const escaped = q
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const re = new RegExp(`^${escaped}$`, "i");
    return { test: (name) => re.test(name), invalid: false };
  }

  const lower = q.toLowerCase();
  return { test: (name) => name.toLowerCase().includes(lower), invalid: false };
}

/** 从选中路径集合中挑出属于文件夹的路径。 */
export function filterDirPaths(tree: TreeNode[], paths: string[]): string[] {
  const dirs = new Set<string>();
  const mark = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (!n.isDir) continue;
      dirs.add(n.path);
      if (n.children) mark(n.children);
    }
  };
  mark(tree);
  return paths.filter((p) => dirs.has(p));
}

/** 收集目标文件夹及其全部嵌套子文件夹路径。 */
export function collectNestedDirs(tree: TreeNode[], roots: string[]): string[] {
  const rootSet = new Set(roots);
  const out: string[] = [];
  const collectSubtree = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (!n.isDir) continue;
      out.push(n.path);
      if (n.children) collectSubtree(n.children);
    }
  };
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (!n.isDir) continue;
      if (rootSet.has(n.path)) {
        out.push(n.path);
        if (n.children) collectSubtree(n.children);
      } else if (n.children) {
        walk(n.children);
      }
    }
  };
  walk(tree);
  return Array.from(new Set(out));
}
