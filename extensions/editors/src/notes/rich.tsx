import { useEffect, useRef, useState } from "preact/hooks";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { ArrowDown, ArrowUp, Check, Code, Copy, Heading1, Heading2, Heading3, Heading4, List, ListChecks, ListOrdered, Pilcrow, Quote, Trash2 } from "lucide-preact";
import { blockSourcePlugin } from "./blocksource";
import { blankLinesPlugin, configureBlankLines, remarkBlankLines, restoreBlankLinesOnMarkdown } from "./blanklines";
import { configurePocketHtml, pocketHtmlPlugins } from "./htmlrender";
import { liveInlinePlugin } from "./liveinline";
import { previewDocument } from "./html-preview";
import { noteLineKeys, type NoteShortcuts } from "./shortcuts";
import { languages } from "../code/languages";
import { type BlockKind, canMove, convertible, duplicateBlock, kindOf, moveBlock, removeBlock, turnInto } from "./blockops";

export interface RichProps {
  value: string;
  revealSource: boolean;
  shortcuts: NoteShortcuts;
  htmlPreview: boolean;
  onChange: (md: string) => void;
  spellcheck: boolean;
  /** Ctrl / ⌘ + 点击链接。 */
  onOpenLink: (href: string) => void;
  onToast: (text: string, error?: boolean) => void;
  /** 重建之后恢复到这个滚动位置（别的窗口改了同一篇笔记时用）。 */
  scrollTop?: number;
}

interface MenuState {
  pos: number;
  x: number;
  y: number;
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

/** 所见即所得的编辑器（Milkdown）。打开笔记时才加载，换一篇就重建。 */
export function RichEditor(props: RichProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const pm = useRef<PMView | null>(null);
  const active = useRef(-1); // 块手柄当前指着的块
  const [preview, setPreview] = useState("");
  const [failed, setFailed] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const [{ Crepe }, { editorViewCtx }, { remarkPreserveEmptyLinePlugin }, { remarkGFMPlugin }, { LanguageDescription, LanguageSupport, Language }, cm, marks, toc] = await Promise.all([
          import("@milkdown/crepe"),
          import("@milkdown/kit/core"),
          import("@milkdown/kit/preset/commonmark"),
          import("@milkdown/kit/preset/gfm"),
          import("@codemirror/language"),
          import("../code/editor"),
          import("./marks"),
          import("./toc"),
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
              blockHandle: {
                getOffset: () => 8,
                // 手柄每次挪到一个块旁边都会问一下放哪儿：顺便记下它指着的是哪个块，点手柄时要用。
                getPlacement: ({ active: block, blockDom }) => {
                  active.current = block.$pos.pos;
                  if (block.node.type.name === "heading") return "left";
                  let descendants = 0;
                  block.node.descendants((node) => {
                    descendants += node.childCount;
                  });
                  const style = window.getComputedStyle(block.el);
                  const height = block.el.getBoundingClientRect().height - (Number.parseInt(style.paddingTop, 10) || 0) - (Number.parseInt(style.paddingBottom, 10) || 0);
                  return descendants > 2 || blockDom.getBoundingClientRect().height < height ? "left-start" : "left";
                },
              },
            },
          },
        });
        crepe.editor
          .config((ctx) => {
            // 单个波浪线留给下标（H~2~O），删除线用两个。
            ctx.set(remarkGFMPlugin.options.key, { singleTilde: false });
            marks.configurePocketMarks(ctx);
            configureBlankLines(ctx);
            configurePocketHtml(ctx, { isLive: () => !latest.current.revealSource });
          })
          .use(marks.pocketMarks)
          .use(pocketHtmlPlugins)
          .use(remarkBlankLines)
          .use(blankLinesPlugin)
          .use(toc.tocPlugin)
          .use(liveInlinePlugin(() => ({ enabled: !latest.current.revealSource })))
          .use(blockSourcePlugin(() => ({ enabled: latest.current.revealSource, shortcuts: latest.current.shortcuts })));
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
        await crepe.create();
        if (!alive) {
          void crepe.destroy();
          return;
        }
        const view = crepe.editor.ctx.get(editorViewCtx);
        pm.current = view;
        const refreshPreview = () => {
          if (latest.current.htmlPreview) setPreview(previewDocument(view.state.doc, document.documentElement.dataset.theme === "dark"));
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
    if (props.htmlPreview && pm.current) setPreview(previewDocument(pm.current.state.doc, document.documentElement.dataset.theme === "dark"));
  }, [props.htmlPreview]);

  useEffect(() => {
    const view = pm.current;
    if (view) view.dispatch(view.state.tr.setMeta("pocket-mode-switch", props.revealSource));
  }, [props.revealSource]);

  // 点块手柄（六个点的那个）打开块菜单；Ctrl / ⌘ + 点击链接用系统浏览器打开。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      const handle = target.closest?.(".milkdown-block-handle .operation-item:last-child");
      if (handle && pm.current && active.current >= 0 && pm.current.state.doc.nodeAt(active.current)) {
        e.preventDefault();
        e.stopPropagation();
        const r = handle.getBoundingClientRect();
        setMenu({ pos: active.current, x: r.left, y: r.bottom + 4 });
        return;
      }
      const link = target.closest?.(".ProseMirror a[href]");
      if (link && (e.metaKey || e.ctrlKey || e.button === 1)) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onOpenLink(link.getAttribute("href") ?? "");
      }
    };
    root.addEventListener("click", onClick, true);
    root.addEventListener("auxclick", onClick, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("auxclick", onClick, true);
    };
  }, []);

  if (failed) return <div class="pk-empty">阅读模式编辑器加载失败（{failed}），可以先切到源码模式。</div>;
  return (
    <>
      <div class="fx-notes-rich" ref={host} style={props.htmlPreview ? { display: "none" } : undefined} />
      {props.htmlPreview && <iframe class="pocket-html-preview" title="Markdown HTML/CSS 预览" sandbox="" srcDoc={preview} />}
      {menu && pm.current && <BlockMenu view={pm.current} at={menu} onClose={() => setMenu(null)} />}
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
