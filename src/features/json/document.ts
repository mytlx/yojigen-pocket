export type Mode = "tree" | "format" | "minify" | "escape" | "unescape" | "xml";
export type Kind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";
export type CopyFormat = "value" | "pretty" | "minify" | "pair" | "key" | "path";

interface Node {
  key: string;
  parent: number;
  ordinal: number;
  start: number;
  end: number;
  kind: Kind;
  children?: number[];
}

export interface Correction {
  from: number;
  to: number;
  insert: string;
  label: string;
}

export interface Diagnostic {
  offset: number;
  end: number;
  line: number;
  column: number;
  message: string;
  hint?: string;
  fix?: Correction;
  repairAllCount?: number;
}

export class Fault extends Error {
  constructor(
    public offset: number,
    message: string,
    public fix?: Correction,
    public end?: number,
    public hint?: string,
  ) {
    super(message);
  }
}

export interface Row {
  id: number;
  key: string;
  kind: Kind;
  parentKind?: Kind;
  count: number;
  preview: string;
  level: number;
  start: number;
  end: number;
}

export interface Options {
  mode: Mode;
  expanded: number[];
  pages: Record<number, number>;
  query: string;
  page: number;
  selected: number;
  detailPage?: number;
  autoEscape?: boolean;
  scope?: "text" | "node";
}

export interface Match {
  label: string;
  start: number;
  end: number;
  id?: number;
  context: string;
  trail?: [number, number][];
}

export interface Result {
  rows: Row[];
  detail?: Row;
  entries?: Row[];
  rootCount?: number;
  rootKind?: Kind;
  matches?: Match[];
  path?: string;
  preview: string;
  size: number;
  count: number;
  hits: number;
  error?: Diagnostic;
}

export const pageSize = 50;

