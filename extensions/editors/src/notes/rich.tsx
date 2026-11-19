import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Crepe as CrepeType } from "@milkdown/crepe";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PMNode, ResolvedPos, Schema } from "@milkdown/kit/prose/model";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { ArrowDown, ArrowUp, Check, Code, Copy, EyeOff, Heading1, Heading2, Heading3, Heading4, List, ListChecks, ListOrdered, Pilcrow, Quote, Trash2 } from "lucide-preact";
import { editorClipboard, Notes } from "../host";
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
  nextLinkRefId,
  removeBlock,
  selectionKindOf,
  transformSelection,
  turnInto,
  type BlockKind,
} from "./blockops";
import { EditorContextMenu, type EditorMenuActions, type EditorMenuTarget, type FormatKind, type InsertKind } from "./editormenu";
import {
  getRichFindStats,
  replaceAllRich,
  replaceCurrentRich,
  richFindPlugin,
  setRichFindQuery,
  stepRichFind,
  type FindQuery,
  type FindStats,
} from "./findreplace";
import type { HighlightColorId } from "./highlights";
import { previewDocument } from "./html-preview";
import { configurePocketHtml, pocketHtmlPlugins } from "./htmlrender";
import { blobToBase64, resolveNoteRelativePath, type PendingImageInput } from "./images";
import {
  ImageLightbox,
  configurePocketImageSchema,
  createPocketImageView,
  remarkPocketImage,
  type LightboxImageInfo,
} from "./imagewidget";
import { listSelectionGuardPlugin, liveInlinePlugin } from "./liveinline";
import { insertLine, matchShortcutAction, noteLineKeys, type NoteShortcuts } from "./shortcuts";
import { insertRichFootnote, richSlashPlugin } from "./slashmenu";
import { pickBestBlockIndex, resolveOffsetInBlockText, type EditorAnchor } from "./syncpos";
import { formatTime } from "./timefmt";
import { languages } from "../code/languages";

export type RichViewMode = "read" | "live" | "block";

export interface RichHandle {
  captureAnchor: () => EditorAnchor | null;
  getFindStats: () => FindStats;
  setFindQuery: (query: FindQuery, scroll?: boolean) => FindStats;
  stepFind: (dir: 1 | -1) => FindStats;
  replaceFind: (replacement: string) => FindStats;
  replaceAllFind: (replacement: string) => { count: number; stats: FindStats };
  getSelectedText: () => string;
  focus: () => void;
}

export interface RichProps {
  value: string;
  notePath: string;
  viewMode: RichViewMode;
  strictLineBreaks: boolean;
  highlightColor: HighlightColorId;
  highlightOpacity: number;
  editorMaxWidth: number;
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
  onInsertFrontmatter: () => void;
  onOpenFind: (replace: boolean) => void;
  onPasteImage: (input: PendingImageInput, insert: (markdownUrl: string, alt: string) => void) => void;
  /** 重建之后恢复到这个滚动位置（别的窗口改了同一篇笔记时用）。 */
  scrollTop?: number;
  /** 从源码模式切换过来时恢复对应的块与光标位置。 */
  initialAnchor?: EditorAnchor | null;
  /** 供父组件在切换模式前采集当前块与光标锚点及驱动查找替换。 */
  handleRef?: { current: RichHandle | null };
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

function isNonEmptyTopBlock(node: PMNode): boolean {
  return !(node.type.name === "paragraph" && node.content.size === 0);
}

function nonEmptyTopBlocks(doc: PMNode): { childIdx: number; pos: number; node: PMNode }[] {
  const out: { childIdx: number; pos: number; node: PMNode }[] = [];
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (isNonEmptyTopBlock(child)) out.push({ childIdx: i, pos, node: child });
    pos += child.nodeSize;
  }
  return out;
}

function nonEmptyIndexForChild(doc: PMNode, childIdx: number): number {
  let count = 0;
  for (let i = 0; i < childIdx && i < doc.childCount; i++) {
    if (isNonEmptyTopBlock(doc.child(i))) count++;
  }
  return count;
}

