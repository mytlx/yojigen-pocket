import { useEffect, useState } from "preact/hooks";
import { Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-preact";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $remark, $view } from "@milkdown/kit/utils";
import { Notes } from "../host";
import { resolveNoteRelativePath } from "./images";

export interface ResizedImageAttrs {
  src: string;
  alt: string;
  title: string;
  width: number;
}

export interface LightboxImageInfo {
  /** 实际可用于渲染展示的图片 URL（已解析相对路径） */
  src: string;
  /** Markdown 中原始 src */
  origSrc: string;
  alt: string;
}

const MIN_IMG_WIDTH = 48;
const MAX_IMG_WIDTH = 2400;

const IMG_TAG_RE = /^\s*<img\s+([^>]*?)\s*\/?>\s*$/i;
const ATTR_PAIR_RE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SAFE_IMG_ATTRS = new Set(["src", "alt", "title", "width", "height", "style"]);

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseWidthPx(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(trimmed);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  if (!Number.isFinite(n) || n < MIN_IMG_WIDTH || n > MAX_IMG_WIDTH) return null;
  return n;
}

/**
 * 解析 Markdown 中由缩放生成的标准 `<img src="..." alt="..." width="480" />`（方案 A）。
 * 若包含 class / id / on* 等自定义 HTML 属性则放弃接管，交由原 HTML 渲染器无损保留。
 */
export function parseResizedImgHtml(rawHtml: string): ResizedImageAttrs | null {
  const m = IMG_TAG_RE.exec(rawHtml);
  if (!m) return null;
  const body = m[1] ?? "";
  const attrs: Record<string, string> = {};
  ATTR_PAIR_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ATTR_PAIR_RE.exec(body)) !== null) {
    const name = am[1]!.toLowerCase();
    if (!SAFE_IMG_ATTRS.has(name)) return null;
    const val = decodeHtmlEntities(am[2] ?? am[3] ?? am[4] ?? "");
    attrs[name] = val;
  }
  const src = attrs.src?.trim();
  if (!src) return null;
  let width = parseWidthPx(attrs.width);
  if (width === null && attrs.style) {
    const parts = attrs.style
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      const colon = part.indexOf(":");
      if (colon < 0) return null;
      const prop = part.slice(0, colon).trim().toLowerCase();
      const val = part.slice(colon + 1).trim();
      if (prop === "width") {
        width = parseWidthPx(val);
      } else if (prop === "height" && val.toLowerCase() === "auto") {
        continue;
      } else {
        return null;
      }
    }
  }
  if (width === null) return null;
  return {
    src,
    alt: attrs.alt ?? "",
    title: attrs.title ?? "",
    width,
  };
}

/** 按方案 A 序列化缩放后的图片为通用兼容的 `<img src="..." alt="..." width="..." />`。 */
export function formatResizedImgHtml(attrs: { src: string; alt?: string | null; title?: string | null; width: number }): string {
  const w = Math.max(MIN_IMG_WIDTH, Math.min(MAX_IMG_WIDTH, Math.round(attrs.width)));
  const parts = [`src="${escapeHtmlAttr(attrs.src)}"`];
  if (attrs.alt !== undefined && attrs.alt !== null) parts.push(`alt="${escapeHtmlAttr(attrs.alt)}"`);
  if (attrs.title) parts.push(`title="${escapeHtmlAttr(attrs.title)}"`);
  parts.push(`width="${w}"`);
  return `<img ${parts.join(" ")} />`;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  data?: Record<string, unknown>;
  children?: MdNode[];
}

const SKIP_MD_NODES = new Set(["code", "inlineCode", "math", "inlineMath", "yaml", "definition", "footnoteReference"]);

function transformResizedImgs(node: MdNode) {
  if (!node.children || SKIP_MD_NODES.has(node.type)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (child.type === "html" && typeof child.value === "string") {
      const parsed = parseResizedImgHtml(child.value);
      if (parsed) {
        const imgNode: MdNode = {
          type: "image",
          url: parsed.src,
          alt: parsed.alt,
          title: parsed.title || undefined,
          data: { pocketWidth: parsed.width },
        };
        // 顶层块级 HTML <img> 包进段落，与普通 Markdown 图片节点保持同一语义树
        node.children[i] = node.type === "root" || node.type === "blockquote" || node.type === "listItem"
          ? { type: "paragraph", children: [imgNode] }
          : imgNode;
        continue;
      }
    }
    transformResizedImgs(child);
  }
}

export const remarkPocketImage = $remark("remarkPocketImage", () => () => (tree: unknown) => {
  transformResizedImgs(tree as MdNode);
});