export function lineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(source.length, offset));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i++) {
    const ch = source[i]!;
    if (ch === "\n") {
      line++;
      column = 1;
    } else if (ch === "\r") {
      if (source[i + 1] === "\n" && i + 1 < clamped) i++;
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

const exactToken = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?|true|false|null)$/;
const tokenStopChars = ' \t\r\n,:：=}[]"{}\'/';

export class DocumentIndex {
  nodes: Node[] = [];

  constructor(readonly source: string) {
    let pos = 0;

    const fail = (
      message: string,
      fix?: Correction,
      end = pos,
      hint?: string,
      at = pos,
    ): never => {
      throw new Fault(at, message, fix, Math.max(at, end), hint);
    };

    const ws = () => {
      for (;;) {
        while (pos < source.length && " \t\n\r".includes(source[pos]!)) pos++;
        if (source[pos] === "/") {
          const next = source[pos + 1];
          if (next === "/") {
            const start = pos;
            let end = pos + 2;
            while (end < source.length && source[end] !== "\n" && source[end] !== "\r") {
              end++;
            }
            // If this comment owns its entire line, remove the whole line to avoid blank lines.
            let lineStart = start;
            while (lineStart > 0 && (source[lineStart - 1] === " " || source[lineStart - 1] === "\t")) {
              lineStart--;
            }
            const ownsLine = lineStart === 0 || source[lineStart - 1] === "\n" || source[lineStart - 1] === "\r";
            let fixFrom = start;
            let fixTo = end;
            if (ownsLine && end < source.length) {
              fixFrom = lineStart;
              fixTo = source[end] === "\r" && source[end + 1] === "\n" ? end + 2 : end + 1;
            }
            fail(
              "JSON 不支持注释",
              { from: fixFrom, to: fixTo, insert: "", label: "移除注释" },
              end,
              "标准 JSON 格式不允许 // 单行注释",
            );
          }
          if (next === "*") {
            const start = pos;
            const closeIdx = source.indexOf("*/", pos + 2);
            if (closeIdx >= 0) {
              const end = closeIdx + 2;
              fail(
                "JSON 不支持注释",
                { from: start, to: end, insert: "", label: "移除注释" },
                end,
                "标准 JSON 格式不允许 /* */ 块级注释",
              );
            }
            fail(
              "JSON 不支持注释（且多行注释未闭合）",
              { from: start, to: source.length, insert: "", label: "移除注释" },
              source.length,
            );
          }
        }
        break;
      }
    };

    const string = () => {
      const openPos = pos;
      pos++;
      while (pos < source.length) {
        const c = source[pos]!;
        if (c === '"') {
          pos++;
          return;
        }
        if (c === "\\") {
          const slash = pos;
          pos++;
          const e = source[pos];
          if (e === undefined) {
            const openLoc = lineColumn(source, openPos);
            fail(
              "字符串缺少结束引号",
              { from: pos, to: pos, insert: '\\"', label: "转义并补上引号" },
              pos,
              `从第 ${openLoc.line} 行第 ${openLoc.column} 列开始的引号未闭合`,
            );
          }
          if (e === "u") {
            pos++;
            for (let j = 0; j < 4; j++) {
              if (!/[\da-f]/i.test(source[pos] ?? "")) {
                fail(
                  "Unicode 转义需要四位十六进制数",
                  undefined,
                  Math.min(source.length, pos + 1),
                  "格式应为 \\uXXXX（仅含 0-9、a-f、A-F）",
                );
              }
              pos++;
            }
          } else if (e && '"\\/bfnrt'.includes(e)) {
            pos++;
          } else {
            fail(
              `无效的转义字符 "\\${e}"`,
              { from: slash, to: slash + 1, insert: "\\\\", label: "转义反斜杠" },
              slash + 2,
              'JSON 仅支持 \\" \\\\ \\/ \\b \\f \\n \\r \\t 和 \\uXXXX',
              slash,
            );
          }
        } else if (c === "\n" || c === "\r") {
          const openLoc = lineColumn(source, openPos);
          const lineBreak = pos;
          const afterBreak =
            c === "\r" && source[pos + 1] === "\n" ? pos + 2 : pos + 1;
          let nextNonWs = afterBreak;
          while (
            nextNonWs < source.length &&
            (source[nextNonWs] === " " || source[nextNonWs] === "\t")
          ) {
            nextNonWs++;
          }
          const nextChar = source[nextNonWs];
          let beforeEnd = lineBreak;
          while (
            beforeEnd > openPos + 1 &&
            (source[beforeEnd - 1] === " " || source[beforeEnd - 1] === "\t")
          ) {
            beforeEnd--;
          }
          const endsWithComma =
            beforeEnd > openPos + 1 && source[beforeEnd - 1] === ",";
          const nextLooksStructural =
            nextChar === undefined ||
            nextChar === "}" ||
            nextChar === "]" ||
            nextChar === '"';
          if (endsWithComma && nextLooksStructural) {
            const quoteAt = beforeEnd - 1;
            fail(
              "字符串缺少结束引号",
              { from: quoteAt, to: quoteAt, insert: '"', label: "补上结束引号" },
              quoteAt,
              `从第 ${openLoc.line} 行第 ${openLoc.column} 列开始的引号未闭合`,
              quoteAt,
            );
          }
          if (nextLooksStructural) {
            fail(
              "字符串缺少结束引号",
              { from: beforeEnd, to: beforeEnd, insert: '"', label: "补上结束引号" },
              beforeEnd,
              `从第 ${openLoc.line} 行第 ${openLoc.column} 列开始的引号未闭合；若需保留换行请写为 \\n`,
              beforeEnd,
            );
          }
          const esc =
            c === "\r" && source[pos + 1] === "\n"
              ? "\\r\\n"
              : c === "\r"
                ? "\\r"
                : "\\n";
          fail(
            "字符串中不能包含未转义的换行符",
            { from: lineBreak, to: afterBreak, insert: esc, label: "转义换行符" },
            afterBreak,
            "JSON 字符串内的换行必须写成 \\n",
            lineBreak,
          );
        } else if (c < " ") {
          const ctrlPos = pos;
          const esc =
            c === "\t"
              ? "\\t"
              : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
          fail(
            c === "\t"
              ? "字符串中不能包含未转义的制表符"
              : "字符串中的控制字符需要转义",
            {
              from: ctrlPos,
              to: ctrlPos + 1,
              insert: esc,
              label: c === "\t" ? "转义制表符" : "转义控制字符",
            },
            ctrlPos + 1,
            undefined,
            ctrlPos,
          );
        } else {
          pos++;
        }
      }
      const openLoc = lineColumn(source, openPos);
      fail(
        "字符串缺少结束引号",
        { from: pos, to: pos, insert: '"', label: "补上结束引号" },
        pos,
        `从第 ${openLoc.line} 行第 ${openLoc.column} 列开始的引号未闭合`,
      );
    };

    const parseWrongQuote = (
      qStart: number,
      forKey: boolean,
    ): never => {
      const openChar = source[qStart]!;
      const closeTarget = openChar === "'" ? "'" : "”";
      let end = qStart + 1;
      let inner = "";
      let closed = false;
      while (end < source.length) {
        const ch = source[end]!;
        if (ch === "\n" || ch === "\r") break;
        if (ch === "\\" && end + 1 < source.length) {
          const nx = source[end + 1]!;
          if (nx === openChar) {
            inner += openChar;
            end += 2;
            continue;
          }
          inner += ch + nx;
          end += 2;
          continue;
        }
        if (ch === closeTarget || (openChar !== "'" && ch === "“")) {
          closed = true;
          end++;
          break;
        }
        inner += ch;
        end++;
      }
      const msg =
        openChar === "'"
          ? forKey
            ? "键名应使用英文双引号，而不是单引号"
            : "字符串应使用英文双引号，而不是单引号"
          : "应使用英文双引号，而不是中文引号";
      if (closed) {
        return fail(
          msg,
          {
            from: qStart,
            to: end,
            insert: JSON.stringify(inner),
            label: "改为英文双引号",
          },
          end,
          undefined,
          qStart,
        );
      }
      return fail(msg, undefined, Math.min(source.length, qStart + 1), undefined, qStart);
    };

    const read = (parent: number, key: string, depth: number): number => {
      if (depth > 512) fail("嵌套超过 512 层");
      ws();
      if (pos >= source.length) {
        fail(
          "缺少 JSON 值",
          undefined,
          pos,
          "期望一个对象、数组、字符串、数字、布尔值或 null",
        );
      }
      const start = pos,
        c = source[pos]!,
        id = this.nodes.length;
      const kind: Kind =
        c === "{"
          ? "object"
          : c === "["
            ? "array"
            : c === '"'
              ? "string"
              : c === "t" || c === "f"
                ? "boolean"
                : c === "n"
                  ? "null"
                  : "number";
      const n: Node = {
        key,
        parent,
        ordinal: parent < 0 ? 0 : this.nodes[parent]!.children!.length,
        start,
        end: start,
        kind,
      };
      this.nodes.push(n);

      if (kind === "object" || kind === "array") {
        const object = kind === "object",
          close = object ? "}" : "]";
        const children: number[] = (n.children = []);
        pos++;
        ws();
        if (pos >= source.length) {
          fail(
            object ? '对象未闭合，缺少 "}"' : '数组未闭合，缺少 "]"',
            { from: pos, to: pos, insert: close, label: "补上 " + close },
            pos,
            `与第 ${lineColumn(source, start).line} 行的 "${c}" 配对`,
          );
        }
        if (source[pos] !== close) {
          for (;;) {
            let name = String(children.length);
            if (object) {
              if (source[pos] === ",") {
                fail(
                  "对象开头有多余的逗号",
                  { from: pos, to: pos + 1, insert: "", label: "移除多余逗号" },
                  pos + 1,
                );
              }
              if (source[pos] === "]") {
                fail(
                  '括号不匹配：应为 "}"，而不是 "]"',
                  { from: pos, to: pos + 1, insert: "}", label: "改为 }" },
                  pos + 1,
                  `与第 ${lineColumn(source, start).line} 行的 "{" 配对`,
                );
              }
              if (source[pos] === "'" || source[pos] === "“" || source[pos] === "”") {
                parseWrongQuote(pos, true);
              }
              if (source[pos] !== '"') {
                let identEnd = pos;
                while (
                  identEnd < source.length &&
                  !tokenStopChars.includes(source[identEnd]!)
                ) {
                  identEnd++;
                }
                if (identEnd > pos) {
                  const ident = source.slice(pos, identEnd);
                  fail(
                    `键名 "${ident}" 缺少双引号`,
                    {
                      from: pos,
                      to: identEnd,
                      insert: JSON.stringify(ident),
                      label: "为键名添加双引号",
                    },
                    identEnd,
                    'JSON 对象的键名必须用英文双引号 "..." 包裹',
                  );
                }
                fail("键名需要双引号", undefined, Math.min(source.length, pos + 1));
              }
              const k = pos;
              string();
              name = JSON.parse(source.slice(k, pos));
              const afterKey = pos;
              ws();
              if (source[pos] === "：" || source[pos] === "=") {
                const bad = source[pos]!;
                fail(
                  bad === "："
                    ? '使用了中文冒号 "："，应为英文冒号 ":"'
                    : '键名后应使用冒号 ":"，而不是 "="',
                  { from: pos, to: pos + 1, insert: ":", label: "替换为英文冒号" },
                  pos + 1,
                );
              }
              if (pos >= source.length || source[pos] === "}" || source[pos] === ",") {
                fail(`键 "${name}" 后缺少冒号和值`, undefined, afterKey, undefined, afterKey);
              }
              if (source[pos] !== ":") {
                fail(
                  '键名后缺少冒号 ":"',
                  { from: afterKey, to: afterKey, insert: ":", label: "补上冒号" },
                  afterKey,
                  undefined,
                  afterKey,
                );
              }
              pos++;
            }

            children.push(read(id, name, depth + 1));
            const afterVal = pos;
            ws();
            if (source[pos] === close) break;
            if (pos >= source.length) {
              fail(
                object ? '对象未闭合，缺少 "}"' : '数组未闭合，缺少 "]"',
                { from: afterVal, to: afterVal, insert: close, label: "补上 " + close },
                afterVal,
                `与第 ${lineColumn(source, start).line} 行的 "${c}" 配对`,
                afterVal,
              );
            }
            const ch = source[pos]!;
            if (ch === "}" || ch === "]") {
              fail(
                `括号不匹配：应为 "${close}"，而不是 "${ch}"`,
                { from: pos, to: pos + 1, insert: close, label: "改为 " + close },
                pos + 1,
                `与第 ${lineColumn(source, start).line} 行的 "${c}" 配对`,
              );
            }
            if (ch === "，" || ch === ";") {
              fail(
                ch === "，"
                  ? '使用了中文逗号 "，"，应为英文逗号 ","'
                  : 'JSON 中不应使用分号 ";"，应为逗号 ","',
                { from: pos, to: pos + 1, insert: ",", label: "替换为英文逗号" },
                pos + 1,
              );
            }
            if (ch !== ",") {
              fail(
                '缺少逗号 ","',
                { from: afterVal, to: afterVal, insert: ",", label: "补上逗号" },
                afterVal,
                "对象或数组元素之间必须用英文逗号分隔",
                afterVal,
              );
            }
            const comma = pos++;
            ws();
            if (pos >= source.length) {
              fail(
                object
                  ? "对象未闭合，且最后一项后有多余的逗号"
                  : "数组未闭合，且最后一项后有多余的逗号",
                {
                  from: comma,
                  to: comma + 1,
                  insert: close,
                  label: "移除逗号并补上 " + close,
                },
                comma + 1,
                undefined,
                comma,
              );
            }
            if (source[pos] === ",") {
              fail(
                "存在多余的连续逗号",
                { from: pos, to: pos + 1, insert: "", label: "移除多余逗号" },
                pos + 1,
              );
            }
            if (source[pos] === close) {
              fail(
                "最后一项后有多余的逗号",
                {
                  from: comma,
                  to: comma + 1,
                  insert: "",
                  label: "移除尾逗号",
                },
                comma + 1,
                undefined,
                comma,
              );
            }
          }
        }
        pos++;
      } else if (kind === "string") {
        string();
      } else if (c === "'" || c === "“" || c === "”") {
        parseWrongQuote(pos, false);
      } else if (c === "," || c === "}" || c === "]" || c === ":") {
        if (c === "," && parent >= 0 && this.nodes[parent]!.kind === "array" && this.nodes[parent]!.children!.length === 0) {
          fail(
            "数组开头有多余的逗号",
            { from: pos, to: pos + 1, insert: "", label: "移除多余逗号" },
            pos + 1,
          );
        }
        fail("缺少 JSON 值", undefined, pos + 1);
      } else {
        let rawEnd = pos;
        while (rawEnd < source.length && !' \t\r\n,:：=}[]"{}/'.includes(source[rawEnd]!)) {
          rawEnd++;
        }
        const rawTok = source.slice(pos, rawEnd);
        if (exactToken.test(rawTok)) {
          pos = rawEnd;
        } else {
          diagnosePrimitive(rawTok, pos, rawEnd, fail);
        }
      }
      n.end = pos;
      return id;
    };

    read(-1, "值", 0);
    ws();
    if (pos !== source.length) {
      if (source[pos] === "}" || source[pos] === "]") {
        fail(
          `多余的闭合括号 "${source[pos]}"`,
          { from: pos, to: pos + 1, insert: "", label: "移除多余括号" },
          pos + 1,
        );
      }
      fail(
        "根节点后有多余内容",
        undefined,
        source.length,
        "一个 JSON 文档只能有一个根节点",
      );
    }
  }

  row(id: number, level = 0): Row {
    const n = this.nodes[id]!;
    const pKind = n.parent >= 0 ? this.nodes[n.parent]!.kind : undefined;
    return {
      id,
      key: pKind === "array" ? "[" + n.key + "]" : n.key,
      kind: n.kind,
      parentKind: pKind,
      count: n.children?.length ?? 0,
      level,
      start: n.start,
      end: n.end,
      preview: n.children
        ? n.kind === "array"
          ? "[ " + n.children.length + " ]"
          : "{ " + n.children.length + " }"
        : this.source.slice(n.start, Math.min(n.end, n.start + 100)),
    };
  }

  view(o: Options): Result {
    const rows: Row[] = [],
      expanded = new Set(o.expanded);
    let hits = 0;
    const root = this.nodes[0]!;
    const matches: Match[] = [];
    if (o.query && o.scope !== "text") {
      const q = o.query.toLowerCase();
      this.nodes.forEach((n, id) => {
        if (!id && n.children) return;
        if (
          !n.key.toLowerCase().includes(q) &&
          (n.children || !this.value(n).toLowerCase().includes(q))
        )
          return;
        if (Math.floor(hits++ / pageSize) !== o.page) return;
        const trail: [number, number][] = [];
        for (
          let child = n;
          child.parent >= 0;
          child = this.nodes[child.parent]!
        )
          trail.push([child.parent, Math.floor(child.ordinal / pageSize)]);
        matches.push({
          id,
          start: n.start,
          end: n.end,
          label: this.row(id).key,
          context: this.path(id),
          trail,
        });
      });
    }
    const visit = (id: number, level: number) => {
      const n = this.nodes[id]!;
      if (id !== 0 || !n.children) rows.push(this.row(id, level));
      if (id === 0 || expanded.has(id)) {
        const from = (o.pages[id] ?? 0) * pageSize;
        n.children
          ?.slice(from, from + pageSize)
          .forEach((child) => visit(child, level + 1));
      }
    };
    visit(0, root.children ? -1 : 0);
    const id = this.nodes[o.selected] ? o.selected : 0,
      n = this.nodes[id]!;
    const from = (o.detailPage ?? 0) * pageSize;
    const entries = (
      n.children ? n.children.slice(from, from + pageSize) : [id]
    ).map((k) => {
      const item = this.nodes[k]!,
        row = this.row(k);
      const value = item.children
        ? this.source.slice(item.start, Math.min(item.end, item.start + 512))
        : this.value(item);
      return {
        ...row,
        preview:
          value.length > 4096
            ? value.slice(0, 4096) + "…"
            : value + (item.children && item.end - item.start > 512 ? "…" : ""),
      };
    });
    return {
      rows,
      matches,
      hits,
      rootCount: root.children?.length ?? 0,
      rootKind: root.kind,
      count: this.nodes.length,
      detail: this.row(id),
      path: this.path(id),
      entries,
      preview: "",
      size: n.end - n.start,
    };
  }

  private value(n: Node): string {
    const raw = this.source.slice(n.start, n.end);
    return n.kind === "string" ? JSON.parse(raw) : raw;
  }

  private path(id: number) {
    const path: string[] = [];
    for (let n = this.nodes[id]!; n.parent >= 0; n = this.nodes[n.parent]!)
      path.push(
        this.nodes[n.parent]!.kind === "array"
          ? "[" + n.key + "]"
          : /^[$A-Z_a-z][$\w]*$/.test(n.key)
            ? "." + n.key
            : "[" + JSON.stringify(n.key) + "]",
      );
    return path.reverse().join("").replace(/^\./, "") || "全文";
  }

  private renderNode(id: number, space: string): string {
    const src = this.source;
    const render = (cur: number, depth: number): string => {
      const n = this.nodes[cur]!;
      const children = n.children;
      if (!children) return src.slice(n.start, n.end);
      const obj = n.kind === "object";
      const pad = (d: number) => (space ? "\n" + space.repeat(d) : "");
      return (
        (obj ? "{" : "[") +
        children
          .map(
            (c) =>
              pad(depth + 1) +
              (obj
                ? JSON.stringify(this.nodes[c]!.key) + (space ? ": " : ":")
                : "") +
              render(c, depth + 1),
          )
          .join(",") +
        (children.length ? pad(depth) : "") +
        (obj ? "}" : "]")
      );
    };
    return render(id, 0);
  }

  extract(id: number, format: CopyFormat): string {
    const n = this.nodes[id] ?? this.nodes[0]!;
    switch (format) {
      case "key":
        return n.parent >= 0 ? n.key : "";
      case "path":
        return this.path(this.nodes[id] ? id : 0);
      case "minify":
        return this.renderNode(this.nodes[id] ? id : 0, "");
      case "pretty":
        return this.renderNode(this.nodes[id] ? id : 0, "  ");
      case "pair":
        if (n.parent >= 0 && this.nodes[n.parent]!.kind === "object") {
          return JSON.stringify(n.key) + ": " + this.renderNode(id, "  ");
        }
        return this.renderNode(this.nodes[id] ? id : 0, "  ");
      case "value":
      default:
        return n.children ? this.renderNode(id, "  ") : this.value(n);
    }
  }

  expandableIds(limit = 500): number[] {
    const out: number[] = [];
    const queue = [0];
    while (queue.length && out.length < limit) {
      const cur = queue.shift()!;
      const n = this.nodes[cur];
      if (!n?.children?.length) continue;
      out.push(cur);
      for (const child of n.children) {
        if (this.nodes[child]?.children?.length) queue.push(child);
      }
    }
    return out;
  }

  convert(mode: Mode): string {
    if (mode === "minify") return this.renderNode(0, "");
    if (mode !== "xml") return this.renderNode(0, "  ");
    const src = this.source;
    const escapeXML = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\r/g, "&#13;")
        .replace(/\n/g, "&#10;")
        .replace(/\t/g, "&#9;");
    const legal = (s: string) =>
      !/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(
        s,
      );
    const pad = (d: number) => "\n" + "  ".repeat(d);
    const render = (id: number, depth: number): string => {
      const n = this.nodes[id]!,
        raw = () => src.slice(n.start, n.end);
      const children = n.children;
      const tag =
        id === 0
          ? "json"
          : this.nodes[n.parent]!.kind === "array"
            ? "item"
            : "entry";
      const key =
        tag === "entry"
          ? legal(n.key)
            ? ' key="' + escapeXML(n.key) + '"'
            : ' key-json="' + escapeXML(JSON.stringify(n.key)) + '"'
          : "";
      const value = children
        ? ""
        : n.kind === "string"
          ? (JSON.parse(raw()) as string)
          : raw();
      const body = children
        ? children
            .map((c) => pad(depth + 1) + render(c, depth + 1))
            .join("") + (children.length ? pad(depth) : "")
        : escapeXML(legal(value) ? value : JSON.stringify(value));
      return (
        "<" +
        tag +
        key +
        ' type="' +
        n.kind +
        '"' +
        (legal(value) ? "" : ' encoding="json"') +
        ">" +
        body +
        "</" +
        tag +
        ">"
      );
    };
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + render(0, 0);
  }
}

