import { useEffect, useMemo, useState } from "preact/hooks";
import { Btn, CopyBtn, Seg, highlightJSON, useFocus } from "./ui";
import type { FeatureProps } from "./types";

type Action = "format" | "minify" | "escape" | "unescape";

/** 找出 JSON 的第一个语法错误在哪一行哪一列（WebKit 的报错不带位置）。 */
export function locateError(src: string): { line: number; col: number; msg: string } | null {
  let i = 0;
  const fail = (msg: string) => {
    const before = src.slice(0, i);
    const line = before.split("\n").length;
    const col = i - before.lastIndexOf("\n");
    throw { line, col, msg };
  };
  const ws = () => {
    while (i < src.length && " \t\r\n".includes(src[i]!)) i++;
  };
  const value = (): void => {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      ws();
      if (src[i] === "}") return void i++;
      for (;;) {
        ws();
        if (src[i] !== '"') fail("这里应该是用双引号括起来的键");
        string();
        ws();
        if (src[i] !== ":") fail("键后面应该是冒号");
        i++;
        value();
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "}") return void i++;
        fail("应该是逗号或右花括号");
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (src[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") return void i++;
        fail("应该是逗号或右方括号");
      }
    }
    if (c === '"') return string();
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|^true|^false|^null/.exec(src.slice(i));
    if (!m) fail(c === "'" ? "字符串要用双引号" : "无法识别的值");
    i += m![0].length;
  };
  const string = () => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === '"') return void i++;
      else if (c === "\n") fail("字符串里不能直接换行");
      else i++;
    }
    fail("字符串没有结束");
  };
  try {
    value();
    ws();
    if (i < src.length) fail("JSON 结束后还有多余的内容");
    return null;
  } catch (e) {
    return e as { line: number; col: number; msg: string };
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function JsonTool({ input, args, ctx }: FeatureProps) {
  const [text, setText] = useState(input);
  const [action, setAction] = useState<Action>((args.action as Action) === "minify" ? "minify" : "format");
  const [indent, setIndent] = useState<"2" | "4" | "tab">("2");
  const [sorted, setSorted] = useState(false);
  const area = useFocus<HTMLTextAreaElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);

  const result = useMemo(() => {
    const src = text.trim();
    if (!src) return { out: "", error: "", json: false };
    try {
      if (action === "escape") return { out: JSON.stringify(src), error: "", json: false };
      if (action === "unescape") {
        const v = JSON.parse(src.startsWith('"') ? src : `"${src}"`);
        return { out: typeof v === "string" ? v : JSON.stringify(v), error: "", json: false };
      }
      let value = JSON.parse(src);
      if (sorted) value = sortKeys(value);
      const space = action === "minify" ? undefined : indent === "tab" ? "\t" : Number(indent);
      return { out: JSON.stringify(value, null, space), error: "", json: true };
    } catch {
      const at = action === "format" || action === "minify" ? locateError(src) : null;
      return { out: "", error: at ? `第 ${at.line} 行第 ${at.col} 列：${at.msg}` : "内容不是合法的 JSON 字符串", json: false };
    }
  }, [text, action, indent, sorted]);

  return (
    <div class="fx-page">
      <div class="fx-toolbar">
        <Seg
          value={action}
          onChange={setAction}
          options={[
            { value: "format", label: "格式化" },
            { value: "minify", label: "压缩" },
            { value: "escape", label: "转义" },
            { value: "unescape", label: "去转义" },
          ]}
        />
        <span class="fx-spacer" />
        {action === "format" && (
          <Seg value={indent} onChange={setIndent} options={[{ value: "2", label: "2 空格" }, { value: "4", label: "4 空格" }, { value: "tab", label: "Tab" }]} />
        )}
        <Btn small on={sorted} onClick={() => setSorted(!sorted)} title="按键名排序">
          排序键
        </Btn>
      </div>
      <div class="fx-split fx-grow-1">
        <textarea
          ref={area}
          class="ui-area is-mono"
          placeholder='粘贴 JSON，例如 {"name":"pocket"}'
          value={text}
          spellcheck={false}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <div class="fx-out">
          {result.error ? (
            <pre class="fx-out-text is-error">{result.error}</pre>
          ) : result.json ? (
            <pre class="fx-out-text fx-code" dangerouslySetInnerHTML={{ __html: highlightJSON(result.out) }} />
          ) : (
            <pre class="fx-out-text">{result.out || <span class="fx-hint">结果会显示在这里</span>}</pre>
          )}
          <div class="fx-out-bar">
            {result.json && <span class="fx-meta">{result.out.length} 字符</span>}
            <span class="fx-spacer" />
            <CopyBtn text={result.out} copy={ctx.copy} label="复制" />
          </div>
        </div>
      </div>
    </div>
  );
}
