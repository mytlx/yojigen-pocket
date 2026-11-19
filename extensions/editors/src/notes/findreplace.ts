import { StateEffect, StateField } from "@codemirror/state";
import { Decoration as CMDecoration, type DecorationSet as CMDecorationSet, EditorView as CMView } from "@codemirror/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration as PMDecoration, DecorationSet as PMDecorationSet, type EditorView as PMView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

export interface FindQuery {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindStats {
  total: number;
  /** 1-based 当前选中命中序号，无命中时为 0 */
  current: number;
  error?: string;
}

export interface TextMatchRange {
  from: number;
  to: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 编译统一查找正则（供实时/阅读/整块与源码模式共用，保证匹配与计数语义完全一致）。 */
export function compileFindRegex(q: FindQuery): { re: RegExp | null; error?: string } {
  if (!q.query) return { re: null };
  let pattern = q.regex ? q.query : escapeRegex(q.query);
  if (q.wholeWord) {
    pattern = `\\b(?:${pattern})\\b`;
  }
  const flags = q.caseSensitive ? "gu" : "giu";
  try {
    return { re: new RegExp(pattern, flags) };
  } catch (e) {
    return { re: null, error: (e as Error).message || "正则表达式无效" };
  }
}

export function findTextRanges(text: string, q: FindQuery, limit = 5000): { matches: TextMatchRange[]; error?: string } {
  const { re, error } = compileFindRegex(q);
  if (error) return { matches: [], error };
  if (!re || !text) return { matches: [] };
  const matches: TextMatchRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (end > start) {
      matches.push({ from: start, to: end });
      if (matches.length >= limit) break;
    } else {
      re.lastIndex++;
    }
  }
  return { matches };
}

/** 结合正则分组展开替换文本（正则模式支持 $1 / $&，普通模式按字面替换）。 */
export function expandReplacement(matched: string, q: FindQuery, replacement: string): string {
  if (!q.regex) return replacement;
  const { re } = compileFindRegex(q);
  if (!re) return replacement;
  const single = new RegExp(re.source, q.caseSensitive ? "u" : "iu");
  return matched.replace(single, replacement);
}

// =============================================================================
// 1) ProseMirror（阅读 / 实时 / 整块）查找与替换插件
// =============================================================================

interface RichFindState {
  query: FindQuery;
  matches: TextMatchRange[];
  activeIndex: number; // 0-based, -1 if empty
  error?: string;
}

const EMPTY_QUERY: FindQuery = { query: "", caseSensitive: false, wholeWord: false, regex: false };

const richFindKey = new PluginKey<RichFindState>("pocket-rich-find");

/** 在 ProseMirror 文档每个文本块中收集跨 inline 节点（如加粗/高亮/链接）的连续文本命中区间。 */
function collectProseMatches(doc: PMNode, q: FindQuery): { matches: TextMatchRange[]; error?: string } {
  const { re, error } = compileFindRegex(q);
  if (error) return { matches: [], error };
  if (!re) return { matches: [] };

  const matches: TextMatchRange[] = [];
  doc.descendants((node, pos) => {
    if (matches.length >= 5000) return false;
    if (!node.isTextblock) return true;

    let fullText = "";
    const segs: { textFrom: number; textTo: number; docFrom: number }[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        const start = fullText.length;
        fullText += child.text;
        segs.push({ textFrom: start, textTo: fullText.length, docFrom: pos + 1 + offset });
      } else {
        // 用不可见占位符隔开内联原子节点（如换行、行内公式），防止错误跨节点匹配
        fullText += "\uFFFC";
      }
    });
    if (!fullText) return false;

    const toDocPos = (textOffset: number, isEnd: boolean): number | null => {
      for (const seg of segs) {
        if (isEnd ? textOffset > seg.textFrom && textOffset <= seg.textTo : textOffset >= seg.textFrom && textOffset < seg.textTo) {
          return seg.docFrom + (textOffset - seg.textFrom);
        }
      }
      return null;
    };

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fullText)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const docFrom = toDocPos(m.index, false);
      const docTo = toDocPos(m.index + m[0].length, true);
      if (docFrom !== null && docTo !== null && docTo > docFrom) {
        matches.push({ from: docFrom, to: docTo });
        if (matches.length >= 5000) break;
      }
    }
    return false;
  });
  return { matches };
}

