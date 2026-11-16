/**
 * Ctrl + 滚轮。
 *
 * WebView 默认会把它当成“缩放整个页面”，于是搜索框、列表、按钮全都跟着变大变小。
 * 这里把默认行为拦掉；只有在文字编辑区里，它才有用：调这个编辑区的字号。
 *
 * 三种编辑区各记各的字号：
 *   rich  所见即所得的笔记        （CSS 变量 --zoom-rich）
 *   code  代码编辑器（CodeMirror） （CSS 变量 --zoom-code）
 *   text  普通的多行输入框         （直接改 font-size）
 *
 * Ctrl + 0 恢复原来的大小，Ctrl + 加号 / 减号 和滚轮一样（焦点在编辑区里时）。
 */
type Kind = "rich" | "code" | "text";

const MIN = 0.6;
const MAX = 2.6;
const key = (k: Kind) => `pocket.zoom.${k}`;

function load(k: Kind): number {
  try {
    const v = Number(localStorage.getItem(key(k)));
    return v >= MIN && v <= MAX ? v : 1;
  } catch {
    return 1;
  }
}

function areaOf(target: EventTarget | null): { kind: Kind; el: HTMLElement } | null {
  const el = target instanceof Element ? target : null;
  if (!el) return null;
  const rich = el.closest<HTMLElement>(".fx-notes-rich");
  if (rich) return { kind: "rich", el: rich };
  const code = el.closest<HTMLElement>(".code-editor, .cm-mergeView, .cm-editor");
  if (code) return { kind: "code", el: code };
  const text = el.closest<HTMLElement>("textarea");
  if (text) return { kind: "text", el: text };
  return null;
}

/** 普通输入框没有统一的字号变量：记下它原来的字号，按比例改。 */
function applyText(el: HTMLElement, zoom: number) {
  if (zoom === 1 && !el.dataset.zoomBase) return;
  if (!el.dataset.zoomBase) el.dataset.zoomBase = String(parseFloat(getComputedStyle(el).fontSize) || 13);
  el.style.fontSize = zoom === 1 ? "" : `${(Number(el.dataset.zoomBase) * zoom).toFixed(2)}px`;
}

export function installZoom(doc: Document = document) {
  const flag = doc as unknown as { __pocketZoom?: boolean };
  if (flag.__pocketZoom) return;
  flag.__pocketZoom = true;
  const view = doc.defaultView;
  const root = doc.documentElement;
  const zoom: Record<Kind, number> = { rich: load("rich"), code: load("code"), text: load("text") };
  root.style.setProperty("--zoom-rich", String(zoom.rich));
  root.style.setProperty("--zoom-code", String(zoom.code));
  // 扩展页面走本机回环随机端口时，重启后端口会变，同时存一份到宿主的插件存储里。
  const extStorage = (view as unknown as { pocket?: { storage?: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> } } } | null)?.pocket?.storage;
  if (extStorage) {
    for (const k of ["rich", "code", "text"] as const) {
      void extStorage
        .get(key(k))
        .then((raw) => {
          const v = Number(raw);
          if (v >= MIN && v <= MAX && v !== zoom[k]) {
            zoom[k] = v;
            if (k === "text") doc.querySelectorAll<HTMLElement>("textarea").forEach((t) => applyText(t, v));
            else root.style.setProperty(`--zoom-${k}`, String(v));
          }
        })
        .catch(() => undefined);
    }
  }

  let badge: HTMLDivElement | null = null;
  let badgeTimer: ReturnType<typeof setTimeout> | undefined;
  const showBadge = (el: HTMLElement, value: number) => {
    badge ??= doc.createElement("div");
    badge.className = "ui-tip is-shown ui-zoom-badge";
    badge.textContent = `${Math.round(value * 100)}%`;
    doc.body.appendChild(badge);
    const r = el.getBoundingClientRect();
    badge.style.left = `${Math.round(r.right - badge.offsetWidth - 10)}px`;
    badge.style.top = `${Math.round(Math.max(4, r.top + 8))}px`;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge?.remove(), 900);
  };

  const set = (kind: Kind, el: HTMLElement, value: number) => {
    const next = Math.round(Math.min(MAX, Math.max(MIN, value)) * 100) / 100;
    zoom[kind] = next;
    try {
      if (next === 1) localStorage.removeItem(key(kind));
      else localStorage.setItem(key(kind), String(next));
    } catch {
      /* 存不了就只在这次生效 */
    }
    if (extStorage) {
      void extStorage.set(key(kind), next === 1 ? null : next).catch(() => undefined);
    }
    if (kind === "text") doc.querySelectorAll<HTMLElement>("textarea").forEach((t) => applyText(t, next));
    else {
      root.style.setProperty(`--zoom-${kind}`, String(next));
      // 代码编辑器要重新量一下行高和字宽。
      view?.dispatchEvent(new Event("resize"));
    }
    showBadge(el, next);
  };

  doc.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // 无论在哪儿，都不缩放整个界面
      const area = areaOf(e.target);
      if (!area || e.deltaY === 0) return;
      set(area.kind, area.el, zoom[area.kind] + (e.deltaY < 0 ? 0.1 : -0.1));
    },
    { passive: false, capture: true },
  );

  doc.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const step = e.key === "=" || e.key === "+" ? 0.1 : e.key === "-" || e.key === "_" ? -0.1 : e.key === "0" ? 0 : null;
      if (step === null) return;
      e.preventDefault(); // 同样不让它缩放整个界面
      const area = areaOf(doc.activeElement);
      if (area) set(area.kind, area.el, step === 0 ? 1 : zoom[area.kind] + step);
    },
    true,
  );

  // 后来才出现的输入框（切换功能页）也用上记住的字号。
  if (view && "MutationObserver" in view) {
    const apply = (node: Node) => {
      if (zoom.text === 1 || !(node instanceof HTMLElement)) return;
      if (node.tagName === "TEXTAREA") applyText(node, zoom.text);
      else node.querySelectorAll?.<HTMLElement>("textarea").forEach((t) => applyText(t, zoom.text));
    };
    new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach(apply))).observe(doc.body ?? root, { childList: true, subtree: true });
    apply(doc.body);
  }
}
