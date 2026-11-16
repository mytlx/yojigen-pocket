import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { redo, undo } from "@milkdown/kit/prose/history";
import { joinBackward, lift } from "@milkdown/kit/prose/commands";
import type { Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { liftListItem, splitListItem } from "@milkdown/kit/prose/schema-list";
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { insertLine, lineAction, type NoteShortcuts } from "./shortcuts";

interface Editing {
  from: number;
  to: number;
  source: string;
  cursor: number;
  id: number;
}

interface BlockTarget {
  from: number;
  to: number;
  node: PMNode;
  depth: number;
}

const key = new PluginKey<Editing | null>("pocket-block-source");
const BLOCK_EDITABLE = new Set(["paragraph", "heading"]);
const EXCLUDED_ANCESTORS = new Set(["table", "table_row", "table_cell", "table_header", "code_block"]);
let sequence = 0;

function clampPos(doc: PMNode, pos: number): number {
  return Math.max(0, Math.min(pos, doc.content.size));
}

/** 向上查找离 pos 最近的独立文本块（段落或标题），不把整棵列表或引用包进来；表格和代码块除外。 */
function findBlockTarget(doc: PMNode, pos: number): BlockTarget | null {
  const $pos = doc.resolve(clampPos(doc, pos));
  for (let d = $pos.depth; d >= 1; d--) {
    if (EXCLUDED_ANCESTORS.has($pos.node(d).type.name)) return null;
  }
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (BLOCK_EDITABLE.has(node.type.name)) {
      const from = $pos.before(d);
      return { from, to: from + node.nodeSize, node, depth: d };
    }
  }
  return null;
}

/** 向上查找最近的特定祖先节点深度（例如 list_item 或 blockquote）。 */
function ancestorDepth($pos: ResolvedPos, name: string): number {
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === name) return d;
  }
  return -1;
}

// 把渲染文本里的点击/光标偏移映射到序列化后的 Markdown 源码位置。
function sourceCursor(node: PMNode, offset: number, source: string): number {
  const headingPrefix = node.type.name === "heading" ? (node.attrs.level as number) + 1 : 0;
  if (node.content.size === 0) return Math.min(source.length, headingPrefix);
  let scan = Math.min(source.length, headingPrefix);
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
  return Math.min(source.length, cursor);
}

/** 测量多行文本框当前光标是否处于视觉首行或末行（兼容自动折行）。 */
function caretEdge(area: HTMLTextAreaElement): { firstLine: boolean; lastLine: boolean; colOffset: number } {
  const sel = area.selectionStart;
  const val = area.value;
  if (!val) return { firstLine: true, lastLine: true, colOffset: 0 };

  const cs = getComputedStyle(area);
  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  mirror.style.width = `${area.clientWidth}px`;
  mirror.style.boxSizing = "border-box";
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.paddingTop = cs.paddingTop;
  mirror.style.paddingBottom = cs.paddingBottom;
  mirror.style.font = cs.font;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = cs.wordBreak;
  mirror.style.overflowWrap = cs.overflowWrap;

  const startMark = document.createElement("span");
  startMark.textContent = "\u200b";
  const caretMark = document.createElement("span");
  caretMark.textContent = "\u200b";
  const endMark = document.createElement("span");
  endMark.textContent = "\u200b";

  mirror.append(startMark, document.createTextNode(val.slice(0, sel)), caretMark, document.createTextNode(val.slice(sel)), endMark);
  document.body.appendChild(mirror);
  try {
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    const firstTop = startMark.offsetTop;
    const caretTop = caretMark.offsetTop;
    const lastTop = endMark.offsetTop;
    const lineStart = val.lastIndexOf("\n", sel - 1) + 1;
    return {
      firstLine: caretTop - firstTop < lh * 0.5,
      lastLine: lastTop - caretTop < lh * 0.5,
      colOffset: sel - lineStart,
    };
  } finally {
    mirror.remove();
  }
}

/** 查找相邻块的可达选区，支持跨入代码块、表格或分割线而不会跳过。 */
function adjacentSelection(doc: PMNode, from: number, to: number, dir: -1 | 1): Selection | null {
  const edge = clampPos(doc, dir === -1 ? from : to);
  return Selection.findFrom(doc.resolve(edge), dir);
}

