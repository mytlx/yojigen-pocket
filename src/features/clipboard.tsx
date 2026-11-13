import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ClipboardPaste, Copy, FileText, Files, Image as ImageIcon, Pin, PinOff, Search, Trash2 } from "lucide-preact";
import { Clips, events, type ClipView } from "../mygo";
import { Btn, Empty, Seg, keepVisible, useDebounced } from "./ui";
import type { FeatureProps } from "./types";

type Kind = "" | "text" | "image" | "files";
const kinds: { value: Kind | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "text", label: "文字" },
  { value: "image", label: "图片" },
  { value: "files", label: "文件" },
];

/** 剪贴板历史：左边列表，右边预览。回车粘贴（独立窗口里是复制）。 */
export function ClipboardTool({ input, ctx }: FeatureProps) {
  const [query, setQuery] = useState(input);
  const [kind, setKind] = useState<Kind>("");
  const [items, setItems] = useState<ClipView[]>([]);
  const [selected, setSelected] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query, 80);
  const want = useRef({ query: debounced, kind });
  want.current = { query: debounced, kind };

  const load = useCallback(() => {
    const asked = want.current;
    void Clips.list(asked.query, asked.kind).then((r) => {
      if (asked !== want.current) return;
      setItems(r ?? []);
    });
  }, []);
  useEffect(() => {
    field.current?.focus();
    return events.clipboardChanged.on(load);
  }, []);
  useEffect(() => {
    setSelected(0);
    load();
  }, [debounced, kind]);
  useEffect(() => ctx.remember(query), [query]);
  useEffect(() => {
    keepVisible(list.current);
  }, [selected]);

  const current = items[Math.min(selected, items.length - 1)];
  const use = (it?: ClipView) => {
    if (!it) return;
    void Clips.paste(it.id).then(
      (pasted) => {
        if (!pasted) ctx.toast(ctx.detached ? "已复制，切到要用的窗口粘贴" : "已复制");
      },
      (e: Error) => ctx.toast(e.message, true),
    );
  };
  const copy = (it?: ClipView) => it && void Clips.copy(it.id).then(() => ctx.toast("已复制"), (e: Error) => ctx.toast(e.message, true));
  const remove = (it?: ClipView) => it && void Clips.remove(it.id);
  const pin = (it?: ClipView) => it && void Clips.togglePin(it.id);

  return (
    <div class="fx-page fx-clip">
      <div class="fx-toolbar">
        <label class="fx-search">
          <Search size={15} />
          <input
            ref={field}
            class="fx-search-input"
            placeholder="搜索复制过的内容…"
            value={query}
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (mod) copy(current);
                else use(current);
              } else if (mod && e.key === "Backspace") {
                e.preventDefault();
                remove(current);
              } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
                e.preventDefault();
                pin(current);
              }
            }}
          />
        </label>
        <Seg value={(kind || "all") as Kind | "all"} options={kinds} onChange={(k) => setKind(k === "all" ? "" : k)} />
        {confirmClear ? (
          <span class="fx-inline">
            固定的会保留
            <Btn small danger onClick={() => { setConfirmClear(false); void Clips.clear(); }}>
              确定清空
            </Btn>
            <Btn small ghost onClick={() => setConfirmClear(false)}>
              取消
            </Btn>
          </span>
        ) : (
          <Btn small ghost title="清空历史" disabled={items.length === 0} onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} />
          </Btn>
        )}
      </div>
      {items.length === 0 ? (
        <Empty title={query || kind ? "没有匹配的记录" : "还没有剪贴板历史"} desc={query || kind ? undefined : "复制过的文字、图片和文件会出现在这里"} />
      ) : (
        <div class="fx-clip-body">
          <div class="fx-out fx-scroll fx-clip-list" ref={list}>
            {items.map((it, i) => (
              <div
                key={it.id}
                class={`fx-clip-row${it === current ? " is-selected" : ""}`}
                onClick={() => setSelected(i)}
                onDblClick={() => use(it)}
              >
                <span class="fx-clip-icon">
                  {it.kind === "image" ? <ImageIcon size={15} /> : it.kind === "files" ? <Files size={15} /> : <FileText size={15} />}
                </span>
                <div class="fx-clip-text">
                  <div class="fx-clip-label">{it.label || "（空白）"}</div>
                  <div class="fx-clip-sub">
                    {it.when}
                    {it.app ? ` · ${it.app}` : ""}
                  </div>
                </div>
                {it.pinned && <Pin size={12} class="fx-clip-pin" />}
              </div>
            ))}
          </div>
          <div class="fx-out fx-clip-preview">
            {current && (
              <>
                {current.kind === "image" ? (
                  <div class="fx-clip-image">
                    <img src={current.image} alt="" draggable={false} />
                  </div>
                ) : current.kind === "files" ? (
                  <div class="fx-out-text is-wrap">{(current.files ?? []).join("\n")}</div>
                ) : (
                  <pre class="fx-out-text is-wrap">{current.text}</pre>
                )}
                <div class="fx-out-bar">
                  <span class="fx-meta">
                    {current.kind === "text" ? `${current.chars} 字 · ` : current.kind === "files" ? `${current.files?.length ?? 0} 个文件 · ` : ""}
                    {current.size}
                  </span>
                  <span class="fx-spacer" />
                  <Btn small ghost icon title={current.pinned ? "取消固定" : "固定"} on={current.pinned} onClick={() => pin(current)}>
                    {current.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </Btn>
                  <Btn small ghost icon title="删除这条" onClick={() => remove(current)}>
                    <Trash2 size={14} />
                  </Btn>
                  <Btn small onClick={() => copy(current)}>
                    <Copy size={14} /> 复制
                  </Btn>
                  {!ctx.detached && (
                    <Btn small primary onClick={() => use(current)}>
                      <ClipboardPaste size={14} /> 粘贴
                    </Btn>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div class="fx-meta">
        {items.length} 条 · ↑↓ 选择 · 回车{ctx.detached ? "复制" : "粘贴到之前的窗口"} · {ctx.platform === "darwin" ? "⌘" : "Ctrl+"}回车只复制 · {ctx.platform === "darwin" ? "⌘⌫" : "Ctrl+退格"} 删除
      </div>
    </div>
  );
}
