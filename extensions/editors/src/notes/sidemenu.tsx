import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-preact";
import type { Node as FileNode } from "../host";
import { Btn } from "../../../../src/features/ui";

export type SideMenuTarget =
  | { kind: "empty"; x: number; y: number }
  | { kind: "dir"; node: FileNode; nestedDirs: string[]; x: number; y: number }
  | { kind: "file"; node: FileNode; x: number; y: number }
  | { kind: "batch"; paths: string[]; dirRoots: string[]; nestedDirs: string[]; x: number; y: number };

export interface SideMenuActions {
  onNewNote: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onExpandAll: (expand: boolean) => void;
  onSetDirsOpen: (roots: string[], expand: boolean) => void;
  onOpenNote: (path: string) => void;
  onRename: (path: string) => void;
  onDuplicate: (path: string) => void;
  onMoveToRoot: (path: string) => void;
  onCopyName: (node: FileNode) => void;
  onCopyPath: (path: string) => void;
  onCopyFullPath: (path: string) => void;
  onCopyContent: (path: string) => void;
  onOpenOutside: (path: string, how: "open" | "openWith" | "reveal") => void;
  onRevealRoot: () => void;
  onRefresh: () => void;
  onResetWidths: () => void;
  onDelete: (paths: string[]) => void;
  onClearSelection: () => void;
}

export interface PendingDeleteItem {
  path: string;
  label: string;
  isDir: boolean;
}

function MenuItem(props: { icon: ComponentChildren; label: string; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" class={`fx-menu-item${props.danger ? " is-danger" : ""}`} disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
      {props.hint && <kbd class="fx-menu-kbd">{props.hint}</kbd>}
    </button>
  );
}

