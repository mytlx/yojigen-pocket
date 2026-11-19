import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Check, Copy } from "lucide-preact";

/** 按钮：按下缩一下，松开弹回。 */
export function Btn(props: {
  children?: ComponentChildren;
  onClick?: () => void;
  primary?: boolean;
  ghost?: boolean;
  small?: boolean;
  icon?: boolean;
  danger?: boolean;
  on?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  const cls = ["ui-btn"];
  if (props.primary) cls.push("is-primary");
  if (props.ghost) cls.push("is-ghost");
  if (props.small) cls.push("is-small");
  if (props.icon) cls.push("is-icon");
  if (props.danger) cls.push("is-danger");
  if (props.on) cls.push("is-on");
  return (
    <button type="button" class={cls.join(" ")} title={props.title} aria-label={props.title} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/** 复制按钮：成功后变成一个蹦出来的勾。 */
export function CopyBtn({ text, copy, label, small = true }: { text: string; copy: (t: string) => Promise<void>; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Btn
      small={small}
      ghost={!label}
      icon={!label}
      title={label ?? "复制"}
      disabled={!text}
      onClick={() => {
        void copy(text).then(() => {
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check class="q-done" size={14} strokeWidth={2.4} /> : <Copy size={14} strokeWidth={1.9} />}
      {label}
    </Btn>
  );
}

/** 分段选择：选中的底块滑过去，带一点回弹。 */
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sync = () => {
      const btn = box.current?.querySelector<HTMLElement>("button.is-on");
      if (!btn || !thumb.current) return;
      thumb.current.style.width = `${btn.offsetWidth}px`;
      thumb.current.style.transform = `translateX(${btn.offsetLeft}px)`;
    };
    sync();
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div class="ui-seg" role="radiogroup" ref={box}>
      <div class="ui-seg-thumb" ref={thumb} />
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={o.value === value} class={o.value === value ? "is-on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" class={`ui-toggle${checked ? " is-on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Empty({ icon, title, desc, children }: { icon?: ComponentChildren; title: string; desc?: string; children?: ComponentChildren }) {
  return (
    <div class="ui-empty">
      {icon}
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {children}
    </div>
  );
}

/** 停手一会儿再更新的值，避免每敲一个字就重算。 */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** 挂载后把焦点给这个输入框。 */
export function useFocus<T extends HTMLElement>(): preact.RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  return ref;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}

/** 给 JSON 文本上色（先转义，所以内容里的 HTML 不会生效）。 */
export function highlightJSON(text: string): string {
  const esc = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return esc.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "fx-num";
      if (m.startsWith('"')) cls = m.trimEnd().endsWith(":") ? "fx-json-key" : "fx-str";
      else if (m === "true" || m === "false") cls = "fx-bool";
      else if (m === "null") cls = "fx-null";
      return `<span class="${cls}">${m}</span>`;
    },
  );
}

/** 让列表里选中的那一行保持可见。只滚这个列表自己，不会带着整个窗口一起滚。 */
export function keepVisible(box: HTMLElement | null, selector = ".is-selected") {
  const row = box?.querySelector<HTMLElement>(selector);
  if (!box || !row) return;
  const b = box.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
}
