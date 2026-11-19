import { expect, test } from "bun:test";
import {
  DocumentIndex,
  Fault,
  type Options,
} from "../../src/features/json/document";
const options: Options = {
  mode: "tree",
  expanded: [0],
  pages: {},
  query: "",
  page: 0,
  selected: 0,
};

test("format and minify preserve numeric tokens, duplicate keys and __proto__", () => {
  const doc = new DocumentIndex(
    '{"z":1e99,"a":9007199254740993,"a":-0,"__proto__":null}',
  );
  expect(doc.convert("minify")).toBe(
    '{"z":1e99,"a":9007199254740993,"a":-0,"__proto__":null}',
  );
});
test("node value and JSON path retain escaped keys and array indices", () => {
  const doc = new DocumentIndex('{"a.b":[{"x":"\\u4f60好"}]}');
  const hit = doc.view({ ...options, query: "你好" }).matches![0]!;
  const detail = doc.view({ ...options, selected: hit.id! });
  expect(detail.path).toBe('["a.b"][0].x');
  expect(doc.source.slice(hit.start, hit.end)).toBe('"\\u4f60好"');
});
test("first syntax error includes whitespace and escaped string offsets", () => {
  for (const [s, pos] of [
    ['\n  {"x":[1,]}', 11],
    ['"\\u02XZ"', 5],
    ['{"a" 1}', 5],
    ["[", 1],
    ["1 true", 2],
  ] as const) {
    try {
      new DocumentIndex(s);
      throw Error("accepted invalid JSON");
    } catch (e) {
      expect(e).toBeInstanceOf(Fault);
      expect((e as Fault).offset).toBe(pos);
    }
  }
});
test("XML represents arbitrary keys, types and characters disallowed by XML", () => {
  const doc = new DocumentIndex('{"< a":"x&y","items":[null,"\\u0000"]}');
  const xml = doc.convert("xml");
  expect(xml).toContain('key="&lt; a" type="string">x&amp;y</entry>');
  expect(xml).toContain('<item type="null">null</item>');
  expect(xml).toContain('encoding="json">&quot;\\u0000&quot;');
});
test("large collections page both children and search matches", () => {
  const doc = new DocumentIndex(
    JSON.stringify(Array.from({ length: 100000 }, (_, i) => ({ id: i }))),
  );
  const first = doc.view(options);
  expect(first.count).toBe(200001);
  expect(first.rows).toHaveLength(50);
  expect(doc.view({ ...options, pages: { 0: 1999 } }).rows.at(-1)?.key).toBe(
    "[99999]",
  );
  expect(doc.view({ ...options, query: "id", page: 10 }).hits).toBe(100000);
});

import { normalizeEscapes } from "../../src/features/json/escapes";
test("paste normalization preserves source ranges, HTML text, numeric precision and input order", () => {
  const input = String.raw`{\
&#x20;   "About": {"QQ":661275469},\
"BigNumber":71357798191653192098,\
"Function":["JSON美化","&nbsp;"," ","\<h1>JSON在线解析\</h1>",{"备注":["www\.json.cn"]}],\
"content":"第一行\
第二行
第三行",\
"json.url":"https\://www\.json.cn", "2":1,"1":2}`;
  const normalized = normalizeEscapes(input),
    doc = new DocumentIndex(normalized.text);
  const root = doc.view(options);
  expect(root.rows.map((r) => r.key)).toEqual([
    "About",
    "BigNumber",
    "Function",
    "content",
    "json.url",
    "2",
    "1",
  ]);
  const array = doc.view({ ...options, selected: root.rows[2]!.id });
  expect(array.entries!.map((r) => r.key)).toEqual([
    "[0]",
    "[1]",
    "[2]",
    "[3]",
    "[4]",
  ]);
  expect(array.entries![3]!.preview).toBe("<h1>JSON在线解析</h1>");
  expect(array.entries![1]!.preview).toBe("&nbsp;");
  const url = root.rows[4]!;
  expect(
    input.slice(normalized.original(url.start), normalized.original(url.end)),
  ).toBe(String.raw`"https\://www\.json.cn"`);
  expect(doc.convert("format")).toContain("71357798191653192098");
  expect(JSON.parse(normalized.text).content).toBe("第一行\n第二行\n第三行");
});