function buildRichFindDecos(doc: PMNode, st: RichFindState): PMDecorationSet {
  if (st.matches.length === 0) return PMDecorationSet.empty;
  const decos = st.matches.map((m, idx) =>
    PMDecoration.inline(m.from, m.to, {
      class: idx === st.activeIndex ? "pocket-find-match is-current" : "pocket-find-match",
    }),
  );
  return PMDecorationSet.create(doc, decos);
}

function pickNearestMatchIndex(matches: readonly TextMatchRange[], cursorPos: number): number {
  if (matches.length === 0) return -1;
  const idx = matches.findIndex((m) => m.to >= cursorPos);
  return idx >= 0 ? idx : 0;
}

function scrollRichPosToCenter(view: PMView, pos: number) {
  const scroller = view.dom.closest(".fx-notes-rich");
  if (!(scroller instanceof HTMLElement)) return;
  try {
    const coords = view.coordsAtPos(pos);
    const sr = scroller.getBoundingClientRect();
    const margin = 44;
    if (coords.top >= sr.top + margin && coords.bottom <= sr.bottom - margin) return;
    const desired = scroller.scrollTop + (coords.top - sr.top) - sr.height * 0.38;
    scroller.scrollTo({ top: Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, desired)), behavior: "auto" });
  } catch {
    /* 忽略不可见块坐标读取失败 */
  }
}

export const richFindPlugin = $prose(
  () =>
    new Plugin<RichFindState>({
      key: richFindKey,
      state: {
        init: () => ({ query: EMPTY_QUERY, matches: [], activeIndex: -1 }),
        apply(tr, prev, _oldState, newState) {
          const meta = tr.getMeta(richFindKey) as { query?: FindQuery; activeIndex?: number } | undefined;
          if (meta) {
            const nextQuery = meta.query ?? prev.query;
            const recalc = meta.query !== undefined || tr.docChanged;
            const { matches, error } = recalc ? collectProseMatches(newState.doc, nextQuery) : { matches: prev.matches, error: prev.error };
            let nextIdx = meta.activeIndex !== undefined ? meta.activeIndex : prev.activeIndex;
            if (matches.length === 0) nextIdx = -1;
            else if (meta.activeIndex === undefined && meta.query !== undefined) {
              nextIdx = pickNearestMatchIndex(matches, newState.selection.from);
            } else {
              nextIdx = ((nextIdx % matches.length) + matches.length) % matches.length;
            }
            return { query: nextQuery, matches, activeIndex: nextIdx, error };
          }
          if (tr.docChanged && prev.query.query) {
            const { matches, error } = collectProseMatches(newState.doc, prev.query);
            const activeIndex = matches.length === 0 ? -1 : Math.min(Math.max(0, prev.activeIndex), matches.length - 1);
            return { query: prev.query, matches, activeIndex, error };
          }
          return prev;
        },
      },
      props: {
        decorations(state) {
          const st = richFindKey.getState(state);
          if (!st || st.matches.length === 0) return null;
          return buildRichFindDecos(state.doc, st);
        },
      },
    }),
);

export function getRichFindStats(view: PMView | null): FindStats {
  if (!view || view.isDestroyed) return { total: 0, current: 0 };
  const st = richFindKey.getState(view.state);
  if (!st) return { total: 0, current: 0 };
  return {
    total: st.matches.length,
    current: st.activeIndex >= 0 ? st.activeIndex + 1 : 0,
    error: st.error,
  };
}

export function setRichFindQuery(view: PMView | null, query: FindQuery, scroll = true): FindStats {
  if (!view || view.isDestroyed) return { total: 0, current: 0 };
  view.dispatch(view.state.tr.setMeta(richFindKey, { query }));
  const st = richFindKey.getState(view.state);
  if (scroll && st && st.activeIndex >= 0 && st.matches[st.activeIndex]) {
    scrollRichPosToCenter(view, st.matches[st.activeIndex]!.from);
  }
  return getRichFindStats(view);
}

