import {
  DocumentIndex,
  Fault,
  lineColumn,
  pageSize,
  repairJson,
  validateUnescape,
  type CopyFormat,
  type Diagnostic,
  type Match,
  type Options,
  type Result,
} from "./document";
import { normalizeEscapes } from "./escapes";

let index: DocumentIndex | undefined,
  raw = "",
  text = "",
  diagSource = "",
  relaxed = false,
  map = (p: number) => p;
let output = "",
  lastFormat = "",
  fault: Diagnostic | undefined;

function textMatches(q: string, page: number) {
  const matches: Match[] = [];
  let hits = 0;
  for (let at = raw.indexOf(q); at >= 0; at = raw.indexOf(q, at + q.length)) {
    if (Math.floor(hits++ / pageSize) === page) {
      const sliceFrom = Math.max(0, at - 20);
      const sliceTo = Math.min(raw.length, at + q.length + 40);
      const snippet = raw.slice(sliceFrom, sliceTo).replace(/\s+/g, " ").trim();
      matches.push({
        label:
          (sliceFrom > 0 ? "…" : "") +
          snippet +
          (sliceTo < raw.length ? "…" : ""),
        start: at,
        end: at + q.length,
        context: "",
      });
    }
  }
  return { matches, hits };
}

function buildDiagnostic(e: Fault, diagText: string, diagMap: (p: number) => number): Diagnostic {
  const offset = diagMap(e.offset);
  const end = diagMap(e.end ?? e.offset);
  const loc = lineColumn(raw, offset);
  let repairAllCount: number | undefined;
  if (e.fix && diagText.length <= 200_000) {
    const rep = repairJson(diagText);
    if (rep.fixes > 1) repairAllCount = rep.fixes;
  }
  return {
    offset,
    end: Math.max(offset, end),
    line: loc.line,
    column: loc.column,
    message: e.message,
    hint: e.hint,
    fix: e.fix && {
      ...e.fix,
      from: diagMap(e.fix.from),
      to: diagMap(e.fix.to),
    },
    repairAllCount,
  };
}

function ensureJsonParsed(useAutoEscape: boolean) {
  if (index || fault) return;
  if (useAutoEscape) {
    const normalized = normalizeEscapes(raw);
    try {
      index = new DocumentIndex(normalized.text);
      text = normalized.text;
      diagSource = normalized.text;
      map = normalized.original;
      return;
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      // If auto-escape turned an unclosed string's newline into \\n, diagnose on newline-preserved text instead.
      const diagNorm = normalized.hadMarkdownEscapes
        ? normalizeEscapes(raw, { keepNewlines: true })
        : undefined;
      const diagText = diagNorm?.text ?? raw;
      const diagMap = diagNorm?.original ?? ((p: number) => p);
      diagSource = diagText;
      try {
        index = new DocumentIndex(diagText);
        text = diagText;
        map = diagMap;
        return;
      } catch (diagErr) {
        if (!(diagErr instanceof Fault)) throw diagErr;
        fault = buildDiagnostic(diagErr, diagText, diagMap);
        return;
      }
    }
  }
  text = raw;
  diagSource = raw;
  map = (p) => p;
  try {
    index = new DocumentIndex(raw);
  } catch (e) {
    if (!(e instanceof Fault)) throw e;
    fault = buildDiagnostic(e, raw, (p) => p);
  }
}

interface WorkerRequest {
  id: number;
  source?: string;
  options: Options;
  full?: boolean;
  copyNode?: { nodeId: number; format: CopyFormat };
  repairAll?: boolean;
  expandAll?: boolean;
}

self.onmessage = ({ data }: { data: WorkerRequest }) => {
  const { options: o, id } = data;
  let r: Result = { rows: [], hits: 0, count: 0, preview: "", size: 0 };
  try {
    if (data.source !== undefined || relaxed !== !!o.autoEscape) {
      raw = data.source ?? raw;
      relaxed = !!o.autoEscape;
      text = raw;
      diagSource = raw;
      map = (p) => p;
      index = undefined;
      fault = undefined;
      lastFormat = "";
      output = "";
    }

    if (data.repairAll) {
      if (!raw.trim()) {
        return self.postMessage({ id, repaired: raw, fixes: 0, complete: true });
      }
      ensureJsonParsed(!!o.autoEscape);
      const rep = repairJson(diagSource || raw);
      return self.postMessage({
        id,
        repaired: rep.text,
        fixes: rep.fixes,
        complete: rep.complete,
      });
    }

    if (data.copyNode) {
      if (!raw.trim()) {
        return self.postMessage({ id, copied: "", format: data.copyNode.format });
      }
      ensureJsonParsed(!!o.autoEscape);
      if (!index) {
        return self.postMessage({
          id,
          copiedError: fault?.message ?? "请先修正源码中的 JSON 错误",
        });
      }
      return self.postMessage({
        id,
        copied: index.extract(data.copyNode.nodeId, data.copyNode.format),
        format: data.copyNode.format,
      });
    }

    if (data.expandAll) {
      if (!raw.trim()) return self.postMessage({ id, expandedIds: [0] });
      ensureJsonParsed(!!o.autoEscape);
      return self.postMessage({
        id,
        expandedIds: index ? index.expandableIds(500) : [0],
      });
    }

    if (!raw.trim()) return self.postMessage({ id, result: r });

    if (o.mode !== "escape" && o.mode !== "unescape") {
      ensureJsonParsed(!!o.autoEscape);
    }

    if (fault && o.mode !== "escape" && o.mode !== "unescape") {
      r.error = fault;
    } else if (o.mode === "tree") {
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
              ? validateUnescape(raw)
              : index!.convert(o.mode);
        lastFormat = format;
      }
      if (data.full) return self.postMessage({ id, full: output });
      r.preview = output;
      r.size = output.length;
      if (index) {
        r.count = index.nodes.length;
        r.rootCount = index.nodes[0]?.children?.length ?? 0;
        r.rootKind = index.nodes[0]?.kind;
      }
    }
  } catch (e) {
    if (e instanceof Fault) {
      const loc = lineColumn(raw, e.offset);
      r.error = {
        offset: e.offset,
        end: e.end ?? e.offset,
        line: loc.line,
        column: loc.column,
        message: e.message,
        hint: e.hint,
        fix: e.fix,
      };
    } else {
      r.error = {
        offset: 0,
        end: 0,
        line: 1,
        column: 1,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  if (o.scope === "text" && o.query)
    Object.assign(r, textMatches(o.query, o.page));
  self.postMessage({ id, result: r });
};
