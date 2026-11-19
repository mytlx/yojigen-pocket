import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Bookmark,
  Check,
  ChevronRight,
  ClipboardCopy,
  ClipboardPaste,
  Clock,
  Code,
  Copy,
  Eraser,
  ExternalLink,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Highlighter,
  Image,
  Italic,
  Link,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Minus,
  Pilcrow,
  Plus,
  Quote,
  Scissors,
  Sigma,
  Strikethrough,
  Table,
  TextSelect,
  Underline,
} from "lucide-preact";
import type { BlockKind, FormatKind, InsertKind } from "./blockops";
import type { NoteShortcuts } from "./shortcuts";
import { formatTime } from "./timefmt";

export type { FormatKind, InsertKind };
type SubMenuId = "copyPasteAs" | "paragraph" | "insert";

export interface EditorMenuTarget {
  x: number;
  y: number;
  readonly: boolean;
  hasSelection: boolean;
  canCopyMarkdown: boolean;
  linkHref?: string;
  currentBlockKind?: BlockKind | "";
  canConvertBlock?: boolean;
}

export interface EditorMenuActions {
  onOpenLink?: (href: string) => void;
  onCopyLink?: (href: string) => void;
  onCut?: () => void;
  onCopy: () => void;
  onCopyMarkdown?: () => void;
  onPaste?: () => void;
  onPastePlain?: () => void;
  onSelectAll: () => void;
  onFormat?: (kind: FormatKind) => void;
  onParagraph?: (kind: BlockKind) => void;
  onInsert?: (kind: InsertKind) => void;
}

const PARA_ITEMS: { kind: BlockKind; label: string; icon: typeof Pilcrow }[] = [
  { kind: "text", label: "正文", icon: Pilcrow },
  { kind: "h1", label: "标题 1", icon: Heading1 },
  { kind: "h2", label: "标题 2", icon: Heading2 },
  { kind: "h3", label: "标题 3", icon: Heading3 },
  { kind: "h4", label: "标题 4", icon: Heading4 },
  { kind: "h5", label: "标题 5", icon: Heading5 },
  { kind: "h6", label: "标题 6", icon: Heading6 },
  { kind: "quote", label: "引用", icon: Quote },
  { kind: "bullet", label: "无序列表", icon: List },
  { kind: "ordered", label: "有序列表", icon: ListOrdered },
  { kind: "task", label: "待办", icon: ListChecks },
];

const QUICK_FORMAT_ICONS: { kind: Exclude<FormatKind, "clear">; label: string; icon: typeof Bold }[] = [
  { kind: "bold", label: "加粗", icon: Bold },
  { kind: "italic", label: "斜体", icon: Italic },
  { kind: "strike", label: "删除线", icon: Strikethrough },
  { kind: "code", label: "行内代码", icon: Code },
  { kind: "mark", label: "高亮", icon: Highlighter },
  { kind: "underline", label: "下划线", icon: Underline },
  { kind: "link", label: "链接", icon: Link },
  { kind: "math", label: "行内公式", icon: Sigma },
];

function MenuItem(props: { icon: ComponentChildren; label: string; hint?: string; disabled?: boolean; current?: boolean; onEnter?: () => void; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      class={`fx-menu-item${props.current ? " is-current" : ""}`}
      disabled={props.disabled}
      onMouseEnter={props.onEnter}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
      {props.hint && <kbd class="fx-menu-kbd">{props.hint}</kbd>}
      {props.current && <Check size={12} class="fx-menu-check" />}
    </button>
  );
}

