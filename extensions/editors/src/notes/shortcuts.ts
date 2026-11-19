import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";

/**
 * 笔记快捷键（对齐 Typora 常用习惯；刻意不包含 Ctrl+0 / Ctrl+= / Ctrl+- 以避免与缩放冲突）。
 * 同时作用于实时模式、整块模式与源码模式。
 */
export interface NoteShortcuts {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  h5: string;
  h6: string;
  codeBlock: string;
  mathBlock: string;
  quote: string;
  orderedList: string;
  bulletList: string;
  taskList: string;
  indent: string;
  outdent: string;
  above: string;
  below: string;
  find: string;
  replace: string;
}

export type ShortcutActionId = keyof NoteShortcuts;

export const defaultShortcuts: NoteShortcuts = {
  h1: "Ctrl+1",
  h2: "Ctrl+2",
  h3: "Ctrl+3",
  h4: "Ctrl+4",
  h5: "Ctrl+5",
  h6: "Ctrl+6",
  codeBlock: "Ctrl+Shift+K",
  mathBlock: "Ctrl+Shift+M",
  quote: "Ctrl+Shift+Q",
  orderedList: "Ctrl+Shift+[",
  bulletList: "Ctrl+Shift+]",
  taskList: "Ctrl+Shift+X",
  indent: "Ctrl+]",
  outdent: "Ctrl+[",
  above: "Ctrl+Alt+Enter",
  below: "Ctrl+Shift+Enter",
  find: "Ctrl+F",
  replace: "Ctrl+H",
};

export interface ShortcutMeta {
  id: ShortcutActionId;
  label: string;
  group: "heading" | "block" | "list" | "edit";
}

export const SHORTCUT_GROUPS: readonly { id: ShortcutMeta["group"]; label: string }[] = [
  { id: "heading", label: "标题" },
  { id: "block", label: "块级元素" },
  { id: "list", label: "列表与缩进" },
  { id: "edit", label: "行操作与查找" },
];

export const SHORTCUT_ITEMS: readonly ShortcutMeta[] = [
  { id: "h1", label: "一级标题", group: "heading" },
  { id: "h2", label: "二级标题", group: "heading" },
  { id: "h3", label: "三级标题", group: "heading" },
  { id: "h4", label: "四级标题", group: "heading" },
  { id: "h5", label: "五级标题", group: "heading" },
  { id: "h6", label: "六级标题", group: "heading" },
  { id: "codeBlock", label: "代码块", group: "block" },
  { id: "mathBlock", label: "公式块", group: "block" },
  { id: "quote", label: "引用", group: "block" },
  { id: "orderedList", label: "有序列表", group: "list" },
  { id: "bulletList", label: "无序列表", group: "list" },
  { id: "taskList", label: "任务列表", group: "list" },
  { id: "indent", label: "增加缩进", group: "list" },
  { id: "outdent", label: "减少缩进", group: "list" },
  { id: "above", label: "在上方插入新行 / 段落", group: "edit" },
  { id: "below", label: "在下方插入新行 / 段落", group: "edit" },
  { id: "find", label: "查找", group: "edit" },
  { id: "replace", label: "查找并替换", group: "edit" },
];

export function normalizeShortcuts(saved: Partial<NoteShortcuts> | undefined | null): NoteShortcuts {
  const out: NoteShortcuts = { ...defaultShortcuts };
  if (!saved || typeof saved !== "object") return out;
  for (const key of Object.keys(defaultShortcuts) as ShortcutActionId[]) {
    const val = saved[key];
    if (typeof val === "string") out[key] = val.trim();
  }
  return out;
}

/** 检测哪些快捷键存在重复绑定，返回冲突项 ID 集合。 */
export function findShortcutConflicts(shortcuts: NoteShortcuts): Set<ShortcutActionId> {
  const map = new Map<string, ShortcutActionId[]>();
  for (const id of Object.keys(defaultShortcuts) as ShortcutActionId[]) {
    const k = shortcuts[id].trim();
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(id);
    map.set(k, list);
  }
  const conflicts = new Set<ShortcutActionId>();
  for (const ids of map.values()) {
    if (ids.length > 1) ids.forEach((id) => conflicts.add(id));
  }
  return conflicts;
}

const CODE_KEY_MAP: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

