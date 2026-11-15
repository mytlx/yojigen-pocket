import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EditorView } from "@codemirror/view";
import { toggleComment } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Copy, FolderOpen, MessageSquareCode, Play, Plus, Search, Sparkles, Square, Trash2, WrapText } from "lucide-preact";
import { Scratch, type FeatureProps, type Node, type RunEvent, type ScratchLang } from "./host";
import { CodeEditor } from "./code/editor";
import { LangPicker } from "./code/langpick";
import { languages } from "./code/languages";
import { canFormatLocally, formatCode } from "./code/format";
import { Btn, Empty } from "../../../src/features/ui";

/** 新建草稿时放进去的几行，点一下运行就能看到结果。 */
const templates: Record<string, string> = {
  python: 'print("你好，Pocket")\n',
  javascript: 'console.log("你好，Pocket");\n',
  typescript: 'const who: string = "Pocket";\nconsole.log(`你好，${who}`);\n',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("你好，Pocket")\n}\n',
  shell: 'echo "你好，Pocket"\n',
  powershell: 'Write-Output "你好，Pocket"\n',
  batch: "@echo off\necho 你好，Pocket\n",
  java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("你好，Pocket");\n    }\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    printf("你好，Pocket\\n");\n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    std::cout << "你好，Pocket" << std::endl;\n    return 0;\n}\n',
  rust: 'fn main() {\n    println!("你好，Pocket");\n}\n',
  ruby: 'puts "你好，Pocket"\n',
  php: '<?php\necho "你好，Pocket\\n";\n',
  lua: 'print("你好，Pocket")\n',
  perl: 'print "你好，Pocket\\n";\n',
  swift: 'print("你好，Pocket")\n',
  kotlin: 'println("你好，Pocket")\n',
  r: 'cat("你好，Pocket\\n")\n',
  html: "<!doctype html>\n<html>\n  <body>\n    <h1>你好，Pocket</h1>\n  </body>\n</html>\n",
  sql: "SELECT id, name\nFROM users\nWHERE created_at > '2026-01-01'\nORDER BY id DESC;\n",
  json: '{\n  "name": "pocket"\n}\n',
};

interface Line {
  kind: "stdout" | "stderr" | "info";
  text: string;
}

const extOf = (path: string) => (path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "");

