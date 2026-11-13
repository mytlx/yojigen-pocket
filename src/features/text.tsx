import { useEffect, useMemo, useState } from "preact/hooks";
import { Undo2 } from "lucide-preact";
import { Btn, CopyBtn, useFocus } from "./ui";
import type { FeatureProps } from "./types";

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-./]+/).filter(Boolean);
const lines = (s: string) => s.split("\n");

export const ops: Record<string, { label: string; fn: (s: string) => string }> = {
  upper: { label: "大写", fn: (s) => s.toUpperCase() },
  lower: { label: "小写", fn: (s) => s.toLowerCase() },
  title: { label: "首字母大写", fn: (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) },
  camel: { label: "camelCase", fn: (s) => words(s).map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("") },
  pascal: { label: "PascalCase", fn: (s) => words(s).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("") },
  snake: { label: "snake_case", fn: (s) => words(s).map((w) => w.toLowerCase()).join("_") },
  kebab: { label: "kebab-case", fn: (s) => words(s).map((w) => w.toLowerCase()).join("-") },
  dedupe: { label: "去重行", fn: (s) => Array.from(new Set(lines(s))).join("\n") },
  sort: { label: "排序行", fn: (s) => lines(s).sort((a, b) => a.localeCompare(b, "zh")).join("\n") },
  reverse: { label: "倒序行", fn: (s) => lines(s).reverse().join("\n") },
  noblank: { label: "去空行", fn: (s) => lines(s).filter((l) => l.trim()).join("\n") },
  trim: { label: "去首尾空白", fn: (s) => lines(s).map((l) => l.trim()).join("\n") },
  join: { label: "合并为一行", fn: (s) => lines(s).map((l) => l.trim()).filter(Boolean).join(" ") },
};

export function TextTool({ input, args, ctx }: FeatureProps) {
  const [text, setText] = useState(() => (args.op && ops[args.op] && args.op !== "count" ? ops[args.op]!.fn(input) : input));
  const [history, setHistory] = useState<string[]>([]);
  const area = useFocus<HTMLTextAreaElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);

  const apply = (op: string) => {
    setHistory((h) => [...h.slice(-30), text]);
    setText(ops[op]!.fn(text));
  };
  const stats = useMemo(
    () => ({
      chars: Array.from(text).length,
      noSpace: Array.from(text.replace(/\s/g, "")).length,
      han: (text.match(/\p{Script=Han}/gu) ?? []).length,
      words: (text.match(/[A-Za-z0-9]+/g) ?? []).length,
      lines: text ? lines(text).length : 0,
      bytes: new TextEncoder().encode(text).length,
    }),
    [text],
  );

  return (
    <div class="fx-page">
      <div class="fx-chips">
        {Object.entries(ops).map(([k, o]) => (
          <button type="button" class="fx-chip" key={k} disabled={!text} onClick={() => apply(k)}>
            {o.label}
          </button>
        ))}
      </div>
      <textarea
        ref={area}
        class="ui-area fx-grow-1"
        placeholder="输入或粘贴文字，点上面的按钮处理"
        value={text}
        spellcheck={false}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <div class="fx-toolbar">
        <span class="fx-meta">
          {stats.chars} 字符 · 不含空白 {stats.noSpace} · 汉字 {stats.han} · 英文词 {stats.words} · {stats.lines} 行 · {stats.bytes} 字节
        </span>
        <span class="fx-spacer" />
        <Btn small ghost disabled={!history.length} title="撤销" onClick={() => {
          setText(history[history.length - 1] ?? text);
          setHistory((h) => h.slice(0, -1));
        }}>
          <Undo2 size={14} /> 撤销
        </Btn>
        <CopyBtn text={text} copy={ctx.copy} label="复制" />
      </div>
    </div>
  );
}