/** 扩展 Milkdown imageSchema：支持可选 width 属性；未改尺寸保持 ![]()，改过尺寸写为 <img ... width="..." />。 */
export function configurePocketImageSchema(ctx: Ctx) {
  ctx.update(imageSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        width: { default: null },
      },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLElement)) return false;
            const width = parseWidthPx(dom.getAttribute("width") ?? dom.style.width ?? undefined);
            return {
              src: dom.getAttribute("src") ?? "",
              title: dom.getAttribute("title") ?? "",
              alt: dom.getAttribute("alt") ?? "",
              width,
            };
          },
        },
      ],
      toDOM: (node: PMNode) => {
        const w = typeof node.attrs.width === "number" && node.attrs.width > 0 ? Math.round(node.attrs.width) : null;
        const attrs: Record<string, string> = {
          src: String(node.attrs.src ?? ""),
          alt: String(node.attrs.alt ?? ""),
        };
        if (node.attrs.title) attrs.title = String(node.attrs.title);
        if (w) {
          attrs.width = String(w);
          attrs.style = `width: ${w}px; height: auto;`;
        }
        return ["img", attrs];
      },
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          const url = (node.url as string) ?? "";
          const alt = (node.alt as string) ?? "";
          const title = (node.title as string) ?? "";
          const rawWidth = (node.data as { pocketWidth?: unknown } | undefined)?.pocketWidth;
          const width = typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth >= MIN_IMG_WIDTH ? Math.round(rawWidth) : null;
          state.addNode(type, { src: url, alt, title, width });
        },
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          const src = String(node.attrs.src ?? "");
          const alt = String(node.attrs.alt ?? "");
          const title = String(node.attrs.title ?? "");
          const width = typeof node.attrs.width === "number" && Number.isFinite(node.attrs.width) && node.attrs.width >= MIN_IMG_WIDTH
            ? Math.round(node.attrs.width)
            : null;
          if (width !== null) {
            state.addNode("html", undefined, formatResizedImgHtml({ src, alt, title, width }));
            return;
          }
          state.addNode("image", undefined, undefined, {
            ...(title ? { title } : {}),
            url: src,
            alt,
          });
        },
      },
    };
  });
}

export interface PocketImageViewOptions {
  getNotePath: () => string;
  resolvedImgMap: Map<string, string>;
  onOpenLightbox: (info: LightboxImageInfo) => void;
}

