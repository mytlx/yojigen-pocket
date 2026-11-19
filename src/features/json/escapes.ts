// Record only edits so editor selections and diagnostics can use original offsets.
export function normalizeEscapes(source: string) {
  const chunks: string[] = [];
  const edits: { end: number; delta: number }[] = [];
  let quoted = false,
    last = 0,
    delta = 0;
  function replace(start: number, end: number, value: string) {
    chunks.push(source.slice(last, start), value);
    last = end;
    delta += end - start - value.length;
    edits.push({ end: end - delta, delta });
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
        replace(i, end, quoted ? "\\n" : "\n");
        i = end - 1;
      } else if (quoted) {
        if (/[.<>:\-_*\[\]()!#&]/.test(next)) replace(i, i + 1, "");
        i++;
      }
    } else if (quoted && c! < " ") {
      replace(i, i + 1, JSON.stringify(c).slice(1, -1));
    } else if (!quoted && c === "&" && source.startsWith("&#x20;", i)) {
      replace(i, i + 6, " ");
      i += 5;
    }
  }
  return {
    text: edits.length ? chunks.join("") + source.slice(last) : source,
    original(offset: number) {
      let low = 0,
        high = edits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (edits[mid]!.end <= offset) low = mid + 1;
        else high = mid;
      }
      return offset + (low ? edits[low - 1]!.delta : 0);
    },
  };
}
