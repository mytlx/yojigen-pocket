import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { undo, redo } from "@milkdown/kit/prose/history";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { insertLine, lineAction, type NoteShortcuts } from "./shortcuts";

interface Editing { from: number; to: number; source: string; cursor: number; id: number }
const key = new PluginKey<Editing | null>("pocket-block-source");
let sequence = 0;

// 把渲染文本里的点击位置映射到序列化后的标记之间，避免每次点击都跳到块末尾。
function sourceCursor(node: PMNode, offset: number, source: string): number {
  let scan = 0;
  let cursor = source.length;
  let found = false;
  node.descendants((child, pos) => {
    if (found || !child.isText || !child.text) return !found;
    const at = source.indexOf(child.text, scan);
    if (at < 0) return;
    if (offset <= pos + child.text.length) {
      cursor = at + Math.max(0, offset - pos);
      found = true;
    }
    scan = at + child.text.length;
  });
  return cursor;
}

/** 活动块展示可编辑的真实 Markdown；每次输入同步进文档，离开后恢复渲染。 */
export function blockSourcePlugin(options: () => { enabled: boolean; shortcuts: NoteShortcuts }) {
  return $prose((ctx) => new Plugin<Editing | null>({
    key,
    state: {
      init: () => null,
      apply(tr, active) {
        const next = tr.getMeta(key) as Editing | null | undefined;
        if (next !== undefined) return next;
        // 撤销、外部编辑时关闭源码块，让文档成为唯一事实来源。
        return tr.docChanged ? null : active;
      },
    },
    props: {
      handleClick(view, pos, event) {
        if (!options().enabled || event.ctrlKey || event.metaKey || (event.target as Element | null)?.closest(".pocket-block-source")) return false;
        const $pos = view.state.doc.resolve(pos);
        if (!$pos.depth) return false;
        const node = $pos.node(1);
        if (!["paragraph", "heading", "blockquote", "bullet_list", "ordered_list"].includes(node.type.name)) return false;
        const from = $pos.before(1);
        const source = ctx.get(serializerCtx)(view.state.schema.topNodeType.create(null, node)).replace(/\n$/, "");
        view.dispatch(view.state.tr.setMeta(key, { from, to: from + node.nodeSize, source, cursor: sourceCursor(node, pos - from - 1, source), id: ++sequence }));
        return true;
      },
      decorations(state) {
        const active = key.getState(state);
        if (!active) return null;
        const hidden: Decoration[] = [];
        state.doc.nodesBetween(active.from, active.to, (node, pos) => {
          if (pos >= active.from && pos + node.nodeSize <= active.to && node.isBlock) {
            hidden.push(Decoration.node(pos, pos + node.nodeSize, { style: "display:none" }));
            return false;
          }
          return true;
        });
        hidden.push(Decoration.widget(active.from, (view) => {
          const area = document.createElement("textarea");
          area.className = "pocket-block-source";
          area.setAttribute("aria-label", "当前块 Markdown 源码");
          area.value = active.source;
          area.spellcheck = false;
          const size = () => { area.style.height = "0"; area.style.height = `${Math.max(44, area.scrollHeight)}px`; };
          const update = () => {
            const current = key.getState(view.state);
            if (!current || current.id !== active.id) return;
            const parsed = ctx.get(parserCtx)(area.value || "\n");
            if (!parsed) return;
            const replacement = parsed.content.size ? parsed.content : view.state.schema.nodes.paragraph!.create();
            const tr = view.state.tr.replaceWith(current.from, current.to, replacement);
            const to = current.to + tr.doc.content.size - view.state.doc.content.size;
            tr.setMeta(key, { ...current, to, source: area.value });
            view.dispatch(tr);
            size();
          };
          area.addEventListener("input", update);
          area.addEventListener("keydown", (e) => {
            e.stopPropagation();
            const direction = lineAction(e, options().shortcuts);
            if (direction) {
              e.preventDefault();
              const edit = insertLine(area.value, area.selectionStart, direction);
              area.setRangeText(edit.insert, edit.from, edit.from, "end");
              area.setSelectionRange(edit.anchor, edit.anchor);
              update();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.isComposing) {
              e.preventDefault();
              (e.shiftKey ? redo : undo)(view.state, view.dispatch);
              view.focus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              area.blur();
              view.focus();
            }
          });
          area.addEventListener("blur", () => {
            if (key.getState(view.state)?.id === active.id) view.dispatch(view.state.tr.setMeta(key, null));
          });
          requestAnimationFrame(() => { if (area.isConnected) { size(); area.focus(); area.setSelectionRange(active.cursor, active.cursor); } });
          return area;
        }, { key: `source-${active.id}`, side: -1, stopEvent: () => true, ignoreSelection: true }));
        return DecorationSet.create(state.doc, hidden);
      },
      handleKeyDown(view, event) {
        const direction = lineAction(event, options().shortcuts);
        if (!direction) return false;
        const { $from } = view.state.selection;
        if (!$from.depth) return false;
        // 插入独立空段落，不切断当前块。
        const at = direction === "above" ? $from.before(1) : $from.after(1);
        const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph!.create());
        tr.setSelection(TextSelection.create(tr.doc, at + 1));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  }));
}
