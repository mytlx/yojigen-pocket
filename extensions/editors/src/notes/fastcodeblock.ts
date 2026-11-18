import type { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { type CodeBlockConfig, CodeMirrorBlock, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";

type CodeBlockCfg = CodeBlockConfig;

class SharedLangLoader {
  private readonly pending = new Map<string, Promise<LanguageSupport | undefined>>();
  readonly parsers = new Map<string, ReturnType<LanguageSupport["language"]["parser"]["parse"]> extends never ? never : LanguageSupport["language"]["parser"]>();

  constructor(private langs: LanguageDescription[]) {}

  setLanguages(langs: LanguageDescription[]) {
    this.langs = langs;
  }

  getAll() {
    return this.langs.map((l) => ({ name: l.name, alias: l.alias }));
  }

  find(name: string): LanguageDescription | undefined {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    return this.langs.find((l) => l.name.toLowerCase() === q || l.alias.some((a) => a.toLowerCase() === q));
  }

  load(languageName: string): Promise<LanguageSupport | undefined> {
    const q = languageName.trim().toLowerCase();
    if (!q) return Promise.resolve(undefined);
    const hit = this.pending.get(q);
    if (hit) return hit;
    const desc = this.find(q);
    if (!desc) return Promise.resolve(undefined);
    const p = desc.load().then((support) => {
      if (support?.language?.parser) this.parsers.set(q, support.language.parser);
      return support;
    });
    this.pending.set(q, p);
    return p;
  }
}

const iconCache = new Map<string, DocumentFragment>();
function cloneIcon(html: string): Node {
  let frag = iconCache.get(html);
  if (!frag) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    frag = tpl.content;
    iconCache.set(html, frag);
  }
  return frag.cloneNode(true);
}

// Idle syntax highlighting queue: only processes currently visible <pre> elements in tiny 4ms slices
// so dragging the scrollbar past 180+ blocks never triggers layout/parse stalls.
interface HighlightJob {
  codeEl: HTMLElement;
  text: string;
  lang: string;
  loader: SharedLangLoader;
}

const visibleIdleEls = new WeakSet<Element>();
const jobByTarget = new WeakMap<Element, HighlightJob>();
const pendingJobs = new Set<Element>();
let idleTimer = 0;
let hlObserver: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!hlObserver) {
    hlObserver = new IntersectionObserver(
      (entries) => {
        let added = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleIdleEls.add(entry.target);
            if (jobByTarget.has(entry.target)) {
              pendingJobs.add(entry.target);
              added = true;
            }
          } else {
            visibleIdleEls.delete(entry.target);
            pendingJobs.delete(entry.target);
          }
        }
        if (added) scheduleHighlightFlush();
      },
      { rootMargin: "150px" },
    );
  }
  return hlObserver;
}

function renderHighlighted(codeEl: HTMLElement, text: string, parser: NonNullable<ReturnType<SharedLangLoader["parsers"]["get"]>>) {
  const frag = document.createDocumentFragment();
  let line = document.createElement("span");
  const appendChunk = (chunk: string, classes: string) => {
    if (!chunk) return;
    if (classes) {
      const s = document.createElement("span");
      s.className = classes;
      s.textContent = chunk;
      line.appendChild(s);
    } else {
      line.appendChild(document.createTextNode(chunk));
    }
  };
  highlightCode(
    text,
    parser.parse(text),
    classHighlighter,
    appendChunk,
    () => {
      line.appendChild(document.createTextNode("\n"));
      frag.appendChild(line);
      line = document.createElement("span");
    },
  );
  frag.appendChild(line);
  codeEl.replaceChildren(frag);
}

function scheduleHighlightFlush(delay = 60) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = 0;
    const drain = () => {
      const deadline = performance.now() + 4;
      for (const target of [...pendingJobs]) {
        if (performance.now() > deadline) {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(drain);
          else window.setTimeout(drain, 16);
          return;
        }
        pendingJobs.delete(target);
        if (!target.isConnected || !visibleIdleEls.has(target)) continue;
        const job = jobByTarget.get(target);
        if (!job) continue;
        const q = job.lang.trim().toLowerCase();
        if (!q) {
          jobByTarget.delete(target);
          continue;
        }
        const parser = job.loader.parsers.get(q);
        if (parser) {
          jobByTarget.delete(target);
          renderHighlighted(job.codeEl, job.text, parser);
        } else {
          void job.loader.load(q).then((sup) => {
            if (sup?.language?.parser && target.isConnected && visibleIdleEls.has(target) && jobByTarget.get(target) === job) {
              pendingJobs.add(target);
              scheduleHighlightFlush(0);
            }
          });
        }
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(drain);
    else drain();
  }, delay);
}

