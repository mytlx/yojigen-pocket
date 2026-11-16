import { DOMSerializer, type Node as PMNode } from "@milkdown/kit/prose/model";

/** Markdown 的 DOM 与原始 HTML 拼接后只送入无权限 iframe，样式不会进入宿主。 */
export function previewDocument(doc: PMNode, dark: boolean): string {
  const box = document.createElement("div");
  box.appendChild(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
  const raw: string[] = [];
  box.querySelectorAll<HTMLElement>('[data-type="html"]').forEach((el) => {
    const index = raw.push(el.dataset.value ?? el.textContent ?? "") - 1;
    el.replaceWith(document.createComment(`pocket-html-${index}`));
  });
  const html = box.innerHTML.replace(/<!--pocket-html-(\d+)-->/g, (_, n: string) => raw[Number(n)] ?? "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; base-uri 'none'; form-action 'none'"><style>
  :root { color-scheme: ${dark ? "dark" : "light"}; } body { margin:24px; font:15px/1.75 system-ui; overflow-wrap:anywhere; color:${dark ? "#e7e9ee" : "#20232a"}; } pre { white-space:pre-wrap; padding:12px; background:#8882; border-radius:8px; } code { font-family:monospace; } table { border-collapse:collapse; } td,th { border:1px solid #8886; padding:6px 12px; } img { max-width:100%; } blockquote { border-left:3px solid #8886; margin-left:0; padding-left:16px; }
  </style></head><body>${html}</body></html>`;
}