export function stepRichFind(view: PMView | null, dir: 1 | -1): FindStats {
  if (!view || view.isDestroyed) return { total: 0, current: 0 };
  const st = richFindKey.getState(view.state);
  if (!st || st.matches.length === 0) return getRichFindStats(view);
  const nextIdx = (st.activeIndex + dir + st.matches.length) % st.matches.length;
  const hit = st.matches[nextIdx]!;
  const tr = view.state.tr.setMeta(richFindKey, { activeIndex: nextIdx });
  if (view.editable) {
    tr.setSelection(TextSelection.create(view.state.doc, hit.from, hit.to)).setMeta("pocket-selection", true);
  }
  view.dispatch(tr);
  scrollRichPosToCenter(view, hit.from);
  return getRichFindStats(view);
}

export function replaceCurrentRich(view: PMView | null, replacement: string): FindStats {
  if (!view || view.isDestroyed || !view.editable) return getRichFindStats(view);
  const st = richFindKey.getState(view.state);
  if (!st || st.matches.length === 0 || st.activeIndex < 0) return getRichFindStats(view);
  const hit = st.matches[st.activeIndex]!;
  const matchedText = view.state.doc.textBetween(hit.from, hit.to);
  const nextText = expandReplacement(matchedText, st.query, replacement);
  const tr = view.state.tr.insertText(nextText, hit.from, hit.to);
  tr.setSelection(TextSelection.create(tr.doc, hit.from + nextText.length));
  view.dispatch(tr.scrollIntoView());
  // 自动跳到下一处（保留 activeIndex，它现在天然指向后续那一项）
  const after = richFindKey.getState(view.state);
  if (after && after.activeIndex >= 0 && after.matches[after.activeIndex]) {
    scrollRichPosToCenter(view, after.matches[after.activeIndex]!.from);
  }
  return getRichFindStats(view);
}

export function replaceAllRich(view: PMView | null, replacement: string): { count: number; stats: FindStats } {
  if (!view || view.isDestroyed || !view.editable) return { count: 0, stats: getRichFindStats(view) };
  const st = richFindKey.getState(view.state);
  if (!st || st.matches.length === 0) return { count: 0, stats: getRichFindStats(view) };
  const tr = view.state.tr;
  // 倒序替换，保证前面位置不偏移且合并为一次可撤销事务
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const hit = st.matches[i]!;
    const matchedText = view.state.doc.textBetween(hit.from, hit.to);
    const nextText = expandReplacement(matchedText, st.query, replacement);
    tr.insertText(nextText, hit.from, hit.to);
  }
  view.dispatch(tr);
  return { count: st.matches.length, stats: getRichFindStats(view) };
}

// =============================================================================
// 2) CodeMirror（源码模式）查找与替换扩展
// =============================================================================

interface CodeFindState {
  query: FindQuery;
  matches: TextMatchRange[];
  activeIndex: number;
  error?: string;
}

const codeFindEffect = StateEffect.define<{ query?: FindQuery; activeIndex?: number }>();
const cmMatchMark = CMDecoration.mark({ class: "cm-searchMatch" });
const cmActiveMark = CMDecoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });

const codeFindField = StateField.define<CodeFindState>({
  create: () => ({ query: EMPTY_QUERY, matches: [], activeIndex: -1 }),
  update(prev, tr) {
    let query = prev.query;
    let activeOverride: number | undefined;
    let queryChanged = false;
    for (const eff of tr.effects) {
      if (eff.is(codeFindEffect)) {
        if (eff.value.query !== undefined) {
          query = eff.value.query;
          queryChanged = true;
        }
        if (eff.value.activeIndex !== undefined) {
          activeOverride = eff.value.activeIndex;
        }
      }
    }
    if (!queryChanged && activeOverride === undefined && !tr.docChanged) return prev;
    if (!query.query) return { query, matches: [], activeIndex: -1 };
    const { matches, error } = queryChanged || tr.docChanged ? findTextRanges(tr.state.doc.toString(), query) : { matches: prev.matches, error: prev.error };
    let activeIndex = activeOverride !== undefined ? activeOverride : prev.activeIndex;
    if (matches.length === 0) activeIndex = -1;
    else if (activeOverride === undefined && queryChanged) {
      activeIndex = pickNearestMatchIndex(matches, tr.state.selection.main.from);
    } else {
      activeIndex = ((activeIndex % matches.length) + matches.length) % matches.length;
    }
    return { query, matches, activeIndex, error };
  },
  provide: (field) =>
    CMView.decorations.from(field, (st): CMDecorationSet => {
      if (st.matches.length === 0) return CMDecoration.none;
      return CMDecoration.set(
        st.matches.map((m, i) => (i === st.activeIndex ? cmActiveMark : cmMatchMark).range(m.from, m.to)),
        true,
      );
    }),
});

