import { useRef } from "preact/hooks";

interface Props {
  label: string;
  ratio: number;
  orientation?: "vertical" | "horizontal";
  resize: (fraction: number) => void;
  reset: () => void;
}

// Measure the two adjacent panes along the split axis, excluding the handle.
function measure(handle: HTMLElement, horizontal: boolean) {
  const prev = handle.previousElementSibling!.getBoundingClientRect();
  const next = handle.nextElementSibling!.getBoundingClientRect();
  const first = horizontal ? prev.height : prev.width;
  const total = first + (horizontal ? next.height : next.width);
  return { first, total };
}

export function Splitter({
  label,
  ratio,
  orientation = "vertical",
  resize,
  reset,
}: Props) {
  const horizontal = orientation === "horizontal";
  const drag = useRef<{
    pointer: number;
    origin: number;
    first: number;
    total: number;
  }>();

  function adjust(first: number, total: number) {
    if (!total) return;
    const min = Math.min(horizontal ? 96 : 160, total / 3.5);
    resize(Math.max(min, Math.min(total - min, first)) / total);
  }

  return (
    <div
      class={"jx-splitter" + (horizontal ? " is-horizontal" : "")}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title={label + " · 拖动调整，双击复位"}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        const handle = e.currentTarget;
        drag.current = {
          pointer: e.pointerId,
          origin: horizontal ? e.clientY : e.clientX,
          ...measure(handle, horizontal),
        };
        handle.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && d.pointer === e.pointerId) {
          const pos = horizontal ? e.clientY : e.clientX;
          adjust(d.first + pos - d.origin, d.total);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onDblClick={reset}
      onKeyDown={(e) => {
        const inc = horizontal
          ? e.key === "ArrowDown"
            ? 16
            : e.key === "ArrowUp"
              ? -16
              : 0
          : e.key === "ArrowRight"
            ? 16
            : e.key === "ArrowLeft"
              ? -16
              : 0;
        if (!inc) return;
        e.preventDefault();
        e.stopPropagation();
        const { first, total } = measure(e.currentTarget, horizontal);
        adjust(first + inc, total);
      }}
    />
  );
}
