import { useRef } from "preact/hooks";

interface Props {
  label: string;
  ratio: number;
  resize: (fraction: number) => void;
  reset: () => void;
}

// Measure the two adjacent panes, excluding the handle and any other pane.
function measure(handle: HTMLElement) {
  const left = handle.previousElementSibling!.getBoundingClientRect().width;
  const total = left + handle.nextElementSibling!.getBoundingClientRect().width;
  return { left, total };
}

export function Splitter({ label, ratio, resize, reset }: Props) {
  const drag = useRef<{
    pointer: number;
    x: number;
    left: number;
    total: number;
  }>();
  function adjust(left: number, total: number) {
    if (!total) return;
    const min = Math.min(100, total / 3);
    resize(Math.max(min, Math.min(total - min, left)) / total);
  }
  return (
    <div
      class="jx-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title={label + " · 拖动调整，双击复位"}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        const handle = e.currentTarget;
        drag.current = {
          pointer: e.pointerId,
          x: e.clientX,
          ...measure(handle),
        };
        handle.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && d.pointer === e.pointerId)
          adjust(d.left + e.clientX - d.x, d.total);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onDblClick={reset}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const { left, total } = measure(e.currentTarget);
        adjust(left + (e.key === "ArrowRight" ? 16 : -16), total);
      }}
    />
  );
}
