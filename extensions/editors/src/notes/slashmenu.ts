import { serializerCtx } from "@milkdown/kit/core";
import { createTable } from "@milkdown/kit/preset/gfm";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { nextFootnoteIndex, turnInto, type BlockKind } from "./blockops";
import { filterSlashItems, matchBlockSlash, type SlashCommandItem, type SlashItemId } from "./slash";
import { formatTime } from "./timefmt";

export interface SlashAnchor {
  left: number;
  top: number;
  bottom: number;
}

const ITEM_ICON_SVG: Partial<Record<SlashItemId, string>> = {
  text: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/></svg>',
  h1: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/></svg>',
  h2: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/></svg>',
  h3: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/></svg>',
  h4: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 10v4h4"/><path d="M21 10v8"/></svg>',
  h5: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 13v-3h4"/><path d="M17 17.7c.4.2.8.3 1.3.3 1.5 0 2.7-1.1 2.7-2.5S19.8 13 18.3 13H17"/></svg>',
  h6: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><circle cx="19" cy="16" r="2"/><path d="M20 10c-2 2-3 3.5-3 6"/></svg>',
  quote: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>',
  divider: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  bullet: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/></svg>',
  ordered: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>',
  task: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  time: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  table: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>',
  math: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 7V4H6l6 8-6 8h12v-3"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  footnote: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 14V5h5a3 3 0 0 1 0 6H7"/><path d="M17 5h2v7"/></svg>',
  toc: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h12"/><path d="M3 18h16"/></svg>',
};

