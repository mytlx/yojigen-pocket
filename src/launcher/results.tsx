import { useLayoutEffect, useRef } from "preact/hooks";
import type { Item, Preview } from "../mygo";
import { Icon } from "../shared/icons";
import { Pin } from "lucide-preact";
import { FilePreview } from "../shared/filepreview";

/** 把命中的字符高亮。 */
function Highlighted({ text, positions }: { text: string; positions?: number[] }) {
  if (!positions?.length) return <>{text}</>;
  const set = new Set(positions);
  const out: preact.ComponentChildren[] = [];
  let run = "";
  let runHit = false;
  Array.from(text).forEach((ch, i) => {
    const hit = set.has(i);
    if (hit !== runHit && run) {
      out.push(runHit ? <mark>{run}</mark> : run);
      run = "";
    }
    run += ch;
    runHit = hit;
  });
  if (run) out.push(runHit ? <mark>{run}</mark> : run);
  return <>{out}</>;
}

// 窗口出现或列表变化时，指针没动 WebKit 也会发 mousemove。只有指针真的移动才改变选中项，
// 否则键盘选中的行会被静止的指针抢走。
let lastPointer: { x: number; y: number } | null = null;
function pointerMoved(e: MouseEvent) {
  const moved = lastPointer !== null && (lastPointer.x !== e.screenX || lastPointer.y !== e.screenY);
  lastPointer = { x: e.screenX, y: e.screenY };
  return moved;
}

interface ListProps {
  items: Item[];
  selected: number;
  onSelect: (i: number) => void;
  onRun: (i: number) => void;
  onActions: (i: number, at: { x: number; y: number }) => void;
  modHeld: boolean;
  indexLabel: string;
}

/**
 * 选中块：一个独立的底块滑到选中的那一行，带回弹。
 * 换了一批结果（打字）时直接跳过去，只有上下移动选择时才滑动，免得打字时晃眼。
 */
function useCursor(selected: number, items: Item[], container: preact.RefObject<HTMLElement>, selector: string, grid = false) {
  const cursor = useRef<HTMLDivElement>(null);
  const lastItems = useRef(items);
  useLayoutEffect(() => {
    const el = cursor.current;
    const target = container.current?.querySelectorAll<HTMLElement>(selector)[selected];
    if (!el || !target) {
      if (el) el.style.opacity = "0";
      return;
    }
    const jump = lastItems.current !== items;
    lastItems.current = items;
    el.classList.toggle("is-instant", jump);
    el.style.opacity = "1";
    el.style.height = `${target.offsetHeight}px`;
    if (grid) el.style.width = `${target.offsetWidth}px`;
    el.style.transform = `translate(${grid ? target.offsetLeft : 0}px, ${target.offsetTop}px)`;
    if (jump) void el.offsetWidth; // 立即生效，再恢复过渡
    if (jump) requestAnimationFrame(() => el.classList.remove("is-instant"));
  }, [selected, items]);
  return cursor;
}

export function Results(props: ListProps & { done: boolean; showSource: boolean; showPreview: boolean; showMeta: boolean }) {
  const { items, selected, onSelect, onRun, onActions, modHeld, indexLabel, done, showSource, showPreview, showMeta } = props;
  const current = items[selected];
  // 文件有预览区和属性区两个开关，开着任意一个就显示右侧；其他内容只看预览的开关。
  const isFile = current?.preview?.type === "file";
  const preview = (isFile ? showPreview || showMeta : showPreview) ? current?.preview : undefined;
  const list = useRef<HTMLDivElement>(null);
  const cursor = useCursor(selected, items, list, ".pk-row");

  if (items.length === 0) {
    return <div class="pk-empty">{done ? "没有找到结果" : "正在搜索…"}</div>;
  }
  return (
    <div class={`pk-results${preview ? " has-preview" : ""}`}>
      <div class="pk-list" role="listbox" ref={list}>
        <div class="pk-cursor" ref={cursor} />
        {items.map((item, i) => (
          <div
            key={item.id}
            role="option"
            aria-selected={i === selected}
            class={`pk-row${i === selected ? " is-selected" : ""}${item.error ? " is-error" : ""}`}
            onMouseMove={(e) => pointerMoved(e) && i !== selected && onSelect(i)}
            onClick={() => onRun(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              onActions(i, { x: e.clientX, y: e.clientY });
            }}
          >
            <Icon icon={item.icon} size={rowIcon} />
            <div class="pk-row-text">
              <div class="pk-row-title">
                <Highlighted text={item.title} positions={item.highlights} />
              </div>
              {item.subtitle && <div class="pk-row-subtitle">{item.subtitle}</div>}
            </div>
            <div class="pk-row-meta">
              {item.pinned && <Pin class="pk-row-pin" size={13} strokeWidth={2} />}
              {modHeld && i < 9 ? (
                <span class="pk-row-index">
                  <kbd>{indexLabel}</kbd>
                  <kbd>{i + 1}</kbd>
                </span>
              ) : (
                showSource && !preview && item.sourceLabel && <span class="pk-row-badge">{item.sourceLabel}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {preview &&
        (isFile ? (
          <div class="pk-preview" key={current!.id}>
            <FilePreview path={preview.text ?? ""} showPreview={showPreview} showMeta={showMeta} />
          </div>
        ) : (
          <PreviewPane key={current!.id} preview={preview} />
        ))}
    </div>
  );
}

const rowIcon = 30;

function PreviewPane({ preview }: { preview: Preview }) {
  return (
    <div class="pk-preview">
      {preview.type === "image" && (
        <div class="pk-preview-image">
          <img src={preview.url} alt="" draggable={false} />
        </div>
      )}
      {(preview.type === "text" || preview.type === "code") && <pre class={`pk-preview-text${preview.type === "code" ? " is-code" : ""}`}>{preview.text}</pre>}
      {preview.info && <div class="pk-preview-info">{preview.info}</div>}
    </div>
  );
}

/** 首页：固定的和常用的，一排排图标。 */
export function Home({ items, selected, onSelect, onRun, onActions, modHeld, indexLabel }: ListProps) {
  const grid = useRef<HTMLDivElement>(null);
  const cursor = useCursor(selected, items, grid, ".pk-tile", true);
  if (items.length === 0) {
    return <div class="pk-empty">输入内容开始搜索。常用的项目会出现在这里。</div>;
  }
  return (
    <div class="pk-home" role="listbox" ref={grid}>
      <div class="pk-cursor is-tile" ref={cursor} />
      {items.map((item, i) => (
        <div
          key={item.id}
          role="option"
          aria-selected={i === selected}
          class={`pk-tile${i === selected ? " is-selected" : ""}`}
          title={item.subtitle ? `${item.title}\n${item.subtitle}` : item.title}
          onMouseMove={(e) => pointerMoved(e) && i !== selected && onSelect(i)}
          onClick={() => onRun(i)}
          onContextMenu={(e) => {
            e.preventDefault();
            onActions(i, { x: e.clientX, y: e.clientY });
          }}
        >
          <Icon icon={item.icon} size={40} />
          <div class="pk-tile-title">{item.title}</div>
          {item.pinned && <Pin class="pk-tile-pin" size={11} strokeWidth={2.2} />}
          {modHeld && i < 9 && (
            <span class="pk-tile-index">
              <kbd>{indexLabel}</kbd>
              <kbd>{i + 1}</kbd>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
