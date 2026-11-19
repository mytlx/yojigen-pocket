import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { renderOutlineInlinesDOM, type OutlineInline, type OutlineInlineTag } from "./outline";

/**
 * [TOC]：单独占一行时，在它下面显示根据标题生成的目录，点一下跳到对应的标题。
 * 文档里保存的仍然是 [TOC] 这一行，目录是显示的时候现算的。
 */
interface Head {
  level: number;
  text: string;
  inlines: OutlineInline[];
}

function headingNodeToInlines(heading: PMNode): OutlineInline[] {
  const out: OutlineInline[] = [];
  heading.forEach((child) => {
    if (!child.isText || !child.text) return;
    let node: OutlineInline = { type: "text", value: child.text };
    for (const mark of child.marks) {
      let tag: OutlineInlineTag | null = null;
      switch (mark.type.name) {
        case "strong":
          tag = "strong";
          break;
        case "emphasis":
          tag = "em";
          break;
        case "strike_through":
          tag = "del";
          break;
        case "inlineCode":
        case "pocket_kbd":
          tag = "code";
          break;
        case "pocket_mark":
          tag = "mark";
          break;
        case "pocket_u":
          tag = "u";
          break;
        case "pocket_sup":
          tag = "sup";
          break;
        case "pocket_sub":
          tag = "sub";
          break;
      }
      if (tag) node = { type: tag, children: [node] };
    }
    out.push(node);
  });
  return out;
}

function jump(view: EditorView, index: number) {
  let seen = -1;
  let target = -1;
  view.state.doc.forEach((node, pos) => {
    if (node.type.name === "heading" && ++seen === index) target = pos;
  });
  if (target < 0) return;
  const dom = view.nodeDOM(target);
  if (!(dom instanceof HTMLElement)) return;
  const container = dom.closest(".fx-notes-rich");
  if (container instanceof HTMLElement) {
    const align = () => {
      const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + dom.getBoundingClientRect().top - container.getBoundingClientRect().top - 10));
      if (Math.abs(top - container.scrollTop) >= 1) {
        container.scrollTo({ top, behavior: "instant" as ScrollBehavior });
        return true;
      }
      return false;
    };
    if (align()) requestAnimationFrame(() => void align());
    return;
  }
  dom.scrollIntoView({ block: "start" });
}

function render(view: EditorView, heads: Head[]): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "md-toc";
  nav.contentEditable = "false";
  if (heads.length === 0) {
    nav.textContent = "还没有标题";
    nav.classList.add("is-empty");
    return nav;
  }
  const top = Math.min(...heads.map((h) => h.level));
  heads.forEach((h, i) => {
    const a = document.createElement("a");
    a.className = "md-toc-item";
    a.style.paddingLeft = `${(h.level - top) * 16}px`;
    if (h.inlines.length > 0 && h.text) a.appendChild(renderOutlineInlinesDOM(h.inlines));
    else a.textContent = h.text || "（空标题）";
    a.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jump(view, i);
    });
    nav.appendChild(a);
  });
  return nav;
}

function buildTocDecos(doc: PMNode): DecorationSet | null {
  const marks: { pos: number; size: number }[] = [];
  const heads: Head[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") {
      heads.push({ level: node.attrs.level as number, text: node.textContent, inlines: headingNodeToInlines(node) });
    } else if (node.type.name === "paragraph" && /^\[toc\]$/i.test(node.textContent.trim())) {
      marks.push({ pos, size: node.nodeSize });
    }
  });
  if (marks.length === 0) return null;
  // 标题内容与样式没变就复用上一次画好的目录。
  const key = `toc:${JSON.stringify(heads)}`;
  return DecorationSet.create(
    doc,
    marks.flatMap((m) => [
      Decoration.node(m.pos, m.pos + m.size, { class: "md-toc-marker" }),
      Decoration.widget(m.pos + m.size, (view) => render(view, heads), { side: -1, key, ignoreSelection: true }),
    ]),
  );
}

const tocKey = new PluginKey<DecorationSet | null>("pocket-toc");

export const tocPlugin = $prose(
  () =>
    new Plugin<DecorationSet | null>({
      key: tocKey,
      state: {
        init: (_, state) => buildTocDecos(state.doc),
        apply: (tr, prev, _, newState) => (tr.docChanged ? buildTocDecos(newState.doc) : prev),
      },
      props: {
        decorations(state) {
          return tocKey.getState(state) ?? null;
        },
      },
    }),
);
