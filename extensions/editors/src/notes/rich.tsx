import { useEffect, useRef, useState } from "preact/hooks";
import type { Crepe as CrepeType } from "@milkdown/crepe";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PMNode, ResolvedPos, Schema } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { ArrowDown, ArrowUp, Check, Code, Copy, EyeOff, Heading1, Heading2, Heading3, Heading4, List, ListChecks, ListOrdered, Pilcrow, Quote, Trash2 } from "lucide-preact";
import { editorClipboard } from "../host";
import { blockSourcePlugin } from "./blocksource";
import { blankLinesPlugin, configureBlankLines, remarkBlankLines, restoreBlankLinesOnMarkdown } from "./blanklines";
import {
  applySourceFormat,
  applySourceParagraph,
  buildSourceInsert,
  canMove,
  convertible,
  duplicateBlock,
  kindOf,
  moveBlock,
  removeBlock,
  turnInto,
  type BlockKind,
} from "./blockops";
import { EditorContextMenu, type EditorMenuActions, type EditorMenuTarget, type FormatKind, type InsertKind } from "./editormenu";
import { previewDocument } from "./html-preview";
import { configurePocketHtml, pocketHtmlPlugins } from "./htmlrender";
import { listSelectionGuardPlugin, liveInlinePlugin } from "./liveinline";
import { noteLineKeys, type NoteShortcuts } from "./shortcuts";
import { CLOCK_ICON_SVG } from "./slash";
import { formatTime } from "./timefmt";
import { languages } from "../code/languages";

export type RichViewMode = "read" | "live" | "block";

export interface RichProps {
  value: string;
  viewMode: RichViewMode;
  strictLineBreaks: boolean;
  timeFormat: string;
  platform: string;
  shortcuts: NoteShortcuts;
  htmlPreview: boolean;
  onChange: (md: string) => void;
  spellcheck: boolean;
  /** Ctrl / ⌘ + 点击链接（阅读模式可直接单击打开）。 */
  onOpenLink: (href: string) => void;
  onCopy: (text: string, label?: string) => void;
  onToast: (text: string, error?: boolean) => void;
  onExitHtmlPreview: () => void;
  /** 重建之后恢复到这个滚动位置（别的窗口改了同一篇笔记时用）。 */
  scrollTop?: number;
}

interface MenuState {
  pos: number;
  x: number;
  y: number;
}

interface RichApi {
  ctx: Ctx;
  parse: (md: string) => PMNode | null;
  serialize: (doc: PMNode) => string;
  maxOpenSlice: (doc: PMNode) => unknown;
  createTextSelection: (doc: PMNode, from: number, to?: number) => unknown;
  nearSelection: ($pos: ResolvedPos) => unknown;
  createTable: (ctx: Ctx, rows?: number, cols?: number) => PMNode;
  runFormat: (view: PMView, kind: FormatKind) => void;
}

const kinds: { kind: BlockKind; label: string; icon: typeof Pilcrow }[] = [
  { kind: "text", label: "正文", icon: Pilcrow },
  { kind: "h1", label: "标题 1", icon: Heading1 },
  { kind: "h2", label: "标题 2", icon: Heading2 },
  { kind: "h3", label: "标题 3", icon: Heading3 },
  { kind: "h4", label: "标题 4", icon: Heading4 },
  { kind: "bullet", label: "无序列表", icon: List },
  { kind: "ordered", label: "有序列表", icon: ListOrdered },
  { kind: "task", label: "待办", icon: ListChecks },
  { kind: "quote", label: "引用", icon: Quote },
  { kind: "code", label: "代码块", icon: Code },
];

function findEditableBlockPos($from: ResolvedPos): number {
  for (let d = $from.depth; d >= 1; d--) {
    const name = $from.node(d).type.name;
    if (name === "list_item" || name === "blockquote") return $from.before(d);
    if (d === 1) return $from.before(1);
  }
  return -1;
}

