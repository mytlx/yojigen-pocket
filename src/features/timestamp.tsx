import { useEffect, useMemo, useState } from "preact/hooks";
import { Pause, Play } from "lucide-preact";
import { Btn, CopyBtn, useFocus } from "./ui";
import { formatDateTime } from "../shared/time";
import type { FeatureProps } from "./types";

function relative(d: Date) {
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  const units: [number, string][] = [[31536000, "年"], [2592000, "个月"], [86400, "天"], [3600, "小时"], [60, "分钟"], [1, "秒"]];
  for (const [size, name] of units) {
    if (abs >= size) return `${Math.floor(abs / size)} ${name}${s < 0 ? "前" : "后"}`;
  }
  return "现在";
}
const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 解析输入：数字按位数判断秒/毫秒/微秒/纳秒，其他按日期字符串。 */
export function parseTime(raw: string): { date: Date; kind: string } | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const digits = s.replace(/^-/, "").split(".")[0]!.length;
    if (digits >= 18) return { date: new Date(n / 1e6), kind: "纳秒时间戳" };
    if (digits >= 15) return { date: new Date(n / 1e3), kind: "微秒时间戳" };
    if (digits >= 12) return { date: new Date(n), kind: "毫秒时间戳" };
    return { date: new Date(n * 1000), kind: "秒时间戳" };
  }
  const normalized = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(s) ? s.replace(/\//g, "-").replace(" ", "T") : s;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : { date: d, kind: "日期" };
}

export function TimestampTool({ input, ctx }: FeatureProps) {
  const [now, setNow] = useState(Date.now());
  const [paused, setPaused] = useState(false);
  const [text, setText] = useState(input);
  const field = useFocus<HTMLInputElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [paused]);

  const parsed = useMemo(() => parseTime(text), [text]);
  const rows = parsed
    ? [
        ["本地时间", formatDateTime(parsed.date)],
        ["UTC", parsed.date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")],
        ["ISO 8601", parsed.date.toISOString()],
        ["秒", String(Math.floor(parsed.date.getTime() / 1000))],
        ["毫秒", String(parsed.date.getTime())],
        ["星期", weekdays[parsed.date.getDay()]!],
        ["相对现在", relative(parsed.date)],
      ]
    : [];

  return (
    <div class="fx-page">
      <div class="fx-now">
        <div>
          <span class="fx-meta">现在 · 秒</span>
          <code class="fx-big">{Math.floor(now / 1000)}</code>
          <CopyBtn text={String(Math.floor(now / 1000))} copy={ctx.copy} />
        </div>
        <div>
          <span class="fx-meta">现在 · 毫秒</span>
          <code class="fx-big">{now}</code>
          <CopyBtn text={String(now)} copy={ctx.copy} />
        </div>
        <Btn small ghost icon title={paused ? "继续走时" : "暂停"} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </Btn>
      </div>
      <input
        ref={field}
        class="ui-input is-mono fx-input-lg"
        placeholder="输入时间戳（秒/毫秒/微秒/纳秒）或日期，例如 2026-11-10 08:00"
        value={text}
        spellcheck={false}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
      />
      {text && !parsed && <div class="fx-error-line">无法识别这个时间</div>}
      {parsed && (
        <div class="fx-rows fx-appear">
          <div class="fx-meta">识别为{parsed.kind}</div>
          {rows.map(([k, v]) => (
            <div class="fx-kv" key={k}>
              <span class="fx-kv-key">{k}</span>
              <code class="fx-kv-val">{v}</code>
              <CopyBtn text={v!} copy={ctx.copy} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
