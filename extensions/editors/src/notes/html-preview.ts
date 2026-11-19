import { DOMSerializer, type Node as PMNode } from "@milkdown/kit/prose/model";

export interface PreviewOptions {
  strictLineBreaks?: boolean;
  themeEl?: Element | null;
}

const PREVIEW_VAR_DEFAULTS = (dark: boolean): Record<string, string> => ({
  "--text": dark ? "#e7e9ee" : "#20232a",
  "--text-2": dark ? "#a8b0be" : "#555c68",
  "--text-3": dark ? "#7a8291" : "#8a92a0",
  "--accent": dark ? "#5b8aff" : "#2563eb",
  "--accent-rgb": dark ? "91, 138, 255" : "37, 99, 235",
  "--line": dark ? "rgba(255, 255, 255, 0.1)" : "rgba(16, 18, 24, 0.1)",
  "--line-strong": dark ? "rgba(255, 255, 255, 0.18)" : "rgba(16, 18, 24, 0.18)",
  "--well": dark ? "rgba(255, 255, 255, 0.08)" : "rgba(16, 18, 24, 0.05)",
  "--card": dark ? "#1c1f26" : "#ffffff",
  "--card-solid": dark ? "#242832" : "#ffffff",
  "--font-ui": 'system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  "--code-bg": dark ? "rgba(0, 0, 0, 0.26)" : "rgba(16, 18, 24, 0.045)",
  "--code-border": dark ? "rgba(255, 255, 255, 0.08)" : "rgba(16, 18, 24, 0.08)",
  "--code-text": dark ? "#e7e9ee" : "#20232a",
  "--cm-tag": dark ? "#ff7b72" : "#c23b3b",
});

function readThemeVars(dark: boolean, themeEl?: Element | null): string {
  const defaults = PREVIEW_VAR_DEFAULTS(dark);
  const el = themeEl ?? (typeof document !== "undefined" ? document.documentElement : null);
  const cs = el && typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const fallbackCs =
    !cs && typeof document !== "undefined" && typeof getComputedStyle === "function"
      ? getComputedStyle(document.documentElement)
      : null;
  const rootCs = typeof document !== "undefined" && typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  return Object.entries(defaults)
    .map(([name, fb]) => {
      const val = cs?.getPropertyValue(name).trim() || fallbackCs?.getPropertyValue(name).trim() || rootCs?.getPropertyValue(name).trim() || fb;
      return `${name}: ${val};`;
    })
    .join(" ");
}

/** Markdown 的 DOM 与原始 HTML 拼接后只送入无权限 iframe，样式不会进入宿主。 */
export function previewDocument(doc: PMNode, dark: boolean, opts?: PreviewOptions): string {
  const box = document.createElement("div");
  box.appendChild(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
  const raw: string[] = [];
  box.querySelectorAll<HTMLElement>('[data-type="html"]').forEach((el) => {
    const index = raw.push(el.dataset.value ?? el.textContent ?? "") - 1;
    el.replaceWith(document.createComment(`pocket-html-${index}`));
  });
  const html = box.innerHTML.replace(/<!--pocket-html-(\d+)-->/g, (_, n: string) => raw[Number(n)] ?? "");
  const vars = readThemeVars(dark, opts?.themeEl);
  const softBreakRule = opts?.strictLineBreaks
    ? ""
    : 'span[data-type="hardbreak"][data-is-inline="true"]::after { content: "\\A"; white-space: pre; }';

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; base-uri 'none'; form-action 'none'"><style>
  :root { color-scheme: ${dark ? "dark" : "light"}; ${vars} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--card); color: var(--text); }
  body { margin: 18px 26px 40px; font: 14px/1.7 var(--font-ui); overflow-wrap: anywhere; }
  p { margin: 0 0 8px; line-height: 1.7; }
  h1, h2, h3, h4, h5, h6 { margin: 16px 0 8px; font-weight: 600; line-height: 1.38; color: var(--text); }
  h1 { font-size: 1.85em; font-weight: 700; line-height: 1.28; padding-bottom: 7px; border-bottom: 1px solid var(--line-strong); }
  h2 { font-size: 1.5em; font-weight: 700; line-height: 1.32; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.28em; }
  h4 { font-size: 1.14em; }
  h5 { font-size: 1.06em; }
  h6 { font-size: 1em; color: var(--text-2); }
  body > :first-child { margin-top: 0; }
  a { color: var(--accent); text-decoration: underline; text-decoration-color: rgba(var(--accent-rgb), 0.4); text-underline-offset: 2px; }
  blockquote { margin: 8px 0; padding-left: 16px; border-left: 3px solid rgba(var(--accent-rgb), 0.5); color: var(--text-2); }
  pre { margin: 8px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--code-border); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; }
  :not(pre) > code { padding: 1px 5px; border-radius: 5px; font-family: var(--font-mono); font-size: 0.88em; background: var(--well); color: var(--cm-tag); white-space: pre-wrap; overflow-wrap: anywhere; }
  table { border-collapse: collapse; margin: 10px 0; max-width: 100%; }
  td, th { border: 1px solid var(--line-strong); padding: 6px 12px; }
  th { background: var(--well); font-weight: 600; }
  hr { border: 0; height: 1px; margin: 16px 0; background: var(--line-strong); }
  img { max-width: 100%; }
  ul, ol { padding-left: 24px; margin: 6px 0; }
  li.task-list-item { list-style: none; margin-left: -18px; }
  mark, .md-mark { background: rgba(250, 204, 21, 0.35); color: inherit; padding: 0 2px; border-radius: 3px; }
  kbd, .md-kbd { padding: 1px 5px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--well); font-family: var(--font-mono); font-size: 0.85em; }
  sup, sub { font-size: 0.75em; line-height: 0; }
  sup { vertical-align: super; }
  sub { vertical-align: sub; }
  ${softBreakRule}
  </style></head><body>${html}</body></html>`;
}
