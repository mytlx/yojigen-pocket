import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { onFileDrop } from "mygo-runtime";
import { ArrowLeft, BookPlus, ChevronLeft, ChevronRight, EyeOff, List, Maximize2, Minus, PanelTopClose, Pause, Play, Plus, Trash2, X } from "lucide-preact";
import { Library, Windows, events, type Book, type ChapterText, type ReaderConfig } from "../mygo";
import { Icon } from "../shared/icons";
import { Btn, Empty, Seg } from "./ui";
import type { FeatureProps } from "./types";

const themes = [
  { value: "auto", label: "跟随" },
  { value: "paper", label: "纸张" },
  { value: "green", label: "护眼" },
  { value: "dark", label: "夜间" },
] as const;

function wan(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

export function ReaderTool({ ctx }: FeatureProps) {
  const [prefs, setPrefs] = useState<ReaderConfig | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [book, setBook] = useState<Book | null>(null);
  const [toc, setToc] = useState<string[]>([]);
  const [chapter, setChapter] = useState<ChapterText | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [auto, setAuto] = useState(false);
  const [hover, setHover] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const stealth = ctx.stealth;

  const refresh = useCallback(async () => {
    const list = await Library.books();
    setBooks(list);
    return list;
  }, []);

  const loadChapter = useCallback(async (b: Book, index: number, position = 0) => {
    try {
      const ch = await Library.chapter(b.id, index);
      restore.current = position;
      setChapter(ch);
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
  }, [ctx]);

  const openBook = useCallback(async (b: Book) => {
    setBook(b);
    setDrawer(false);
    setToc(await Library.chapters(b.id));
    await loadChapter(b, b.chapter, b.position);
  }, [loadChapter]);

  useEffect(() => {
    void Library.prefs().then(setPrefs);
    void refresh().then((list) => {
      // 摸鱼小窗直接接着读最近的一本。
      if (stealth && list[0]) void openBook(list[0]);
    });
    const off = onFileDrop(({ paths }) => {
      const files = paths.filter((p) => /\.(txt|epub)$/i.test(p));
      if (files.length) void importPaths(files);
    });
    return () => {
      off();
      clearTimeout(saveTimer.current);
    };
  }, []);

  const importPaths = async (paths?: string[]) => {
    try {
      const added = paths ? await Library.importPaths(paths) : await Library.importDialog();
      await refresh();
      if (added.length === 1) void openBook(added[0]!);
    } catch (e) {
      await refresh();
      ctx.toast((e as Error).message, true);
    }
  };

  // 换章后回到记住的位置。
  useLayoutEffect(() => {
    const el = content.current;
    if (!el || restore.current === null) return;
    const pos = restore.current;
    restore.current = null;
    el.scrollTop = pos === -1 ? el.scrollHeight : pos * Math.max(el.scrollHeight - el.clientHeight, 0);
    if (!stealth) el.focus({ preventScroll: true });
  }, [chapter]);

  const saveProgress = () => {
    const el = content.current;
    if (!el || !book || !chapter) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
      void Library.saveProgress(book.id, chapter.index, ratio);
    }, 500);
  };

  const lineHeightPx = prefs ? prefs.fontSize * prefs.lineHeight : 30;
  const step = () => {
    const el = content.current;
    if (!el) return 0;
    return stealth ? lineHeightPx * (prefs?.stealthLines ?? 2) : Math.max(el.clientHeight - lineHeightPx * 1.5, lineHeightPx);
  };

  const gotoChapter = (index: number, position = 0) => {
    if (!book || !chapter || index < 0 || index >= chapter.total) return;
    void loadChapter(book, index, position);
    void Library.saveProgress(book.id, index, position === -1 ? 1 : position);
  };

  const pageDown = () => {
    const el = content.current;
    if (!el || !chapter) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) gotoChapter(chapter.index + 1);
    else el.scrollBy({ top: step(), behavior: stealth ? "auto" : "smooth" });
  };
  const pageUp = () => {
    const el = content.current;
    if (!el || !chapter) return;
    if (el.scrollTop <= 1) gotoChapter(chapter.index - 1, -1);
    else el.scrollBy({ top: -step(), behavior: stealth ? "auto" : "smooth" });
  };

  // 全局翻页热键、自动翻页。
  const handlers = useRef({ pageDown, pageUp, toggleAuto: () => setAuto((a) => !a) });
  handlers.current = { pageDown, pageUp, toggleAuto: () => setAuto((a) => !a) };
  useEffect(
    () =>
      events.readerCommand.on((cmd) => {
        if (cmd === "next") handlers.current.pageDown();
        if (cmd === "prev") handlers.current.pageUp();
        if (cmd === "autopage") handlers.current.toggleAuto();
      }),
    [],
  );
  useEffect(() => {
    if (!auto) return;
    const secs = prefs?.autoPageSecs || 8;
    const t = setInterval(() => handlers.current.pageDown(), secs * 1000);
    return () => clearInterval(t);
  }, [auto, prefs?.autoPageSecs]);

  // 摸鱼小窗：窗口高度正好放下设定的行数。
  useEffect(() => {
    if (!stealth || !prefs) return;
    const h = Math.round(lineHeightPx * prefs.stealthLines + 20);
    void Windows.resize(Math.max(window.innerWidth, 240), h);
  }, [stealth, prefs?.stealthLines, prefs?.fontSize, prefs?.lineHeight]);

  const savePrefs = (p: ReaderConfig) => {
    setPrefs(p);
    void Library.savePrefs(p).then((warn) => warn && ctx.toast(warn, true));
  };

  const onKey = (e: KeyboardEvent) => {
    if (!book || e.isComposing) return;
    const mod = ctx.platform === "darwin" ? e.metaKey : e.ctrlKey;
    if (["ArrowRight", "PageDown", " ", "j"].includes(e.key) && !mod) {
      e.preventDefault();
      pageDown();
    } else if (["ArrowLeft", "PageUp", "k"].includes(e.key) && !mod) {
      e.preventDefault();
      pageUp();
    } else if (mod && e.key === "]") {
      e.preventDefault();
      gotoChapter((chapter?.index ?? 0) + 1);
    } else if (mod && e.key === "[") {
      e.preventDefault();
      gotoChapter((chapter?.index ?? 0) - 1);
    } else if (e.key === "Escape" && drawer) {
      e.preventDefault();
      setDrawer(false);
    }
  };

  const style = prefs ? ({ "--rd-size": `${prefs.fontSize}px`, "--rd-lh": String(prefs.lineHeight) } as Record<string, string>) : {};
  const theme = prefs?.theme ?? "auto";

  // --- 摸鱼小窗 ---
  if (stealth) {
    const dim = !hover && prefs ? prefs.stealthOpacity / 100 : 1;
    return (
      <div
        class="rd-stealth"
        style={{ ...style, "--app-region": "drag" } as Record<string, string>}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onKeyDown={onKey}
        tabIndex={0}
      >
        <div class="rd-stealth-text" ref={content} style={{ opacity: dim }} onScroll={saveProgress}>
          {chapter ? chapter.text.split("\n").map((p, i) => (p.trim() ? <p key={i}>{p.trim()}</p> : null)) : <p>{books.length ? "加载中…" : "书库是空的：先在「摸鱼阅读」里添加书籍"}</p>}
        </div>
        <div class={`rd-stealth-bar${hover ? " is-shown" : ""}`} style={{ "--app-region": "no-drag" } as Record<string, string>}>
          <button type="button" title="上一页" onClick={pageUp}><ChevronLeft size={14} /></button>
          <button type="button" title="下一页" onClick={pageDown}><ChevronRight size={14} /></button>
          <button type="button" title={auto ? "停止自动翻页" : "自动翻页"} onClick={() => setAuto(!auto)}>{auto ? <Pause size={13} /> : <Play size={13} />}</button>
          <button type="button" title="少一行" onClick={() => prefs && savePrefs({ ...prefs, stealthLines: Math.max(1, prefs.stealthLines - 1) })}><Minus size={13} /></button>
          <button type="button" title="多一行" onClick={() => prefs && savePrefs({ ...prefs, stealthLines: Math.min(6, prefs.stealthLines + 1) })}><Plus size={13} /></button>
          <button type="button" title="隐藏（老板键）" onClick={() => void Windows.control("hide", 0)}><EyeOff size={13} /></button>
          <button type="button" title="打开完整阅读器" onClick={() => void Windows.detach({ feature: "reader", title: "摸鱼阅读", icon: "svg:book-open" })}><Maximize2 size={13} /></button>
          <button type="button" title="关闭" onClick={() => void Windows.control("close", 0)}><X size={13} /></button>
        </div>
      </div>
    );
  }

  // --- 书库 ---
  if (!book || !chapter) {
    return (
      <div class="fx-page rd-library">
        <div class="fx-toolbar">
          <b class="rd-lib-title">书库 · {books.length}</b>
          <span class="fx-spacer" />
          <Btn small onClick={() => void Windows.detach({ feature: "reader", mode: "stealth", title: "摸鱼阅读", icon: "svg:book-open" })} disabled={!books.length}>
            <PanelTopClose size={14} /> 摸鱼小窗
          </Btn>
          <Btn small primary onClick={() => void importPaths()}>
            <BookPlus size={14} /> 添加书籍
          </Btn>
        </div>
        {books.length === 0 ? (
          <Empty icon={<Icon icon="svg:book-open" size={52} />} title="书库还是空的" desc="添加 txt 或 epub，也可以直接把文件拖进来。之后可以分离成不起眼的小窗，用老板键一键藏起来。">
            <Btn primary onClick={() => void importPaths()}>
              <BookPlus size={15} /> 添加书籍
            </Btn>
          </Empty>
        ) : (
          <div class="rd-books fx-scroll fx-grow-1">
            {books.map((b, i) => (
              <div key={b.id} class="rd-book fx-stagger" style={{ animationDelay: `${i * 30}ms` }} onClick={() => void openBook(b)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && void openBook(b)}>
                <div class="rd-cover">{b.title.slice(0, 2)}</div>
                <div class="rd-book-info">
                  <b>{b.title}</b>
                  <span class="fx-meta">
                    {b.format.toUpperCase()} · {wan(b.chars)} · {b.chapters} 章
                  </span>
                  <div class="rd-progress"><i style={{ width: `${Math.min(100, b.percent)}%` }} /></div>
                  <span class="fx-meta">{b.percent > 0 ? `读到 ${b.percent.toFixed(1)}%` : "还没开始读"}</span>
                </div>
                {confirmDelete === b.id ? (
                  <span class="rd-book-actions" onClick={(e) => e.stopPropagation()}>
                    <Btn small onClick={() => setConfirmDelete("")}>取消</Btn>
                    <Btn small danger onClick={() => void Library.remove(b.id).then(refresh).then(() => setConfirmDelete(""))}>删除</Btn>
                  </span>
                ) : (
                  <span class="rd-book-actions" onClick={(e) => e.stopPropagation()}>
                    <Btn small ghost icon title="从书库删除" onClick={() => setConfirmDelete(b.id)}>
                      <Trash2 size={14} />
                    </Btn>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // --- 阅读 ---
  return (
    <div class={`rd-reader rd-theme-${theme}`} style={style} onKeyDown={onKey}>
      <div class="rd-top">
        <Btn small ghost icon title="回到书库" onClick={() => { setBook(null); setChapter(null); void refresh(); }}>
          <ArrowLeft size={15} />
        </Btn>
        <button type="button" class="rd-chapter-title" title="目录" onClick={() => setDrawer(!drawer)}>
          <List size={14} /> <span>{chapter.title}</span>
        </button>
        <span class="fx-spacer" />
        <span class="fx-meta">{chapter.index + 1} / {chapter.total}</span>
        <Btn small ghost icon title="字号减小" onClick={() => prefs && savePrefs({ ...prefs, fontSize: Math.max(12, prefs.fontSize - 1) })}><Minus size={14} /></Btn>
        <Btn small ghost icon title="字号增大" onClick={() => prefs && savePrefs({ ...prefs, fontSize: Math.min(32, prefs.fontSize + 1) })}><Plus size={14} /></Btn>
        <Seg value={theme} options={themes.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => prefs && savePrefs({ ...prefs, theme: v })} />
        <Btn small ghost icon title={auto ? "停止自动翻页" : "自动翻页"} on={auto} onClick={() => setAuto(!auto)}>
          {auto ? <Pause size={14} /> : <Play size={14} />}
        </Btn>
        <Btn small title="以摸鱼小窗继续读（老板键一键隐藏）" onClick={() => void Windows.detach({ feature: "reader", mode: "stealth", title: "摸鱼阅读", icon: "svg:book-open" })}>
          <PanelTopClose size={14} /> 小窗
        </Btn>
      </div>
      <div class="rd-body">
        {drawer && (
          <div class="rd-toc">
            {toc.map((t, i) => (
              <button type="button" key={i} class={i === chapter.index ? "is-current" : ""} onClick={() => { gotoChapter(i); setDrawer(false); }} ref={i === chapter.index ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}>
                {t}
              </button>
            ))}
          </div>
        )}
        <div class="rd-content" ref={content} tabIndex={0} onScroll={saveProgress} key={`${book.id}-${chapter.index}`}>
          <h2>{chapter.title}</h2>
          {chapter.text.split("\n").map((p, i) => (p.trim() ? <p key={i}>{p.trim()}</p> : null))}
          <div class="rd-end">
            <Btn small disabled={chapter.index === 0} onClick={() => gotoChapter(chapter.index - 1)}><ChevronLeft size={14} /> 上一章</Btn>
            <Btn small primary disabled={chapter.index + 1 >= chapter.total} onClick={() => gotoChapter(chapter.index + 1)}>下一章 <ChevronRight size={14} /></Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