/** 实时模式与整块模式共用的统一 `/` 斜线菜单浮窗控制器。 */
export class SlashPopupController {
  private el: HTMLDivElement | null = null;
  private items: SlashCommandItem[] = [];
  private activeIdx = 0;
  private onChoose: ((item: SlashCommandItem) => void) | null = null;
  private onOutside = (e: MouseEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) this.close();
  };

  isOpen(): boolean {
    return this.el !== null && this.items.length > 0;
  }

  open(items: SlashCommandItem[], anchor: SlashAnchor, onChoose: (item: SlashCommandItem) => void) {
    if (items.length === 0) {
      this.close();
      return;
    }
    this.items = items;
    this.onChoose = onChoose;
    if (this.activeIdx >= items.length) this.activeIdx = 0;

    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "fx-menu pocket-block-slash";
      this.el.setAttribute("role", "listbox");
      document.body.appendChild(this.el);
      document.addEventListener("mousedown", this.onOutside, true);
    }

    this.render();
    this.position(anchor);
  }

  close() {
    if (this.el) {
      this.el.remove();
      this.el = null;
      document.removeEventListener("mousedown", this.onOutside, true);
    }
    this.items = [];
    this.activeIdx = 0;
    this.onChoose = null;
  }

  move(dir: -1 | 1) {
    if (!this.isOpen()) return;
    this.activeIdx = (this.activeIdx + dir + this.items.length) % this.items.length;
    this.syncActiveClass();
  }

  selectCurrent(): boolean {
    if (!this.isOpen()) return false;
    const item = this.items[this.activeIdx];
    const cb = this.onChoose;
    this.close();
    if (item && cb) cb(item);
    return true;
  }

  private render() {
    if (!this.el) return;
    this.el.replaceChildren();
    let lastGroup = "";
    this.items.forEach((item, idx) => {
      if (item.groupLabel !== lastGroup) {
        lastGroup = item.groupLabel;
        const grp = document.createElement("div");
        grp.className = "fx-menu-label";
        grp.textContent = item.groupLabel;
        this.el!.appendChild(grp);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `fx-menu-item${idx === this.activeIdx ? " is-active" : ""}`;

      const iconSvg = ITEM_ICON_SVG[item.id];
      if (iconSvg) {
        const iconWrap = document.createElement("span");
        iconWrap.className = "pocket-slash-icon";
        iconWrap.innerHTML = iconSvg;
        btn.appendChild(iconWrap);
      }

      const label = document.createElement("span");
      label.textContent = item.label;
      const hint = document.createElement("kbd");
      hint.className = "fx-menu-kbd";
      hint.textContent = item.hint;
      btn.append(label, hint);

      btn.addEventListener("mouseenter", () => {
        if (this.activeIdx === idx) return;
        this.activeIdx = idx;
        this.syncActiveClass();
      });
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cb = this.onChoose;
        this.close();
        cb?.(item);
      });
      this.el!.appendChild(btn);
    });
    this.syncActiveClass();
  }

  private syncActiveClass() {
    if (!this.el) return;
    this.el.querySelectorAll(".fx-menu-item").forEach((el, i) => {
      el.classList.toggle("is-active", i === this.activeIdx);
    });
    const activeBtn = this.el.querySelector<HTMLElement>(".fx-menu-item.is-active");
    activeBtn?.scrollIntoView({ block: "nearest" });
  }

  private position(anchor: SlashAnchor) {
    if (!this.el) return;
    const rect = this.el.getBoundingClientRect();
    const left = Math.max(6, Math.min(anchor.left, window.innerWidth - rect.width - 6));
    const spaceBelow = window.innerHeight - anchor.bottom - 8;
    const top =
      spaceBelow < rect.height && anchor.top - rect.height - 6 > 6
        ? anchor.top - rect.height - 4
        : Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 6);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(6, top)}px`;
  }
}

function findConvertiblePos($from: ResolvedPos): number {
  for (let d = $from.depth; d >= 1; d--) {
    const name = $from.node(d).type.name;
    if (name === "list_item" || name === "blockquote") return $from.before(d);
    if (d === 1) return $from.before(1);
  }
  return -1;
}

/** 在 ProseMirror 中插入脚注引用并在文末补充脚注定义（自动编号）。 */
export function insertRichFootnote(view: EditorView, ctx: Ctx) {
  const md = ctx.get(serializerCtx)(view.state.doc);
  const label = String(nextFootnoteIndex(md));
  const schema = view.state.schema;
  const refType = schema.nodes.footnote_reference;
  const defType = schema.nodes.footnote_definition;
  const paraType = schema.nodes.paragraph;
  let tr = view.state.tr;

  if (refType) {
    tr = tr.replaceSelectionWith(refType.create({ label }));
  } else {
    tr = tr.insertText(`[^${label}]`);
  }

  if (defType && paraType) {
    const defNode = defType.create({ label }, paraType.create(null, schema.text("脚注内容")));
    const endPos = tr.doc.content.size;
    tr = tr.insert(endPos, defNode);
    const contentStart = endPos + 2;
    const contentEnd = contentStart + "脚注内容".length;
    tr = tr.setSelection(TextSelection.create(tr.doc, contentStart, contentEnd));
  } else if (paraType) {
    const text = `[^${label}]: 脚注内容`;
    const endPos = tr.doc.content.size;
    tr = tr.insert(endPos, paraType.create(null, schema.text(text)));
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

const BLOCK_KIND_SET = new Set<string>(["text", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "bullet", "ordered", "task"]);

const richSlashKey = new PluginKey("pocket-rich-slash");

/** 实时模式统一的 `/` 斜线菜单 ProseMirror 插件（与整块模式共用 SlashPopupController 与 SLASH_ITEMS）。 */
export function richSlashPlugin(options: () => { enabled: boolean; timeFormat: string }) {
  return $prose((ctx) => {
    const popup = new SlashPopupController();
    let dismissedAtPos: number | null = null;
    let manualOpenPos: number | null = null;
    let activeRange: { from: number; to: number } | null = null;

    const executeItem = (view: EditorView, item: SlashCommandItem) => {
      const range = activeRange;
      activeRange = null;
      manualOpenPos = null;
      dismissedAtPos = null;

      if (range && range.to > range.from) {
        view.dispatch(view.state.tr.delete(range.from, range.to));
      }

      if (item.id === "time") {
        const stamp = formatTime(new Date(), options().timeFormat);
        view.dispatch(view.state.tr.insertText(stamp).scrollIntoView());
        view.focus();
        return;
      }

      if (BLOCK_KIND_SET.has(item.id)) {
        const pos = findConvertiblePos(view.state.selection.$from);
        if (pos >= 0) turnInto(view, pos, item.id as BlockKind);
        view.focus();
        return;
      }

      const schema = view.state.schema;
      const { $from } = view.state.selection;
      const replaceEmptyPara = $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
      const insertAt = replaceEmptyPara ? $from.before(1) : $from.depth >= 1 ? $from.after(1) : view.state.selection.to;
      const insertTo = replaceEmptyPara ? $from.after(1) : insertAt;

      if (item.id === "divider" && schema.nodes.hr && schema.nodes.paragraph) {
        const tr = view.state.tr.replaceWith(insertAt, insertTo, [schema.nodes.hr.create(), schema.nodes.paragraph.create()]);
        const caret = Math.min(tr.doc.content.size, insertAt + 2);
        tr.setSelection(Selection.near(tr.doc.resolve(caret)));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "code" && schema.nodes.code_block) {
        const tr = view.state.tr.replaceWith(insertAt, insertTo, schema.nodes.code_block.create());
        tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, insertAt + 1))));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "math" && schema.nodes.code_block) {
        const tr = view.state.tr.replaceWith(insertAt, insertTo, schema.nodes.code_block.create({ language: "LaTeX" }));
        tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, insertAt + 1))));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "table") {
        const tbl = createTable(ctx, 3, 3) as PMNode;
        const tr = view.state.tr.replaceWith(insertAt, insertTo, tbl);
        tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, insertAt + 3))));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "toc" && schema.nodes.paragraph) {
        const tocPara = schema.nodes.paragraph.create(null, schema.text("[TOC]"));
        const nextPara = schema.nodes.paragraph.create();
        const tr = view.state.tr.replaceWith(insertAt, insertTo, [tocPara, nextPara]);
        const caret = Math.min(tr.doc.content.size, insertAt + tocPara.nodeSize + 1);
        tr.setSelection(Selection.near(tr.doc.resolve(caret)));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "image") {
        const text = "![图片描述](https://)";
        const from = view.state.selection.from;
        const tr = view.state.tr.insertText(text, from, view.state.selection.to);
        tr.setSelection(TextSelection.create(tr.doc, from + 8, from + 16));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return;
      }

      if (item.id === "footnote") {
        insertRichFootnote(view, ctx);
      }
    };

    const syncPopup = (view: EditorView) => {
      if (!options().enabled || !view.editable || view.composing || !view.hasFocus()) {
        popup.close();
        activeRange = null;
        return;
      }
      const sel = view.state.selection;
      if (!(sel instanceof TextSelection) || !sel.empty) {
        popup.close();
        activeRange = null;
        return;
      }
      const $from = sel.$from;
      const parent = $from.parent;
      if (!parent.isTextblock || parent.type.name === "code_block") {
        popup.close();
        activeRange = null;
        return;
      }

      if (manualOpenPos !== null) {
        const blockStart = $from.start();
        if (Math.abs(manualOpenPos - sel.from) <= 1 && parent.content.size === 0) {
          const coords = view.coordsAtPos(sel.from);
          activeRange = { from: sel.from, to: sel.from };
          popup.open(filterSlashItems(""), { left: coords.left, top: coords.top, bottom: coords.bottom }, (item) => executeItem(view, item));
          return;
        }
        if (blockStart > manualOpenPos || sel.from < manualOpenPos) {
          manualOpenPos = null;
        }
      }

      const textBefore = parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
      const m = matchBlockSlash(textBefore, textBefore.length);
      if (!m) {
        dismissedAtPos = null;
        popup.close();
        activeRange = null;
        return;
      }

      const slashFrom = $from.pos - (textBefore.length - m.from);
      if (dismissedAtPos === slashFrom) {
        popup.close();
        activeRange = null;
        return;
      }

      const items = filterSlashItems(m.query);
      if (items.length === 0) {
        popup.close();
        activeRange = null;
        return;
      }

      activeRange = { from: slashFrom, to: sel.from };
      const coords = view.coordsAtPos(sel.from);
      popup.open(items, { left: coords.left, top: coords.top, bottom: coords.bottom }, (item) => executeItem(view, item));
    };

    return new Plugin({
      key: richSlashKey,
      view(editorView) {
        const onManualOpen = () => {
          if (!options().enabled || !editorView.editable) return;
          dismissedAtPos = null;
          manualOpenPos = editorView.state.selection.from;
          syncPopup(editorView);
        };
        editorView.dom.addEventListener("pocket-open-slash", onManualOpen);
        return {
          update(view) {
            syncPopup(view);
          },
          destroy() {
            editorView.dom.removeEventListener("pocket-open-slash", onManualOpen);
            popup.close();
          },
        };
      },
      props: {
        handleKeyDown(_view, event) {
          if (!popup.isOpen() || event.isComposing) return false;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            popup.move(1);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            popup.move(-1);
            return true;
          }
          if ((event.key === "Enter" || event.key === "Tab") && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            return popup.selectCurrent();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            dismissedAtPos = activeRange?.from ?? null;
            manualOpenPos = null;
            popup.close();
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          blur() {
            manualOpenPos = null;
            popup.close();
            return false;
          },
        },
      },
    });
  });
}
