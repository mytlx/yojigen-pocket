import { lift, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { liftListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** 块菜单里的操作：把一个块转换成别的类型、复制、上下移动、删除。pos 是块在文档里的起始位置。 */

export type BlockKind = "text" | "h1" | "h2" | "h3" | "h4" | "bullet" | "ordered" | "task" | "quote" | "code";

/** 这个块现在是什么（菜单里给当前类型打勾）。认不出来的返回空串。 */
export function kindOf(view: EditorView, pos: number): BlockKind | "" {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return "";
  switch (node.type.name) {
    case "paragraph":
      return "text";
    case "heading":
      return (["h1", "h2", "h3", "h4"] as const)[(node.attrs.level as number) - 1] ?? "";
    case "blockquote":
      return "quote";
    case "code_block":
      return "code";
    case "list_item": {
      if (node.attrs.checked != null) return "task";
      const parent = view.state.doc.resolve(pos).parent;
      return parent.type.name === "ordered_list" ? "ordered" : "bullet";
    }
  }
  return "";
}

/** 能不能转换类型：表格、分割线、图片这些只能移动和删除。 */
export function convertible(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return false;
  // 公式块是特殊语言的代码块，转成别的会丢掉公式的含义。
  if (node.type.name === "code_block") return !/^latex$/i.test(String(node.attrs.language ?? ""));
  return node.isTextblock || node.type.name === "list_item" || node.type.name === "blockquote";
}

export function turnInto(view: EditorView, pos: number, kind: BlockKind) {
  const run = (cmd: (state: EditorView["state"], dispatch: EditorView["dispatch"]) => boolean) => cmd(view.state, view.dispatch);
  const start = view.state.doc.nodeAt(pos);
  if (!start || start.nodeSize < 2) return;
  const n = view.state.schema.nodes;

  // 列表项在同一种列表里换成待办 / 普通项：只改一个属性，不把列表拆开。
  if (start.type.name === "list_item" && (kind === "task" || kind === "bullet" || kind === "ordered")) {
    const parent = view.state.doc.resolve(pos).parent;
    const wantOrdered = kind === "ordered";
    if ((parent.type.name === "ordered_list") === wantOrdered || kind === "task") {
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...start.attrs, checked: kind === "task" ? false : null }));
      view.focus();
      return;
    }
  }

  const doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(pos + 1), doc.resolve(pos + start.nodeSize - 1))));
  // 先从列表、引用里拿出来，变成最外层的普通块，再换成目标类型。
  for (let i = 0; i < 12 && view.state.selection.$from.depth > 1; i++) {
    if (!(run(liftListItem(n.list_item!)) || run(lift))) break;
  }
  const paragraph = () => run(setBlockType(n.paragraph!));
  switch (kind) {
    case "text":
      paragraph();
      break;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
      run(setBlockType(n.heading!, { level: Number(kind[1]) }));
      break;
    case "code":
      run(setBlockType(n.code_block!));
      break;
    case "quote":
      paragraph();
      run(wrapIn(n.blockquote!));
      break;
    case "bullet":
    case "ordered":
    case "task": {
      paragraph();
      run(wrapInList(kind === "ordered" ? n.ordered_list! : n.bullet_list!));
      if (kind === "task") {
        const { from, to } = view.state.selection;
        const tr = view.state.tr;
        view.state.doc.nodesBetween(from, to, (node, at) => {
          if (node.type === n.list_item) tr.setNodeMarkup(at, undefined, { ...node.attrs, checked: false });
        });
        view.dispatch(tr);
      }
      break;
    }
  }
  view.focus();
}

export function duplicateBlock(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(view.state.tr.insert(pos + node.nodeSize, node.type.create(node.attrs, node.content, node.marks)).scrollIntoView());
}

export function removeBlock(view: EditorView, pos: number) {
  const { doc, schema } = view.state;
  const node = doc.nodeAt(pos);
  if (!node) return;
  const $pos = doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  // 它是父节点里唯一的一项（比如只有一项的列表）：连父节点一起删，不留下空壳。
  let depth = $pos.depth;
  while (depth > 0 && $pos.node(depth).childCount === 1) {
    from = $pos.before(depth);
    to = $pos.after(depth);
    depth--;
  }
  const tr = view.state.tr;
  if (depth === 0 && doc.childCount === 1) tr.replaceWith(from, to, schema.nodes.paragraph!.create());
  else tr.delete(from, to);
  view.dispatch(tr);
  view.focus();
}

/** 往上（-1）或往下（1）挪一位。到头了返回 false。 */
export function moveBlock(view: EditorView, pos: number, dir: -1 | 1): boolean {
  const { doc } = view.state;
  const node = doc.nodeAt(pos);
  if (!node) return false;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const parent = $pos.parent;
  const other: PMNode | null = dir < 0 ? (index > 0 ? parent.child(index - 1) : null) : index < parent.childCount - 1 ? parent.child(index + 1) : null;
  if (!other) return false;
  const target = dir < 0 ? pos - other.nodeSize : pos + other.nodeSize;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).insert(target, node).scrollIntoView());
  return true;
}

/** 能不能往这个方向挪（菜单里把不能点的置灰）。 */
export function canMove(view: EditorView, pos: number, dir: -1 | 1): boolean {
  const $pos = view.state.doc.resolve(pos);
  return dir < 0 ? $pos.index() > 0 : $pos.index() < $pos.parent.childCount - 1;
}
