import { useEffect, useMemo, useState } from "preact/hooks";
import { Btn, useFocus } from "./ui";
import type { FeatureProps } from "./types";

const presets = [
  { name: "手机号", re: "1[3-9]\\d{9}" },
  { name: "邮箱", re: "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+" },
  { name: "网址", re: "https?://[^\\s\"'<>]+" },
  { name: "IPv4", re: "\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b" },
  { name: "身份证", re: "\\d{17}[\\dXx]" },
  { name: "日期", re: "\\d{4}-\\d{2}-\\d{2}" },
  { name: "中文", re: "[\\u4e00-\\u9fa5]+" },
];

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function RegexTool({ input, ctx }: FeatureProps) {
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("g");
  const [text, setText] = useState(input);
  const [replace, setReplace] = useState("");
  const field = useFocus<HTMLInputElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);

  const result = useMemo(() => {
    if (!pattern) return { re: null as RegExp | null, error: "", matches: [] as RegExpExecArray[] };
    try {
      const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
      const matches: RegExpExecArray[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && matches.length < 500) {
        matches.push(m);
        if (m[0] === "") re.lastIndex++;
      }
      return { re, error: "", matches };
    } catch (e) {
      return { re: null, error: (e as Error).message, matches: [] };
    }
  }, [pattern, flags, text]);

  const highlighted = useMemo(() => {
    if (!result.matches.length) return escape(text);
    let out = "";
    let last = 0;
    result.matches.forEach((m, i) => {
      out += escape(text.slice(last, m.index)) + `<mark class="fx-mark fx-mark-${i % 2}">${escape(m[0]) || "&#8203;"}</mark>`;
      last = m.index + m[0].length;
    });
    return out + escape(text.slice(last));
  }, [text, result.matches]);

  const replaced = useMemo(() => {
    if (!result.re || !replace) return "";
    try {
      return text.replace(new RegExp(pattern, flags), replace);
    } catch {
      return "";
    }
  }, [result.re, replace, text, pattern, flags]);

  const toggle = (f: string) => setFlags(flags.includes(f) ? flags.replace(f, "") : flags + f);

  return (
    <div class="fx-page">
      <div class="fx-regex-bar">
        <span class="fx-slash">/</span>
        <input
          ref={field}
          class="ui-input is-mono fx-grow-1"
          placeholder="正则表达式"
          value={pattern}
          spellcheck={false}
          onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
        />
        <span class="fx-slash">/</span>
        {["g", "i", "m", "s", "u"].map((f) => (
          <Btn key={f} small on={flags.includes(f)} onClick={() => toggle(f)} title={{ g: "全局", i: "忽略大小写", m: "多行", s: "点号匹配换行", u: "Unicode" }[f]}>
            {f}
          </Btn>
        ))}
      </div>
      <div class="fx-chips">
        {presets.map((p) => (
          <button type="button" class="fx-chip" key={p.name} onClick={() => setPattern(p.re)}>
            {p.name}
          </button>
        ))}
      </div>
      {result.error && <div class="fx-error-line">{result.error}</div>}
      <div class="fx-split fx-grow-1">
        <textarea class="ui-area is-mono" placeholder="测试文本" value={text} spellcheck={false} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <div class="fx-out">
          <pre class="fx-out-text is-wrap" dangerouslySetInnerHTML={{ __html: highlighted || '<span class="fx-hint">匹配会高亮在这里</span>' }} />
          <div class="fx-out-bar">
            <span class="fx-meta">{pattern && !result.error ? `${result.matches.length} 处匹配` : ""}</span>
          </div>
        </div>
      </div>
      {result.matches.length > 0 && (
        <div class="fx-match-list">
          {result.matches.slice(0, 50).map((m, i) => (
            <div class="fx-match" key={i}>
              <span class="fx-meta">#{i + 1}</span>
              <code>{m[0]}</code>
              {m.slice(1).map((g, j) => (
                <span class="fx-group" key={j}>
                  ${j + 1} <code>{g ?? "—"}</code>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      <div class="fx-regex-bar">
        <input class="ui-input is-mono fx-grow-1" placeholder="替换为（可用 $1、$2）" value={replace} spellcheck={false} onInput={(e) => setReplace((e.target as HTMLInputElement).value)} />
        <Btn small disabled={!replaced} onClick={() => void ctx.copy(replaced, "已复制替换结果")}>
          复制替换结果
        </Btn>
      </div>
    </div>
  );
}
