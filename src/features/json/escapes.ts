// Record only edits so editor selections and diagnostics can use original offsets.
export interface EscapeEdit {
  normStart: number;
  normEnd: number;
  origStart: number;
  origEnd: number;
  delta: number;
}

export interface NormalizeResult {
  text: string;
  hadMarkdownEscapes: boolean;
  original: (offset: number) => number;
}

export function normalizeEscapes(
  source: string,
  opts?: { keepNewlines?: boolean },
): NormalizeResult {
  const chunks: string[] = [];
  const edits: EscapeEdit[] = [];
  const keepNewlines = !!opts?.keepNewlines;
  let quoted = false,
    last = 0,
    delta = 0,
    hadMarkdownEscapes = false;

  function replace(start: number, end: number, value: string) {
    const prevDelta = delta;
    chunks.push(source.slice(last, start), value);
    last = end;
    delta += end - start - value.length;
    const normStart = start - prevDelta;
    const normEnd = end - delta;
    edits.push({
      normStart,
      normEnd,
      origStart: start,
      origEnd: end,
      delta,
    });
  }

  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      next = source[i + 1];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (c === "\\" && next !== undefined) {
      if (next === "\n" || next === "\r") {
        const end = i + (next === "\r" && source[i + 2] === "\n" ? 3 : 2);
        hadMarkdownEscapes = true;
        replace(i, end, quoted ? "\\n" : "\n");
        i = end - 1;
      } else if (quoted) {
        if (/[.<>:\-_*\[\]()!#&]/.test(next)) {
          hadMarkdownEscapes = true;
          replace(i, i + 1, "");
        }
        i++;
      }
    } else if (quoted && c! < " ") {
      if (keepNewlines && (c === "\n" || c === "\r")) continue;
      replace(i, i + 1, JSON.stringify(c).slice(1, -1));
    } else if (!quoted && c === "&" && source.startsWith("&#x20;", i)) {
      hadMarkdownEscapes = true;
      replace(i, i + 6, " ");
      i += 5;
    }
  }

  return {
    text: edits.length ? chunks.join("") + source.slice(last) : source,
    hadMarkdownEscapes,
    original(offset: number) {
      let low = 0,
        high = edits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (edits[mid]!.normEnd <= offset) low = mid + 1;
        else high = mid;
      }
      if (low < edits.length && offset >= edits[low]!.normStart) {
        return edits[low]!.origStart;
      }
      const mapped = offset + (low ? edits[low - 1]!.delta : 0);
      return Math.max(0, Math.min(source.length, mapped));
    },
  };
}
