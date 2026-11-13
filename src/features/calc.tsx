import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Copy, CornerDownLeft, Eraser, Trash2, X } from "lucide-preact";
import { Calc, type CalcEntry, type CalcLine } from "../mygo";
import { Btn, Empty } from "./ui";
import type { FeatureProps } from "./types";

const LINE = 26; // 行高：算式和结果两列靠它对齐

/** 计算器：每行一个算式，右边对齐显示结果；右侧是历史。 */
export function CalcTool({ input, ctx }: FeatureProps) {
  const [text, setText] = useState(input);
  const [lines, setLines] = useState<CalcLine[]>([]);
  const [total, setTotal] = useState("");
  const [history, setHistory] = useState<CalcEntry[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    void Calc.history().then((h) => setHistory(h ?? []));
    const el = area.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  useEffect(() => {
    if (input && input !== text) setText(input);
  }, [input]);
  useEffect(() => ctx.remember(text), [text]);

  const rows = useMemo(() => text.split("\n"), [text]);
  useEffect(() => {
    const my = ++seq.current;
    // 末尾多算一行 sum：它就是前面所有结果的合计。
    void Calc.eval([...rows, "sum"]).then((out) => {
      if (my !== seq.current) return;
      const list = out ?? [];
      setLines(list.slice(0, rows.length));
      setTotal(list[rows.length]?.text ?? "");
    });
  }, [rows]);
  useLayoutEffect(() => {
    if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop;
  }, [lines]);

  const answered = lines.map((l, i) => ({ ...l, expr: rows[i] ?? "", i })).filter((l) => l.text);
  const last = answered[answered.length - 1];
  const count = answered.length;

  const record = (expr: string, result: string) => void Calc.record(expr.trim(), result).then((h) => setHistory(h ?? []));
  const copyResult = (expr: string, result: string) => {
    void ctx.copy(result);
    record(expr, result);
  };
  const lineAtCaret = () => {
    const el = area.current;
    if (!el) return rows.length - 1;
    return el.value.slice(0, el.selectionStart).split("\n").length - 1;
  };
  const append = (snippet: string) => {
    setText((t) => (t.trim() ? t.replace(/\n*$/, "\n") + snippet : snippet));
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  };

  return (
    <div class="fx-page fx-calc">
      <div class="fx-calc-main">
        <div class="fx-out fx-calc-sheet">
          <div class="fx-calc-editor">
            <textarea
              ref={area}
              class="fx-calc-input"
              style={{ lineHeight: `${LINE}px` }}
              placeholder={"每行一个算式，回车换行\n例如：\nprice = 199\nprice * 3 * 0.85\n10 km to mi"}
              value={text}
              spellcheck={false}
              wrap="off"
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onScroll={(e) => {
                if (gutter.current) gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
              }}
              onKeyDown={(e) => {
                if (e.isComposing) return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  // Ctrl/⌘+回车：复制光标所在行的结果（没有就复制最后一个）。
                  e.preventDefault();
                  const at = lines[lineAtCaret()];
                  const hit = at?.text ? { expr: rows[lineAtCaret()] ?? "", text: at.text } : last;
                  if (hit?.text) copyResult(hit.expr, hit.text);
                } else if (e.key === "Enter") {
                  // 回车换行，顺手把刚算完的这一行记进历史。
                  const i = lineAtCaret();
                  const line = lines[i];
                  if (line?.text && rows[i]?.trim()) record(rows[i]!, line.text);
                }
              }}
            />
            <div class="fx-calc-results" ref={gutter} style={{ lineHeight: `${LINE}px` }} aria-live="polite">
              {rows.map((_, i) => {
                const l = lines[i];
                if (l?.error) {
                  return (
                    <div key={i} class="fx-calc-result is-error" title={l.error}>
                      {l.error}
                    </div>
                  );
                }
                if (!l?.text) return <div key={i} class="fx-calc-result" />;
                return (
                  <button key={i} type="button" class="fx-calc-result is-value" title="点击复制" onClick={() => copyResult(rows[i] ?? "", l.text!)}>
                    {l.name && <span class="fx-calc-name">{l.name} =</span>}
                    {l.text}
                  </button>
                );
              })}
            </div>
          </div>
          <div class="fx-out-bar">
            <span class="fx-meta">
              {count > 1 ? `${count} 个结果 · 合计 ` : ""}
              {count > 1 && <b class="fx-calc-total">{total}</b>}
              {count <= 1 && "变量 x = 3 · ans 上一行 · sum 合计 · # 注释"}
            </span>
            <span class="fx-spacer" />
            <Btn small ghost title="清空" disabled={!text} onClick={() => { setText(""); area.current?.focus(); }}>
              <Eraser size={14} /> 清空
            </Btn>
            <Btn
              small
              disabled={count === 0}
              title="复制每一行的算式和结果"
              onClick={() => void ctx.copy(answered.map((l) => `${l.expr.trim()} = ${l.text}`).join("\n"), "已复制全部")}
            >
              <Copy size={14} /> 复制全部
            </Btn>
            <Btn small primary disabled={!last} title={ctx.platform === "darwin" ? "⌘ 回车" : "Ctrl+回车"} onClick={() => last && copyResult(last.expr, last.text!)}>
              <CornerDownLeft size={14} /> 复制结果
            </Btn>
          </div>
        </div>
        <div class="fx-out fx-calc-history">
          <div class="fx-out-title">
            <span>历史</span>
            <span class="fx-spacer" />
            {history.length > 0 && (
              <Btn small ghost title="清空历史" onClick={() => void Calc.clear().then(() => setHistory([]))}>
                <Trash2 size={13} /> 清空
              </Btn>
            )}
          </div>
          {history.length === 0 ? (
            <Empty title="还没有历史" desc="在这里按回车算完一行，或在搜索框里回车复制结果，都会记下来" />
          ) : (
            <div class="fx-calc-list">
              {history.map((h) => (
                <div class="fx-calc-entry" key={h.id}>
                  <button type="button" class="fx-calc-entry-main" title="点击把算式放回左边" onClick={() => append(h.expr)}>
                    <span class="fx-calc-expr">{h.expr}</span>
                    <span class="fx-calc-answer">= {h.result}</span>
                  </button>
                  <Btn small ghost icon title="复制结果" onClick={() => void ctx.copy(h.result)}>
                    <Copy size={13} />
                  </Btn>
                  <Btn small ghost icon title="删除这条" onClick={() => void Calc.remove(h.id).then((list) => setHistory(list ?? []))}>
                    <X size={13} />
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
