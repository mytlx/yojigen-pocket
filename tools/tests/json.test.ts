import { expect, test } from "bun:test";
import {
  DocumentIndex,
  Fault,
  lineColumn,
  repairJson,
  validateUnescape,
  type Options,
} from "../../src/features/json/document";
import { normalizeEscapes } from "../../src/features/json/escapes";

const options: Options = {
  mode: "tree",
  expanded: [0],
  pages: {},
  query: "",
  page: 0,
  selected: 0,
};

function expectFault(s: string) {
  try {
    new DocumentIndex(s);
    throw Error("accepted invalid JSON: " + s);
  } catch (e) {
    expect(e).toBeInstanceOf(Fault);
    return e as Fault;
  }
}

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
    ['\n  {"x":[1,]}', 10],
    ['"\\u02XZ"', 5],
    ['{"a" 1}', 4],
    ["[", 1],
    ["1 true", 2],
  ] as const) {
    const f = expectFault(s);
    expect(f.offset).toBe(pos);
  }
});

test("multiline trailing comma and missing comma report accurate positions and fixes", () => {
  const trailing = '{\n  "a": 1,\n}';
  const tf = expectFault(trailing);
  expect(tf.offset).toBe(10);
  expect(lineColumn(trailing, tf.offset)).toEqual({ line: 2, column: 9 });
  expect(tf.fix).toEqual({ from: 10, to: 11, insert: "", label: "移除尾逗号" });

  const missingComma = '{\n  "a": 1\n  "b": 2\n}';
  const mf = expectFault(missingComma);
  expect(mf.offset).toBe(10);
  expect(lineColumn(missingComma, mf.offset)).toEqual({ line: 2, column: 9 });
  expect(mf.fix).toEqual({ from: 10, to: 10, insert: ",", label: "补上逗号" });
});

test("diagnostics catch invalid numbers, non-standard literals, quotes, unquoted keys, comments and brackets", () => {
  const numCases: [string, string, string][] = [
    ['{"a": 012}', "数字不能有前导零", '{"a": 12}'],
    ['{"a": 1.}', "小数点后缺少数字", '{"a": 1.0}'],
    ['{"a": .5}', "小数点前缺少 0", '{"a": 0.5}'],
    ['{"a": +1}', '数字不能带正号 "+"', '{"a": 1}'],
  ];
  for (const [src, msg, expected] of numCases) {
    const f = expectFault(src);
    expect(f.message).toContain(msg);
    expect(repairJson(src).text).toBe(expected);
  }
  expect(expectFault('{"a": 1e}').message).toContain("科学计数法指数缺少数字");
  expect(expectFault('{"a": 123abc}').message).toContain("无效的数字格式");

  for (const [src, expected] of [
    ['{"a": True}', '{"a": true}'],
    ['{"a": False}', '{"a": false}'],
    ['{"a": None}', '{"a": null}'],
    ['{"a": undefined}', '{"a": null}'],
    ['{"a": NaN}', '{"a": null}'],
    ["{'a': 'b'}", '{"a": "b"}'],
    ['{“a”: “b”}', '{"a": "b"}'],
    ["{foo: 1}", '{"foo": 1}'],
    ['{\n  // note\n  "a": 1\n}', '{\n  "a": 1\n}'],
    ['{"a": /* c */ 1}', '{"a":  1}'],
    ['{"a": [1, 2}', '{"a": [1, 2]}'],
    ['{"a": 1', '{"a": 1}'],
  ]) {
    const rep = repairJson(src);
    expect(rep.complete).toBe(true);
    expect(rep.text).toBe(expected);
  }
});

test("repairJson fixes multiple errors iteratively", () => {
  const dirty = "{\n  foo: 'bar'\n  baz: True,\n}";
  const rep = repairJson(dirty);
  expect(rep.complete).toBe(true);
  expect(rep.fixes).toBe(6);
  expect(JSON.parse(rep.text)).toEqual({ foo: "bar", baz: true });
});

test("autoEscape keepNewlines preserves unclosed string line and original offsets", () => {
  const src = '{\n  "url": "https\\://a\\.b\n  "ok": 1\n}';
  const normKeep = normalizeEscapes(src, { keepNewlines: true });
  expect(normKeep.hadMarkdownEscapes).toBe(true);
  const f = expectFault(normKeep.text);
  const orig = normKeep.original(f.offset);
  expect(src.slice(0, orig)).toBe('{\n  "url": "https\\://a\\.b');
  expect(lineColumn(src, orig)).toEqual({ line: 2, column: 24 });

  const rep = repairJson(normKeep.text);
  expect(rep.complete).toBe(true);
  expect(JSON.parse(rep.text)).toEqual({ url: "https://a.b", ok: 1 });
});

test("validateUnescape parses valid strings and pinpoints invalid escapes or quotes", () => {
  expect(validateUnescape('{\\"a\\": 1}')).toBe('{"a": 1}');
  expect(validateUnescape('"hello\\nworld"')).toBe("hello\nworld");
  try {
    validateUnescape('{\\"a": 1}');
    throw Error("should fail");
  } catch (e) {
    expect(e).toBeInstanceOf(Fault);
    expect((e as Fault).offset).toBe(4);
    expect((e as Fault).fix?.insert).toBe('\\"');
  }
  try {
    validateUnescape("abc\\");
    throw Error("should fail");
  } catch (e) {
    expect(e).toBeInstanceOf(Fault);
    expect((e as Fault).offset).toBe(3);
  }
});

test("DocumentIndex.extract supports all copy formats", () => {
  const doc = new DocumentIndex(
    '{"user":{"name":"张三","tags":["go","ts"]},"big":9007199254740993}',
  );
  const rows = doc.view(options).rows;
  const userRow = rows[0]!;
  const bigRow = rows[1]!;
  const expanded = doc.view({ ...options, expanded: [0, userRow.id] }).rows;
  const nameRow = expanded[1]!;

  expect(doc.extract(nameRow.id, "value")).toBe("张三");
  expect(doc.extract(nameRow.id, "key")).toBe("name");
  expect(doc.extract(nameRow.id, "pair")).toBe('"name": "张三"');
  expect(doc.extract(nameRow.id, "path")).toBe("user.name");
  expect(doc.extract(nameRow.id, "minify")).toBe('"张三"');
  expect(doc.extract(bigRow.id, "value")).toBe("9007199254740993");
  expect(doc.extract(userRow.id, "minify")).toBe(
    '{"name":"张三","tags":["go","ts"]}',
  );
  expect(doc.extract(userRow.id, "pretty")).toBe(
    '{\n  "name": "张三",\n  "tags": [\n    "go",\n    "ts"\n  ]\n}',
  );
  expect(doc.extract(userRow.id, "pair")).toContain('"user": {\n');
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
