import {
  DocumentIndex,
  Fault,
  pageSize,
  type Match,
  type Options,
  type Result,
} from "./document";
import { normalizeEscapes } from "./escapes";
let index: DocumentIndex | undefined,
  raw = "",
  text = "",
  relaxed = false,
  map = (p: number) => p;
let output = "",
  lastFormat = "",
  fault: Result["error"];
function textMatches(q: string, page: number) {
  const matches: Match[] = [];
  let hits = 0;
  for (let at = raw.indexOf(q); at >= 0; at = raw.indexOf(q, at + q.length)) {
    if (Math.floor(hits++ / pageSize) === page)
      matches.push({
        label: raw.slice(Math.max(0, at - 20), at + q.length + 40),
        start: at,
        end: at + q.length,
        context: "",
      });
  }
  return { matches, hits };
}
self.onmessage = ({
  data,
}: {
  data: { source?: string; options: Options; id: number; full?: boolean };
}) => {
  const { options: o, id } = data;
  let r: Result = { rows: [], hits: 0, count: 0, preview: "", size: 0 };
  try {
    if (data.source !== undefined || relaxed !== !!o.autoEscape) {
      raw = data.source ?? raw;
      relaxed = !!o.autoEscape;
      const normalized = relaxed ? normalizeEscapes(raw) : undefined;
      text = normalized?.text ?? raw;
      map = normalized?.original ?? ((p) => p);
      index = undefined;
      fault = undefined;
      lastFormat = "";
      output = "";
    }
    if (!text.trim()) return self.postMessage({ id, result: r });
    if (o.mode !== "escape" && o.mode !== "unescape" && !index && !fault) {
      try {
        index = new DocumentIndex(text);
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
        fault = {
          offset: map(e.offset),
          message: e.message,
          fix: e.fix && { ...e.fix, from: map(e.fix.from), to: map(e.fix.to) },
        };
      }
    }
    if (fault && o.mode !== "escape" && o.mode !== "unescape") r.error = fault;
    else if (o.mode === "tree") {
      if (data.full) return self.postMessage({ id, full: text });
      r = index!.view(o);
      for (const item of [
        ...r.rows,
        ...(r.entries ?? []),
        ...(r.matches ?? []),
        ...(r.detail ? [r.detail] : []),
      ]) {
        item.start = map(item.start);
        item.end = map(item.end);
      }
    } else {
      const format = o.mode;
      if (lastFormat !== format) {
        const s = raw.trim();
        output =
          o.mode === "escape"
            ? JSON.stringify(s)
            : o.mode === "unescape"
              ? JSON.parse(s.startsWith('"') ? s : '"' + s + '"')
              : index!.convert(o.mode);
        lastFormat = format;
      }
      if (data.full) return self.postMessage({ id, full: output });
      r.preview = output;
      r.size = output.length;
    }
  } catch (e) {
    r.error = {
      offset: 0,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (o.scope === "text" && o.query)
    Object.assign(r, textMatches(o.query, o.page));
  self.postMessage({ id, result: r });
};