export const codeFindExtension = [codeFindField];

export function getCodeFindStats(view: CMView | null): FindStats {
  if (!view) return { total: 0, current: 0 };
  const st = view.state.field(codeFindField, false);
  if (!st) return { total: 0, current: 0 };
  return {
    total: st.matches.length,
    current: st.activeIndex >= 0 ? st.activeIndex + 1 : 0,
    error: st.error,
  };
}

export function setCodeFindQuery(view: CMView | null, query: FindQuery, scroll = true): FindStats {
  if (!view) return { total: 0, current: 0 };
  view.dispatch({ effects: codeFindEffect.of({ query }) });
  const st = view.state.field(codeFindField, false);
  if (scroll && st && st.activeIndex >= 0 && st.matches[st.activeIndex]) {
    const hit = st.matches[st.activeIndex]!;
    view.dispatch({ effects: CMView.scrollIntoView(hit.from, { y: "center" }) });
  }
  return getCodeFindStats(view);
}

export function stepCodeFind(view: CMView | null, dir: 1 | -1): FindStats {
  if (!view) return { total: 0, current: 0 };
  const st = view.state.field(codeFindField, false);
  if (!st || st.matches.length === 0) return getCodeFindStats(view);
  const nextIdx = (st.activeIndex + dir + st.matches.length) % st.matches.length;
  const hit = st.matches[nextIdx]!;
  view.dispatch({
    selection: { anchor: hit.from, head: hit.to },
    effects: [codeFindEffect.of({ activeIndex: nextIdx }), CMView.scrollIntoView(hit.from, { y: "center" })],
  });
  return getCodeFindStats(view);
}

export function replaceCurrentCode(view: CMView | null, replacement: string): FindStats {
  if (!view) return { total: 0, current: 0 };
  const st = view.state.field(codeFindField, false);
  if (!st || st.matches.length === 0 || st.activeIndex < 0) return getCodeFindStats(view);
  const hit = st.matches[st.activeIndex]!;
  const matchedText = view.state.sliceDoc(hit.from, hit.to);
  const nextText = expandReplacement(matchedText, st.query, replacement);
  view.dispatch({
    changes: { from: hit.from, to: hit.to, insert: nextText },
    selection: { anchor: hit.from + nextText.length },
    effects: CMView.scrollIntoView(hit.from + nextText.length, { y: "center" }),
  });
  const after = view.state.field(codeFindField, false);
  if (after && after.activeIndex >= 0 && after.matches[after.activeIndex]) {
    view.dispatch({ effects: CMView.scrollIntoView(after.matches[after.activeIndex]!.from, { y: "center" }) });
  }
  return getCodeFindStats(view);
}

export function replaceAllCode(view: CMView | null, replacement: string): { count: number; stats: FindStats } {
  if (!view) return { count: 0, stats: { total: 0, current: 0 } };
  const st = view.state.field(codeFindField, false);
  if (!st || st.matches.length === 0) return { count: 0, stats: getCodeFindStats(view) };
  const changes = st.matches.map((hit) => ({
    from: hit.from,
    to: hit.to,
    insert: expandReplacement(view.state.sliceDoc(hit.from, hit.to), st.query, replacement),
  }));
  view.dispatch({ changes });
  return { count: st.matches.length, stats: getCodeFindStats(view) };
}
