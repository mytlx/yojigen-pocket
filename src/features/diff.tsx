import { useEffect, useMemo, useState } from "preact/hooks";
import { Btn, useDebounced, useFocus } from "./ui";
import type { FeatureProps } from "./types";

type Line = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };

/** 按行做最长公共子序列对比。 */
export function diffLines(a: string[], b: string[], norm: (s: string) => string = (s) => s): Line[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = norm(a[i]!) === norm(b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(a[i]!) === norm(b[j]!)) out.push({ kind: "same", text: b[j]!, a: ++i, b: ++j });
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "del", text: a[i]!, a: ++i });
    else out.push({ kind: "add", text: b[j]!, b: ++j });
  }
  while (i < n) out.push({ kind: "del", text: a[i]!, a: ++i });
  while (j < m) out.push({ kind: "add", text: b[j]!, b: ++j });
  return out;
}

export function DiffTool({ input, ctx }: FeatureProps) {
  const [left, setLeft] = useState(input);
  const [right, setRight] = useState("");
  const [trim, setTrim] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const area = useFocus<HTMLTextAreaElement>();
  const a = useDebounced(left, 200);
  useEffect(() => ctx.remember(left), [left]);
  const b = useDebounced(right, 200);

  const result = useMemo(() => {
    const la = a.split("\n");
    const lb = b.split("\n");
    if (la.length * lb.length > 4_000_000) return { lines: [] as Line[], tooBig: true };
    return { lines: diffLines(la, lb, trim ? (s) => s.trim() : undefined), tooBig: false };
  }, [a, b, trim]);
  const added = result.lines.filter((l) => l.kind === "add").length;
  const removed = result.lines.filter((l) => l.kind === "del").length;

  return (
    <div class="fx-page">
      <div class="fx-split fx-diff-inputs">
        <textarea ref={area} class="ui-area is-mono" placeholder="原文本" value={left} spellcheck={false} onInput={(e) => setLeft((e.target as HTMLTextAreaElement).value)} />
        <textarea class="ui-area is-mono" placeholder="新文本" value={right} spellcheck={false} onInput={(e) => setRight((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="fx-toolbar">
        <span class="fx-badge is-good">+{added}</span>
        <span class="fx-badge is-bad">−{removed}</span>
        <span class="fx-spacer" />
        <Btn small on={trim} onClick={() => setTrim(!trim)}>
          忽略首尾空白
        </Btn>
        <Btn small on={onlyChanges} onClick={() => setOnlyChanges(!onlyChanges)}>
          只看改动
        </Btn>
      </div>
      <div class="fx-diff fx-grow-1">
        {result.tooBig && <div class="fx-error-line">文本太长，超过了逐行对比的上限</div>}
        {!a && !b && <div class="fx-hint fx-pad">在上面两边分别粘贴文本</div>}
        {result.lines
          .filter((l) => !onlyChanges || l.kind !== "same")
          .map((l, i) => (
            <div class={`fx-diff-line is-${l.kind}`} key={i}>
              <span class="fx-diff-no">{l.a ?? ""}</span>
              <span class="fx-diff-no">{l.b ?? ""}</span>
              <span class="fx-diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span class="fx-diff-text">{l.text || " "}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
