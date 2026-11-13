import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Item } from "../mygo";
import { formatShortcut } from "./user";

/** 动作面板：列出这一项能做的所有事。 */
export function ActionPanel({
  item,
  mac,
  at,
  onRun,
  onClose,
}: {
  item: Item;
  mac: boolean;
  /** 右键时鼠标的位置（窗口坐标）；没有就停在右下角。 */
  at?: { x: number; y: number } | null;
  onRun: (index: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // 在鼠标处弹出，并留在面板范围内。面板会为菜单长高，所以跟着它的尺寸重新摆放。
  useLayoutEffect(() => {
    const el = root.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box || !at) return;
    const place = () => {
      const r = box.getBoundingClientRect();
      const left = Math.max(6, Math.min(at.x - r.left + 2, r.width - el.offsetWidth - 6));
      const top = Math.max(6, Math.min(at.y - r.top + 2, r.height - el.offsetHeight - 6));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = el.style.bottom = "auto";
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [at?.x, at?.y]);

  const actions = (item.actions ?? [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => (action.title ?? "").toLowerCase().includes(filter.toLowerCase()));

  useEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(".is-selected");
    const box = list.current;
    if (!row || !box) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight;
  }, [selected]);

  return (
    <>
      {/* 垫一层接住菜单外的点击：点空白处只是关菜单，不会误触下面的项。 */}
      <div
        class="pk-actions-backdrop"
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div class="pk-actions" ref={root} onClick={(e) => e.stopPropagation()}>
        <div class="pk-actions-title">{item.title}</div>
        <div class="pk-actions-list" ref={list}>
          {actions.map(({ action, index }, i) => (
            <div
              key={index}
              class={`pk-action${i === selected ? " is-selected" : ""}`}
              onMouseMove={() => setSelected(i)}
              onClick={() => onRun(index)}
            >
              <span>{action.title}</span>
              {index === 0 ? (
                <kbd>↵</kbd>
              ) : index === 1 ? (
                <span class="pk-action-keys">
                  <kbd>{mac ? "⌘" : "Ctrl"}</kbd>
                  <kbd>↵</kbd>
                </span>
              ) : (
                action.shortcut && (
                  <span class="pk-action-keys">
                    {formatShortcut(action.shortcut, mac).map((k) => (
                      <kbd>{k}</kbd>
                    ))}
                  </span>
                )
              )}
            </div>
          ))}
          {actions.length === 0 && <div class="pk-action-empty">没有匹配的动作</div>}
        </div>
        <input
          ref={input}
          class="pk-actions-filter"
          placeholder="筛选动作…"
          value={filter}
          spellcheck={false}
          onInput={(e) => {
            setFilter((e.target as HTMLInputElement).value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.isComposing) return;
            const count = Math.max(actions.length, 1);
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setSelected((s) => (s + 1) % count);
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setSelected((s) => (s - 1 + count) % count);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = actions[selected];
              if (hit) onRun(hit.index);
            } else if (e.key === "Escape" || ((mac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k")) {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
    </>
  );
}
