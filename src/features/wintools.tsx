import { useEffect, useRef, useState } from "preact/hooks";
import { Copy, Play, Search } from "lucide-preact";
import { WinTools, type WinTool } from "../mygo";
import { Btn, Empty, Seg, keepVisible, useDebounced } from "./ui";
import type { FeatureProps } from "./types";

const categories = ["全部", "控制面板", "管理工具", "系统程序"] as const;
type Category = (typeof categories)[number];

/** Windows 工具：常用的 .cpl、.msc 和系统程序，按原名或说明搜索，回车打开。 */
export function WinToolsPage({ input, ctx }: FeatureProps) {
  const [query, setQuery] = useState(input);
  const [category, setCategory] = useState<Category>("全部");
  const [tools, setTools] = useState<WinTool[]>([]);
  const [selected, setSelected] = useState(0);
  const [available, setAvailable] = useState(true);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query, 60);

  useEffect(() => {
    field.current?.focus();
    void WinTools.info().then((i) => setAvailable(i.available));
  }, []);
  useEffect(() => {
    if (input) setQuery(input);
  }, [input]);
  useEffect(() => ctx.remember(query), [query]);
  useEffect(() => {
    let alive = true;
    void WinTools.search(debounced).then((r) => {
      if (!alive) return;
      setTools(r ?? []);
      setSelected(0);
    });
    return () => {
      alive = false;
    };
  }, [debounced]);

  const shown = category === "全部" ? tools : tools.filter((t) => t.category === category);
  const run = (t?: WinTool) => {
    if (!t) return;
    void WinTools.run(t.name).then(
      () => ctx.toast(`已打开 ${t.title}`),
      (e: Error) => ctx.toast(e.message, true),
    );
  };
  useEffect(() => {
    keepVisible(list.current);
  }, [selected]);

  return (
    <div class="fx-page fx-wintools">
      <div class="fx-toolbar">
        <label class="fx-search">
          <Search size={15} />
          <input
            ref={field}
            class="fx-search-input"
            placeholder="搜原名或说明：services、环境变量、磁盘、fwq…"
            value={query}
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[selected]);
              }
            }}
          />
        </label>
        <Seg value={category} options={categories.map((c) => ({ value: c, label: c }))} onChange={(c) => { setCategory(c); setSelected(0); }} />
      </div>
      {!available && <div class="fx-banner">这些工具只在 Windows 上能打开。在这台电脑上可以查名字和用途。</div>}
      {shown.length === 0 ? (
        <Empty title="没有找到匹配的工具" desc="试试原名（如 services.msc）、中文名或拼音首字母" />
      ) : (
        <div class="fx-out fx-grow-1 fx-scroll fx-tool-list" ref={list}>
          {shown.map((t, i) => (
            <div
              key={t.name}
              class={`fx-tool${i === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onDblClick={() => run(t)}
            >
              <div class="fx-tool-text">
                <div class="fx-tool-title">
                  <b>{t.title}</b>
                  <code>{t.name}</code>
                </div>
                <div class="fx-tool-desc">{t.desc}</div>
              </div>
              <span class="fx-tool-cat">{t.category}</span>
              <Btn small ghost icon title="复制名称" onClick={() => void ctx.copy(t.name)}>
                <Copy size={13} />
              </Btn>
              <Btn small icon title="打开" disabled={!available} onClick={() => run(t)}>
                <Play size={13} />
              </Btn>
            </div>
          ))}
        </div>
      )}
      <div class="fx-meta">共 {shown.length} 项 · ↑↓ 选择 · 回车打开 · 在搜索框里直接输入名字也能找到它们</div>
    </div>
  );
}
