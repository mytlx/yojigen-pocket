import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import {
  Code2,
  ListTree,
  Minimize2,
  Pencil,
  Plus,
  Quote,
  Sparkles,
  Unlink,
  X,
} from "lucide-preact";
import type { Mode } from "./document";

function useSlidingThumb(
  containerRef: preact.RefObject<HTMLElement>,
  thumbRef: preact.RefObject<HTMLElement>,
  selector: string,
  deps: unknown[],
) {
  const readyRef = useRef(false);
  useLayoutEffect(() => {
    const box = containerRef.current;
    const thumb = thumbRef.current;
    if (!box || !thumb) return;
    const sync = (instant: boolean) => {
      const target = box.querySelector<HTMLElement>(selector);
      if (!target) {
        thumb.style.opacity = "0";
        return;
      }
      if (instant) thumb.style.transition = "none";
      thumb.style.opacity = "1";
      thumb.style.width = `${target.offsetWidth}px`;
      thumb.style.height = `${target.offsetHeight}px`;
      thumb.style.transform = `translate3d(${target.offsetLeft}px, ${target.offsetTop}px, 0)`;
      if (instant) {
        void thumb.offsetWidth;
        thumb.style.transition = "";
      }
    };
    sync(!readyRef.current);
    readyRef.current = true;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => sync(true));
    ro.observe(box);
    return () => ro.disconnect();
  }, deps);
}

const modeGlyph: Record<Mode, ComponentChildren> = {
  tree: <ListTree size={13} />,
  format: <Sparkles size={13} />,
  minify: <Minimize2 size={13} />,
  escape: <Quote size={13} />,
  unescape: <Unlink size={13} />,
  xml: <Code2 size={13} />,
};

export function SlidingModes({
  mode,
  modes,
  onChange,
}: {
  mode: Mode;
  modes: Record<Mode, string>;
  onChange: (m: Mode) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const keys = Object.keys(modes) as Mode[];
  useSlidingThumb(boxRef, thumbRef, 'button[aria-pressed="true"]', [mode]);

  return (
    <div class="jx-modes" role="tablist" aria-label="处理模式" ref={boxRef}>
      <span class="jx-modes-thumb" aria-hidden="true" ref={thumbRef} />
      {keys.map((m) => (
        <button
          type="button"
          key={m}
          role="tab"
          aria-selected={mode === m}
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
        >
          <span class="jx-mode-ic" aria-hidden="true">
            {modeGlyph[m]}
          </span>
          <span>{modes[m]}</span>
        </button>
      ))}
    </div>
  );
}

export interface TabItem {
  id: number;
  name: string;
  initial: string;
}

export type TabHealth = "empty" | "valid" | "error";

export function SlidingTabs({
  tabs,
  active,
  rename,
  health,
  onSelect,
  onStartRename,
  onCommitRename,
  onClose,
  onAdd,
}: {
  tabs: TabItem[];
  active: number;
  rename: number;
  health: Record<number, TabHealth>;
  onSelect: (id: number) => void;
  onStartRename: (id: number) => void;
  onCommitRename: (id: number, name: string) => void;
  onClose: (id: number) => void;
  onAdd: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  useSlidingThumb(navRef, thumbRef, ".jx-tab.current", [
    active,
    rename,
    tabs.map((t) => `${t.id}:${t.name}`).join("|"),
  ]);

  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(".jx-tab.current");
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <nav class="jx-tabs" aria-label="JSON 文档" ref={navRef}>
      <span class="jx-tabs-thumb" aria-hidden="true" ref={thumbRef} />
      {tabs.map((t) => {
        const isCurrent = active === t.id;
        const st = health[t.id] ?? (t.initial.trim() ? "valid" : "empty");
        return (
          <div key={t.id} class={"jx-tab" + (isCurrent ? " current" : "")}>
            <span
              class={`jx-tab-dot is-${st}`}
              title={
                st === "error"
                  ? "存在语法错误"
                  : st === "valid"
                    ? "JSON 有效"
                    : "空白文档"
              }
            />
            {rename === t.id ? (
              <input
                ref={(node) => {
                  if (node && document.activeElement !== node) {
                    node.focus();
                    node.select();
                  }
                }}
                aria-label="标签名称"
                defaultValue={t.name}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim() || t.name;
                  onCommitRename(t.id, name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    e.currentTarget.value = t.name;
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                class="jx-tab-label"
                onClick={() => onSelect(t.id)}
                onDblClick={() => onStartRename(t.id)}
              >
                {t.name}
              </button>
            )}
            {isCurrent && rename !== t.id && (
              <button
                type="button"
                class="jx-tab-act"
                title="重命名标签"
                onClick={() => onStartRename(t.id)}
              >
                <Pencil size={11} />
              </button>
            )}
            {tabs.length > 1 && (
              <button
                type="button"
                class="jx-tab-act is-close"
                title={"关闭 " + t.name}
                onClick={() => onClose(t.id)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        class="jx-tab-add"
        title="新建标签"
        aria-label="新建标签"
        onClick={onAdd}
      >
        <Plus size={14} />
      </button>
    </nav>
  );
}

export function SlidingSwitch({
  checked,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  label: string;
  title?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      class={"jx-switch-pill" + (checked ? " is-on" : "")}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span class="jx-switch-track" aria-hidden="true">
        <span class="jx-switch-knob" />
      </span>
      <span class="jx-switch-text">{label}</span>
    </button>
  );
}

export function SlidingScope({
  scope,
  treeAvailable,
  options,
  onSelect,
}: {
  scope: "text" | "node";
  treeAvailable: boolean;
  options: { key: "text" | "node"; label: string; icon: ComponentChildren }[];
  onSelect: (k: "text" | "node") => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  useSlidingThumb(boxRef, thumbRef, 'button[aria-pressed="true"]', [
    scope,
    treeAvailable,
  ]);

  return (
    <div class="jx-searchmodes" ref={boxRef}>
      <span class="jx-searchmodes-thumb" aria-hidden="true" ref={thumbRef} />
      {options.map((o) => (
        <button
          type="button"
          key={o.key}
          aria-pressed={o.key === scope}
          disabled={o.key === "node" && !treeAvailable}
          onClick={() => onSelect(o.key)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
