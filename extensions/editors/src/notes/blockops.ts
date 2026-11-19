import { Fragment, type Node as PMNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { formatTime } from "./timefmt";

/** 块级与多行选区转换操作：支持单块、跨多块、段内软换行、列表/引用/代码块/公式块/标题/正文之间双向互转。 */

export type BlockKind = "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "bullet" | "ordered" | "task" | "quote" | "code" | "math";
export type FormatKind = "bold" | "italic" | "strike" | "code" | "mark" | "underline" | "link" | "math" | "clear";
export type InsertKind =
  | "time"
  | "image"
  | "footnote"
  | "linkref"
  | "divider"
  | "table"
  | "code"
  | "math"
  | "toc"
  | "frontmatter"
  | "paraAbove"
  | "paraBelow";

function isMathCodeBlock(node: PMNode): boolean {
  return node.type.name === "code_block" && /^latex$/i.test(String(node.attrs.language ?? ""));
}

/** 这个块现在是什么（菜单里给当前类型打勾）。认不出来的返回空串。 */
export function kindOf(view: EditorView, pos: number): BlockKind | "" {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return "";
  switch (node.type.name) {
    case "paragraph":
      return "text";
    case "heading":
      return (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[(node.attrs.level as number) - 1] ?? "";
    case "blockquote":
      return "quote";
    case "code_block":
      return isMathCodeBlock(node) ? "math" : "code";
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
  return node.isTextblock || node.type.name === "list_item" || node.type.name === "blockquote";
}

interface ExtractedUnit {
  /** 段内行内节点（保留加粗/斜体/链接/高亮等行内样式） */
  inline: Fragment;
  /** 纯文本（转换到代码块/公式块时使用，软换行还原为 \n） */
  plainText: string;
  /** 原块类型（用于判定全选同类时的 toggle 还原） */
  kind: BlockKind;
  /** 若原节点是标题，保留其级别（供转为引用时原样保留结构） */
  headingLevel?: number;
  /** 非文本块（如引用内的嵌套表格/分割线）原样携带 */
  rawNode?: PMNode;
}

function inlineFragmentToPlainText(frag: Fragment): string {
  let out = "";
  frag.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardbreak") out += "\n";
    else if (child.type.name === "math_inline") out += `$${String(child.attrs.value ?? "")}$`;
    else if (child.type.name === "image") out += `![${String(child.attrs.alt ?? "")}](${String(child.attrs.src ?? "")})`;
    else out += child.textContent;
  });
  return out;
}

/** 把包含 hardbreak 或段内换行符 \n 的段落按行切分成独立 inline 片段及其在文档中的精确区间。 */
function splitParagraphByHardbreak(para: PMNode, paraPos: number): { from: number; to: number; inline: Fragment }[] {
  const schema = para.type.schema;
  const segs: { from: number; to: number; inline: Fragment }[] = [];
  let nodes: PMNode[] = [];
  let segStart = paraPos + 1;
  let cursor = paraPos + 1;

  para.forEach((child) => {
    if (child.type.name === "hardbreak") {
      segs.push({ from: segStart, to: cursor, inline: Fragment.fromArray(nodes) });
      nodes = [];
      cursor += child.nodeSize;
      segStart = cursor;
    } else if (child.isText && child.text && child.text.includes("\n")) {
      const parts = child.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (part.length > 0) {
          nodes.push(schema.text(part, child.marks));
          cursor += part.length;
        }
        if (i < parts.length - 1) {
          segs.push({ from: segStart, to: cursor, inline: Fragment.fromArray(nodes) });
          nodes = [];
          cursor += 1; // 跳过 \n
          segStart = cursor;
        }
      }
    } else {
      nodes.push(child);
      cursor += child.nodeSize;
    }
  });
  segs.push({ from: segStart, to: cursor, inline: Fragment.fromArray(nodes) });
  return segs;
}