function diagnosePrimitive(
  rawTok: string,
  start: number,
  rawEnd: number,
  fail: (
    message: string,
    fix?: Correction,
    end?: number,
    hint?: string,
    at?: number,
  ) => never,
): never {
  if (/^true$/i.test(rawTok)) {
    fail(
      '布尔值应小写为 "true"',
      { from: start, to: rawEnd, insert: "true", label: "改为 true" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^false$/i.test(rawTok)) {
    fail(
      '布尔值应小写为 "false"',
      { from: start, to: rawEnd, insert: "false", label: "改为 false" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^(?:null|none|nil)$/i.test(rawTok)) {
    fail(
      '空值应写为小写 "null"',
      { from: start, to: rawEnd, insert: "null", label: "改为 null" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (
    rawTok === "undefined" ||
    rawTok === "NaN" ||
    rawTok === "Infinity" ||
    rawTok === "-Infinity"
  ) {
    fail(
      `JSON 不支持 "${rawTok}"`,
      { from: start, to: rawEnd, insert: "null", label: "替换为 null" },
      rawEnd,
      "标准 JSON 中空值或非数字应使用 null",
      start,
    );
  }
  if (/^-?0\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(rawTok)) {
    const neg = rawTok.startsWith("-") ? "-" : "";
    const body = neg ? rawTok.slice(1) : rawTok;
    const fixed = neg + body.replace(/^0+(?=\d)/, "");
    fail(
      "数字不能有前导零",
      { from: start, to: rawEnd, insert: fixed, label: "移除前导零" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^-?(?:0|[1-9]\d*)\.$/.test(rawTok)) {
    fail(
      "小数点后缺少数字",
      { from: start, to: rawEnd, insert: rawTok + "0", label: "补上 0" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^-?\.\d+(?:[Ee][+-]?\d+)?$/.test(rawTok)) {
    const fixed = rawTok.startsWith("-")
      ? "-0" + rawTok.slice(1)
      : "0" + rawTok;
    fail(
      "小数点前缺少 0",
      { from: start, to: rawEnd, insert: fixed, label: "补上前导 0" },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^\+(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(rawTok)) {
    fail(
      '数字不能带正号 "+"',
      { from: start, to: rawEnd, insert: rawTok.slice(1), label: '移除 "+"' },
      rawEnd,
      undefined,
      start,
    );
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?[Ee][+-]?$/.test(rawTok)) {
    fail("科学计数法指数缺少数字", undefined, rawEnd, undefined, start);
  }
  if (/^-?\d/.test(rawTok) || rawTok === "-") {
    fail(`无效的数字格式 "${rawTok}"`, undefined, rawEnd, undefined, start);
  }
  fail(
    `无效的 JSON 值 "${rawTok}"`,
    {
      from: start,
      to: rawEnd,
      insert: JSON.stringify(rawTok),
      label: "包裹为字符串",
    },
    rawEnd,
    "字符串值必须用双引号包裹",
    start,
  );
}

export function repairJson(
  source: string,
  maxSteps = 100,
): { text: string; fixes: number; complete: boolean } {
  let current = source;
  let fixes = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (!current.trim()) return { text: current, fixes, complete: false };
    try {
      new DocumentIndex(current);
      return { text: current, fixes, complete: true };
    } catch (e) {
      if (!(e instanceof Fault) || !e.fix) {
        return { text: current, fixes, complete: false };
      }
      const { from, to, insert } = e.fix;
      const next = current.slice(0, from) + insert + current.slice(to);
      if (next === current) {
        return { text: current, fixes, complete: false };
      }
      current = next;
      fixes++;
    }
  }
  try {
    new DocumentIndex(current);
    return { text: current, fixes, complete: true };
  } catch {
    return { text: current, fixes, complete: false };
  }
}

export function validateUnescape(source: string): string {
  const lead = source.length - source.trimStart().length;
  const trimmed = source.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    try {
      new DocumentIndex(trimmed);
      return JSON.parse(trimmed) as string;
    } catch (e) {
      if (e instanceof Fault) {
        throw new Fault(
          lead + e.offset,
          e.message,
          e.fix && {
            ...e.fix,
            from: lead + e.fix.from,
            to: lead + e.fix.to,
          },
          e.end !== undefined ? lead + e.end : undefined,
          e.hint,
        );
      }
      throw e;
    }
  }
  const wrapped = '"' + trimmed + '"';
  try {
    new DocumentIndex(wrapped);
    return JSON.parse(wrapped) as string;
  } catch (e) {
    if (e instanceof Fault) {
      const mapOff = (p: number) =>
        Math.max(0, Math.min(source.length, lead + p - 1));
      if (e.message === "根节点后有多余内容") {
        // An unescaped quote inside the wrapped text closed the string early.
        let q = 0;
        while (q < trimmed.length) {
          if (trimmed[q] === "\\") {
            q += 2;
            continue;
          }
          if (trimmed[q] === '"') break;
          q++;
        }
        const qPos = lead + Math.min(q, Math.max(0, trimmed.length - 1));
        throw new Fault(
          qPos,
          "去转义文本中存在未转义的双引号",
          { from: qPos, to: qPos + 1, insert: '\\"', label: "转义双引号" },
          qPos + 1,
          '内部双引号应写作 \\"',
        );
      }
      if (e.message === "字符串缺少结束引号" && trimmed.endsWith("\\")) {
        const bsPos = lead + trimmed.length - 1;
        throw new Fault(
          bsPos,
          "末尾存在未配对的反斜杠",
          { from: bsPos, to: bsPos + 1, insert: "\\\\", label: "转义反斜杠" },
          bsPos + 1,
        );
      }
      throw new Fault(
        mapOff(e.offset),
        e.message,
        e.fix && {
          ...e.fix,
          from: mapOff(e.fix.from),
          to: mapOff(e.fix.to),
        },
        e.end !== undefined ? mapOff(e.end) : undefined,
        e.hint,
      );
    }
    throw e;
  }
}