/** 根据块内纯文本偏移在 ProseMirror 子树里找到最接近的文档 pos。 */
function findDocPosForTextOffset(topNode: PMNode, topStartPos: number, targetOffset: number): number {
  let seen = 0;
  let result = -1;
  topNode.descendants((node, relPos) => {
    if (result >= 0) return false;
    if (node.isText) {
      const len = node.text?.length ?? 0;
      if (targetOffset <= seen + len) {
        result = topStartPos + 1 + relPos + Math.max(0, targetOffset - seen);
        return false;
      }
      seen += len;
    }
    return true;
  });
  if (result >= 0) return result;
  return topStartPos + Math.max(1, topNode.nodeSize - 1);
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
  const ctxCodeBlockPosRef = useRef<number | null>(null);
  const ctxCodeCmRef = useRef<{
    state: { selection: { main: { from: number; to: number } }; doc: { length: number }; sliceDoc(from: number, to: number): string };
    dispatch(spec: unknown): void;
    focus(): void;
  } | null>(null);
  const ctxMenuOpenRef = useRef(false);
  ctxMenuOpenRef.current = !!ctxMenu;
  const [hideToolbar, setHideToolbar] = useState(false);
  const [lightboxImg, setLightboxImg] = useState<LightboxImageInfo | null>(null);
  const resolvedImgMap = useRef<Map<string, string>>(new Map());

  // 向父组件暴露当前光标 / 视口锚点采集与查找替换能力。
  useEffect(() => {
    const ref = props.handleRef;
    if (!ref) return;
    ref.current = {
      captureAnchor: (): EditorAnchor | null => {
        const v = pm.current;
        const scroller = host.current;
        if (!v || !scroller) return null;

        // 1) 整块源码激活态：直接读当前块序号 + textarea 光标位置与上下文
        const activeArea = scroller.querySelector<HTMLTextAreaElement>("textarea.pocket-block-source");
        if (activeArea && activeArea.isConnected) {
          const fromAttr = Number(activeArea.dataset.pocketBlockFrom);
          if (Number.isFinite(fromAttr) && fromAttr >= 0 && fromAttr <= v.state.doc.content.size) {
            const $r = v.state.doc.resolve(Math.min(v.state.doc.content.size, fromAttr + 1));
            const rawChildIdx = $r.depth >= 1 ? $r.index(0) : 0;
            const blockIndex = nonEmptyIndexForChild(v.state.doc, rawChildIdx);
            const cur = activeArea.selectionStart;
            return {
              blockIndex,
              offsetInBlock: cur,
              beforeSnippet: activeArea.value.slice(Math.max(0, cur - 14), cur),
              afterSnippet: activeArea.value.slice(cur, cur + 14),
              focus: true,
            };
          }
        }

        // 2) 实时模式（或整块未展开但有光标）：读 ProseMirror 选区所在顶层块
        const sel = v.state.selection;
        if (latest.current.viewMode !== "read" && sel.$from.depth >= 1) {
          const rawChildIdx = sel.$from.index(0);
          const blockIndex = nonEmptyIndexForChild(v.state.doc, rawChildIdx);
          const topNode = v.state.doc.child(rawChildIdx);
          const topStart = sel.$from.before(1);
          const offsetInBlock = v.state.doc.textBetween(topStart + 1, Math.max(topStart + 1, sel.from), "\n").length;
          const blockText = topNode.textContent;
          return {
            blockIndex,
            offsetInBlock,
            beforeSnippet: blockText.slice(Math.max(0, offsetInBlock - 14), offsetInBlock),
            afterSnippet: blockText.slice(offsetInBlock, offsetInBlock + 14),
            focus: true,
          };
        }

        // 3) 阅读模式：查找视口顶部第一个可见顶层非空块
        const scrollerTop = scroller.getBoundingClientRect().top;
        let visibleIdx = 0;
        let found = false;
        const topBlocks = nonEmptyTopBlocks(v.state.doc);
        for (let i = 0; i < topBlocks.length; i++) {
          const dom = v.nodeDOM(topBlocks[i]!.pos);
          if (dom instanceof HTMLElement) {
            const r = dom.getBoundingClientRect();
            if (r.bottom > scrollerTop + 8) {
              visibleIdx = i;
              found = true;
              break;
            }
          }
        }
        return { blockIndex: found ? visibleIdx : 0, offsetInBlock: 0, focus: false };
      },
      getFindStats: () => getRichFindStats(pm.current),
      setFindQuery: (query, scroll = true) => setRichFindQuery(pm.current, query, scroll),
      stepFind: (dir) => stepRichFind(pm.current, dir),
      replaceFind: (replacement) => replaceCurrentRich(pm.current, replacement),
      replaceAllFind: (replacement) => replaceAllRich(pm.current, replacement),
      getSelectedText: () => {
        const v = pm.current;
        if (!v) return "";
        const area = host.current?.querySelector<HTMLTextAreaElement>("textarea.pocket-block-source");
        if (area && document.activeElement === area && area.selectionStart !== area.selectionEnd) {
          return area.value.slice(area.selectionStart, area.selectionEnd);
        }
        const { from, to, empty } = v.state.selection;
        return empty ? "" : v.state.doc.textBetween(from, to, " ");
      },
      focus: () => {
        pm.current?.focus();
      },
    };
    return () => {
      if (ref.current) ref.current = null;
    };
  }, [props.handleRef]);

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
              // 关闭 Crepe 原生斜线弹窗，改由统一的 richSlashPlugin 渲染，与整块模式外观、搜索和命令完全一致。
              buildMenu: (builder) => {
                builder.clear();
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

        const localImagePreviewPlugin = $prose(() => {
          const resolveAll = (view: PMView) => {
            if (view.isDestroyed) return;
            const notePath = latest.current.notePath;
            view.dom.querySelectorAll<HTMLImageElement>("img:not(.pocket-img-el)").forEach((img) => {
              const orig = img.dataset.pocketOrigSrc ?? img.getAttribute("src") ?? "";
              if (!orig) return;
              const rel = resolveNoteRelativePath(notePath, orig);
              if (!rel) return;
              img.dataset.pocketOrigSrc = orig;
              const cached = resolvedImgMap.current.get(orig);
              if (cached) {
                if (img.getAttribute("src") !== cached) img.src = cached;
                return;
              }
              void Notes.imageAssetUrl(rel)
                .then((url) => {
                  if (!url) return;
                  resolvedImgMap.current.set(orig, url);
                  if (img.isConnected && img.dataset.pocketOrigSrc === orig && img.getAttribute("src") !== url) {
                    img.src = url;
                  }
                })
                .catch(() => undefined);
            });
          };
          return new Plugin({
            key: new PluginKey("pocket-local-images"),
            view(v) {
              resolveAll(v);
              return { update: (cur) => resolveAll(cur) };
            },
          });
        });

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
            configurePocketImageSchema(ctx);
            configureBlankLines(ctx);
            configurePocketHtml(ctx, { isLive: () => latest.current.viewMode === "live" });
          })
          .use(marks.pocketMarks)
          .use(remarkPocketImage)
          .use(
            createPocketImageView({
              getNotePath: () => latest.current.notePath,
              resolvedImgMap: resolvedImgMap.current,
              onOpenLightbox: (info) => setLightboxImg(info),
            }),
          )
          .use(pocketHtmlPlugins)
          .use(remarkBlankLines)
          .use(blankLinesPlugin)
          .use(toc.tocPlugin)
          .use(richFindPlugin)
          .use(localImagePreviewPlugin)
          .use(listSelectionGuardPlugin)
          .use(liveInlinePlugin(() => ({ enabled: latest.current.viewMode === "live" })))
          .use(
            richSlashPlugin(() => ({
              enabled: latest.current.viewMode === "live",
              timeFormat: latest.current.timeFormat,
            })),
          )
          .use(
            blockSourcePlugin(() => ({
              enabled: latest.current.viewMode === "block",
              shortcuts: latest.current.shortcuts,
              platform: latest.current.platform,
              timeFormat: latest.current.timeFormat,
              onOpenFind: (replace) => latest.current.onOpenFind(replace),
              onPasteImage: (input, insert) => latest.current.onPasteImage(input, insert),
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
              case "math": {
                const { from, to } = v.state.selection;
                const inner = v.state.doc.textBetween(from, to) || "x^2";
                const mathNode = schema.nodes.math_inline;
                if (mathNode) {
                  const tr = v.state.tr.replaceRangeWith(from, to, mathNode.create({ value: inner }));
                  v.dispatch(tr.scrollIntoView());
                } else {
                  const tr = v.state.tr.insertText(`$${inner}$`, from, to);
                  tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1 + inner.length));
                  v.dispatch(tr.scrollIntoView());
                }
                break;
              }
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
                themeEl: host.current?.closest(".fx-notes") ?? host.current?.closest(".fx-notes-body") ?? host.current,
                editorMaxWidth: latest.current.editorMaxWidth,
                resolveImgSrc: (src) => resolvedImgMap.current.get(src),
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

        // 恢复从源码切回时的精确光标与居中滚动位置；否则恢复保存的滚动位置。
        const anchor = latest.current.initialAnchor;
        if (anchor && view.state.doc.childCount > 0) {
          const blocks = nonEmptyTopBlocks(view.state.doc);
          const picked =
            blocks.length > 0
              ? blocks[pickBestBlockIndex(blocks, (b) => b.node.textContent, anchor)]!
              : { pos: 0, node: view.state.doc.child(0) };
          const textOff = resolveOffsetInBlockText(picked.node.textContent, anchor);
          const docPos = Math.max(0, Math.min(view.state.doc.content.size, findDocPosForTextOffset(picked.node, picked.pos, textOff)));
          const sel = Selection.near(view.state.doc.resolve(docPos));
          view.dispatch(view.state.tr.setSelection(sel).setMeta("pocket-selection", true));
          if (anchor.focus && latest.current.viewMode !== "read") {
            view.focus();
          }
          const scrollToTarget = () => {
            const scroller = host.current;
            if (!scroller || view.isDestroyed) return;
            try {
              const coords = view.coordsAtPos(sel.from);
              const sr = scroller.getBoundingClientRect();
              const desired = scroller.scrollTop + (coords.top - sr.top) - sr.height * 0.38;
              scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, desired));
            } catch {
              /* 忽略未布局时的坐标读取异常 */
            }
          };
          requestAnimationFrame(() => {
            scrollToTarget();
            requestAnimationFrame(scrollToTarget);
          });
        } else if (latest.current.scrollTop) {
          host.current.scrollTop = latest.current.scrollTop;
        }

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

  useLayoutEffect(() => {
    if (props.htmlPreview && pm.current) {
      setPreview(
        previewDocument(pm.current.state.doc, document.documentElement.dataset.theme === "dark", {
          strictLineBreaks: props.strictLineBreaks,
          themeEl: host.current?.closest(".fx-notes") ?? host.current?.closest(".fx-notes-body") ?? host.current,
          editorMaxWidth: props.editorMaxWidth,
          resolveImgSrc: (src) => resolvedImgMap.current.get(src),
        }),
      );
    }
  }, [props.htmlPreview, props.strictLineBreaks, props.highlightColor, props.highlightOpacity, props.editorMaxWidth]);

  useEffect(() => {
    crepeRef.current?.setReadonly(props.viewMode === "read");
    const view = pm.current;
    if (view) {
      view.dispatch(view.state.tr.setMeta("pocket-mode-switch", props.viewMode));
      const readonly = props.viewMode === "read";
      view.dom.querySelectorAll(".pocket-img-wrap").forEach((el) => {
        el.classList.toggle("is-readonly", readonly);
        if (readonly) el.classList.remove("is-selected");
      });
    }
    if (props.viewMode === "read") setHideToolbar(false);
  }, [props.viewMode]);

  // 点块手柄打开块菜单或统一斜线菜单；阅读态单击或 Ctrl / ⌘ + 点击链接用系统浏览器打开；右键弹出自定义菜单并抑制浮动 Toolbar。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const onPointerUp = (e: PointerEvent) => {
      const target = e.target as Element;
      const addBtn = target.closest?.(".milkdown-block-handle .operation-item:first-child");
      if (addBtn && latest.current.viewMode !== "read" && pm.current && richApiRef.current && active.current >= 0) {
        const v = pm.current;
        const api = richApiRef.current;
        const node = v.state.doc.nodeAt(active.current);
        const para = v.state.schema.nodes.paragraph;
        if (!node || !para) return;
        e.preventDefault();
        e.stopPropagation();
        const afterPos = active.current + node.nodeSize;
        const tr = v.state.tr.insert(afterPos, para.create());
        tr.setSelection(api.nearSelection(tr.doc.resolve(afterPos + 1)) as PMView["state"]["selection"]);
        v.dispatch(tr.scrollIntoView());
        v.focus();
        requestAnimationFrame(() => {
          v.dom.dispatchEvent(new CustomEvent("pocket-open-slash"));
        });
      }
    };
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
      if (target?.closest(".fx-menu, .milkdown-code-block .language-picker")) return;
      const v = pm.current;
      const api = richApiRef.current;
      if (!v || !api) return;

      e.preventDefault();
      e.stopPropagation();
      setHideToolbar(true);

      const area = target?.closest("textarea.pocket-block-source") as HTMLTextAreaElement | null;
      ctxAreaRef.current = area;
      ctxCodeBlockPosRef.current = null;
      ctxCodeCmRef.current = null;
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
      const codeEl = target?.closest('.milkdown-code-block[data-pocket-code-block="1"]') as
        | (HTMLElement & { __pocketGetPos?: () => number | undefined; __pocketGetCM?: () => typeof ctxCodeCmRef.current })
        | null;
      if (codeEl) {
        const codePos = codeEl.__pocketGetPos?.();
        const codeNode = typeof codePos === "number" ? v.state.doc.nodeAt(codePos) : null;
        const codeCm = codeEl.__pocketGetCM?.() ?? null;
        if (codeNode && typeof codePos === "number") {
          ctxCodeBlockPosRef.current = codePos;
          ctxCodeCmRef.current = codeCm;
          const cmSel = codeCm?.state.selection.main;
          const domSel = window.getSelection();
          const hasSelection = cmSel ? cmSel.from !== cmSel.to : !!(domSel && !domSel.isCollapsed && codeEl.contains(domSel.anchorNode));
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            readonly,
            hasSelection,
            canCopyMarkdown: false,
            currentBlockKind: kindOf(v, codePos),
            canConvertBlock: true,
          });
          return;
        }
      }

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
        currentBlockKind: selectionKindOf(v),
        canConvertBlock: !sel.empty || (blockPos >= 0 && convertible(v, blockPos)),
      });
    };
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest(".fx-editor-menu")) return;
      if (e.button === 0) setHideToolbar(false);
    };
    const insertImageIntoPM = (url: string, alt: string) => {
      const v = pm.current;
      if (!v || v.isDestroyed) return;
      const imgType = v.state.schema.nodes.image;
      if (imgType) {
        const node = imgType.create({ src: url, alt });
        v.dispatch(v.state.tr.replaceSelectionWith(node).scrollIntoView());
      } else {
        v.dispatch(v.state.tr.insertText(`![${alt}](${url})`).scrollIntoView());
      }
      v.focus();
    };
    const handleRichImageFiles = (files: File[]) => {
      if (latest.current.viewMode === "read") return false;
      const imgFile = files.find((f) => f.type.startsWith("image/"));
      if (!imgFile) return false;
      void blobToBase64(imgFile).then((base64) => {
        latest.current.onPasteImage(
          { base64, mime: imgFile.type || "image/png", originalName: imgFile.name || "image.png" },
          insertImageIntoPM,
        );
      });
      return true;
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("textarea.pocket-block-source, .milkdown-code-block .cm-editor")) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0 && handleRichImageFiles(files)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDrop = (e: DragEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("textarea.pocket-block-source, .milkdown-code-block .cm-editor")) return;
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0 && handleRichImageFiles(files)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!ctxMenuOpenRef.current) setHideToolbar(false);
      const target = e.target as Element | null;
      if (target?.closest("textarea.pocket-block-source")) return;
      const act = matchShortcutAction(e, latest.current.shortcuts, latest.current.platform);
      if (!act) return;
      if (act === "find" || act === "replace") {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onOpenFind(act === "replace");
        return;
      }
      if (latest.current.viewMode === "read" || target?.closest(".pocket-syntax-input, input, textarea")) return;
      const v = pm.current;
      const api = richApiRef.current;
      if (!v || !api) return;

      const paraMap: Partial<Record<typeof act, BlockKind>> = {
        h1: "h1",
        h2: "h2",
        h3: "h3",
        h4: "h4",
        h5: "h5",
        h6: "h6",
        codeBlock: "code",
        mathBlock: "math",
        quote: "quote",
        orderedList: "ordered",
        bulletList: "bullet",
        taskList: "task",
      };
      const targetKind = paraMap[act];
      const codeEl = target?.closest('.milkdown-code-block[data-pocket-code-block="1"]') as
        | (HTMLElement & { __pocketGetPos?: () => number | undefined })
        | null;
      if (targetKind) {
        if (codeEl) {
          const codePos = codeEl.__pocketGetPos?.();
          const codeNode = typeof codePos === "number" ? v.state.doc.nodeAt(codePos) : null;
          if (codeNode && typeof codePos === "number") {
            e.preventDefault();
            e.stopPropagation();
            transformSelection(v, targetKind, {
              toggle: true,
              range: { from: codePos, to: codePos + codeNode.nodeSize },
              selectConverted: true,
            });
          }
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        transformSelection(v, targetKind, { toggle: true });
        return;
      }
      // 代码块内部的缩进/插行交给代码块里的 CodeMirror 自己处理
      if (codeEl) return;
      if (act === "indent" || act === "outdent") {
        const liType = v.state.schema.nodes.list_item;
        e.preventDefault();
        e.stopPropagation();
        if (liType) {
          const ran = (act === "indent" ? sinkListItem(liType) : liftListItem(liType))(v.state, v.dispatch);
          if (ran) return;
        }
        if (act === "indent") {
          v.dispatch(v.state.tr.insertText("  ").scrollIntoView());
        } else {
          const { $from } = v.state.selection;
          const start = $from.start();
          const headText = v.state.doc.textBetween(start, Math.min($from.end(), start + 2));
          const rm = headText.startsWith("  ") ? 2 : headText.startsWith("\t") || headText.startsWith(" ") ? 1 : 0;
          if (rm > 0) v.dispatch(v.state.tr.delete(start, start + rm));
        }
        return;
      }
      if ((act === "above" || act === "below") && v.state.schema.nodes.paragraph) {
        e.preventDefault();
        e.stopPropagation();
        const { $from } = v.state.selection;
        const pos = $from.depth >= 1 ? (act === "above" ? $from.before(1) : $from.after(1)) : v.state.selection.from;
        const tr = v.state.tr.insert(pos, v.state.schema.nodes.paragraph.create());
        tr.setSelection(api.nearSelection(tr.doc.resolve(Math.min(tr.doc.content.size, pos + 1))) as PMView["state"]["selection"]);
        v.dispatch(tr.scrollIntoView());
        v.focus();
      }
    };
    const onDblClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const img = target?.closest?.(".ProseMirror img:not(.ProseMirror-separator):not(.pocket-img-el)") as HTMLImageElement | null;
      if (!img) return;
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      setLightboxImg({
        src,
        origSrc: img.dataset.pocketOrigSrc ?? img.getAttribute("src") ?? src,
        alt: img.getAttribute("alt") ?? "",
      });
    };
    root.addEventListener("pointerup", onPointerUp, true);
    root.addEventListener("click", onClick, true);
    root.addEventListener("auxclick", onClick, true);
    root.addEventListener("dblclick", onDblClick, true);
    root.addEventListener("contextmenu", onContextMenu, true);
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("drop", onDrop, true);
    document.addEventListener("mousedown", onMouseDown, true);
    root.addEventListener("keydown", onKeyDown, true);
    return () => {
      root.removeEventListener("pointerup", onPointerUp, true);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("auxclick", onClick, true);
      root.removeEventListener("dblclick", onDblClick, true);
      root.removeEventListener("contextmenu", onContextMenu, true);
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("drop", onDrop, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      root.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const menuActions: EditorMenuActions = (() => {
    const area = ctxAreaRef.current;
    const v = pm.current;
    const api = richApiRef.current;

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
          if (area.isConnected) area.focus();
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
          if (kind === "frontmatter") {
            latest.current.onInsertFrontmatter();
            return;
          }
          if (kind === "paraAbove" || kind === "paraBelow") {
            const edit = insertLine(area.value, area.selectionStart, kind === "paraAbove" ? "above" : "below");
            area.setRangeText(edit.insert, edit.from, edit.from, "end");
            area.setSelectionRange(edit.anchor, edit.anchor);
            dispatchAreaInput();
            if (area.isConnected) area.focus();
            return;
          }
          if (kind === "footnote" && v && api) {
            area.blur();
            insertRichFootnote(v, api.ctx);
            return;
          }
          if ((kind === "code" || kind === "math") && area.selectionStart !== area.selectionEnd) {
            const edit = applySourceParagraph(area.value, area.selectionStart, area.selectionEnd, kind, { toggle: true });
            area.setRangeText(edit.insert, edit.from, edit.to, "end");
            area.setSelectionRange(edit.anchor, edit.head);
            dispatchAreaInput();
            if (area.isConnected) area.focus();
            return;
          }
          const lineStart = area.value.lastIndexOf("\n", area.selectionStart - 1) + 1;
          const emptyLine = area.value.slice(lineStart, area.selectionStart).trim() === "";
          const docText = v && api ? api.serialize(v.state.doc) : area.value;
          const res = buildSourceInsert(kind, latest.current.timeFormat, emptyLine, docText);
          const at = area.selectionStart;
          area.setRangeText(res.insert, at, area.selectionEnd, "end");
          const selEnd = at + res.cursorOffset + (res.selectLen ?? 0);
          area.setSelectionRange(at + res.cursorOffset, selEnd);
          dispatchAreaInput();
          if (res.appendDoc && v && v.state.schema.nodes.paragraph) {
            const endPos = v.state.doc.content.size;
            v.dispatch(v.state.tr.insert(endPos, v.state.schema.nodes.paragraph.create(null, v.state.schema.text(res.appendDoc))));
          }
          if (area.isConnected) area.focus();
        },
      };
    }

    const codeBlockPos = ctxCodeBlockPosRef.current;
    const codeCm = ctxCodeCmRef.current;
    if (codeBlockPos !== null && v && v.state.doc.nodeAt(codeBlockPos)) {
      const codeNode = v.state.doc.nodeAt(codeBlockPos)!;
      const codeRange = { from: codeBlockPos, to: codeBlockPos + codeNode.nodeSize };
      return {
        onCut: () => {
          if (!codeCm) return;
          const { from, to } = codeCm.state.selection.main;
          if (from === to) return;
          void editorClipboard.write(codeCm.state.sliceDoc(from, to));
          codeCm.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
          codeCm.focus();
        },
        onCopy: () => {
          if (codeCm) {
            const { from, to } = codeCm.state.selection.main;
            if (from !== to) void editorClipboard.write(codeCm.state.sliceDoc(from, to));
            codeCm.focus();
          } else {
            const selTxt = window.getSelection()?.toString() || codeNode.textContent;
            if (selTxt) void editorClipboard.write(selTxt);
          }
        },
        onPaste: async () => {
          if (!codeCm) return;
          const clip = await editorClipboard.read();
          if (!clip) return;
          const { from, to } = codeCm.state.selection.main;
          codeCm.dispatch({ changes: { from, to, insert: clip }, selection: { anchor: from + clip.length } });
          codeCm.focus();
        },
        onPastePlain: async () => {
          if (!codeCm) return;
          const clip = await editorClipboard.read();
          if (!clip) return;
          const { from, to } = codeCm.state.selection.main;
          codeCm.dispatch({ changes: { from, to, insert: clip }, selection: { anchor: from + clip.length } });
          codeCm.focus();
        },
        onSelectAll: () => {
          if (!codeCm) return;
          codeCm.dispatch({ selection: { anchor: 0, head: codeCm.state.doc.length } });
          codeCm.focus();
        },
        onParagraph: (kind) => {
          transformSelection(v, kind, { toggle: false, range: codeRange, selectConverted: true });
        },
        onInsert: (kind) => {
          if (kind === "code" || kind === "math") {
            transformSelection(v, kind, { toggle: true, range: codeRange, selectConverted: true });
            return;
          }
          if (kind === "frontmatter") {
            latest.current.onInsertFrontmatter();
            return;
          }
          if ((kind === "paraAbove" || kind === "paraBelow") && v.state.schema.nodes.paragraph && api) {
            const at = kind === "paraAbove" ? codeRange.from : codeRange.to;
            const tr = v.state.tr.insert(at, v.state.schema.nodes.paragraph.create());
            tr.setSelection(api.nearSelection(tr.doc.resolve(Math.min(tr.doc.content.size, at + 1))) as PMView["state"]["selection"]);
            v.dispatch(tr.scrollIntoView());
            v.focus();
          }
        },
      };
    }

    const selectedPlain = () => {
      if (!v) return "";
      const { from, to, empty } = v.state.selection;
      if (!empty) return v.state.doc.textBetween(from, to, "\n\n");
      return window.getSelection()?.toString() ?? "";
    };
    const insertBlockNode = (kind: InsertKind) => {
      if (kind === "frontmatter") {
        latest.current.onInsertFrontmatter();
        return;
      }
      if (!v || !api) return;
      if (kind === "time") {
        const stamp = formatTime(new Date(), latest.current.timeFormat);
        v.dispatch(v.state.tr.insertText(stamp).scrollIntoView());
        v.focus();
        return;
      }
      if (kind === "image") {
        const from = v.state.selection.from;
        const snippet = "![图片描述](https://)";
        const tr = v.state.tr.insertText(snippet, from, v.state.selection.to);
        tr.setSelection(api.createTextSelection(tr.doc, from + 8, from + 16) as PMView["state"]["selection"]);
        v.dispatch(tr.scrollIntoView());
        v.focus();
        return;
      }
      if (kind === "footnote") {
        insertRichFootnote(v, api.ctx);
        return;
      }
      if (kind === "linkref") {
        const id = nextLinkRefId(api.serialize(v.state.doc));
        const from = v.state.selection.from;
        const refText = `[链接文本][${id}]`;
        let tr = v.state.tr.insertText(refText, from, v.state.selection.to);
        if (v.state.schema.nodes.paragraph) {
          tr = tr.insert(tr.doc.content.size, v.state.schema.nodes.paragraph.create(null, v.state.schema.text(`[${id}]: https://`)));
        }
        tr.setSelection(api.createTextSelection(tr.doc, from + 1, from + 5) as PMView["state"]["selection"]);
        v.dispatch(tr.scrollIntoView());
        v.focus();
        return;
      }
      const { $from } = v.state.selection;
      const schema = v.state.schema;
      if ((kind === "paraAbove" || kind === "paraBelow") && schema.nodes.paragraph) {
        const pos = $from.depth >= 1 ? (kind === "paraAbove" ? $from.before(1) : $from.after(1)) : v.state.selection.from;
        const tr = v.state.tr.insert(pos, schema.nodes.paragraph.create());
        tr.setSelection(api.nearSelection(tr.doc.resolve(Math.min(tr.doc.content.size, pos + 1))) as PMView["state"]["selection"]);
        v.dispatch(tr.scrollIntoView());
        v.focus();
        return;
      }

      if ((kind === "code" || kind === "math") && schema.nodes.code_block) {
        transformSelection(v, kind, { toggle: true });
        return;
      }
      const nodesToInsert: PMNode[] = [];
      let caretDelta = 1;
      if (kind === "divider" && schema.nodes.hr && schema.nodes.paragraph) {
        nodesToInsert.push(schema.nodes.hr.create(), schema.nodes.paragraph.create());
        caretDelta = 2;
      } else if (kind === "table") {
        nodesToInsert.push(api.createTable(api.ctx, 3, 3));
        caretDelta = 3;
      } else if (kind === "toc" && schema.nodes.paragraph) {
        const tocPara = schema.nodes.paragraph.create(null, schema.text("[TOC]"));
        nodesToInsert.push(tocPara, schema.nodes.paragraph.create());
        caretDelta = tocPara.nodeSize + 1;
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
      if (!text) {
        if (!plain) {
          const imgB64 = await editorClipboard.readImage().catch(() => "");
          if (imgB64) {
            latest.current.onPasteImage(
              { base64: imgB64, mime: "image/png", originalName: "clipboard.png" },
              (url, alt) => {
                if (v.isDestroyed) return;
                const imgType = v.state.schema.nodes.image;
                if (imgType) v.dispatch(v.state.tr.replaceSelectionWith(imgType.create({ src: url, alt })).scrollIntoView());
                else v.dispatch(v.state.tr.insertText(`![${alt}](${url})`).scrollIntoView());
                v.focus();
              },
            );
          }
        }
        return;
      }
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
        transformSelection(v, kind, { toggle: false });
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
          shortcuts={props.shortcuts}
          actions={menuActions}
          onClose={() => {
            setCtxMenu(null);
            ctxAreaRef.current = null;
            ctxCodeBlockPosRef.current = null;
            ctxCodeCmRef.current = null;
          }}
        />
      )}
      {lightboxImg && <ImageLightbox image={lightboxImg} onClose={() => setLightboxImg(null)} />}
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