/** 文件栏右键菜单：区分空白处、单个文件夹、单个文件与多选批量四类上下文。 */
export function SideContextMenu(props: {
  menu: SideMenuTarget;
  currentPath: string;
  openDirs: Record<string, boolean>;
  hasDirs: boolean;
  canResetWidths: boolean;
  actions: SideMenuActions;
  onClose: () => void;
}) {
  const { menu, actions, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPlace({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6)),
    });
  }, [menu.x, menu.y, menu.kind]);

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
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div
      class="fx-menu fx-side-menu"
      ref={box}
      role="menu"
      style={{ left: `${place.left}px`, top: `${place.top}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "empty" && (
        <>
          <MenuItem icon={<Plus size={14} />} label="新建笔记" onClick={run(() => actions.onNewNote(""))} />
          <MenuItem icon={<FolderPlus size={14} />} label="新建文件夹" onClick={run(() => actions.onNewFolder(""))} />
          {props.hasDirs && (
            <>
              <div class="fx-menu-sep" />
              <MenuItem icon={<ChevronsUpDown size={14} />} label="全部展开文件夹" onClick={run(() => actions.onExpandAll(true))} />
              <MenuItem icon={<ChevronsDownUp size={14} />} label="全部收起文件夹" onClick={run(() => actions.onExpandAll(false))} />
            </>
          )}
          <div class="fx-menu-sep" />
          <MenuItem icon={<FolderOpen size={14} />} label="在文件夹中显示" onClick={run(actions.onRevealRoot)} />
          <MenuItem icon={<RefreshCw size={14} />} label="刷新列表" onClick={run(actions.onRefresh)} />
          <div class="fx-menu-sep" />
          <MenuItem icon={<RotateCcw size={14} />} label="恢复默认栏宽" disabled={!props.canResetWidths} onClick={run(actions.onResetWidths)} />
        </>
      )}

      {menu.kind === "dir" && (
        <>
          <MenuItem icon={<Plus size={14} />} label="在此新建笔记" onClick={run(() => actions.onNewNote(menu.node.path))} />
          <MenuItem icon={<FolderPlus size={14} />} label="在此新建子文件夹" onClick={run(() => actions.onNewFolder(menu.node.path))} />
          {(!props.openDirs[menu.node.path] || menu.nestedDirs.some((d) => !props.openDirs[d])) && (
            <MenuItem icon={<ChevronsUpDown size={14} />} label="展开文件夹" onClick={run(() => actions.onSetDirsOpen([menu.node.path], true))} />
          )}
          {props.openDirs[menu.node.path] && (
            <MenuItem icon={<ChevronsDownUp size={14} />} label="收起文件夹" onClick={run(() => actions.onSetDirsOpen([menu.node.path], false))} />
          )}
          <div class="fx-menu-sep" />
          <MenuItem icon={<Copy size={14} />} label="复制文件夹名" onClick={run(() => actions.onCopyName(menu.node))} />
          <MenuItem icon={<Copy size={14} />} label="复制相对路径" onClick={run(() => actions.onCopyPath(menu.node.path))} />
          <MenuItem icon={<Copy size={14} />} label="复制完整路径" onClick={run(() => actions.onCopyFullPath(menu.node.path))} />
          <MenuItem icon={<Pencil size={14} />} label="重命名" onClick={run(() => actions.onRename(menu.node.path))} />
          <MenuItem icon={<FolderOpen size={14} />} label="在文件夹中显示" onClick={run(() => actions.onOpenOutside(menu.node.path, "reveal"))} />
          <div class="fx-menu-sep" />
          <MenuItem icon={<Trash2 size={14} />} label="删除（移到废纸篓）" hint="Del" danger onClick={run(() => actions.onDelete([menu.node.path]))} />
        </>
      )}

      {menu.kind === "file" && (() => {
        const parentDir = menu.node.path.includes("/") ? menu.node.path.slice(0, menu.node.path.lastIndexOf("/")) : "";
        return (
          <>
            {menu.node.path !== props.currentPath && (
              <MenuItem icon={<FileText size={14} />} label="打开笔记" onClick={run(() => actions.onOpenNote(menu.node.path))} />
            )}
            <MenuItem icon={<Plus size={14} />} label="新建文件" onClick={run(() => actions.onNewNote(parentDir))} />
            <MenuItem icon={<FolderPlus size={14} />} label="新建文件夹" onClick={run(() => actions.onNewFolder(parentDir))} />
            <div class="fx-menu-sep" />
            <MenuItem icon={<Pencil size={14} />} label="重命名" onClick={run(() => actions.onRename(menu.node.path))} />
            <MenuItem icon={<CopyPlus size={14} />} label="创建副本" onClick={run(() => actions.onDuplicate(menu.node.path))} />
            {menu.node.path.includes("/") && (
              <MenuItem icon={<FolderUp size={14} />} label="移到根目录" onClick={run(() => actions.onMoveToRoot(menu.node.path))} />
            )}
            <div class="fx-menu-sep" />
            <MenuItem icon={<Copy size={14} />} label="复制文件名" onClick={run(() => actions.onCopyName(menu.node))} />
            <MenuItem icon={<Copy size={14} />} label="复制相对路径" onClick={run(() => actions.onCopyPath(menu.node.path))} />
            <MenuItem icon={<Copy size={14} />} label="复制完整路径" onClick={run(() => actions.onCopyFullPath(menu.node.path))} />
            <MenuItem icon={<Copy size={14} />} label="复制 Markdown 内容" onClick={run(() => actions.onCopyContent(menu.node.path))} />
            <div class="fx-menu-sep" />
            <MenuItem icon={<ExternalLink size={14} />} label="用默认应用打开" onClick={run(() => actions.onOpenOutside(menu.node.path, "open"))} />
            <MenuItem icon={<SquareArrowOutUpRight size={14} />} label="用其他应用打开…" onClick={run(() => actions.onOpenOutside(menu.node.path, "openWith"))} />
            <MenuItem icon={<FolderOpen size={14} />} label="在文件夹中显示" onClick={run(() => actions.onOpenOutside(menu.node.path, "reveal"))} />
            <div class="fx-menu-sep" />
            <MenuItem icon={<Trash2 size={14} />} label="删除（移到废纸篓）" hint="Del" danger onClick={run(() => actions.onDelete([menu.node.path]))} />
          </>
        );
      })()}

      {menu.kind === "batch" && (
        <>
          <div class="fx-menu-label">已选中 {menu.paths.length} 项</div>
          {menu.dirRoots.length > 0 && (
            <>
              {menu.nestedDirs.some((d) => !props.openDirs[d]) && (
                <MenuItem icon={<ChevronsUpDown size={14} />} label="展开选中文件夹" onClick={run(() => actions.onSetDirsOpen(menu.dirRoots, true))} />
              )}
              {menu.nestedDirs.some((d) => !!props.openDirs[d]) && (
                <MenuItem icon={<ChevronsDownUp size={14} />} label="收起选中文件夹" onClick={run(() => actions.onSetDirsOpen(menu.dirRoots, false))} />
              )}
              <div class="fx-menu-sep" />
            </>
          )}
          <MenuItem
            icon={<Trash2 size={14} />}
            label={`批量删除（${menu.paths.length} 项）`}
            hint="Del"
            danger
            onClick={run(() => actions.onDelete(menu.paths))}
          />
          <MenuItem icon={<RotateCcw size={14} />} label="取消选择" onClick={run(actions.onClearSelection)} />
        </>
      )}
    </div>
  );
}

/** 统一删除二次确认对话框：支持单删、文件夹与批量删除，Enter 确认、Esc 取消。 */
export function DeleteConfirmModal(props: { items: PendingDeleteItem[]; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmWrapRef = useRef<HTMLDivElement>(null);
  const hasDir = props.items.some((i) => i.isDir);
  const preview = props.items.slice(0, 5);
  const extra = props.items.length - preview.length;

  useEffect(() => {
    confirmWrapRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      } else if (e.key === "Enter" && !props.busy) {
        if (cancelRef.current && e.target === cancelRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        props.onConfirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props.onCancel, props.onConfirm, props.busy]);

  return (
    <div class="fx-confirm-backdrop" role="dialog" aria-modal="true" aria-label="确认删除" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="fx-confirm-dialog">
        <div class="fx-confirm-title">{props.items.length === 1 ? `确定删除「${props.items[0]!.label}」？` : `确定删除选中的 ${props.items.length} 项？`}</div>
        <div class="fx-confirm-desc">
          <p>{hasDir ? "所选条目（包含文件夹内的全部笔记）将被移到系统废纸篓，可从废纸篓恢复。" : "所选笔记将被移到系统废纸篓，可从废纸篓恢复。"}</p>
          {props.items.length > 1 && (
            <ul class="fx-confirm-list">
              {preview.map((it) => (
                <li key={it.path}>
                  {it.isDir ? "📁" : "📄"} {it.label}
                </li>
              ))}
              {extra > 0 && <li class="is-more">……以及其他 {extra} 项</li>}
            </ul>
          )}
        </div>
        <div class="fx-confirm-actions">
          <button ref={cancelRef} type="button" class="ui-btn is-small" disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
          <span ref={confirmWrapRef}>
            <Btn small primary danger disabled={props.busy} onClick={props.onConfirm}>
              {props.busy ? "正在删除…" : "移到废纸篓"}
            </Btn>
          </span>
        </div>
      </div>
    </div>
  );
}
