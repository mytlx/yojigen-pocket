import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
/** 笔记快捷键同时用于源码、块源码和富文本，避免两种模式行为不一致。 */
export interface NoteShortcuts { above: string; below: string }
export const defaultShortcuts: NoteShortcuts = { above: "Ctrl+Alt+Enter", below: "Ctrl+Shift+Enter" };

export function shortcutOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  if (["Control", "Meta", "Alt", "Shift", "Dead", "Process"].includes(e.key)) return "";
  return [...(e.ctrlKey ? ["Ctrl"] : []), ...(e.metaKey ? ["Meta"] : []), ...(e.altKey ? ["Alt"] : []), ...(e.shiftKey ? ["Shift"] : []), e.key.length === 1 ? e.key.toUpperCase() : e.key].join("+");
}
export function lineAction(e: KeyboardEvent, keys: NoteShortcuts): "above" | "below" | null {
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

export function noteLineKeys(keys: () => NoteShortcuts) {
  return Prec.highest(EditorView.domEventHandlers({ keydown(event, view) {
    const direction = lineAction(event, keys());
    if (!direction) return false;
    const change = insertLine(view.state.doc.toString(), view.state.selection.main.head, direction);
    view.dispatch({ changes: { from: change.from, insert: change.insert }, selection: { anchor: change.anchor }, scrollIntoView: true });
    event.preventDefault();
    return true;
  } }));
}