/**
 * 轻量按需代码块视图：
 * 默认以纯静态 HTML + 视口空闲分片 Lezer 着色渲染，彻底避免长笔记滚动时一次性挂载上百个 CodeMirror/Vue 实例导致主线程阻塞与空白块；
 * 仅在点击、切语言或光标进入当前代码块时挂载完整的 Milkdown CodeMirrorBlock，失焦离开后安全卸载回静态视图。
 */
export const fastCodeBlockView = $view(codeBlockSchema.node, (ctx) => {
  const configSlice = ctx.use(codeBlockConfig.key);
  const loader = new SharedLangLoader(configSlice.get().languages);

  return (initialNode: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    let curNode = initialNode;
    let selected = false;
    let activeInner: CodeMirrorBlock | null = null;
    let teardownTimer: number | null = null;
    let codeEl: HTMLElement | null = null;
    let langBtn: HTMLButtonElement | null = null;
    let previewContainer: HTMLElement | null = null;
    let previewPanel: HTMLElement | null = null;
    let lastHlLang = "";
    let lastHlText = "";

    const dom = document.createElement("div");
    dom.className = "milkdown-code-block pocket-code-idle";

    const cancelTeardown = () => {
      if (teardownTimer !== null) {
        window.clearTimeout(teardownTimer);
        teardownTimer = null;
      }
    };

    const syncIdlePreview = (cfg: CodeBlockCfg) => {
      if (!previewPanel || !previewContainer) return;
      const lang = String(curNode.attrs.language ?? "");
      const applyPreview = (val: null | string | HTMLElement) => {
        if (!previewPanel || !previewContainer) return;
        if (!val) {
          previewContainer.replaceChildren();
          previewPanel.classList.add("hidden");
          return;
        }
        previewPanel.classList.remove("hidden");
        if (typeof val === "string") previewContainer.innerHTML = val;
        else previewContainer.replaceChildren(val);
      };
      const out = cfg.renderPreview(lang, curNode.textContent, applyPreview);
      if (out === null || out === undefined) {
        if (out === null) applyPreview(null);
      } else {
        applyPreview(out);
      }
    };

    const queueHighlight = () => {
      if (!codeEl) return;
      const text = curNode.textContent;
      const lang = String(curNode.attrs.language ?? "");
      if (!text || !lang || !loader.find(lang)) {
        jobByTarget.delete(dom);
        pendingJobs.delete(dom);
        return;
      }
      if (lastHlLang === lang && lastHlText === text) return;
      const parser = loader.parsers.get(lang.trim().toLowerCase());
      if (parser && visibleIdleEls.has(dom)) {
        lastHlLang = lang;
        lastHlText = text;
        renderHighlighted(codeEl, text, parser);
        return;
      }
      lastHlLang = lang;
      lastHlText = text;
      jobByTarget.set(dom, { codeEl, text, lang, loader });
      ensureObserver()?.observe(dom);
      if (visibleIdleEls.has(dom)) {
        pendingJobs.add(dom);
        scheduleHighlightFlush();
      }
    };

    const renderIdle = () => {
      const cfg = configSlice.get();
      loader.setLanguages(cfg.languages);
      dom.className = `milkdown-code-block pocket-code-idle${selected ? " selected" : ""}`;
      lastHlLang = "";
      lastHlText = "";

      const tools = document.createElement("div");
      tools.className = "tools";

      const langText = String(curNode.attrs.language || "").trim() || "text";
      langBtn = document.createElement("button");
      langBtn.type = "button";
      langBtn.className = "language-button";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = langText;
      const expandSpan = document.createElement("span");
      expandSpan.className = "expand-icon";
      if (cfg.expandIcon) expandSpan.appendChild(cloneIcon(cfg.expandIcon));
      langBtn.append(labelSpan, expandSpan);
      langBtn.addEventListener("mousedown", (e) => {
        if (!view.editable) return;
        e.preventDefault();
        e.stopPropagation();
        activate({ openPicker: true });
      });

      const btnGroup = document.createElement("div");
      btnGroup.className = "tools-button-group";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-button";
      if (cfg.copyIcon) copyBtn.appendChild(cloneIcon(cfg.copyIcon));
      const copyLabel = document.createElement("span");
      copyLabel.textContent = cfg.copyText || "复制";
      copyBtn.appendChild(copyLabel);
      copyBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(curNode.textContent).catch(() => {});
        cfg.onCopy?.(curNode.textContent);
      });
      btnGroup.appendChild(copyBtn);
      tools.append(langBtn, btnGroup);

      const host = document.createElement("div");
      host.className = "codemirror-host";
      const pre = document.createElement("pre");
      pre.className = "pocket-code-pre";
      codeEl = document.createElement("code");
      codeEl.textContent = curNode.textContent;
      pre.appendChild(codeEl);
      host.appendChild(pre);

      pre.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        activate({ clientX: e.clientX, clientY: e.clientY });
      });

      previewPanel = document.createElement("div");
      previewPanel.className = "preview-panel hidden";
      const divBar = document.createElement("div");
      divBar.className = "preview-divider";
      const pLabel = document.createElement("div");
      pLabel.className = "preview-label";
      pLabel.textContent = cfg.previewLabel || "预览";
      previewContainer = document.createElement("div");
      previewContainer.className = "preview";
      previewPanel.append(divBar, pLabel, previewContainer);

      dom.replaceChildren(tools, host, previewPanel);
      syncIdlePreview(cfg);
      queueHighlight();
    };

    const deactivate = () => {
      cancelTeardown();
      if (!activeInner) return;
      curNode = activeInner.node;
      activeInner.destroy();
      activeInner = null;
      renderIdle();
    };

    const scheduleDeactivate = () => {
      cancelTeardown();
      teardownTimer = window.setTimeout(() => {
        teardownTimer = null;
        if (!activeInner) return;
        const active = document.activeElement;
        if (selected || (active && dom.contains(active))) return;
        deactivate();
      }, 1500);
    };

    const activate = (opts?: { anchor?: number; head?: number; clientX?: number; clientY?: number; openPicker?: boolean; select?: boolean }) => {
      cancelTeardown();
      if (!activeInner) {
        ensureObserver()?.unobserve(dom);
        jobByTarget.delete(dom);
        pendingJobs.delete(dom);
        codeEl = null;
        langBtn = null;
        previewPanel = null;
        previewContainer = null;

        const cfg = configSlice.get();
        loader.setLanguages(cfg.languages);
        activeInner = new CodeMirrorBlock(
          curNode,
          view,
          getPos,
          loader as never,
          cfg,
          (watcher) => configSlice.on(watcher),
        );
        dom.className = `milkdown-code-block pocket-code-active${selected ? " selected" : ""}`;
        dom.replaceChildren(activeInner.dom);
      }

      if (opts?.select) {
        activeInner.selectNode();
      } else {
        const a = opts?.anchor ?? 0;
        const h = opts?.head ?? a;
        activeInner.setSelection(a, h);
        if (opts?.clientX !== undefined && opts?.clientY !== undefined && activeInner.cm) {
          const pos = activeInner.cm.posAtCoords({ x: opts.clientX, y: opts.clientY });
          if (typeof pos === "number") activeInner.setSelection(pos, pos);
        }
      }
      if (opts?.openPicker) {
        activeInner.dom.querySelector<HTMLButtonElement>(".language-button")?.click();
      }
    };

    dom.addEventListener("focusin", cancelTeardown);
    dom.addEventListener("focusout", (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && dom.contains(next)) return;
      scheduleDeactivate();
    });

    renderIdle();

    return {
      dom,
      update(node) {
        if (node.type !== curNode.type) return false;
        curNode = node;
        if (activeInner) return activeInner.update(node);
        if (langBtn) {
          const span = langBtn.firstElementChild;
          if (span) span.textContent = String(node.attrs.language || "").trim() || "text";
        }
        if (codeEl && codeEl.textContent !== node.textContent) {
          codeEl.textContent = node.textContent;
          lastHlLang = "";
          lastHlText = "";
        }
        syncIdlePreview(configSlice.get());
        queueHighlight();
        return true;
      },
      setSelection(anchor, head) {
        activate({ anchor, head });
      },
      selectNode() {
        selected = true;
        dom.classList.add("selected");
        if (activeInner) activeInner.selectNode();
      },
      deselectNode() {
        selected = false;
        dom.classList.remove("selected");
        activeInner?.deselectNode();
        scheduleDeactivate();
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
      destroy() {
        cancelTeardown();
        ensureObserver()?.unobserve(dom);
        jobByTarget.delete(dom);
        pendingJobs.delete(dom);
        activeInner?.destroy();
        activeInner = null;
      },
    };
  };
});