/** 预览与实时编辑的核心区域（Milkdown Crepe）。打开笔记时才加载，换一篇或变更换行策略时重建。 */
export function RichEditor(props: RichProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const crepeRef = useRef<CrepeType | null>(null);
  const richApiRef = useRef<RichApi | null>(null);
  const pm = useRef<PMView | null>(null);
  const active = useRef(-1); // 块手柄当前指着的块
  const [preview, setPreview] = useState("");
  const [failed, setFailed] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [ctxMenu, setCtxMenu] = useState<EditorMenuTarget | null>(null);
  const ctxAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const ctxMenuOpenRef = useRef(false);
  ctxMenuOpenRef.current = !!ctxMenu;
  const [hideToolbar, setHideToolbar] = useState(false);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const [
          { Crepe },
          { commandsCtx, editorViewCtx, parserCtx, serializerCtx },
          { codeBlockView },
          {
            hardbreakAttr,
            hardbreakSchema,
            remarkPreserveEmptyLinePlugin,
            toggleEmphasisCommand,
            toggleInlineCodeCommand,
            toggleLinkCommand,
            toggleStrongCommand,
          },
          { createTable, remarkGFMPlugin, toggleStrikethroughCommand },
          { toggleMark },
          { Slice },
          { Selection, TextSelection },
          { LanguageDescription, LanguageSupport, Language },
          cm,
          marks,
          toc,
          { fastCodeBlockView },
        ] = await Promise.all([
          import("@milkdown/crepe"),
          import("@milkdown/kit/core"),
          import("@milkdown/kit/component/code-block"),
          import("@milkdown/kit/preset/commonmark"),
          import("@milkdown/kit/preset/gfm"),
          import("@milkdown/kit/prose/commands"),
          import("@milkdown/kit/prose/model"),
          import("@milkdown/kit/prose/state"),
          import("@codemirror/language"),
          import("../code/editor"),
          import("./marks"),
          import("./toc"),
          import("./fastcodeblock"),
          import("@milkdown/crepe/theme/common/style.css"),
          import("@milkdown/crepe/theme/frame.css"),
        ]);
        if (!alive || !host.current) return;

        // 代码块能选的语言：和代码草稿用同一张表，用到哪种才加载哪种的高亮。
        const codeLanguages = languages
          .filter((l) => l.id !== "text" && l.id !== "batch")
          .map((l) =>
            LanguageDescription.of({
              name: l.name,
              alias: [l.id, ...l.aliases],
              load: async () => {
                const ext = await l.load();
                return ext instanceof LanguageSupport ? ext : new LanguageSupport(ext as InstanceType<typeof Language>);
              },
            }),
          );

        const crepe = new Crepe({
          root: host.current,
          defaultValue: latest.current.value,
          features: {
            [Crepe.Feature.Latex]: true,
            [Crepe.Feature.AI]: false,
            [Crepe.Feature.ImageBlock]: false,
            [Crepe.Feature.TopBar]: false,
          },
          featureConfigs: {
            [Crepe.Feature.Placeholder]: { text: "写点什么…  输入 / 插入标题、列表、表格、代码块" },
            [Crepe.Feature.CodeMirror]: {
              languages: codeLanguages,
              theme: [cm.noteCodeTheme, cm.pocketHighlight, noteLineKeys(() => latest.current.shortcuts)],
              searchPlaceholder: "搜索语言",
              noResultText: "没有匹配的语言",
              copyText: "复制",
              onCopy: () => latest.current.onToast("已复制"),
              previewLabel: "预览",
              previewToggleText: (previewOnly: boolean) => (previewOnly ? "编辑" : "收起"),
            },
            [Crepe.Feature.LinkTooltip]: { inputPlaceholder: "粘贴链接…", onCopyLink: () => latest.current.onToast("链接已复制") },
            [Crepe.Feature.Toolbar]: { boldLabel: "加粗", italicLabel: "斜体", strikethroughLabel: "删除线", codeLabel: "行内代码", linkLabel: "链接", latexLabel: "公式" },
            [Crepe.Feature.BlockEdit]: {
              textGroup: {
                label: "文字",
                text: { label: "正文" },
                h1: { label: "标题 1" },
                h2: { label: "标题 2" },
                h3: { label: "标题 3" },
                h4: { label: "标题 4" },
                h5: { label: "标题 5" },
                h6: { label: "标题 6" },
                quote: { label: "引用" },
                divider: { label: "分割线" },
              },
              listGroup: { label: "列表", bulletList: { label: "无序列表" }, orderedList: { label: "有序列表" }, taskList: { label: "待办" } },
              advancedGroup: { label: "更多", image: { label: "图片" }, codeBlock: { label: "代码块" }, table: { label: "表格" }, math: { label: "公式" } },
              buildMenu: (builder) => {
                builder.getGroup("advanced").addItem("current-time", {
                  label: "当前时间",
                  icon: CLOCK_ICON_SVG,
                  onRun: (c) => {
                    const v = c.get(editorViewCtx);
                    const stamp = formatTime(new Date(), latest.current.timeFormat);
                    const { selection, tr } = v.state;
                    const parent = selection.$from.parent;
                    const textBefore = parent.textBetween(0, selection.$from.parentOffset, undefined, "\ufffc");
                    const m = /\/[^\s]*$/.exec(textBefore);
                    const from = m ? selection.$from.pos - m[0].length : selection.from;
                    tr.insertText(stamp, from, selection.to);
                    v.dispatch(tr.scrollIntoView());
                    v.focus();
                  },
                });
              },
              blockHandle: {
                getOffset: () => 8,
                // 手柄每次挪到一个块旁边都会问一下放哪儿：顺便记下它指着的是哪个块，点手柄时要用。
                getPlacement: ({ active: block, blockDom }) => {
                  active.current = block.$pos.pos;
                  if (block.node.type.name === "heading") return "left";
                  let descendants = 0;
                  block.node.descendants((node) => {
                    if (descendants > 2) return false;
                    descendants += node.childCount;
                    return descendants <= 2;
                  });
                  if (descendants > 2) return "left-start";
                  const style = window.getComputedStyle(block.el);
                  const height = block.el.getBoundingClientRect().height - (Number.parseInt(style.paddingTop, 10) || 0) - (Number.parseInt(style.paddingBottom, 10) || 0);
                  return blockDom.getBoundingClientRect().height < height ? "left-start" : "left";
                },
              },
            },
          },
        });
        crepeRef.current = crepe;

        crepe.editor
          .config((ctx) => {
            // 单个波浪线留给下标（H~2~O），删除线用两个。
            ctx.set(remarkGFMPlugin.options.key, { singleTilde: false });
            // 关闭“严格换行”时，源码单换行渲染为 <br>，保存仍原样写回纯 \n（不插入 \）。
            ctx.update(hardbreakSchema.key, (prev) => (c) => {
              const base = prev(c);
              return {
                ...base,
                parseDOM: [{ tag: 'br[data-is-inline="true"]', getAttrs: () => ({ isInline: true }) }, ...(base.parseDOM ?? [])],
                toDOM: (node: PMNode) =>
                  node.attrs.isInline && latest.current.strictLineBreaks
                    ? ["span", c.get(hardbreakAttr.key)(node), " "]
                    : ["br", c.get(hardbreakAttr.key)(node)],
              };
            });
            marks.configurePocketMarks(ctx);
            configureBlankLines(ctx);
            configurePocketHtml(ctx, { isLive: () => latest.current.viewMode === "live" });
          })
          .use(marks.pocketMarks)
          .use(pocketHtmlPlugins)
          .use(remarkBlankLines)
          .use(blankLinesPlugin)
          .use(toc.tocPlugin)
          .use(listSelectionGuardPlugin)
          .use(liveInlinePlugin(() => ({ enabled: latest.current.viewMode === "live" })))
          .use(
            blockSourcePlugin(() => ({
              enabled: latest.current.viewMode === "block",
              shortcuts: latest.current.shortcuts,
              timeFormat: latest.current.timeFormat,
            })),
          );
        // 保存时 [TOC] 会被转义成 \[TOC]（方括号在 Markdown 里有含义），别的编辑器就不认了：改回去。
        crepe.on((l) =>
          l.markdownUpdated((ctx, md) => {
            const v = ctx.get(editorViewCtx);
            const full = restoreBlankLinesOnMarkdown(v.state.doc, md, v.state);
            latest.current.onChange(full.replace(/^\\\[(toc)\]$/gim, "[$1]"));
          }),
        );
        // 不在空段落处写入 <br /> 占位，保持标准 Markdown 换行行为（类 Typora）。
        await crepe.editor.remove(remarkPreserveEmptyLinePlugin);
        // 替换滚动期间按视口批量实例化数百个 CodeMirror 的默认节点视图，改用点击/聚焦时按需激活。
        await crepe.editor.remove(codeBlockView);
        crepe.editor.use(fastCodeBlockView);
        await crepe.create();
        if (!alive) {
          void crepe.destroy();
          return;
        }
        crepe.setReadonly(latest.current.viewMode === "read");

        const ctx = crepe.editor.ctx;
        const view = ctx.get(editorViewCtx);
        pm.current = view;
        richApiRef.current = {
          ctx,
          parse: (md) => ctx.get(parserCtx)(md),
          serialize: (doc) => ctx.get(serializerCtx)(doc),
          maxOpenSlice: (doc) => Slice.maxOpen(doc.content),
          createTextSelection: (doc, from, to) => TextSelection.create(doc, from, to),
          nearSelection: ($pos) => Selection.near($pos),
          createTable: (c, rows = 3, cols = 3) => createTable(c, rows, cols),
          runFormat: (v, kind) => {
            const commands = ctx.get(commandsCtx);
            const schema = v.state.schema as Schema;
            switch (kind) {
              case "bold":
                commands.call(toggleStrongCommand.key);
                break;
              case "italic":
                commands.call(toggleEmphasisCommand.key);
                break;
              case "strike":
                commands.call(toggleStrikethroughCommand.key);
                break;
              case "code":
                commands.call(toggleInlineCodeCommand.key);
                break;
              case "link":
                commands.call(toggleLinkCommand.key);
                break;
              case "mark":
                if (schema.marks.pocket_mark) toggleMark(schema.marks.pocket_mark, { md: true })(v.state, v.dispatch);
                break;
              case "underline":
                if (schema.marks.pocket_u) toggleMark(schema.marks.pocket_u, { md: false })(v.state, v.dispatch);
                break;
              case "clear": {
                const { from, to, empty } = v.state.selection;
                const tr = v.state.tr;
                if (empty) tr.setStoredMarks([]);
                else tr.removeMark(from, to, null);
                v.dispatch(tr);
                break;
              }
            }
            v.focus();
          },
        };

        const refreshPreview = () => {
          if (latest.current.htmlPreview) {
            setPreview(
              previewDocument(view.state.doc, document.documentElement.dataset.theme === "dark", {
                strictLineBreaks: latest.current.strictLineBreaks,
                themeEl: host.current?.closest(".fx-notes-body") ?? host.current,
              }),
            );
          }
        };
        refreshPreview();
        crepe.on((l) => l.markdownUpdated(() => refreshPreview()));
        const themeWatch = new MutationObserver(refreshPreview);
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        view.dom.setAttribute("spellcheck", String(latest.current.spellcheck));
        // 自动化测试靠它读写编辑器里的内容。
        (host.current as unknown as { __pm: PMView }).__pm = view;
        if (latest.current.scrollTop) host.current.scrollTop = latest.current.scrollTop;
        destroy = () => {
          themeWatch.disconnect();
          crepeRef.current = null;
          richApiRef.current = null;
          pm.current = null;
          void crepe.destroy();
        };
      } catch (e) {
        if (alive) setFailed((e as Error).message || "编辑器加载失败");
      }
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, []);

  useEffect(() => {
    pm.current?.dom.setAttribute("spellcheck", String(props.spellcheck));
  }, [props.spellcheck]);

  useEffect(() => {
    if (props.htmlPreview && pm.current) {
      setPreview(
        previewDocument(pm.current.state.doc, document.documentElement.dataset.theme === "dark", {
          strictLineBreaks: props.strictLineBreaks,
          themeEl: host.current?.closest(".fx-notes-body") ?? host.current,
        }),
      );
    }
  }, [props.htmlPreview, props.strictLineBreaks]);

  useEffect(() => {
    crepeRef.current?.setReadonly(props.viewMode === "read");
    const view = pm.current;
    if (view) view.dispatch(view.state.tr.setMeta("pocket-mode-switch", props.viewMode));
    if (props.viewMode === "read") setHideToolbar(false);
  }, [props.viewMode]);

  // 点块手柄打开块菜单；阅读态单击或 Ctrl / ⌘ + 点击链接用系统浏览器打开；右键弹出自定义菜单并抑制浮动 Toolbar。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      const handle = target.closest?.(".milkdown-block-handle .operation-item:last-child");
      if (handle && latest.current.viewMode !== "read" && pm.current && active.current >= 0 && pm.current.state.doc.nodeAt(active.current)) {
        e.preventDefault();
        e.stopPropagation();
        const r = handle.getBoundingClientRect();
        setMenu({ pos: active.current, x: r.left, y: r.bottom + 4 });
        return;
      }
      const link = target.closest?.(".ProseMirror a[href]");
      if (link && (latest.current.viewMode === "read" || e.metaKey || e.ctrlKey || e.button === 1)) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onOpenLink(link.getAttribute("href") ?? "");
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".fx-menu, .milkdown-code-block .language-picker, .milkdown-code-block .cm-editor")) return;
      const v = pm.current;
      const api = richApiRef.current;
      if (!v || !api) return;

      e.preventDefault();
      e.stopPropagation();
      setHideToolbar(true);

      const area = target?.closest("textarea.pocket-block-source") as HTMLTextAreaElement | null;
      ctxAreaRef.current = area;
      if (area) {
        const hasSelection = area.selectionStart !== area.selectionEnd;
        const pos = findEditableBlockPos(v.state.selection.$from);
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          readonly: false,
          hasSelection,
          canCopyMarkdown: false,
          currentBlockKind: pos >= 0 ? kindOf(v, pos) : "",
          canConvertBlock: pos >= 0 ? convertible(v, pos) : true,
        });
        return;
      }

      const readonly = latest.current.viewMode === "read";
      const link = target?.closest(".ProseMirror a[href]") as HTMLAnchorElement | null;
      const linkHref = link?.getAttribute("href") ?? undefined;
      let sel = v.state.selection;
      if (!readonly && (sel.empty || !target?.closest(".ProseMirror"))) {
        const coords = v.posAtCoords({ left: e.clientX, top: e.clientY });
        if (coords) {
          const nextSel = api.nearSelection(v.state.doc.resolve(coords.pos));
          v.dispatch(v.state.tr.setSelection(nextSel as typeof sel));
          sel = v.state.selection;
        }
      }
      const domSel = window.getSelection();
      const hasDomSel = !!(domSel && !domSel.isCollapsed && root.contains(domSel.anchorNode));
      const hasSelection = !sel.empty || hasDomSel;
      const blockPos = findEditableBlockPos(sel.$from);
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        readonly,
        hasSelection,
        canCopyMarkdown: !sel.empty,
        linkHref,
        currentBlockKind: blockPos >= 0 ? kindOf(v, blockPos) : "",
        canConvertBlock: blockPos >= 0 ? convertible(v, blockPos) : false,
      });
    };
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest(".fx-editor-menu")) return;
      if (e.button === 0) setHideToolbar(false);
    };
    const onKeyDown = () => {
      if (!ctxMenuOpenRef.current) setHideToolbar(false);
    };
    root.addEventListener("click", onClick, true);
    root.addEventListener("auxclick", onClick, true);
    root.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("mousedown", onMouseDown, true);
    root.addEventListener("keydown", onKeyDown, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("auxclick", onClick, true);
      root.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      root.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const menuActions: EditorMenuActions = (() => {
    const area = ctxAreaRef.current;
    if (area && area.isConnected) {
      const dispatchAreaInput = () => area.dispatchEvent(new Event("input", { bubbles: true }));
      const selectedText = () => area.value.slice(area.selectionStart, area.selectionEnd);
      return {
        onCut: () => {
          const txt = selectedText();
          if (!txt) return;
          void editorClipboard.write(txt);
          area.setRangeText("", area.selectionStart, area.selectionEnd, "end");
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
        onCopy: () => {
          const txt = selectedText();
          if (txt) void editorClipboard.write(txt);
          area.focus();
        },
        onPaste: async () => {
          const clip = await editorClipboard.read();
          if (!clip) return;
          area.setRangeText(clip, area.selectionStart, area.selectionEnd, "end");
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
        onPastePlain: async () => {
          const clip = await editorClipboard.read();
          if (!clip) return;
          area.setRangeText(clip, area.selectionStart, area.selectionEnd, "end");
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
        onSelectAll: () => {
          area.focus();
          area.select();
        },
        onFormat: (kind) => {
          const edit = applySourceFormat(area.value, area.selectionStart, area.selectionEnd, kind);
          area.setRangeText(edit.insert, edit.from, edit.to, "end");
          area.setSelectionRange(edit.anchor, edit.head);
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
        onParagraph: (kind) => {
          const edit = applySourceParagraph(area.value, area.selectionStart, area.selectionEnd, kind);
          area.setRangeText(edit.insert, edit.from, edit.to, "end");
          area.setSelectionRange(edit.anchor, edit.head);
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
        onInsert: (kind) => {
          const lineStart = area.value.lastIndexOf("\n", area.selectionStart - 1) + 1;
          const emptyLine = area.value.slice(lineStart, area.selectionStart).trim() === "";
          const { insert, cursorOffset } = buildSourceInsert(kind, latest.current.timeFormat, emptyLine);
          const at = area.selectionStart;
          area.setRangeText(insert, at, area.selectionEnd, "end");
          area.setSelectionRange(at + cursorOffset, at + cursorOffset);
          dispatchAreaInput();
          if (area.isConnected) area.focus();
        },
      };
    }

    const v = pm.current;
    const api = richApiRef.current;
    const selectedPlain = () => {
      if (!v) return "";
      const { from, to, empty } = v.state.selection;
      if (!empty) return v.state.doc.textBetween(from, to, "\n\n");
      return window.getSelection()?.toString() ?? "";
    };
    const insertBlockNode = (kind: InsertKind) => {
      if (!v || !api) return;
      if (kind === "time") {
        const stamp = formatTime(new Date(), latest.current.timeFormat);
        v.dispatch(v.state.tr.insertText(stamp).scrollIntoView());
        v.focus();
        return;
      }
      const { $from } = v.state.selection;
      const schema = v.state.schema;
      const nodesToInsert: PMNode[] = [];
      let caretDelta = 1;
      if (kind === "divider" && schema.nodes.hr && schema.nodes.paragraph) {
        nodesToInsert.push(schema.nodes.hr.create(), schema.nodes.paragraph.create());
        caretDelta = 2;
      } else if (kind === "code" && schema.nodes.code_block) {
        nodesToInsert.push(schema.nodes.code_block.create());
      } else if (kind === "math" && schema.nodes.code_block) {
        nodesToInsert.push(schema.nodes.code_block.create({ language: "LaTeX" }));
      } else if (kind === "table") {
        nodesToInsert.push(api.createTable(api.ctx, 3, 3));
        caretDelta = 3;
      }
      if (!nodesToInsert.length) return;
      const replaceEmptyPara = $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
      const from = replaceEmptyPara ? $from.before(1) : $from.depth >= 1 ? $from.after(1) : v.state.selection.to;
      const to = replaceEmptyPara ? $from.after(1) : from;
      const tr = v.state.tr.replaceWith(from, to, nodesToInsert);
      const targetPos = Math.min(tr.doc.content.size, from + caretDelta);
      tr.setSelection(api.nearSelection(tr.doc.resolve(targetPos)) as PMView["state"]["selection"]);
      v.dispatch(tr.scrollIntoView());
      v.focus();
    };
    const pasteText = async (plain: boolean) => {
      if (!v || !api) return;
      const text = await editorClipboard.read();
      if (!text) return;
      if (plain) {
        v.dispatch(v.state.tr.insertText(text).scrollIntoView());
        v.focus();
        return;
      }
      const parsed = api.parse(text);
      if (parsed && parsed.content.size > 0) {
        v.dispatch(v.state.tr.replaceSelection(api.maxOpenSlice(parsed) as never).scrollIntoView());
      } else {
        v.dispatch(v.state.tr.insertText(text).scrollIntoView());
      }
      v.focus();
    };
    return {
      onOpenLink: (href) => latest.current.onOpenLink(href),
      onCopyLink: (href) => latest.current.onCopy(href, "已复制链接"),
      onCut: () => {
        if (!v || v.state.selection.empty) return;
        const txt = selectedPlain();
        if (txt) void editorClipboard.write(txt);
        v.dispatch(v.state.tr.deleteSelection().scrollIntoView());
        v.focus();
      },
      onCopy: () => {
        const txt = selectedPlain();
        if (txt) void editorClipboard.write(txt);
        v?.focus();
      },
      onCopyMarkdown: () => {
        if (!v || !api || v.state.selection.empty) return;
        const slice = v.state.doc.slice(v.state.selection.from, v.state.selection.to);
        const doc = v.state.schema.topNodeType.create(null, slice.content);
        const md = api.serialize(doc).replace(/\n$/, "");
        void editorClipboard.write(md);
        v.focus();
      },
      onPaste: () => void pasteText(false),
      onPastePlain: () => void pasteText(true),
      onSelectAll: () => {
        if (!v || !api) return;
        const { doc } = v.state;
        const tr = v.state.tr.setSelection(api.createTextSelection(doc, 0, doc.content.size) as PMView["state"]["selection"]);
        v.dispatch(tr);
        v.focus();
      },
      onFormat: (kind) => {
        if (v && api) api.runFormat(v, kind);
      },
      onParagraph: (kind) => {
        if (!v) return;
        const pos = findEditableBlockPos(v.state.selection.$from);
        if (pos >= 0) turnInto(v, pos, kind);
      },
      onInsert: insertBlockNode,
    };
  })();

  if (failed) return <div class="pk-empty">预览编辑器加载失败（{failed}），可以先切到源码模式。</div>;
  return (
    <>
      <div
        class={`fx-notes-rich${props.viewMode === "read" ? " is-readonly" : ""}${hideToolbar ? " pocket-hide-toolbar" : ""}`}
        ref={host}
        style={props.htmlPreview ? { display: "none" } : undefined}
      />
      {props.htmlPreview && (
        <div class="pocket-html-preview-wrap">
          <div class="pocket-html-preview-bar">
            <span>HTML 沙箱预览（只读隔离）</span>
            <button type="button" class="ui-btn is-ghost is-small" onClick={props.onExitHtmlPreview}>
              <EyeOff size={13} />
              <span>退出沙箱预览</span>
            </button>
          </div>
          <iframe class="pocket-html-preview" title="HTML 沙箱预览" sandbox="" srcDoc={preview} />
        </div>
      )}
      {menu && pm.current && <BlockMenu view={pm.current} at={menu} onClose={() => setMenu(null)} />}
      {ctxMenu && (
        <EditorContextMenu
          menu={ctxMenu}
          platform={props.platform}
          timeFormat={props.timeFormat}
          actions={menuActions}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

/** 块菜单：转换类型、复制一份、上移下移、删除。 */
function BlockMenu({ view, at, onClose }: { view: PMView; at: MenuState; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });
  const current = kindOf(view, at.pos);
  const canConvert = convertible(view, at.pos);

  useEffect(() => {
    // 放不下就往上、往左收一收。
    const r = box.current?.getBoundingClientRect();
    if (r) setPlace({ left: Math.max(6, Math.min(at.x, window.innerWidth - r.width - 6)), top: Math.max(6, Math.min(at.y, window.innerHeight - r.height - 6)) });
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div class="fx-menu fx-block-menu" ref={box} style={{ left: `${place.left}px`, top: `${place.top}px` }} role="menu">
      {canConvert && (
        <>
          <div class="fx-menu-label">转换成</div>
          <div class="fx-block-kinds">
            {kinds.map(({ kind, label, icon: Icon }) => (
              <button key={kind} type="button" role="menuitem" class={`fx-menu-item${kind === current ? " is-current" : ""}`} onClick={act(() => turnInto(view, at.pos, kind))}>
                <Icon size={14} />
                <span>{label}</span>
                {kind === current && <Check size={12} class="fx-menu-check" />}
              </button>
            ))}
          </div>
          <div class="fx-menu-sep" />
        </>
      )}
      <button type="button" role="menuitem" class="fx-menu-item" onClick={act(() => duplicateBlock(view, at.pos))}>
        <Copy size={14} />
        <span>复制一份</span>
      </button>
      <button type="button" role="menuitem" class="fx-menu-item" disabled={!canMove(view, at.pos, -1)} onClick={act(() => void moveBlock(view, at.pos, -1))}>
        <ArrowUp size={14} />
        <span>上移</span>
      </button>
      <button type="button" role="menuitem" class="fx-menu-item" disabled={!canMove(view, at.pos, 1)} onClick={act(() => void moveBlock(view, at.pos, 1))}>
        <ArrowDown size={14} />
        <span>下移</span>
      </button>
      <div class="fx-menu-sep" />
      <button type="button" role="menuitem" class="fx-menu-item is-danger" onClick={act(() => removeBlock(view, at.pos))}>
        <Trash2 size={14} />
        <span>删除</span>
      </button>
    </div>
  );
}
