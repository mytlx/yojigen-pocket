import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ArrowDownToLine, CircleAlert, Download, List } from "lucide-preact";
import { Settings, type LogEntry } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section, Segmented, Toggle } from "./ui";
import "./logs.css";

const limit = 1000;
type Rows = { all: LogEntry[]; errors: LogEntry[] };
const empty: Rows = { all: [], errors: [] };

export function Logs({ config, update }: SectionProps) {
  const [rows, setRows] = useState<Rows>(empty);
  const [filter, setFilter] = useState<keyof Rows>("all");
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState("");
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false, offset = 0, generation = "", previousError = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let delay = 750;
      try {
        const page = await Settings.logPage(offset, generation, previousError);
        if (disposed) return;
        const reset = page.reset || page.generation !== generation || page.offset < offset;
        if (reset) previousError = false;
        if (reset || page.entries.length) {
          setRows(old => {
            const base = reset ? empty : old;
            return {
              all: base.all.concat(page.entries).slice(-limit),
              errors: base.errors.concat(page.entries.filter(e => e.error)).slice(-limit),
            };
          });
        }
        offset = page.offset;
        generation = page.generation;
        previousError = page.entries.at(-1)?.error ?? previousError;
        setReadError("");
        if (page.more) delay = 0;
      } catch (e) {
        if (!disposed) setReadError(String(e));
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(refresh, delay); }
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  const visible = rows[filter];
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  async function save() {
    setExporting(true); setResult("");
    try {
      if (await Settings.exportLog(filter === "errors")) setResult("日志已导出");
    } catch (e) { setResult("导出失败 · " + String(e)); }
    finally { setExporting(false); }
  }

  return <>
    <Section title="日志记录">
      <Row label="记录软件日志" description="在本机保存运行事件和错误，关闭后仍可查看已有记录。">
        <Toggle label="记录软件日志" checked={config.diagnosticLogging} onChange={v => update(c => (c.diagnosticLogging = v))} />
      </Row>
    </Section>
    <section class="log-console" aria-label="实时日志">
      <header class="log-tools">
        <Segmented value={filter} options={[{ value: "all", label: "全部日志" }, { value: "errors", label: "错误日志" }]} onChange={v => { setFilter(v); setResult(""); }} />
        <Button disabled={exporting} onClick={() => void save()} title="导出当前筛选的所有已保存记录"><Download size={14} /> {exporting ? "导出中…" : "导出日志"}</Button>
      </header>
      {readError && <div class="st-banner" role="alert">{readError}</div>}
      <div ref={viewport} class="log-list" tabIndex={0} aria-label="日志内容" onScroll={e => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.clientHeight - el.scrollTop < 8);
      }}>
        {visible.length ? visible.map((entry, i) => <div key={i} class={'log-line' + (entry.error ? ' is-error' : '')}>
          <time title={entry.time}>{entry.time.slice(11)}</time>
          <span class="log-level">{entry.error ? "错误" : "信息"}</span>
          <span class="log-message">{entry.message}</span>
        </div>) : <div class="log-empty">{filter === "errors" ? <CircleAlert /> : <List />}
          <span>{loading ? "正在读取日志…" : filter === "errors" ? "暂无错误日志" : config.diagnosticLogging ? "等待第一条日志" : "暂无日志，开启记录后可在这里查看"}</span>
        </div>}
      </div>
      <footer class="log-footer"><span class={config.diagnosticLogging ? "log-live" : ""}>{config.diagnosticLogging ? "记录中" : "记录已关闭"}</span>
        <span>{visible.length === limit ? "最近 " : ""}{visible.length} 条</span>
        <button aria-pressed={follow} onClick={() => setFollow(!follow)}><ArrowDownToLine size={13} />{follow ? "自动滚动" : "跟随最新"}</button>
      </footer>
    </section>
    {result && <p role="status">{result}</p>}
  </>;
}