/** 光标所在块实时展示紧凑的 Markdown 源码（类 Typora）；离开或按 Esc 恢复渲染。 */
export function blockSourcePlugin(options: () => { enabled: boolean; shortcuts: NoteShortcuts }) {
  return $prose((ctx) => {
    let dismissedFrom: number | null = null;
    let pointerDown = false;

    const serializeBlock = (state: EditorState, node: PMNode): string =>
      ctx.get(serializerCtx)(state.schema.topNodeType.create(null, node)).replace(/\n$/, "");

    const buildEditing = (state: EditorState, target: BlockTarget, cursorOffset?: number): Editing => {
      const source = serializeBlock(state, target.node);
      const cursor = cursorOffset !== undefined ? Math.max(0, Math.min(cursorOffset, source.length)) : sourceCursor(target.node, 0, source);
      return { from: target.from, to: target.to, source, cursor, id: ++sequence };
    };

    const activateAtSelection = (view: EditorView, pos: number, force = false): boolean => {
      if (!options().enabled) return false;
      const target = findBlockTarget(view.state.doc, pos);
      if (!target) {
        if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, null));
        return false;
      }
      if (!force && dismissedFrom === target.from) return false;
      const source = serializeBlock(view.state, target.node);
      const cursor = sourceCursor(target.node, Math.max(0, pos - target.from - 1), source);
      const cur = key.getState(view.state);
      if (cur && cur.from === target.from && cur.to === target.to && (!force || cur.cursor === cursor)) return true;
      dismissedFrom = null;
      view.dispatch(view.state.tr.setMeta(key, { from: target.from, to: target.to, source, cursor, id: ++sequence }));
      return true;
    };

    const findInnerEditable = (doc: PMNode, from: number, spanEnd: number): BlockTarget | null => {
      let inner: BlockTarget | null = null;
      doc.nodesBetween(clampPos(doc, from), clampPos(doc, spanEnd), (node, pos) => {
        if (inner || EXCLUDED_ANCESTORS.has(node.type.name)) return false;
        if (BLOCK_EDITABLE.has(node.type.name)) {
          inner = { from: pos, to: pos + node.nodeSize, node, depth: doc.resolve(pos + 1).depth };
          return false;
        }
        return true;
      });
      return inner;
    };

    return new Plugin<Editing | null>({
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
      view: () => ({
        update(view) {
          const area = view.dom.querySelector<HTMLTextAreaElement>(".pocket-block-source");
          const areaHasFocus = area !== null && document.activeElement === area;
          if (!options().enabled) {
            if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, null));
            return;
          }
          if (areaHasFocus) return;
          const { selection } = view.state;
          if (!(selection instanceof TextSelection) || !selection.empty) {
            if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, null));
            return;
          }
          const target = findBlockTarget(view.state.doc, selection.$from.pos);
          if (dismissedFrom !== null && target?.from !== dismissedFrom) dismissedFrom = null;
          if (!pointerDown && view.hasFocus() && !key.getState(view.state)) {
            activateAtSelection(view, selection.$from.pos);
          }
        },
      }),
      props: {
        handleDOMEvents: {
          mousedown() {
            pointerDown = true;
            window.addEventListener("mouseup", () => { pointerDown = false; }, { once: true });
            return false;
          },
          focus(view) {
            if (!options().enabled || pointerDown) return false;
            const { selection } = view.state;
            if (selection instanceof TextSelection && selection.empty && !key.getState(view.state)) {
              activateAtSelection(view, selection.$from.pos);
            }
            return false;
          },
          blur(view, event) {
            const next = event.relatedTarget as Node | null;
            if (next && view.dom.contains(next)) return false;
            if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, null));
            return false;
          },
        },
        handleClick(view, pos, event) {
          if (!options().enabled || event.ctrlKey || event.metaKey) return false;
          const el = event.target as Element | null;
          if (el?.closest(".pocket-block-source") || el?.closest(".label-wrapper")) return false;
          return activateAtSelection(view, pos, true);
        },
        decorations(state) {
          const active = key.getState(state);
          if (!active) return null;
          const targetNode = state.doc.nodeAt(active.from);
          const hidden: Decoration[] = [Decoration.node(active.from, active.to, { style: "display:none" })];
          hidden.push(
            Decoration.widget(
              active.from,
              (view) => {
                const area = document.createElement("textarea");
                area.className = "pocket-block-source";
                area.rows = 1;
                area.setAttribute("aria-label", "当前块 Markdown 源码");
                if (targetNode?.type.name === "heading") {
                  area.dataset.headingLevel = String(targetNode.attrs.level ?? 1);
                }
                area.value = active.source;
                area.spellcheck = false;

                const size = () => {
                  area.style.height = "0";
                  area.style.height = `${area.scrollHeight}px`;
                };

                const parseBlocks = (md: string): PMNode[] => {
                  const parsed = ctx.get(parserCtx)(md || "\n");
                  if (parsed?.content.size) {
                    return Array.from({ length: parsed.content.childCount }, (_, i) => parsed.content.child(i));
                  }
                  return [view.state.schema.nodes.paragraph!.create()];
                };

                const syncContent = (text: string) => {
                  const current = key.getState(view.state);
                  if (!current || current.id !== active.id) return false;
                  const replacement = parseBlocks(text);
                  const tr = view.state.tr.replaceWith(current.from, current.to, replacement);
                  const delta = tr.doc.content.size - view.state.doc.content.size;
                  const nextTo = current.to + delta;
                  const first = replacement[0];

                  // 在普通段落里敲 "- " / "1. " / "> " 等容器语法时，实时转成对应容器并追踪其内部文本块（类 Typora）。
                  const $start = tr.doc.resolve(clampPos(tr.doc, current.from + 1));
                  if ($start.depth === 1 && first && !BLOCK_EDITABLE.has(first.type.name) && replacement.length === 1) {
                    const inner = findInnerEditable(tr.doc, current.from, nextTo);
                    if (inner && ["bullet_list", "ordered_list", "blockquote"].includes(first.type.name)) {
                      const nextSource = serializeBlock(view.state, inner.node);
                      const nextEditing: Editing = { from: inner.from, to: inner.to, source: nextSource, cursor: nextSource.length, id: ++sequence };
                      tr.setSelection(TextSelection.create(tr.doc, clampPos(tr.doc, inner.from + 1 + inner.node.content.size)));
                      tr.setMeta(key, nextEditing);
                      view.dispatch(tr);
                      return true;
                    }
                    tr.setSelection(Selection.near(tr.doc.resolve(clampPos(tr.doc, current.from + 1))));
                    tr.setMeta(key, null);
                    view.dispatch(tr);
                    view.focus();
                    return true;
                  }

                  tr.setMeta(key, { ...current, to: nextTo, source: text });
                  view.dispatch(tr);
                  size();
                  return true;
                };

                const moveToAdjacent = (dir: -1 | 1, colOffset?: number) => {
                  const current = key.getState(view.state);
                  if (!current || current.id !== active.id) return false;
                  const nextSel = adjacentSelection(view.state.doc, current.from, current.to, dir);
                  if (!nextSel) return false;
                  dismissedFrom = null;
                  const next = findBlockTarget(view.state.doc, nextSel.$from.pos);
                  if (next && next.from !== current.from) {
                    const source = serializeBlock(view.state, next.node);
                    let cursor = dir === 1 ? 0 : source.length;
                    if (colOffset !== undefined) {
                      if (dir === 1) {
                        const firstEnd = source.indexOf("\n");
                        cursor = Math.min(firstEnd < 0 ? source.length : firstEnd, colOffset);
                      } else {
                        const lineStart = source.lastIndexOf("\n") + 1;
                        cursor = Math.min(source.length, lineStart + colOffset);
                      }
                    }
                    const editing: Editing = { from: next.from, to: next.to, source, cursor, id: ++sequence };
                    view.dispatch(view.state.tr.setSelection(nextSel).setMeta(key, editing).scrollIntoView());
                    return true;
                  }
                  view.dispatch(view.state.tr.setSelection(nextSel).setMeta(key, null).scrollIntoView());
                  view.focus();
                  return true;
                };

                const handleEnterSplit = () => {
                  const current = key.getState(view.state);
                  if (!current || current.id !== active.id) return;
                  const before = area.value.slice(0, area.selectionStart);
                  const after = area.value.slice(area.selectionEnd);
                  const curNode = view.state.doc.nodeAt(current.from);
                  const $cur = view.state.doc.resolve(clampPos(view.state.doc, current.from + 1));
                  const listDepth = ancestorDepth($cur, "list_item");
                  const quoteDepth = ancestorDepth($cur, "blockquote");
                  const schema = view.state.schema;

                  // 1) 在列表项内部按 Enter：空列表项退回正文，否则新建下一条列表项（Typora 逻辑）。
                  if (listDepth > 0 && current.from === $cur.before(listDepth) + 1) {
                    const listItemType = schema.nodes.list_item!;
                    if (!area.value.trim()) {
                      dismissedFrom = null;
                      view.dispatch(
                        view.state.tr
                          .replaceWith(current.from, current.to, schema.nodes.paragraph!.create())
                          .setSelection(TextSelection.create(view.state.doc, current.from + 1))
                          .setMeta(key, null),
                      );
                      liftListItem(listItemType)(view.state, view.dispatch);
                      const target = findBlockTarget(view.state.doc, view.state.selection.$from.pos);
                      if (target) view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, target, 0)));
                      else view.focus();
                      return;
                    }

                    const rawBefore = before ? parseBlocks(before)[0]! : schema.nodes.paragraph!.create();
                    const beforePara = rawBefore.type.name === "paragraph" ? rawBefore : schema.nodes.paragraph!.create(null, rawBefore.content);
                    const tr1 = view.state.tr.replaceWith(current.from, current.to, beforePara);
                    const splitAt = current.from + 1 + beforePara.content.size;
                    tr1.setSelection(TextSelection.create(tr1.doc, splitAt)).setMeta(key, null);
                    view.dispatch(tr1);
                    if (splitListItem(listItemType)(view.state, view.dispatch)) {
                      const newPos = view.state.selection.$from.pos;
                      const newTarget = findBlockTarget(view.state.doc, newPos);
                      if (newTarget) {
                        if (after) {
                          const rawAfter = parseBlocks(after)[0]!;
                          const afterPara = rawAfter.type.name === "paragraph" ? rawAfter : schema.nodes.paragraph!.create(null, rawAfter.content);
                          const tr2 = view.state.tr.replaceWith(newTarget.from, newTarget.to, afterPara);
                          const created = tr2.doc.nodeAt(newTarget.from);
                          if (created) {
                            const editing = buildEditing(view.state, { from: newTarget.from, to: newTarget.from + created.nodeSize, node: created, depth: newTarget.depth }, 0);
                            tr2.setSelection(TextSelection.create(tr2.doc, newTarget.from + 1)).setMeta(key, editing);
                            view.dispatch(tr2.scrollIntoView());
                            return;
                          }
                        }
                        view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, newTarget, 0)).scrollIntoView());
                        return;
                      }
                    }
                    view.focus();
                    return;
                  }

                  // 2) 在引用块空段落按 Enter：直接跳出引用块变成正文段落。
                  if (quoteDepth > 0 && !area.value.trim()) {
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from + 1)).setMeta(key, null));
                    if (lift(view.state, view.dispatch)) {
                      const target = findBlockTarget(view.state.doc, view.state.selection.$from.pos);
                      if (target) {
                        view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, target, 0)).scrollIntoView());
                        return;
                      }
                    }
                  }

                  // 3) 段落 / 标题 / 非空引用段按 Enter：拆分成两个独立块，绝不写入 <br />。
                  const beforeNodes = before ? parseBlocks(before) : [schema.nodes.paragraph!.create()];
                  const afterNodes = after ? parseBlocks(after) : [schema.nodes.paragraph!.create()];
                  // 标题中间断开时，若后半段未显式以 # 开头，默认降为正文段落（Typora 逻辑）。
                  if (curNode?.type.name === "heading" && after && !/^\s{0,3}#{1,6}(?:\s|$)/.test(after) && afterNodes[0]?.isTextblock) {
                    afterNodes[0] = schema.nodes.paragraph!.create(null, afterNodes[0].content);
                  }

                  const beforeSize = beforeNodes.reduce((sum, n) => sum + n.nodeSize, 0);
                  const tr = view.state.tr.replaceWith(current.from, current.to, [...beforeNodes, ...afterNodes]);
                  const nextFrom = current.from + beforeSize;
                  const created = tr.doc.nodeAt(nextFrom);
                  if (created && BLOCK_EDITABLE.has(created.type.name)) {
                    const nextTarget: BlockTarget = { from: nextFrom, to: nextFrom + created.nodeSize, node: created, depth: $cur.depth };
                    const nextEditing: Editing = { from: nextTarget.from, to: nextTarget.to, source: after, cursor: 0, id: ++sequence };
                    tr.setSelection(TextSelection.create(tr.doc, clampPos(tr.doc, nextTarget.from + 1))).setMeta(key, nextEditing);
                    view.dispatch(tr.scrollIntoView());
                    return;
                  }
                  tr.setMeta(key, null);
                  view.dispatch(tr.scrollIntoView());
                  view.focus();
                };

                const handleBackspaceAtStart = (): boolean => {
                  const current = key.getState(view.state);
                  if (!current || current.id !== active.id) return false;
                  const $cur = view.state.doc.resolve(clampPos(view.state.doc, current.from + 1));
                  const listDepth = ancestorDepth($cur, "list_item");
                  if (listDepth > 0 && current.from === $cur.before(listDepth) + 1) {
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from + 1)).setMeta(key, null));
                    if (liftListItem(view.state.schema.nodes.list_item!)(view.state, view.dispatch)) {
                      const target = findBlockTarget(view.state.doc, view.state.selection.$from.pos);
                      if (target) view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, target, 0)));
                      return true;
                    }
                  }
                  const quoteDepth = ancestorDepth($cur, "blockquote");
                  if (quoteDepth > 0 && current.from === $cur.before(quoteDepth) + 1) {
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from + 1)).setMeta(key, null));
                    if (lift(view.state, view.dispatch)) {
                      const target = findBlockTarget(view.state.doc, view.state.selection.$from.pos);
                      if (target) view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, target, 0)));
                      return true;
                    }
                  }
                  const prevSel = adjacentSelection(view.state.doc, current.from, current.to, -1);
                  const prev = prevSel ? findBlockTarget(view.state.doc, prevSel.$from.pos) : null;
                  const prevLen = prev ? serializeBlock(view.state, prev.node).length : 0;
                  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from + 1)).setMeta(key, null));
                  if (joinBackward(view.state, view.dispatch)) {
                    const target = findBlockTarget(view.state.doc, view.state.selection.$from.pos);
                    if (target) view.dispatch(view.state.tr.setMeta(key, buildEditing(view.state, target, prevLen)));
                    return true;
                  }
                  return false;
                };

                area.addEventListener("input", () => void syncContent(area.value));
                area.addEventListener("keydown", (e) => {
                  e.stopPropagation();
                  const direction = lineAction(e, options().shortcuts);
                  if (direction) {
                    e.preventDefault();
                    const edit = insertLine(area.value, area.selectionStart, direction);
                    area.setRangeText(edit.insert, edit.from, edit.from, "end");
                    area.setSelectionRange(edit.anchor, edit.anchor);
                    syncContent(area.value);
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.isComposing) {
                    e.preventDefault();
                    dismissedFrom = active.from;
                    (e.shiftKey ? redo : undo)(view.state, view.dispatch);
                    view.focus();
                    return;
                  }
                  if (e.key === "Escape" && !e.isComposing) {
                    e.preventDefault();
                    dismissedFrom = active.from;
                    area.blur();
                    view.focus();
                    return;
                  }
                  if (e.isComposing) return;

                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    if (e.shiftKey) {
                      area.setRangeText("\\\n", area.selectionStart, area.selectionEnd, "end");
                      syncContent(area.value);
                    } else {
                      handleEnterSplit();
                    }
                    return;
                  }
                  if (e.key === "Backspace" && area.selectionStart === 0 && area.selectionEnd === 0) {
                    if (handleBackspaceAtStart()) e.preventDefault();
                    return;
                  }
                  if (e.key === "ArrowLeft" && area.selectionStart === 0 && area.selectionEnd === 0) {
                    if (moveToAdjacent(-1)) e.preventDefault();
                    return;
                  }
                  if (e.key === "ArrowRight" && area.selectionStart === area.value.length && area.selectionEnd === area.value.length) {
                    if (moveToAdjacent(1, 0)) e.preventDefault();
                    return;
                  }
                  if (e.key === "ArrowUp" && area.selectionStart === area.selectionEnd) {
                    const edge = caretEdge(area);
                    if (edge.firstLine && moveToAdjacent(-1, edge.colOffset)) e.preventDefault();
                    return;
                  }
                  if (e.key === "ArrowDown" && area.selectionStart === area.selectionEnd) {
                    const edge = caretEdge(area);
                    if (edge.lastLine && moveToAdjacent(1, edge.colOffset)) e.preventDefault();
                  }
                });

                area.addEventListener("blur", () => {
                  if (key.getState(view.state)?.id === active.id) view.dispatch(view.state.tr.setMeta(key, null));
                });

                requestAnimationFrame(() => {
                  if (area.isConnected) {
                    size();
                    area.focus();
                    area.setSelectionRange(active.cursor, active.cursor);
                  }
                });
                return area;
              },
              { key: `source-${active.id}`, side: -1, stopEvent: () => true, ignoreSelection: true },
            ),
          );
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
    });
  });
}