function joinSegmentsWithHardbreak(segs: { inline: Fragment }[], schema: PMNode["type"]["schema"]): PMNode {
  const hb = schema.nodes.hardbreak;
  const nodes: PMNode[] = [];
  segs.forEach((seg, idx) => {
    if (idx > 0 && hb) nodes.push(hb.create({ isInline: true }));
    seg.inline.forEach((c) => nodes.push(c));
  });
  return schema.nodes.paragraph!.create(null, nodes);
}

/** 将单个非容器块节点拆成逻辑单元。 */
function extractFromLeafBlock(node: PMNode, inheritedKind?: BlockKind): ExtractedUnit[] {
  const schema = node.type.schema;
  if (node.type.name === "code_block") {
    const kind: BlockKind = inheritedKind ?? (isMathCodeBlock(node) ? "math" : "code");
    const lines = node.textContent.split("\n");
    return lines.map((line) => ({
      inline: line ? Fragment.from(schema.text(line)) : Fragment.empty,
      plainText: line,
      kind,
    }));
  }
  if (node.type.name === "heading") {
    const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
    const kind: BlockKind = inheritedKind ?? (`h${level}` as BlockKind);
    return [{ inline: node.content, plainText: inlineFragmentToPlainText(node.content), kind, headingLevel: level }];
  }
  if (node.type.name === "paragraph") {
    return [{ inline: node.content, plainText: inlineFragmentToPlainText(node.content), kind: inheritedKind ?? "text" }];
  }
  if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
    const out: ExtractedUnit[] = [];
    node.forEach((li) => {
      const liKind: BlockKind = inheritedKind ?? (li.attrs.checked != null ? "task" : node.type.name === "ordered_list" ? "ordered" : "bullet");
      li.forEach((child) => out.push(...extractFromLeafBlock(child, liKind)));
    });
    return out;
  }
  if (node.type.name === "blockquote") {
    const out: ExtractedUnit[] = [];
    node.forEach((child) => out.push(...extractFromLeafBlock(child, inheritedKind ?? "quote")));
    return out;
  }
  return [{ inline: Fragment.empty, plainText: node.textContent, kind: inheritedKind ?? "text", rawNode: node }];
}

function listItemKind(listNode: PMNode, liNode: PMNode): BlockKind {
  if (liNode.attrs.checked != null) return "task";
  return listNode.type.name === "ordered_list" ? "ordered" : "bullet";
}

function touchesRange(nodeStart: number, nodeEnd: number, selFrom: number, selTo: number): boolean {
  if (selFrom === selTo) return selFrom >= nodeStart && selFrom <= nodeEnd;
  return nodeEnd > selFrom && nodeStart < selTo;
}

/** 找出选区内最内层的单块 code_block 祖先（用于焦点直接在代码块内按快捷键的场景）。 */
function findEnclosingCodeBlock(doc: PMNode, from: number, to: number): { pos: number; node: PMNode } | null {
  const direct = doc.nodeAt(from);
  if (direct && direct.type.name === "code_block" && to <= from + direct.nodeSize) {
    return { pos: from, node: direct };
  }
  const $from = doc.resolve(Math.max(0, Math.min(doc.content.size, from)));
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name === "code_block") {
      const pos = $from.before(d);
      if (to <= pos + node.nodeSize) return { pos, node };
    }
  }
  return null;
}

