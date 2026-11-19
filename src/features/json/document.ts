export type Mode = "tree" | "format" | "minify" | "escape" | "unescape" | "xml";
export type Kind =
  "object" | "array" | "string" | "number" | "boolean" | "null";
interface Node {
  key: string;
  parent: number;
  ordinal: number;
  start: number;
  end: number;
  kind: Kind;
  children?: number[];
}
interface Correction {
  from: number;
  to: number;
  insert: string;
  label: string;
}
export class Fault extends Error {
  constructor(
    public offset: number,
    message: string,
    public fix?: Correction,
  ) {
    super(message);
  }
}
export interface Row {
  id: number;
  key: string;
  kind: Kind;
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
  matches?: Match[];
  path?: string;
  preview: string;
  size: number;
  count: number;
  hits: number;
  error?: { offset: number; message: string; fix?: Correction };
}
const pageSize = 50;
export { pageSize };
export class DocumentIndex {
  nodes: Node[] = [];
  constructor(readonly source: string) {
    let pos = 0;
    const fail = (message: string, fix?: Correction): never => {
      throw new Fault(pos, message, fix);
    };
    const ws = () => {
      while (pos < source.length && " \t\n\r".includes(source[pos]!)) pos++;
    };
    const token =
      /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?|true|false|null/y;
    const string = () => {
      pos++;
      while (pos < source.length) {
        const c = source[pos++]!;
        if (c === '"') return;
        if (c === "\\") {
          const e = source[pos];
          if (e === "u") {
            pos++;
            for (let j = 0; j < 4; j++) {
              if (!/[\da-f]/i.test(source[pos] ?? ""))
                fail("Unicode 转义需要四位十六进制数");
              pos++;
            }
          } else if (e && '"\\/bfnrt'.includes(e)) pos++;
          else fail("无效的转义字符");
        } else if (c < " ") {
          pos--;
          fail("字符串中的控制字符需要转义");
        }
      }
      fail("字符串缺少结束引号");
    };
    const read = (parent: number, key: string, depth: number): number => {
      if (depth > 512) fail("嵌套超过 512 层");
      ws();
      const start = pos,
        c = source[pos],
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
        if (source[pos] !== close)
          for (;;) {
            let name = String(children.length);
            if (object) {
              if (source[pos] !== '"') fail("键名需要双引号");
              const k = pos;
              string();
              name = JSON.parse(source.slice(k, pos));
              ws();
              if (source[pos] !== ":")
                fail("键名后缺少冒号", {
                  from: pos,
                  to: pos,
                  insert: ":",
                  label: "补上冒号",
                });
              pos++;
            }
            children.push(read(id, name, depth + 1));
            ws();
            if (source[pos] === close) break;
            if (source[pos] !== ",") fail("需要逗号或 " + close);
            const comma = pos++;
            ws();
            if (source[pos] === close)
              fail("最后一项后有多余的逗号", {
                from: comma,
                to: comma + 1,
                insert: "",
                label: "移除尾逗号",
              });
          }
        pos++;
      } else if (kind === "string") string();
      else {
        token.lastIndex = pos;
        if (!token.test(source)) fail("需要有效的 JSON 值");
        pos = token.lastIndex;
      }
      n.end = pos;
      return id;
    };
    read(-1, "值", 0);
    ws();
    if (pos !== source.length) fail("根节点后有多余内容");
  }
  row(id: number, level = 0): Row {
    const n = this.nodes[id]!;
    return {
      id,
      key:
        n.parent >= 0 && this.nodes[n.parent]!.kind === "array"
          ? "[" + n.key + "]"
          : n.key,
      kind: n.kind,
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
  convert(mode: Mode): string {
    const src = this.source,
      xml = mode === "xml";
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
    const space = mode === "minify" ? "" : "  ";
    const render = (id: number, depth: number): string => {
      const n = this.nodes[id]!,
        raw = () => src.slice(n.start, n.end);
      const children = n.children;
      const pad = (d: number) => (space ? "\n" + space.repeat(d) : "");
      if (xml) {
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
      }
      if (!children) return raw();
      const obj = n.kind === "object";
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
    return (
      (xml ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "") + render(0, 0)
    );
  }
}