function normalizeEventKey(e: Pick<KeyboardEvent, "key" | "shiftKey"> & { code?: string }): string {
  if (["Control", "Meta", "Alt", "Shift", "Dead", "Process"].includes(e.key)) return "";
  // 按下 Shift+[ / Shift+] / Shift+数字 时浏览器会报 `{` / `}` / `!`，按物理键还原为 `[` / `]` / `1` 才能稳定匹配 Ctrl+Shift+[ 等快捷键。
  if (e.code) {
    if (e.code in CODE_KEY_MAP) return CODE_KEY_MAP[e.code]!;
    if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  }
  if (e.shiftKey) {
    if (e.key === "{") return "[";
    if (e.key === "}") return "]";
  }
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export function shortcutOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { code?: string }): string {
  const key = normalizeEventKey(e);
  if (!key) return "";
  return [
    ...(e.ctrlKey ? ["Ctrl"] : []),
    ...(e.metaKey ? ["Meta"] : []),
    ...(e.altKey ? ["Alt"] : []),
    ...(e.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
}

/** 匹配任意已配置的笔记快捷键动作（支持 macOS ⌘ 与 Ctrl 互认）。 */
export function matchShortcutAction(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"> & { code?: string },
  keys: NoteShortcuts,
  platform?: string,
): ShortcutActionId | null {
  if (e.isComposing) return null;
  const pressed = shortcutOf(e);
  if (!pressed) return null;
  const macAlt = platform === "darwin" && e.metaKey && !e.ctrlKey ? shortcutOf({ ...e, ctrlKey: true, metaKey: false }) : "";

  for (const id of Object.keys(defaultShortcuts) as ShortcutActionId[]) {
    const binding = keys[id]?.trim();
    if (!binding) continue;
    if (pressed === binding || (macAlt && macAlt === binding)) return id;
  }
  return null;
}

/** 兼容旧调用：判断当前按键是否为“上方/下方插行”。 */
export function lineAction(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"> & { code?: string },
  keys: Pick<NoteShortcuts, "above" | "below">,
): "above" | "below" | null {
  if (e.isComposing) return null;
  const key = shortcutOf(e);
  return key === keys.above ? "above" : key === keys.below ? "below" : null;
}

export function insertLine(text: string, cursor: number, direction: "above" | "below") {
  const start = cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
  const end = text.indexOf("\n", cursor);
  const at = direction === "above" ? start : end < 0 ? text.length : end;
  const indent = /^[\t ]*/.exec(text.slice(start))![0];
  const insert = direction === "above" ? indent + "\n" : "\n" + indent;
  return { from: at, insert, anchor: at + (direction === "above" ? indent.length : insert.length) };
}

/** 源码/块源码里批量增加或减少所选行缩进（2 空格或 1 Tab）。 */
export function applySourceIndent(text: string, from: number, to: number, dir: "indent" | "outdent"): { from: number; to: number; insert: string; anchor: number; head: number } {
  const lineStart = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  const endIdx = text.indexOf("\n", to);
  const lineEnd = endIdx < 0 ? text.length : endIdx;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, i) => {
    if (dir === "indent") {
      if (i === 0) firstDelta = 2;
      totalDelta += 2;
      return `  ${line}`;
    }
    const m = /^(\t| {1,2})/.exec(line);
    const rm = m ? m[1]!.length : 0;
    if (i === 0) firstDelta = -rm;
    totalDelta -= rm;
    return line.slice(rm);
  });
  const insert = nextLines.join("\n");
  return {
    from: lineStart,
    to: lineEnd,
    insert,
    anchor: Math.max(lineStart, from + firstDelta),
    head: Math.max(lineStart, to + totalDelta),
  };
}

/**
 * CodeMirror 快捷键扩展：
 * - 若传入 onAction，则把全部自定义笔记快捷键交由外部统一执行（标题、块、缩进、查找/替换、插行）；
 * - 否则仅处理上方/下方插行（供代码块内部 CodeMirror 复用）。
 */
export function noteLineKeys(
  keys: () => NoteShortcuts,
  opts?: { platform?: string; onAction?: (action: ShortcutActionId, view: EditorView) => boolean },
) {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (opts?.onAction) {
          const act = matchShortcutAction(event, keys(), opts.platform);
          if (act && opts.onAction(act, view)) {
            event.preventDefault();
            return true;
          }
          return false;
        }
        const direction = lineAction(event, keys());
        if (!direction) return false;
        const change = insertLine(view.state.doc.toString(), view.state.selection.main.head, direction);
        view.dispatch({ changes: { from: change.from, insert: change.insert }, selection: { anchor: change.anchor }, scrollIntoView: true });
        event.preventDefault();
        return true;
      },
    }),
  );
}