function buildConvertedNodes(units: ExtractedUnit[], target: BlockKind, schema: PMNode["type"]["schema"]): PMNode[] {
  const n = schema.nodes;
  const toPara = (u: ExtractedUnit): PMNode => n.paragraph!.create(null, u.inline);

  if (target === "code" || target === "math") {
    const text = units.map((u) => u.plainText).join("\n");
    const attrs = target === "math" ? { language: "LaTeX" } : { language: "" };
    return [n.code_block!.create(attrs, text ? schema.text(text) : undefined)];
  }
  if (target === "text") {
    return units.map((u) => (u.rawNode ? u.rawNode : toPara(u)));
  }
  if (target === "h1" || target === "h2" || target === "h3" || target === "h4" || target === "h5" || target === "h6") {
    const level = Number(target[1]);
    return units.map((u) => (u.rawNode ? u.rawNode : n.heading!.create({ level }, u.inline)));
  }
  if (target === "quote") {
    const children = units.map((u) => {
      if (u.rawNode) return u.rawNode;
      if (u.headingLevel && n.heading) return n.heading.create({ level: u.headingLevel }, u.inline);
      return toPara(u);
    });
    return [n.blockquote!.create(null, children.length ? children : [n.paragraph!.create()])];
  }
  if (target === "bullet" || target === "ordered" || target === "task") {
    const listType = target === "ordered" ? n.ordered_list! : n.bullet_list!;
    const checked = target === "task" ? false : null;
    const items = units.map((u) => {
      const body = u.rawNode ? u.rawNode : toPara(u);
      return n.list_item!.create({ checked }, [body]);
    });
    return [listType.create(null, items.length ? items : [n.list_item!.create({ checked }, [n.paragraph!.create()])])];
  }
  return units.map(toPara);
}

/** 计算给定选区的共同块类型（供右键菜单“段落”子菜单标出当前打勾项）。 */
export function selectionKindOf(view: EditorView, explicitRange?: { from: number; to: number }): BlockKind | "" {
  const { doc } = view.state;
  const from = explicitRange ? explicitRange.from : view.state.selection.from;
  const to = explicitRange ? explicitRange.to : view.state.selection.to;

  const codeHit = findEnclosingCodeBlock(doc, from, to);
  if (codeHit) return isMathCodeBlock(codeHit.node) ? "math" : "code";

  const kinds = new Set<BlockKind>();
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const end = pos + child.nodeSize;
    if (touchesRange(pos, end, from, to)) {
      if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
        let liPos = pos + 1;
        for (let j = 0; j < child.childCount; j++) {
          const li = child.child(j);
          if (touchesRange(liPos, liPos + li.nodeSize, from, to)) kinds.add(listItemKind(child, li));
          liPos += li.nodeSize;
        }
      } else {
        const k = kindOf(view, pos);
        if (k) kinds.add(k);
      }
    }
    pos = end;
  }
  return kinds.size === 1 ? Array.from(kinds)[0]! : "";
}

/**
 * 统一的 Typora 风格多行/多块互转入口：
 * - 支持多段落、多列表项、引用块、代码块、公式块、段内软换行（Shift+Enter / 单换行）之间任意互转；
 * - 全部选中项已为目标类型且 toggle=true 时，自动还原为普通段落；
 * - 代码块/公式块退出为正文、或多行/多块转换后，自动选中转换结果，方便连续按快捷键继续切换类型。
 */
