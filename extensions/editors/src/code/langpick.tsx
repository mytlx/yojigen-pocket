import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronDown } from "lucide-preact";
import { findLang, languages, searchLangs, type LangDef } from "./languages";

/** 语言选择：点开后直接打字搜索（名字、别名、扩展名都行），上下键选，回车确定。 */
export function LangPicker({
  value,
  onChange,
  list = languages,
  note,
}: {
  value: string;
  onChange: (id: string) => void;
  list?: LangDef[];
  /** 每个选项右侧的小字，例如“可运行”。 */
  note?: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const items = searchLangs(query, list);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, list.findIndex((l) => l.id === value)));
    field.current?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away, true);
    return () => document.removeEventListener("mousedown", away, true);
  }, [open]);
  useEffect(() => {
    // 只滚列表自己：scrollIntoView 会连着整个窗口一起滚。
    const listEl = box.current?.querySelector<HTMLElement>(".lang-pick-list");
    const row = listEl?.querySelector<HTMLElement>(".is-active");
    if (!listEl || !row) return;
    const b = listEl.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < b.top) listEl.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) listEl.scrollTop += r.bottom - b.bottom;
  }, [active, open]);

  const choose = (l?: LangDef) => {
    if (!l) return;
    onChange(l.id);
    setOpen(false);
  };
  return (
    <div class="lang-pick" ref={box}>
      <button type="button" class="lang-pick-btn" aria-haspopup="listbox" aria-expanded={open} title="选择语言" onClick={() => setOpen(!open)}>
        {findLang(value).name}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div class="lang-pick-pop">
          <input
            ref={field}
            placeholder="搜索语言：py、sql、yaml…"
            value={query}
            spellcheck={false}
            aria-label="搜索语言"
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(items[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div class="lang-pick-list" role="listbox">
            {items.map((l, i) => (
              <button
                type="button"
                key={l.id}
                role="option"
                aria-selected={l.id === value}
                class={`lang-pick-item${i === active ? " is-active" : ""}${l.id === value ? " is-current" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(l)}
              >
                {l.name}
                <small>{note?.(l.id)}</small>
              </button>
            ))}
            {items.length === 0 && <div class="lang-pick-empty">没有这种语言</div>}
          </div>
        </div>
      )}
    </div>
  );
}