/** 类 Typora 编辑器右键菜单：剪贴板、一级 2×4 格式快捷图标 + 单列清除格式、段落与丰富插入子菜单。 */
export function EditorContextMenu(props: {
  menu: EditorMenuTarget;
  platform: string;
  timeFormat: string;
  shortcuts?: NoteShortcuts;
  actions: EditorMenuActions;
  onClose: () => void;
}) {
  const { menu, actions, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<SubMenuId, HTMLDivElement | null>>({ copyPasteAs: null, paragraph: null, insert: null });
  const [place, setPlace] = useState({ left: menu.x, top: menu.y });
  const [openSub, setOpenSub] = useState<SubMenuId | null>(null);
  const [subPlace, setSubPlace] = useState({ left: 0, top: 0 });
  const closeSubTimer = useRef<number>(0);

  const mod = props.platform === "darwin" ? "⌘" : "Ctrl+";
  const pastePlainHint = props.platform === "darwin" ? "⇧⌘V" : "Ctrl+Shift+V";
  const timePreview = formatTime(new Date(), props.timeFormat);
  const showCopyPasteSub =
    (menu.canCopyMarkdown && !!actions.onCopyMarkdown) || (!menu.readonly && !!actions.onPastePlain);

  useLayoutEffect(() => {
    setOpenSub(null);
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPlace({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6)),
    });
  }, [menu.x, menu.y, menu.readonly, menu.hasSelection, menu.linkHref]);

  useLayoutEffect(() => {
    if (!openSub) return;
    const trig = triggerRefs.current[openSub];
    const sub = subRef.current;
    if (!trig || !sub) return;
    const tr = trig.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    const fitsRight = tr.right + sr.width + 6 <= window.innerWidth;
    const left = fitsRight ? tr.right + 2 : Math.max(6, tr.left - sr.width - 2);
    const top = Math.max(6, Math.min(tr.top - 5, window.innerHeight - sr.height - 6));
    setSubPlace({ left, top });
  }, [openSub, place]);

  useEffect(() => {
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
    const scrollAway = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrollAway, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.clearTimeout(closeSubTimer.current);
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrollAway, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const enterItem = () => {
    window.clearTimeout(closeSubTimer.current);
    setOpenSub(null);
  };
  const enterSub = (id: SubMenuId) => {
    window.clearTimeout(closeSubTimer.current);
    setOpenSub(id);
  };
  const leaveSubWrap = () => {
    window.clearTimeout(closeSubTimer.current);
    closeSubTimer.current = window.setTimeout(() => setOpenSub(null), 120);
  };

  const run = (fn?: () => void) => () => {
    if (!fn) return;
    onClose();
    fn();
  };

  const renderSubMenu = (id: SubMenuId) => {
    if (openSub !== id) return null;
    return (
      <div
        class="fx-menu fx-submenu"
        ref={subRef}
        role="menu"
        style={{ left: `${subPlace.left}px`, top: `${subPlace.top}px` }}
        onMouseEnter={() => window.clearTimeout(closeSubTimer.current)}
      >
        {id === "copyPasteAs" && (
          <>
            {menu.canCopyMarkdown && actions.onCopyMarkdown && (
              <MenuItem
                icon={<Copy size={14} />}
                label="复制为 Markdown"
                disabled={!menu.hasSelection}
                onClick={run(actions.onCopyMarkdown)}
              />
            )}
            {!menu.readonly && actions.onPastePlain && (
              <MenuItem
                icon={<ClipboardPaste size={14} />}
                label="粘贴为纯文本"
                hint={pastePlainHint}
                onClick={run(actions.onPastePlain)}
              />
            )}
          </>
        )}
        {id === "paragraph" &&
          PARA_ITEMS.map(({ kind, label, icon: Icon }) => (
            <MenuItem
              key={kind}
              icon={<Icon size={14} />}
              label={label}
              current={menu.currentBlockKind === kind}
              onClick={run(() => actions.onParagraph?.(kind))}
            />
          ))}
        {id === "insert" && (
          <>
            <MenuItem
              icon={<Clock size={14} />}
              label="当前时间"
              hint={timePreview}
              onClick={run(() => actions.onInsert?.("time"))}
            />
            <div class="fx-menu-sep" />
            <MenuItem icon={<Image size={14} />} label="图像" onClick={run(() => actions.onInsert?.("image"))} />
            <MenuItem icon={<Bookmark size={14} />} label="脚注" onClick={run(() => actions.onInsert?.("footnote"))} />
            <MenuItem icon={<Link2 size={14} />} label="链接引用" onClick={run(() => actions.onInsert?.("linkref"))} />
            <MenuItem icon={<Minus size={14} />} label="水平分割线" onClick={run(() => actions.onInsert?.("divider"))} />
            <MenuItem icon={<Table size={14} />} label="表格" onClick={run(() => actions.onInsert?.("table"))} />
            <MenuItem icon={<Code size={14} />} label="代码块" onClick={run(() => actions.onInsert?.("code"))} />
            <MenuItem icon={<Sigma size={14} />} label="公式块" onClick={run(() => actions.onInsert?.("math"))} />
            <MenuItem icon={<ListTree size={14} />} label="内容目录" onClick={run(() => actions.onInsert?.("toc"))} />
            <MenuItem icon={<FileCode2 size={14} />} label="YAML Front Matter" onClick={run(() => actions.onInsert?.("frontmatter"))} />
            <div class="fx-menu-sep" />
            <MenuItem
              icon={<ArrowUpToLine size={14} />}
              label="段落（上方）"
              hint={props.shortcuts?.above}
              onClick={run(() => actions.onInsert?.("paraAbove"))}
            />
            <MenuItem
              icon={<ArrowDownToLine size={14} />}
              label="段落（下方）"
              hint={props.shortcuts?.below}
              onClick={run(() => actions.onInsert?.("paraBelow"))}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div
      class="fx-menu fx-editor-menu"
      ref={box}
      role="menu"
      style={{ left: `${place.left}px`, top: `${place.top}px` }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={leaveSubWrap}
    >
      {menu.linkHref && (
        <>
          <MenuItem icon={<ExternalLink size={14} />} label="打开链接" onEnter={enterItem} onClick={run(() => actions.onOpenLink?.(menu.linkHref!))} />
          <MenuItem icon={<Copy size={14} />} label="复制链接地址" onEnter={enterItem} onClick={run(() => actions.onCopyLink?.(menu.linkHref!))} />
          <div class="fx-menu-sep" />
        </>
      )}

      {!menu.readonly && actions.onCut && (
        <MenuItem icon={<Scissors size={14} />} label="剪切" hint={`${mod}X`} disabled={!menu.hasSelection} onEnter={enterItem} onClick={run(actions.onCut)} />
      )}
      <MenuItem icon={<Copy size={14} />} label="复制" hint={`${mod}C`} disabled={!menu.hasSelection} onEnter={enterItem} onClick={run(actions.onCopy)} />
      {!menu.readonly && actions.onPaste && (
        <MenuItem icon={<ClipboardPaste size={14} />} label="粘贴" hint={`${mod}V`} onEnter={enterItem} onClick={run(actions.onPaste)} />
      )}
      {showCopyPasteSub && (
        <div
          class="fx-menu-sub-wrap"
          ref={(el) => {
            triggerRefs.current.copyPasteAs = el;
          }}
          onMouseEnter={() => enterSub("copyPasteAs")}
        >
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openSub === "copyPasteAs"}
            class={`fx-menu-item fx-menu-sub-trigger${openSub === "copyPasteAs" ? " is-active" : ""}`}
            onClick={() => setOpenSub((s) => (s === "copyPasteAs" ? null : "copyPasteAs"))}
          >
            <ClipboardCopy size={14} />
            <span>复制 / 粘贴为…</span>
            <ChevronRight size={13} class="fx-menu-arrow" />
          </button>
          {renderSubMenu("copyPasteAs")}
        </div>
      )}
      <MenuItem icon={<TextSelect size={14} />} label="全选" hint={`${mod}A`} onEnter={enterItem} onClick={run(actions.onSelectAll)} />

      {!menu.readonly && (
        <>
          {actions.onFormat && (
            <>
              <div class="fx-menu-sep" />
              <div class="fx-menu-icon-grid" role="group" aria-label="快捷格式" onMouseEnter={enterItem}>
                {QUICK_FORMAT_ICONS.map(({ kind, label, icon: Icon }) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    class="fx-menu-icon-btn"
                    title={label}
                    aria-label={label}
                    onClick={run(() => actions.onFormat?.(kind))}
                  >
                    <Icon size={14} />
                  </button>
                ))}
              </div>
              <MenuItem icon={<Eraser size={14} />} label="清除格式" onEnter={enterItem} onClick={run(() => actions.onFormat?.("clear"))} />
            </>
          )}
          <div class="fx-menu-sep" />
          {actions.onParagraph && (
            <div
              class="fx-menu-sub-wrap"
              ref={(el) => {
                triggerRefs.current.paragraph = el;
              }}
              onMouseEnter={() => enterSub("paragraph")}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === "paragraph"}
                disabled={menu.canConvertBlock === false}
                class={`fx-menu-item fx-menu-sub-trigger${openSub === "paragraph" ? " is-active" : ""}`}
                onClick={() => menu.canConvertBlock !== false && setOpenSub((s) => (s === "paragraph" ? null : "paragraph"))}
              >
                <Pilcrow size={14} />
                <span>段落</span>
                <ChevronRight size={13} class="fx-menu-arrow" />
              </button>
              {menu.canConvertBlock !== false && renderSubMenu("paragraph")}
            </div>
          )}
          {actions.onInsert && (
            <div
              class="fx-menu-sub-wrap"
              ref={(el) => {
                triggerRefs.current.insert = el;
              }}
              onMouseEnter={() => enterSub("insert")}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === "insert"}
                class={`fx-menu-item fx-menu-sub-trigger${openSub === "insert" ? " is-active" : ""}`}
                onClick={() => setOpenSub((s) => (s === "insert" ? null : "insert"))}
              >
                <Plus size={14} />
                <span>插入</span>
                <ChevronRight size={13} class="fx-menu-arrow" />
              </button>
              {renderSubMenu("insert")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
