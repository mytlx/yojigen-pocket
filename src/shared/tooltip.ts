/**
 * 悬停提示。系统自带的 title 提示在 WebView 里不可靠：窗口不是当前窗口、鼠标没停稳、
 * 或者在不抢焦点的面板里，经常干脆不出来。这里把 title 接管过来自己画，放上去就显示。
 *
 * 用法不变：元素上照常写 title（或 data-tip）。每个窗口调用一次 installTooltips()。
 */
export function installTooltips(doc: Document = document) {
  const flag = doc as unknown as { __pocketTips?: boolean };
  if (flag.__pocketTips) return;
  flag.__pocketTips = true;

  let tip: HTMLDivElement | null = null;
  let target: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastShown = 0;

  const hide = () => {
    clearTimeout(timer);
    if (tip) {
      tip.remove();
      tip = null;
      lastShown = Date.now();
    }
    target = null;
  };

  const place = (el: Element, text: string) => {
    const view = doc.defaultView;
    if (!view || !el.isConnected) return;
    tip = doc.createElement("div");
    tip.className = "ui-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    doc.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 6;
    const margin = 4;
    // 默认在下面；下面放不下就放上面。
    let top = r.bottom + gap;
    if (top + t.height > view.innerHeight - margin && r.top - gap - t.height >= margin) top = r.top - gap - t.height;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, view.innerWidth - t.width - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(margin, top))}px`;
    tip.classList.add("is-shown");
  };

  /** 找到带提示的元素，并把原生的 title 收走（否则系统的提示会和我们的叠在一起）。 */
  const pick = (from: EventTarget | null): Element | null => {
    const start = from instanceof Element ? from : null;
    const el = start?.closest("[title], [data-tip]") ?? null;
    if (!el || el.tagName === "IFRAME") return null;
    const title = el.getAttribute("title");
    if (title !== null) {
      // 每次都以最新的 title 为准：组件重新渲染时可能换了文字。
      el.removeAttribute("title");
      if (title) {
        el.setAttribute("data-tip", title);
        if (!el.getAttribute("aria-label") && !(el.textContent ?? "").trim()) el.setAttribute("aria-label", title);
      } else el.removeAttribute("data-tip");
    }
    return el.getAttribute("data-tip") ? el : null;
  };

  doc.addEventListener(
    "mouseover",
    (e) => {
      const el = pick(e.target);
      if (el === target) return;
      hide();
      if (!el) return;
      target = el;
      // 刚看过一个提示、紧接着移到旁边的按钮上：不用再等。
      const delay = Date.now() - lastShown < 400 ? 60 : 320;
      timer = setTimeout(() => {
        if (target === el) place(el, el.getAttribute("data-tip") ?? "");
      }, delay);
    },
    true,
  );
  doc.addEventListener(
    "mouseout",
    (e) => {
      const to = (e as MouseEvent).relatedTarget;
      if (target && !(to instanceof Node && target.contains(to))) hide();
    },
    true,
  );
  for (const name of ["mousedown", "keydown", "wheel", "blur"] as const) doc.addEventListener(name, hide, true);
  doc.defaultView?.addEventListener("blur", hide);
}