/** 自定义图片 NodeView：支持相对路径本地解析、单击选中、拖拽左右/右下边缘等比缩放、双击放大预览。 */
export function createPocketImageView(opts: PocketImageViewOptions) {
  return $view(imageSchema.node, () => (initialNode: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    let curNode = initialNode;
    let selected = false;
    let resizing = false;

    const wrap = document.createElement("span");
    wrap.className = "pocket-img-wrap";
    wrap.contentEditable = "false";

    const img = document.createElement("img");
    img.className = "pocket-img-el";
    img.draggable = false;

    const leftHandle = document.createElement("span");
    leftHandle.className = "pocket-img-handle is-left";
    leftHandle.title = "拖动调整大小（双击恢复原始尺寸）";

    const rightHandle = document.createElement("span");
    rightHandle.className = "pocket-img-handle is-right";
    rightHandle.title = "拖动调整大小（双击恢复原始尺寸）";

    const cornerHandle = document.createElement("span");
    cornerHandle.className = "pocket-img-handle is-corner";
    cornerHandle.title = "拖动调整大小（双击恢复原始尺寸）";

    const badge = document.createElement("span");
    badge.className = "pocket-img-badge";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "pocket-img-reset";
    resetBtn.title = "恢复原始尺寸";
    resetBtn.textContent = "1:1";

    wrap.append(img, leftHandle, rightHandle, cornerHandle, badge, resetBtn);

    let activeOrigSrc = "";
    const applySrc = (orig: string) => {
      activeOrigSrc = orig;
      if (!orig) {
        img.removeAttribute("src");
        return;
      }
      const rel = resolveNoteRelativePath(opts.getNotePath(), orig);
      if (!rel) {
        if (img.getAttribute("src") !== orig) img.src = orig;
        return;
      }
      const cached = opts.resolvedImgMap.get(orig);
      if (cached) {
        if (img.getAttribute("src") !== cached) img.src = cached;
        return;
      }
      void Notes.imageAssetUrl(rel)
        .then((url) => {
          if (!url) return;
          opts.resolvedImgMap.set(orig, url);
          if (wrap.isConnected && activeOrigSrc === orig && img.getAttribute("src") !== url) {
            img.src = url;
          }
        })
        .catch(() => undefined);
    };

    const syncFromNode = (node: PMNode) => {
      curNode = node;
      const src = String(node.attrs.src ?? "");
      const alt = String(node.attrs.alt ?? "");
      const title = String(node.attrs.title ?? "");
      const width = typeof node.attrs.width === "number" && node.attrs.width >= MIN_IMG_WIDTH ? Math.round(node.attrs.width) : null;

      applySrc(src);
      img.alt = alt;
      if (title) img.title = title;
      else img.removeAttribute("title");

      if (width !== null) {
        img.style.width = `${width}px`;
        img.style.height = "auto";
        wrap.classList.add("has-width");
        badge.textContent = `${width}px`;
      } else {
        img.style.width = "";
        img.style.height = "";
        wrap.classList.remove("has-width");
        badge.textContent = "";
      }
      wrap.classList.toggle("is-readonly", !view.editable);
    };

    syncFromNode(initialNode);

    const commitWidth = (nextWidth: number | null) => {
      if (view.isDestroyed || !view.editable) return;
      const pos = getPos();
      if (typeof pos !== "number") return;
      const latestNode = view.state.doc.nodeAt(pos);
      if (!latestNode || latestNode.type.name !== curNode.type.name) return;
      const curW = typeof latestNode.attrs.width === "number" ? latestNode.attrs.width : null;
      if (curW === nextWidth) return;
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...latestNode.attrs, width: nextWidth });
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      view.dispatch(tr);
    };

    const selectSelf = () => {
      if (view.isDestroyed || !view.editable) return;
      const pos = getPos();
      if (typeof pos !== "number") return;
      try {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        view.focus();
      } catch {
        /* 忽略非法选区 */
      }
    };

    const onImgMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !view.editable) return;
      if ((e.target as Element)?.closest(".pocket-img-handle, .pocket-img-reset")) return;
      selectSelf();
    };

    const onImgDblClick = (e: MouseEvent) => {
      if ((e.target as Element)?.closest(".pocket-img-handle, .pocket-img-reset")) return;
      e.preventDefault();
      e.stopPropagation();
      const orig = String(curNode.attrs.src ?? "");
      const displaySrc = img.currentSrc || img.getAttribute("src") || opts.resolvedImgMap.get(orig) || orig;
      if (!displaySrc) return;
      opts.onOpenLightbox({
        src: displaySrc,
        origSrc: orig,
        alt: String(curNode.attrs.alt ?? ""),
      });
    };

    const startDragResize = (side: "left" | "right" | "corner") => (e: PointerEvent) => {
      if (e.button !== 0 || !view.editable) return;
      e.preventDefault();
      e.stopPropagation();
      selectSelf();

      const startX = e.clientX;
      const rect = img.getBoundingClientRect();
      const startW = Math.max(MIN_IMG_WIDTH, Math.round(rect.width || Number(curNode.attrs.width) || img.naturalWidth || 240));
      const hostEl = wrap.closest(".ProseMirror") as HTMLElement | null;
      const maxW = Math.min(MAX_IMG_WIDTH, Math.max(240, Math.round((hostEl?.clientWidth ?? 1200) - 8)));
      let currentW = startW;
      resizing = true;
      wrap.classList.add("is-resizing");
      badge.textContent = `${currentW}px`;

      const handleEl = e.currentTarget as HTMLElement;
      handleEl.setPointerCapture?.(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = side === "left" ? startX - ev.clientX : ev.clientX - startX;
        currentW = Math.max(MIN_IMG_WIDTH, Math.min(maxW, Math.round(startW + dx)));
        img.style.width = `${currentW}px`;
        img.style.height = "auto";
        badge.textContent = `${currentW}px`;
      };
      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        resizing = false;
        wrap.classList.remove("is-resizing");
        commitWidth(currentW);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    };

    const onHandleDblClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      commitWidth(null);
    };

    const onResetClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      commitWidth(null);
    };

    const onLeftDown = startDragResize("left");
    const onRightDown = startDragResize("right");
    const onCornerDown = startDragResize("corner");

    wrap.addEventListener("mousedown", onImgMouseDown);
    img.addEventListener("dblclick", onImgDblClick);
    leftHandle.addEventListener("pointerdown", onLeftDown);
    rightHandle.addEventListener("pointerdown", onRightDown);
    cornerHandle.addEventListener("pointerdown", onCornerDown);
    leftHandle.addEventListener("dblclick", onHandleDblClick);
    rightHandle.addEventListener("dblclick", onHandleDblClick);
    cornerHandle.addEventListener("dblclick", onHandleDblClick);
    resetBtn.addEventListener("click", onResetClick);

    return {
      dom: wrap,
      update(nextNode: PMNode) {
        if (nextNode.type !== curNode.type) return false;
        if (!resizing) syncFromNode(nextNode);
        else curNode = nextNode;
        wrap.classList.toggle("is-selected", selected && view.editable);
        return true;
      },
      selectNode() {
        selected = true;
        wrap.classList.toggle("is-selected", view.editable);
      },
      deselectNode() {
        selected = false;
        wrap.classList.remove("is-selected");
      },
      stopEvent(event: Event) {
        if (resizing) return true;
        if (event.type === "dblclick") return true;
        if ((event.target as Element | null)?.closest(".pocket-img-handle, .pocket-img-reset")) return true;
        return false;
      },
      ignoreMutation: () => true,
      destroy() {
        wrap.removeEventListener("mousedown", onImgMouseDown);
        img.removeEventListener("dblclick", onImgDblClick);
        leftHandle.removeEventListener("pointerdown", onLeftDown);
        rightHandle.removeEventListener("pointerdown", onRightDown);
        cornerHandle.removeEventListener("pointerdown", onCornerDown);
        leftHandle.removeEventListener("dblclick", onHandleDblClick);
        rightHandle.removeEventListener("dblclick", onHandleDblClick);
        cornerHandle.removeEventListener("dblclick", onHandleDblClick);
        resetBtn.removeEventListener("click", onResetClick);
      },
    };
  });
}