/** 代码草稿：像 IDEA 的 Scratches，随手写一段、跑一下，文件一直留着。 */
export function ScratchTool({ input, ctx }: FeatureProps) {
  const [langs, setLangs] = useState<ScratchLang[]>([]);
  const [files, setFiles] = useState<Node[]>([]);
  const [path, setPath] = useState("");
  const [code, setCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [exit, setExit] = useState<RunEvent | null>(null);
  const [stdin, setStdin] = useState("");
  const [showStdin, setShowStdin] = useState(false);
  const [preview, setPreview] = useState("");
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
  const [renaming, setRenaming] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const view = useRef<EditorView | null>(null);
  const outBox = useRef<HTMLPreElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const state = useRef({ path, code });
  state.current = { path, code };
  const mod = ctx.platform === "darwin" ? "⌘" : "Ctrl+";

  const langOf = useCallback((p: string) => langs.find((l) => l.ext === extOf(p) || (l.id === "javascript" && extOf(p) === ".mjs") || (l.id === "yaml" && extOf(p) === ".yml"))?.id ?? "text", [langs]);
  const lang = langOf(path);
  const info = langs.find((l) => l.id === lang);
  const picker = useMemo(() => languages.filter((l) => langs.some((x) => x.id === l.id)), [langs]);

  const refresh = () => Scratch.list().then((list) => setFiles((list ?? []).filter((n) => !n.isDir)));
  const flush = () => {
    clearTimeout(saveTimer.current);
    const s = state.current;
    if (s.path) void Scratch.write(s.path, s.code).catch((e: Error) => ctx.toast(e.message, true));
  };
  const open = async (p: string) => {
    flush();
    try {
      const text = await Scratch.read(p);
      setPath(p);
      setCode(text);
      setLoaded(true);
      setLines([]);
      setExit(null);
      setPreview("");
      try {
        localStorage.setItem("pocket.scratch.last", p);
      } catch {
        /* 存不了也不影响使用 */
      }
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
  };
  const create = async (id: string, content?: string) => {
    try {
      const p = await Scratch.new(langs.find((l) => l.id === id)?.ext ?? ".txt");
      const text = content ?? templates[id] ?? "";
      if (text) await Scratch.write(p, text);
      await refresh();
      await open(p);
      view.current?.focus();
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
  };

  useEffect(() => {
    void Promise.all([Scratch.languages(), Scratch.list()]).then(([ls, list]) => {
      setLangs(ls ?? []);
      const all = (list ?? []).filter((n) => !n.isDir);
      setFiles(all);
      let last = "";
      try {
        last = localStorage.getItem("pocket.scratch.last") ?? "";
      } catch {
        /* 忽略 */
      }
      const first = all.find((f) => f.path === last) ?? [...all].sort((a, b) => b.modified - a.modified)[0];
      if (input.trim()) void create("text", input);
      else if (first) void open(first.path);
      else setLoaded(true);
    });
    return () => {
      flush();
        void Scratch.stop();
    };
  }, []);

  const onChange = (value: string) => {
    setCode(value);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };
  useEffect(() => ctx.remember(code), [code]);
  useEffect(() => {
    const el = outBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, exit]);

  const stop = () => void Scratch.stop();
  const run = () => {
    if (!path) return false;
    if (lang === "html") {
      setPreview(code);
      return true;
    }
    if (!info?.tool) {
      ctx.toast(info ? `这台电脑上没有找到运行 ${info.name} 的程序` : "这种文件不能运行", true);
      return true;
    }
    if (running) return true;
    flush();
    setLines([]);
    setExit(null);
    setRunning(true);
    Scratch.run({ lang, code, stdin: showStdin ? stdin : "", timeout: 0 }, (ev) => {
      if (ev.kind === "stdout" || ev.kind === "stderr") setLines((l) => [...l, { kind: ev.kind as "stdout" | "stderr", text: ev.text ?? "" }]);
      else if (ev.kind === "start") setLines((l) => [...l, { kind: "info", text: `▸ ${ev.text}\n` }]);
      else if (ev.kind === "exit") setExit(ev);
    })
      .catch((e: Error) => setLines((l) => [...l, { kind: "stderr", text: e.message + "\n" }]))
      .finally(() => setRunning(false));
    return true;
  };
  const format = () => {
    if (!path) return true;
    void formatCode(lang, code).then(
      (out) => {
        if (out !== code) onChange(out);
        ctx.toast("已格式化");
      },
      (e: Error) => ctx.toast(e.message, true),
    );
    return true;
  };
  const changeLang = (id: string) => {
    const target = langs.find((l) => l.id === id);
    if (!target || !path || id === lang) return;
    flush();
    const stem = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path;
    void Scratch.rename(path, stem + target.ext).then(
      (p) => {
        setPath(p);
        void refresh();
      },
      (e: Error) => ctx.toast(e.message, true),
    );
  };
  const rename = (p: string, name: string) => {
    setRenaming("");
    if (!name.trim() || name === p) return;
    void Scratch.rename(p, name).then(
      (np) => {
        if (p === path) setPath(np);
        void refresh();
      },
      (e: Error) => ctx.toast(e.message, true),
    );
  };
  const remove = (p: string) => {
    setConfirmDelete("");
    void Scratch.delete(p).then(async () => {
      if (p === path) {
        clearTimeout(saveTimer.current);
        setPath("");
        setCode("");
      }
      await refresh();
    }, (e: Error) => ctx.toast(e.message, true));
  };

  const canFormat = canFormatLocally(lang) || !!info?.formatter;
  const runnable = lang === "html" || !!info?.tool;
  const sorted = [...files].sort((a, b) => b.modified - a.modified);
  const quick = ["python", "javascript", "go", "shell", "sql", "json"].filter((id) => langs.some((l) => l.id === id));

  return (
    <div class="fx-page fx-scratch">
      <aside class="fx-out fx-side">
        <div class="fx-side-head">
          <b>草稿</b>
          <span class="fx-spacer" />
          <Btn small ghost icon title="打开草稿所在的文件夹" onClick={() => void Scratch.reveal()}>
            <FolderOpen size={13} />
          </Btn>
          <Btn small ghost icon title="新建草稿（和当前同一种语言）" onClick={() => void create(path ? lang : "python")}>
            <Plus size={14} />
          </Btn>
        </div>
        <div class="fx-side-list">
          {sorted.map((f) => (
            <div key={f.path} class={`fx-side-item${f.path === path ? " is-selected" : ""}`} onClick={() => f.path !== path && void open(f.path)} onDblClick={() => setRenaming(f.path)}>
              {renaming === f.path ? (
                <input
                  class="fx-side-rename"
                  defaultValue={f.name}
                  autoFocus
                  spellcheck={false}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => rename(f.path, (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming("");
                    }
                  }}
                />
              ) : (
                <>
                  <span class="fx-side-name" title={`${f.name}\n双击改名`}>{f.name}</span>
                  {confirmDelete === f.path ? (
                    <Btn small danger onClick={() => remove(f.path)}>删除</Btn>
                  ) : (
                    <button type="button" class="fx-side-del" title="删除（移到废纸篓）" onClick={(e) => { e.stopPropagation(); setConfirmDelete(f.path); setTimeout(() => setConfirmDelete((c) => (c === f.path ? "" : c)), 2500); }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {files.length === 0 && <div class="fx-side-empty">还没有草稿</div>}
        </div>
      </aside>

      {!path ? (
        <div class="fx-out fx-grow-1 fx-scratch-empty">
          {loaded && (
            <Empty title="写点什么" desc="选一种语言开始。草稿会一直留着，下次打开还在。">
              <div class="fx-scratch-quick">
                {quick.map((id) => (
                  <Btn key={id} small onClick={() => void create(id)}>
                    {langs.find((l) => l.id === id)?.name}
                  </Btn>
                ))}
                <LangPicker value="text" list={picker} onChange={(id) => void create(id)} />
              </div>
            </Empty>
          )}
        </div>
      ) : (
        <div class="fx-scratch-main">
          <div class="fx-toolbar">
            <LangPicker value={lang} list={picker} onChange={changeLang} note={(id) => (id === "html" ? "可预览" : langs.find((l) => l.id === id)?.tool ? "可运行" : "")} />
            {running ? (
              <Btn small danger onClick={stop}>
                <Square size={12} /> 停止
              </Btn>
            ) : (
              <Btn small primary disabled={!runnable} title={runnable ? `${mod}回车` : info?.tool === "" && info ? `这台电脑上没有装运行 ${info.name} 的程序` : "这种文件不能运行"} onClick={run}>
                <Play size={12} /> {lang === "html" ? "预览" : "运行"}
              </Btn>
            )}
            <Btn small disabled={!canFormat} title={canFormat ? "格式化（Shift+Alt+F）" : "这种语言需要先装对应的格式化工具"} onClick={format}>
              <Sparkles size={13} /> 格式化
            </Btn>
            <span class="fx-spacer" />
            {info?.tool && <span class="fx-meta" title="用这个程序运行">{info.tool}</span>}
            <Btn small ghost icon title={`注释 / 取消注释（${mod}/）`} onClick={() => { if (view.current) { toggleComment(view.current); view.current.focus(); } }}>
              <MessageSquareCode size={14} />
            </Btn>
            <Btn small ghost icon title={`查找和替换（${mod}F）`} onClick={() => view.current && openSearchPanel(view.current)}>
              <Search size={14} />
            </Btn>
            <Btn small ghost icon title="自动换行" on={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={14} />
            </Btn>
            <Btn small ghost icon title="复制全部代码" onClick={() => void ctx.copy(code)}>
              <Copy size={14} />
            </Btn>
          </div>
          <div class="fx-out fx-scratch-editor">
            <CodeEditor
              key={path}
              value={code}
              lang={lang}
              wrap={wrap}
              tabSize={["python", "java", "c", "cpp", "rust", "kotlin", "swift", "php"].includes(lang) ? 4 : 2}
              onChange={onChange}
              onReady={(v) => (view.current = v)}
              onCursor={setCursor}
              keys={[
                { key: "Mod-Enter", run },
                { key: "Shift-Alt-f", run: format },
              ]}
              autoFocus
            />
          </div>
          {preview ? (
            <div class="fx-out fx-scratch-out">
              <div class="fx-out-title">
                预览
                <span class="fx-spacer" />
                <Btn small ghost onClick={() => setPreview("")}>关闭</Btn>
              </div>
              {/* 不给脚本权限以外的任何权限：草稿里的页面碰不到应用自己的接口 */}
              <iframe class="fx-scratch-frame" sandbox="allow-scripts" srcdoc={preview} title="预览" />
            </div>
          ) : (
            (lines.length > 0 || exit || running || showStdin) && (
              <div class="fx-out fx-scratch-out">
                <div class="fx-out-title">
                  输出
                  {running && <span class="ui-spinner" />}
                  {exit && (
                    <span class={`fx-scratch-exit${exit.code === 0 && !exit.stopped ? "" : " is-bad"}`}>
                      {exit.note || (exit.code === 0 ? "运行完成" : `退出码 ${exit.code}`)} · {exit.millis && exit.millis >= 1000 ? `${(exit.millis / 1000).toFixed(2)} 秒` : `${exit.millis ?? 0} 毫秒`}
                    </span>
                  )}
                  <span class="fx-spacer" />
                  <Btn small ghost on={showStdin} title="运行时从标准输入读到的内容" onClick={() => setShowStdin(!showStdin)}>输入</Btn>
                  <Btn small ghost icon title="复制输出" disabled={lines.length === 0} onClick={() => void ctx.copy(lines.filter((l) => l.kind !== "info").map((l) => l.text).join(""))}>
                    <Copy size={13} />
                  </Btn>
                  <Btn small ghost onClick={() => { setLines([]); setExit(null); setShowStdin(false); }}>清空</Btn>
                </div>
                {showStdin && <textarea class="ui-area fx-scratch-stdin" placeholder="程序从标准输入读到的内容（input()、read、Scanner…）" value={stdin} spellcheck={false} onInput={(e) => setStdin((e.target as HTMLTextAreaElement).value)} />}
                <pre class="fx-scratch-log" ref={outBox}>
                  {lines.map((l, i) => (
                    <span key={i} class={`is-${l.kind}`}>{l.text}</span>
                  ))}
                  {!running && !exit && lines.length === 0 && <span class="is-info">点“运行”或按 {mod}回车</span>}
                </pre>
              </div>
            )
          )}
          <div class="fx-meta fx-scratch-status">
            <span>{path}</span>
            <span class="fx-spacer" />
            <span>
              第 {cursor.line} 行，第 {cursor.col} 列{cursor.selected ? `（选中 ${cursor.selected}）` : ""} · {code.split("\n").length} 行 · {Array.from(code).length} 字符 · 自动保存
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
