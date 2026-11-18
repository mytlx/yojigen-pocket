import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/**
 * [TOC]：单独占一行时，在它下面显示根据标题生成的目录，点一下跳到对应的标题。
 * 文档里保存的仍然是 [TOC] 这一行，目录是显示的时候现算的。
 */
interface Head {
  level: number;
  text: string;
}

function jump(view: EditorView, index: number) {
  let seen = -1;
  let target = -1;
  view.state.doc.forEach((node, pos) => {
    if (node.type.name === "heading" && ++seen === index) target = pos;
  });
  if (target < 0) return;
  const dom = view.nodeDOM(target);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
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
    a.textContent = h.text || "（空标题）";
    a.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jump(view, i);
    });
    nav.appendChild(a);
  });
  return nav;
}

export const tocPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("pocket-toc"),
      props: {
        decorations(state) {
          const marks: { pos: number; size: number }[] = [];
          const heads: Head[] = [];
          state.doc.forEach((node, pos) => {
            if (node.type.name === "heading") heads.push({ level: node.attrs.level as number, text: node.textContent });
            else if (node.type.name === "paragraph" && /^\[toc\]$/i.test(node.textContent.trim())) marks.push({ pos, size: node.nodeSize });
          });
          if (marks.length === 0) return null;
          // 标题没变就复用上一次画好的目录。
          const key = `toc:${JSON.stringify(heads)}`;
          return DecorationSet.create(
            state.doc,
            marks.flatMap((m) => [
              Decoration.node(m.pos, m.pos + m.size, { class: "md-toc-marker" }),
              Decoration.widget(m.pos + m.size, (view) => render(view, heads), { side: -1, key, ignoreSelection: true }),
            ]),
          );
        },
      },
    }),
);