/** 双击图片全屏放大预览弹窗：支持滚轮缩放、拖拽平移、1:1 / 适应窗口切换与快捷键。 */
export function ImageLightbox(props: { image: LightboxImageInfo; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const clampScale = (s: number) => Math.max(0.25, Math.min(5, Math.round(s * 100) / 100));

  const zoomBy = (delta: number) => {
    setFitMode(false);
    setScale((s) => clampScale(s + delta));
  };

  const resetFit = () => {
    setFitMode(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const resetActual = () => {
    setFitMode(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(0.2);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomBy(-0.2);
      } else if (e.key === "0") {
        e.preventDefault();
        resetFit();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props.onClose]);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.15 : -0.15;
    setFitMode(false);
    setScale((s) => clampScale(s + step));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...offset };
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      setOffset({ x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) });
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const caption = props.image.alt || props.image.origSrc.split("/").pop() || "图片预览";

  return (
    <div
      class="fx-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="图片放大预览"
      onWheel={(e) => onWheel(e as unknown as WheelEvent)}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="fx-lightbox-stage" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        <img
          src={props.image.src}
          alt={props.image.alt}
          draggable={false}
          class={`fx-lightbox-img${fitMode ? " is-fit" : ""}${dragging ? " is-dragging" : ""}`}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
          onLoad={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            if (el.naturalWidth > 0) setNatural({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          onPointerDown={(e) => onPointerDown(e as unknown as PointerEvent)}
          onDblClick={resetFit}
        />
      </div>

      <div class="fx-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span class="fx-lightbox-caption" title={props.image.origSrc}>
          {caption}
          {natural ? ` (${natural.w}×${natural.h})` : ""}
        </span>
        <span class="fx-lightbox-sep" />
        <button type="button" class="fx-lightbox-btn" title="缩小 (-)" aria-label="缩小" onClick={() => zoomBy(-0.2)}>
          <ZoomOut size={15} />
        </button>
        <span class="fx-lightbox-pct">{Math.round(scale * 100)}%</span>
        <button type="button" class="fx-lightbox-btn" title="放大 (+)" aria-label="放大" onClick={() => zoomBy(0.2)}>
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          class={`fx-lightbox-btn is-text${fitMode ? " is-active" : ""}`}
          title="适应窗口 (0)"
          onClick={resetFit}
        >
          <Minimize2 size={13} />
          <span>适应</span>
        </button>
        <button
          type="button"
          class={`fx-lightbox-btn is-text${!fitMode && scale === 1 ? " is-active" : ""}`}
          title="原始尺寸 (1:1)"
          onClick={resetActual}
        >
          <Maximize2 size={13} />
          <span>1:1</span>
        </button>
        {(offset.x !== 0 || offset.y !== 0) && (
          <button type="button" class="fx-lightbox-btn" title="重置位置" onClick={resetFit}>
            <RotateCcw size={14} />
          </button>
        )}
        <span class="fx-lightbox-sep" />
        <button type="button" class="fx-lightbox-btn" title="关闭 (Esc)" aria-label="关闭预览" onClick={props.onClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