export function transformSelection(
  view: EditorView,
  targetKind: BlockKind,
  opts?: { toggle?: boolean; range?: { from: number; to: number }; selectConverted?: boolean },
): boolean {
  const { doc, schema } = view.state;
  const n = schema.nodes;
  if (!n.paragraph || !n.heading || !n.blockquote || !n.bullet_list || !n.ordered_list || !n.list_item || !n.code_block) {
    return false;
  }

  const selFrom = opts?.range ? Math.max(0, Math.min(doc.content.size, opts.range.from)) : view.state.selection.from;
  const selTo = opts?.range ? Math.max(selFrom, Math.min(doc.content.size, opts.range.to)) : view.state.selection.to;
  const wasExpanded = selTo > selFrom;

  // 1) 光标/选区位于单个代码块（或公式块）内部：直接做代码块退出/互转，转换后选中全部内容（类 Typora）。
  const codeHit = findEnclosingCodeBlock(doc, selFrom, selTo);
  if (codeHit) {
    const curKind: BlockKind = isMathCodeBlock(codeHit.node) ? "math" : "code";
    const effective: BlockKind = opts?.toggle && targetKind === curKind ? "text" : targetKind;
    if (effective === "code" || effective === "math") {
      const nextLang = effective === "math" ? "LaTeX" : "";
      if (String(codeHit.node.attrs.language ?? "") !== nextLang) {
        const tr = view.state.tr.setNodeMarkup(codeHit.pos, undefined, { ...codeHit.node.attrs, language: nextLang });
        view.dispatch(tr.scrollIntoView());
      }
      return true;
    }

    // 若代码块被包在列表或引用内部，先按顶层块拆出；顶层代码块直接替换。
    const $code = doc.resolve(codeHit.pos);
    const units = extractFromLeafBlock(codeHit.node, curKind);
    const converted = buildConvertedNodes(units, effective, schema);

    if ($code.depth === 0) {
      const tr = view.state.tr.replaceWith(codeHit.pos, codeHit.pos + codeHit.node.nodeSize, converted);
      const convSize = converted.reduce((acc, node) => acc + node.nodeSize, 0);
      const startBound = Math.min(tr.doc.content.size, codeHit.pos);
      const endBound = Math.min(tr.doc.content.size, codeHit.pos + convSize);
      tr.setSelection(TextSelection.between(tr.doc.resolve(startBound), tr.doc.resolve(endBound)));
      view.dispatch(tr.scrollIntoView());
      view.focus();
      requestAnimationFrame(() => {
        if (!view.isDestroyed) view.focus();
      });
      return true;
    }
  }

  // 2) 收集触及选区的连续顶层块范围，支持列表部分项拆分、引用部分段拆分、软换行段落拆分。
  let replaceFrom = -1;
  let replaceTo = -1;
  const prefixNodes: PMNode[] = [];
  const suffixNodes: PMNode[] = [];
  const units: ExtractedUnit[] = [];
  let singleCaretOffset: number | null = null;
  let cameFromCode = false;

  // 若选区完全落在同一个顶层列表中，且仅在 bullet <-> task 之间切换，可直接就地改 checked 属性而不拆列表。
  const $selFrom = doc.resolve(selFrom);
  if (targetKind === "bullet" || targetKind === "task") {
    let listDepth = -1;
    for (let d = $selFrom.depth; d >= 1; d--) {
      if ($selFrom.node(d).type === n.bullet_list) {
        listDepth = d;
        break;
      }
    }
    if (listDepth === 1) {
      const listPos = $selFrom.before(1);
      const listNode = $selFrom.node(1);
      if (selTo <= listPos + listNode.nodeSize) {
        const touchedLis: { pos: number; node: PMNode }[] = [];
        let liPos = listPos + 1;
        for (let j = 0; j < listNode.childCount; j++) {
          const li = listNode.child(j);
          if (touchesRange(liPos, liPos + li.nodeSize, selFrom, selTo)) {
            touchedLis.push({ pos: liPos, node: li });
          }
          liPos += li.nodeSize;
        }
        const allMatch = touchedLis.length > 0 && touchedLis.every((x) => listItemKind(listNode, x.node) === targetKind);
        if (touchedLis.length > 0 && !(opts?.toggle && allMatch)) {
          const tr = view.state.tr;
          const nextChecked = targetKind === "task" ? false : null;
          for (const item of touchedLis) {
            tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: nextChecked });
          }
          view.dispatch(tr.scrollIntoView());
          view.focus();
          return true;
        }
      }
    }
  }

  // 记录单块折叠光标在块内的文本偏移，便于单行转换后保持光标不动。
  if (!wasExpanded && $selFrom.parent.isTextblock) {
    singleCaretOffset = $selFrom.parentOffset;
  }

  let topPos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const childEnd = topPos + child.nodeSize;
    if (!touchesRange(topPos, childEnd, selFrom, selTo)) {
      topPos = childEnd;
      continue;
    }
    if (replaceFrom < 0) replaceFrom = topPos;
    replaceTo = childEnd;

    if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
      const beforeItems: PMNode[] = [];
      const afterItems: PMNode[] = [];
      let seenTouched = false;
      let liPos = topPos + 1;
      for (let j = 0; j < child.childCount; j++) {
        const li = child.child(j);
        const liEnd = liPos + li.nodeSize;
        if (touchesRange(liPos, liEnd, selFrom, selTo)) {
          seenTouched = true;
          const k = listItemKind(child, li);
          li.forEach((inner) => units.push(...extractFromLeafBlock(inner, k)));
        } else if (!seenTouched) {
          beforeItems.push(li);
        } else {
          afterItems.push(li);
        }
        liPos = liEnd;
      }
      if (beforeItems.length > 0) prefixNodes.push(child.type.create(child.attrs, beforeItems));
      if (afterItems.length > 0) suffixNodes.push(child.type.create(child.attrs, afterItems));
    } else if (child.type.name === "blockquote") {
      const beforeChildren: PMNode[] = [];
      const afterChildren: PMNode[] = [];
      let seenTouched = false;
      let cPos = topPos + 1;
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        const subEnd = cPos + sub.nodeSize;
        if (touchesRange(cPos, subEnd, selFrom, selTo)) {
          seenTouched = true;
          units.push(...extractFromLeafBlock(sub, "quote"));
        } else if (!seenTouched) {
          beforeChildren.push(sub);
        } else {
          afterChildren.push(sub);
        }
        cPos = subEnd;
      }
      if (beforeChildren.length > 0) prefixNodes.push(n.blockquote.create(child.attrs, beforeChildren));
      if (afterChildren.length > 0) suffixNodes.push(n.blockquote.create(child.attrs, afterChildren));
    } else if (child.type.name === "paragraph") {
      let hasHardbreak = false;
      child.forEach((c) => {
        if (c.type.name === "hardbreak" || (c.isText && !!c.text?.includes("\n"))) hasHardbreak = true;
      });
      if (hasHardbreak) {
        const segs = splitParagraphByHardbreak(child, topPos);
        const beforeSegs: typeof segs = [];
        const touchedSegs: typeof segs = [];
        const afterSegs: typeof segs = [];
        let seenTouched = false;
        for (const seg of segs) {
          if (touchesRange(seg.from, seg.to, selFrom, selTo)) {
            seenTouched = true;
            touchedSegs.push(seg);
          } else if (!seenTouched) {
            beforeSegs.push(seg);
          } else {
            afterSegs.push(seg);
          }
        }
        if (beforeSegs.length > 0) prefixNodes.push(joinSegmentsWithHardbreak(beforeSegs, schema));
        if (afterSegs.length > 0) suffixNodes.push(joinSegmentsWithHardbreak(afterSegs, schema));
        for (const seg of touchedSegs) {
          units.push({ inline: seg.inline, plainText: inlineFragmentToPlainText(seg.inline), kind: "text" });
        }
        if (!wasExpanded && touchedSegs.length === 1) {
          singleCaretOffset = Math.max(0, selFrom - touchedSegs[0]!.from);
        }
      } else {
        units.push(...extractFromLeafBlock(child));
      }
    } else {
      if (child.type.name === "code_block") cameFromCode = true;
      units.push(...extractFromLeafBlock(child));
    }

    topPos = childEnd;
  }

  if (replaceFrom < 0 || units.length === 0) return false;

  const allSameKind = units.every((u) => u.kind === targetKind);
  const effectiveKind: BlockKind = opts?.toggle && allSameKind ? "text" : targetKind;

  const converted = buildConvertedNodes(units, effectiveKind, schema);
  const replacement = [...prefixNodes, ...converted, ...suffixNodes];
  const prefixSize = prefixNodes.reduce((acc, node) => acc + node.nodeSize, 0);
  const convertedSize = converted.reduce((acc, node) => acc + node.nodeSize, 0);

  const tr = view.state.tr.replaceWith(replaceFrom, replaceTo, replacement);
  const convStart = Math.min(tr.doc.content.size, replaceFrom + prefixSize);
  const convEnd = Math.min(tr.doc.content.size, convStart + convertedSize);

  const shouldSelectWhole =
    opts?.selectConverted ||
    wasExpanded ||
    units.length > 1 ||
    cameFromCode ||
    effectiveKind === "code" ||
    effectiveKind === "math";

  if (effectiveKind === "code" || effectiveKind === "math") {
    const innerStart = Math.min(tr.doc.content.size, convStart + 1);
    const innerEnd = Math.max(innerStart, Math.min(tr.doc.content.size, convEnd - 1));
    tr.setSelection(TextSelection.create(tr.doc, innerStart, innerEnd));
  } else if (shouldSelectWhole) {
    tr.setSelection(TextSelection.between(tr.doc.resolve(convStart), tr.doc.resolve(convEnd)));
  } else {
    // 单个块折叠光标：尽量保持在原来的字符偏移处，输入体验更自然
    const targetPos = Math.min(tr.doc.content.size, convStart + 1);
    const $near = tr.doc.resolve(targetPos);
    const textSel = TextSelection.near($near, 1);
    const $tb = textSel.$from;
    if (singleCaretOffset !== null && $tb.parent.isTextblock) {
      const clampedOff = Math.min($tb.parent.content.size, singleCaretOffset);
      tr.setSelection(TextSelection.create(tr.doc, $tb.start() + clampedOff));
    } else {
      tr.setSelection(textSel);
    }
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** 块手柄菜单转换入口：把 pos 处的单个块转换为目标类型。 */
export function turnInto(view: EditorView, pos: number, kind: BlockKind) {
  const start = view.state.doc.nodeAt(pos);
  if (!start || start.nodeSize < 2) return;
  transformSelection(view, kind, {
    toggle: false,
    range: { from: pos, to: pos + start.nodeSize },
  });
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

const FORMAT_WRAP: Record<Exclude<FormatKind, "clear">, [string, string, string]> = {
  bold: ["**", "**", "文字"],
  italic: ["*", "*", "文字"],
  strike: ["~~", "~~", "文字"],
  code: ["`", "`", "code"],
  mark: ["==", "==", "重点"],
  underline: ["<u>", "</u>", "文字"],
  link: ["[", "](https://)", "链接文字"],
  math: ["$", "$", "x^2"],
};

/** 源码 / 整块源码共用的行内格式包裹或清理，返回需要替换的范围与新选区。 */
export function applySourceFormat(
  doc: string,
  from: number,
  to: number,
  kind: FormatKind,
): { from: number; to: number; insert: string; anchor: number; head: number } {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(doc.length, Math.max(from, to));
  const slice = doc.slice(start, end);
  if (kind === "clear") {
    const cleaned = slice
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<\/?(?:u|mark|sup|sub|kbd|strong|em|b|i|s|del)>/gi, "")
      .replace(/(\*\*|~~|==|`|\*|\$)([^\n]+?)\1/g, "$2");
    return { from: start, to: end, insert: cleaned, anchor: start, head: start + cleaned.length };
  }
  const [open, close, placeholder] = FORMAT_WRAP[kind];
  const body = slice || placeholder;
  const insert = `${open}${body}${close}`;
  return {
    from: start,
    to: end,
    insert,
    anchor: start + open.length,
    head: start + open.length + body.length,
  };
}

const LINE_PREFIX_STRIP_RE = /^([ \t]*)(?:#{1,6}\s+|>\s*|-\s*\[[xX\s]\]\s+|[-*+]\s+|\d+\.\s+)/;

function lineMatchesKind(line: string, kind: BlockKind): boolean {
  const trimmed = line.trimStart();
  switch (kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return new RegExp(`^#{${Number(kind[1])}}\\s+`).test(trimmed);
    case "quote":
      return /^>\s?/.test(trimmed);
    case "bullet":
      return /^[-*+]\s+/.test(trimmed) && !/^-\s*\[[xX\s]\]\s+/.test(trimmed);
    case "ordered":
      return /^\d+\.\s+/.test(trimmed);
    case "task":
      return /^-\s*\[[xX\s]\]\s+/.test(trimmed);
    default:
      return false;
  }
}

/** 扫描文档中包围给定范围的围栏代码块（```）或公式块（$$），便于源码/整块模式下双向解包。 */
function findEnclosingSourceFence(
  doc: string,
  selFrom: number,
  selTo: number,
): { kind: "code" | "math"; from: number; to: number; inner: string } | null {
  const lines = doc.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }

  let openIdx = -1;
  let openKind: "code" | "math" | null = null;
  let openFence = "";
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (openIdx < 0) {
      const codeM = /^(`{3,}|~{3,})/.exec(trimmed);
      if (codeM) {
        openIdx = i;
        openKind = "code";
        openFence = codeM[1]!;
      } else if (trimmed === "$$") {
        openIdx = i;
        openKind = "math";
        openFence = "$$";
      }
    } else {
      const closes = openKind === "math" ? trimmed === "$$" : trimmed.startsWith(openFence[0]!.repeat(openFence.length)) && trimmed.replace(new RegExp(`^\\${openFence[0]}+`), "").trim() === "";
      if (closes) {
        const blockFrom = starts[openIdx]!;
        const blockTo = starts[i]! + lines[i]!.length;
        if (selFrom >= blockFrom && selTo <= blockTo) {
          const inner = lines.slice(openIdx + 1, i).join("\n");
          return { kind: openKind!, from: blockFrom, to: blockTo, inner };
        }
        openIdx = -1;
        openKind = null;
        openFence = "";
      }
    }
  }
  return null;
}

/**
 * 源码 / 整块源码共用的多行段落/标题/列表/引用/代码块/公式块双向互转：
 * - 支持 toggle：同类再按还原为普通文本并保持选区；
 * - 支持围栏代码块 ``` 与公式块 $$ 的包裹、解包与跨类型互转。
 */
export function applySourceParagraph(
  doc: string,
  from: number,
  to: number,
  kind: BlockKind,
  opts?: { toggle?: boolean },
): { from: number; to: number; insert: string; anchor: number; head: number } {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(doc.length, Math.max(from, to));
  const wasExpanded = end > start;

  // 若处于围栏代码块/公式块内，支持直接解包为正文或转换成其它块类型（如列表/引用）。
  const fence = findEnclosingSourceFence(doc, start, end);
  if (fence) {
    if (opts?.toggle && kind === fence.kind) {
      return { from: fence.from, to: fence.to, insert: fence.inner, anchor: fence.from, head: fence.from + fence.inner.length };
    }
    if (kind === "text") {
      return { from: fence.from, to: fence.to, insert: fence.inner, anchor: fence.from, head: fence.from + fence.inner.length };
    }
    if (kind === "code" || kind === "math") {
      const marker = kind === "math" ? "$$" : "```";
      const insert = `${marker}\n${fence.inner}\n${marker}`;
      const openLen = marker.length + 1;
      return { from: fence.from, to: fence.to, insert, anchor: fence.from + openLen, head: fence.from + openLen + fence.inner.length };
    }
    // 从围栏转为列表/引用/标题：先把围栏内文本按行转换后替换整个围栏
    const innerRes = applySourceParagraph(fence.inner, 0, fence.inner.length, kind, { toggle: false });
    return {
      from: fence.from,
      to: fence.to,
      insert: innerRes.insert,
      anchor: fence.from,
      head: fence.from + innerRes.insert.length,
    };
  }

  const blockFrom = start === 0 ? 0 : doc.lastIndexOf("\n", start - 1) + 1;
  const nlAfter = doc.indexOf("\n", end);
  const blockTo = nlAfter < 0 ? doc.length : nlAfter;
  const rawSlice = doc.slice(blockFrom, blockTo);

  if (kind === "code" || kind === "math") {
    const marker = kind === "math" ? "$$" : "```";
    const insert = `${marker}\n${rawSlice}\n${marker}`;
    const openLen = marker.length + 1;
    return { from: blockFrom, to: blockTo, insert, anchor: blockFrom + openLen, head: blockFrom + openLen + rawSlice.length };
  }

  const lines = rawSlice.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const allAlready = opts?.toggle && kind !== "text" && nonEmpty.length > 0 && nonEmpty.every((l) => lineMatchesKind(l, kind));
  const effective: BlockKind = allAlready ? "text" : kind;

  let orderNum = 0;
  const next = lines.map((line) => {
    const stripped = line.replace(LINE_PREFIX_STRIP_RE, "$1");
    if (lines.length > 1 && stripped.trim() === "") return stripped;
    const indent = /^[ \t]*/.exec(stripped)?.[0] ?? "";
    const rest = stripped.slice(indent.length);
    switch (effective) {
      case "text":
        return stripped;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return `${indent}${"#".repeat(Number(effective[1]))} ${rest}`;
      case "quote":
        return `${indent}> ${rest}`;
      case "bullet":
        return `${indent}- ${rest}`;
      case "ordered":
        orderNum += 1;
        return `${indent}${orderNum}. ${rest}`;
      case "task":
        return `${indent}- [ ] ${rest}`;
      default:
        return line;
    }
  });
  const insert = next.join("\n");
  if (wasExpanded || lines.length > 1) {
    return { from: blockFrom, to: blockTo, insert, anchor: blockFrom, head: blockFrom + insert.length };
  }
  return { from: blockFrom, to: blockTo, insert, anchor: blockFrom + insert.length, head: blockFrom + insert.length };
}

/** 扫描文档中已有的数字脚注 [^1]、[^2]…，返回下一个不重复编号。 */
export function nextFootnoteIndex(docText: string): number {
  let max = 0;
  for (const m of docText.matchAll(/\[\^(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 扫描文档中已有的链接引用定义 [ref]:，返回不冲突的引用 ID。 */
export function nextLinkRefId(docText: string): string {
  const used = new Set<string>();
  for (const m of docText.matchAll(/^\[([^\]]+)\]:/gm)) {
    used.add(m[1]!.toLowerCase());
  }
  if (!used.has("ref")) return "ref";
  for (let i = 2; i < 999; i++) {
    const id = `ref${i}`;
    if (!used.has(id)) return id;
  }
  return `ref${Date.now()}`;
}

export interface SourceInsertResult {
  insert: string;
  cursorOffset: number;
  selectLen?: number;
  appendDoc?: string;
}

export function buildSourceInsert(kind: InsertKind, timeFormat: string, atEmptyLine = false, docText = ""): SourceInsertResult {
  switch (kind) {
    case "time": {
      const s = formatTime(new Date(), timeFormat);
      return { insert: s, cursorOffset: s.length };
    }
    case "image": {
      const s = "![图片描述](https://)";
      return { insert: s, cursorOffset: 8, selectLen: 8 };
    }
    case "footnote": {
      const n = nextFootnoteIndex(docText);
      const ref = `[^${n}]`;
      return { insert: ref, cursorOffset: ref.length, appendDoc: `[^${n}]: 脚注内容` };
    }
    case "linkref": {
      const id = nextLinkRefId(docText);
      const s = `[链接文本][${id}]`;
      return { insert: s, cursorOffset: 1, selectLen: 4, appendDoc: `[${id}]: https://` };
    }
    case "divider": {
      const s = atEmptyLine ? "---\n" : "\n---\n";
      return { insert: s, cursorOffset: s.length };
    }
    case "code": {
      const s = atEmptyLine ? "```\n\n```" : "\n```\n\n```";
      return { insert: s, cursorOffset: atEmptyLine ? 4 : 5 };
    }
    case "table": {
      const s = `${atEmptyLine ? "" : "\n"}| 列一 | 列二 |\n| --- | --- |\n|  |  |\n`;
      return { insert: s, cursorOffset: s.length };
    }
    case "math": {
      const s = atEmptyLine ? "$$\n\n$$" : "\n$$\n\n$$";
      return { insert: s, cursorOffset: atEmptyLine ? 3 : 4 };
    }
    case "toc": {
      const s = atEmptyLine ? "[TOC]\n" : "\n[TOC]\n";
      return { insert: s, cursorOffset: s.length };
    }
    default:
      return { insert: "", cursorOffset: 0 };
  }
}
