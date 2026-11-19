import { describe, expect, test } from "bun:test";
import { splitFrontmatter, joinFrontmatter } from "../../extensions/editors/src/notes/frontmatter";
import { applyBlankLinesToAst } from "../../extensions/editors/src/notes/blanklines";
import { matchStandaloneHtmlSnippet, parseBlockPrefix } from "../../extensions/editors/src/notes/liveinline";
import { applySourceFormat, applySourceParagraph, buildSourceInsert, nextFootnoteIndex, nextLinkRefId } from "../../extensions/editors/src/notes/blockops";
import { DEFAULT_HIGHLIGHT_COLOR, normalizeHighlightColor, pushHighlightHistory, resolveHighlightVars } from "../../extensions/editors/src/notes/highlights";
import { expandReplacement, findTextRanges } from "../../extensions/editors/src/notes/findreplace";
import { buildImageFilename, extractUrlByPath, resolveImageDir, resolveNoteRelativePath, sanitizeImageName } from "../../extensions/editors/src/notes/images";
import { anchorToSourceOffset, pickBestBlockIndex, sourceOffsetToAnchor } from "../../extensions/editors/src/notes/syncpos";
import { DEFAULT_TIME_FORMAT, formatTime } from "../../extensions/editors/src/notes/timefmt";
import { filterSlashItems, matchBlockSlash } from "../../extensions/editors/src/notes/slash";
import { outlineOf, outlineTree, richOutlineOf } from "../../extensions/editors/src/notes/outline";
import { applySourceIndent, defaultShortcuts, findShortcutConflicts, insertLine, lineAction, matchShortcutAction, shortcutOf } from "../../extensions/editors/src/notes/shortcuts";
import {
  DEFAULT_OUTLINE_W,
  DEFAULT_SIDEBAR_W,
  MIN_EDITOR_W,
  clampDragWidth,
  collectNestedDirs,
  compileFileSearch,
  computePanelWidths,
  filterDirPaths,
  normalizeDeleteTargets,
  normalizePanelBounds,
  selectRange,
  sortTreeNodes,
  visibleTreePaths,
} from "../../extensions/editors/src/notes/sidebar";
import { highlightJSON } from "../../src/features/ui";

describe("notes source fidelity", () => {
  for (const text of ["\n\n# Heading\n", "---\r\ntitle: test\r\n---\r\n\r\n\r\n# Heading\r\n", "---\ntitle: test\n---\n# Heading\n"]) {
    test(JSON.stringify(text), () => { const split = splitFrontmatter(text); expect(joinFrontmatter(split.front, split.body, split)).toBe(text); });
  }
  test("adding body to frontmatter ending at EOF inserts a separator", () => {
    const split = splitFrontmatter("---\ntitle: x\n---");
    expect(joinFrontmatter(split.front, "# Body", split)).toBe("---\ntitle: x\n---\n# Body");
  });
  test("outline ignores fenced code and supports duplicate/Setext headings", () => {
    const text = "# Same\n\n```md\n# Not a heading\n```\n\nSame\n----\n\n## Same\n";
    expect(outlineOf(text).map(h => [h.level, h.text, text.slice(h.from, h.from + 4)])).toEqual([[1,"Same","# Sa"],[2,"Same","Same"],[2,"Same","## S"]]);
  });
});
test("insert line at first/last line without splitting text", () => {
  for (const [direction, want, cursor] of [["above", "  \n  hello", 2], ["below", "  hello\n  ", 10]] as const) {
    const edit = insertLine("  hello", 4, direction);
    expect("  hello".slice(0, edit.from) + edit.insert + "  hello".slice(edit.from)).toBe(want);
    expect(edit.anchor).toBe(cursor);
  }
  expect(insertLine("\ntext", 0, "above").from).toBe(0);
  expect(insertLine("", 0, "above")).toEqual({ from: 0, insert: "\n", anchor: 0 });
});
test("shortcut modifiers are exact and IME does not trigger", () => {
  const event = { key: "Enter", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false } as KeyboardEvent;
  expect(shortcutOf(event)).toBe(defaultShortcuts.above);
  expect(lineAction(event, defaultShortcuts)).toBe("above");
  expect(lineAction({ ...event, shiftKey: true } as KeyboardEvent, defaultShortcuts)).toBeNull();
  expect(lineAction({ ...event, isComposing: true } as KeyboardEvent, defaultShortcuts)).toBeNull();
});
test("JSON highlight does not share keyboard key layout or allow HTML", () => {
  const html = highlightJSON('{"<script>": "x", "nested": {"key": true}}');
  expect(html).not.toContain('class="fx-key"');
  expect(html).toContain('class="fx-json-key"');
  expect(html).not.toContain("<script>");
});

describe("notes sidebar multi-select, delete normalization, and resizable widths", () => {
  const sampleTree = [
    {
      path: "work",
      name: "work",
      isDir: true,
      children: [
        { path: "work/a.md", name: "a.md", isDir: false },
        { path: "work/b.md", name: "b.md", isDir: false },
      ],
    },
    { path: "workshop", name: "workshop", isDir: true, children: [{ path: "workshop/c.md", name: "c.md", isDir: false }] },
    { path: "readme.md", name: "readme.md", isDir: false },
  ];

  test("visibleTreePaths respects collapsed/expanded dirs and search filter", () => {
    expect(visibleTreePaths(sampleTree, {}, null)).toEqual(["work", "workshop", "readme.md"]);
    expect(visibleTreePaths(sampleTree, { work: true }, null)).toEqual(["work", "work/a.md", "work/b.md", "workshop", "readme.md"]);
    expect(visibleTreePaths(sampleTree, { work: true }, [{ path: "work/b.md", name: "b.md", isDir: false }])).toEqual(["work/b.md"]);
  });

  test("selectRange selects forward and backward ranges cleanly", () => {
    const visible = ["work", "work/a.md", "work/b.md", "workshop", "readme.md"];
    expect(selectRange(visible, "work/a.md", "workshop")).toEqual(["work/a.md", "work/b.md", "workshop"]);
    expect(selectRange(visible, "workshop", "work")).toEqual(["work", "work/a.md", "work/b.md", "workshop"]);
    expect(selectRange(visible, "missing", "readme.md")).toEqual(["readme.md"]);
  });

  test("normalizeDeleteTargets prunes descendants of selected dirs without colliding prefixes", () => {
    expect(normalizeDeleteTargets(["work/a.md", "work", "workshop/c.md", "work/b.md", "work"])).toEqual(["work", "workshop/c.md"]);
  });

  test("computePanelWidths preserves editor minimum width in narrow windows", () => {
    const wide = computePanelWidths({ containerWidth: 1000, sidebarOpen: true, outlineOpen: true, sidebarWidth: 280, outlineWidth: 220 });
    expect(wide).toEqual({ sidebar: 280, outline: 220 });

    const narrow = computePanelWidths({ containerWidth: 620, sidebarOpen: true, outlineOpen: true, sidebarWidth: 320, outlineWidth: 260 });
    expect(narrow.sidebar + narrow.outline + 20 + MIN_EDITOR_W).toBeLessThanOrEqual(620);
    expect(narrow.sidebar).toBeGreaterThanOrEqual(150);
    expect(narrow.outline).toBeGreaterThanOrEqual(130);

    const defaults = computePanelWidths({ containerWidth: 0, sidebarOpen: true, outlineOpen: true, sidebarWidth: 0, outlineWidth: 0 });
    expect(defaults).toEqual({ sidebar: DEFAULT_SIDEBAR_W, outline: DEFAULT_OUTLINE_W });
  });

  test("clampDragWidth respects bounds and other panel width", () => {
    expect(clampDragWidth({ which: "sidebar", rawWidth: 999, containerWidth: 700, otherWidth: 180, otherOpen: true })).toBe(700 - 20 - MIN_EDITOR_W - 180);
    expect(clampDragWidth({ which: "outline", rawWidth: 50, containerWidth: 700, otherWidth: 210, otherOpen: true })).toBe(130);
  });

  test("compileFileSearch supports substring, wildcards (* and ?), and regex", () => {
    const sub = compileFileSearch("周报", false)!;
    expect(sub.invalid).toBe(false);
    expect(sub.test("2026 周报.md")).toBe(true);
    expect(sub.test("笔记.md")).toBe(false);

    const globStar = compileFileSearch("笔记*", false)!;
    expect(globStar.test("笔记20.md")).toBe(true);
    expect(globStar.test("我的笔记20.md")).toBe(false);

    const globQuestion = compileFileSearch("*笔记?", false)!;
    expect(globQuestion.test("我的笔记3")).toBe(true);
    expect(globQuestion.test("我的笔记20")).toBe(false);

    const litRegex = compileFileSearch("/^笔记\\d+$/", false)!;
    expect(litRegex.invalid).toBe(false);
    expect(litRegex.test("笔记20")).toBe(true);
    expect(litRegex.test("笔记abc")).toBe(false);

    const forceRegex = compileFileSearch("笔记\\d+", true)!;
    expect(forceRegex.invalid).toBe(false);
    expect(forceRegex.test("我的笔记3")).toBe(true);

    const badRegex = compileFileSearch("[unclosed", true)!;
    expect(badRegex.invalid).toBe(true);
    expect(badRegex.test("anything")).toBe(false);
  });

  test("filterDirPaths and collectNestedDirs handle multi-selected and nested folders", () => {
    const tree = [
      {
        path: "A",
        name: "A",
        isDir: true,
        children: [
          { path: "A/A1", name: "A1", isDir: true, children: [{ path: "A/A1/note.md", name: "note.md", isDir: false }] },
          { path: "A/a.md", name: "a.md", isDir: false },
        ],
      },
      { path: "B", name: "B", isDir: true, children: [{ path: "B/B1", name: "B1", isDir: true, children: [] }] },
      { path: "root.md", name: "root.md", isDir: false },
    ];
    expect(filterDirPaths(tree, ["A", "root.md", "B"])).toEqual(["A", "B"]);
    expect(collectNestedDirs(tree, ["A", "B"])).toEqual(["A", "A/A1", "B", "B/B1"]);
  });

  test("sortTreeNodes orders stems naturally matching Windows Explorer", () => {
    const sorted = sortTreeNodes([
      { path: "2026-11-16 笔记 10.md", name: "2026-11-16 笔记 10.md", isDir: false },
      { path: "2026-11-16 笔记 3.md", name: "2026-11-16 笔记 3.md", isDir: false },
      { path: "2026-11-16 笔记.md", name: "2026-11-16 笔记.md", isDir: false },
      { path: "第10章", name: "第10章", isDir: true, children: [{ path: "第10章/20.md", name: "20.md", isDir: false }, { path: "第10章/3.md", name: "3.md", isDir: false }] },
      { path: "第2章", name: "第2章", isDir: true, children: [] },
    ]);
    expect(sorted.map((n) => n.name)).toEqual(["第2章", "第10章", "2026-11-16 笔记.md", "2026-11-16 笔记 3.md", "2026-11-16 笔记 10.md"]);
    expect(sorted[1]!.children!.map((c) => c.name)).toEqual(["3.md", "20.md"]);
  });

  test("outlineTree builds collapsible hierarchy preserving original flat index", () => {
    const flat = outlineOf("# A\n\n## A1\n\n#### A1a\n\n## A2\n\n# B\n");
    const roots = outlineTree(flat);
    expect(roots.length).toBe(2);
    expect(roots[0]!.heading.text).toBe("A");
    expect(roots[0]!.index).toBe(0);
    expect(roots[0]!.children.map((c) => [c.heading.text, c.index])).toEqual([["A1", 1], ["A2", 3]]);
    expect(roots[0]!.children[0]!.children.map((c) => [c.heading.text, c.index])).toEqual([["A1a", 2]]);
    expect(roots[1]!.heading.text).toBe("B");
    expect(roots[1]!.index).toBe(4);
  });

  test("applyBlankLinesToAst restores extra blank lines between blocks, at top, and at EOF", () => {
    const ast = {
      type: "root",
      children: [
        { type: "paragraph", position: { start: { line: 3 }, end: { line: 3 } }, children: [{ type: "text", value: "a" }] },
        { type: "paragraph", position: { start: { line: 6 }, end: { line: 6 } }, children: [{ type: "text", value: "b" }] },
      ],
    };
    applyBlankLinesToAst(ast as never, "\n\na\n\n\nb\n  \n\n");
    // 2 leading empty paras, a, 1 middle empty para, b, 2 trailing empty paras
    expect(ast.children.map((c) => c.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(ast.children[0]!.children).toEqual([]);
    expect(ast.children[1]!.children).toEqual([]);
    expect(ast.children[3]!.children).toEqual([]);
    expect(ast.children[5]!.children).toEqual([]);
    expect(ast.children[6]!.children).toEqual([]);
  });

  test("applyBlankLinesToAst handles pure-blank documents", () => {
    const empty = { type: "root", children: [] as unknown[] };
    applyBlankLinesToAst(empty as never, "\n\n");
    expect(empty.children.length).toBe(3);
  });

  test("matchStandaloneHtmlSnippet matches standalone closed/void HTML only", () => {
    expect(matchStandaloneHtmlSnippet('<div style="color:red">hi</div>')).toBe('<div style="color:red">hi</div>');
    expect(matchStandaloneHtmlSnippet("<br/>")).toBe("<br/>");
    expect(matchStandaloneHtmlSnippet("<!-- note -->")).toBe("<!-- note -->");
    expect(matchStandaloneHtmlSnippet("100 > 50 且 20 < 40 <div>")).toBeNull();
    expect(matchStandaloneHtmlSnippet("<script>alert(1)</script>")).toBeNull();
  });
});

test("outline labels display inline Markdown as text and keep the source offset", () => {
  const source = "intro\n\n## **bold** [link](https://example.org) ~~old~~ `code` &amp; <i>text</i>";
  expect(outlineOf(source)).toEqual([{ level: 2, text: "bold link old code & text", from: 7 }]);
});

describe("notes v2: timefmt, slash menu, block prefix & source helpers", () => {
  test("formatTime supports default seconds precision, custom tokens, and blank fallback", () => {
    const dt = new Date(2026, 2, 5, 9, 4, 7);
    expect(DEFAULT_TIME_FORMAT).toBe("YYYY-MM-DD HH:mm:ss");
    expect(formatTime(dt)).toBe("2026-03-05 09:04:07");
    expect(formatTime(dt, "   ")).toBe("2026-03-05 09:04:07");
    expect(formatTime(dt, "YY/M/D H:m:s ddd dddd")).toBe("26/3/5 9:4:7 周四 星期四");
  });

  test("matchBlockSlash and filterSlashItems trigger only at line start", () => {
    expect(matchBlockSlash("/", 1)).toEqual({ from: 0, query: "" });
    expect(matchBlockSlash("第一行\n/时间", 7)).toEqual({ from: 4, query: "时间" });
    expect(matchBlockSlash("https://example.com", 19)).toBeNull();
    expect(matchBlockSlash("foo/bar", 7)).toBeNull();
    expect(matchBlockSlash("/a b", 4)).toBeNull();

    expect(filterSlashItems("时间").some((i) => i.id === "time")).toBe(true);
    expect(filterSlashItems("time").some((i) => i.id === "time")).toBe(true);
    expect(filterSlashItems("shijian").some((i) => i.id === "time")).toBe(true);
  });

  test("parseBlockPrefix recognizes headings, quote, lists, tasks, paragraph, and rejects invalid", () => {
    expect(parseBlockPrefix("#")).toEqual({ kind: "heading", level: 1 });
    expect(parseBlockPrefix("###### ")).toEqual({ kind: "heading", level: 6 });
    expect(parseBlockPrefix("#######")).toBeNull();
    expect(parseBlockPrefix("> ")).toEqual({ kind: "blockquote" });
    expect(parseBlockPrefix("-")).toEqual({ kind: "bullet" });
    expect(parseBlockPrefix("*")).toEqual({ kind: "bullet" });
    expect(parseBlockPrefix("1.")).toEqual({ kind: "ordered" });
    expect(parseBlockPrefix("- [ ]")).toEqual({ kind: "task", checked: false });
    expect(parseBlockPrefix("- [x]")).toEqual({ kind: "task", checked: true });
    expect(parseBlockPrefix("  ")).toEqual({ kind: "paragraph" });
    expect(parseBlockPrefix("abc")).toBeNull();
  });

  test("source context menu helpers format, convert paragraphs, and build inserts", () => {
    const bold = applySourceFormat("hello world", 6, 11, "bold");
    expect(bold.insert).toBe("**world**");
    expect(bold.anchor).toBe(8);
    expect(bold.head).toBe(13);

    const cleared = applySourceFormat("**world** <u>hi</u> [a](https://x)", 0, 34, "clear");
    expect(cleared.insert).toBe("world hi a");

    const h2 = applySourceParagraph("- item", 2, 2, "h2");
    expect("".concat(h2.insert)).toBe("## item");
    const quote = applySourceParagraph("## item", 3, 3, "quote");
    expect(quote.insert).toBe("> item");
    const para = applySourceParagraph("> item", 2, 2, "text");
    expect(para.insert).toBe("item");

    const insertedTime = buildSourceInsert("time", DEFAULT_TIME_FORMAT, true);
    expect(insertedTime.insert).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("notes v3: rich outline inlines, cursor sync, highlight presets & extended inserts", () => {
  test("richOutlineOf preserves restrained inline styles and strips == / ^ / ~ markers", () => {
    const md = "## **加粗** ==重点== ~~废弃~~ `API` <u>下划线</u> H~2~O x^2^ [链接](https://a.com)";
    const list = richOutlineOf(md);
    expect(list.length).toBe(1);
    expect(list[0]!.text).toBe("加粗 重点 废弃 API 下划线 H2O x2 链接");
    const tags = list[0]!.inlines.filter((n) => n.type !== "text").map((n) => n.type);
    expect(tags).toEqual(["strong", "mark", "del", "code", "u", "sub", "sup"]);
    expect(outlineOf(md)[0]!.text).toBe("加粗 重点 废弃 API 下划线 H2O x2 链接");
  });

  test("anchorToSourceOffset and sourceOffsetToAnchor round-trip across frontmatter and blocks", () => {
    const doc = [
      "---",
      "title: 长文档",
      "---",
      "",
      "# 第一章",
      "",
      "这是一段普通文字，里面有 **加粗关键词** 和其他内容。",
      "",
      "- 列表条目一",
      "- 列表条目二",
      "",
      "## 第二章",
      "",
      "结尾段落用于定位测试。",
      "",
    ].join("\n");

    const targetIdx = doc.indexOf("加粗关键词");
    const anchor = sourceOffsetToAnchor(doc, targetIdx + 3);
    expect(anchor.blockIndex).toBe(1);
    const back = anchorToSourceOffset(doc, anchor);
    expect(Math.abs(back - (targetIdx + 3))).toBeLessThanOrEqual(3);

    const endTarget = doc.indexOf("定位测试");
    const endAnchor = sourceOffsetToAnchor(doc, endTarget);
    expect(endAnchor.blockIndex).toBe(4);
    const endBack = anchorToSourceOffset(doc, endAnchor);
    expect(Math.abs(endBack - endTarget)).toBeLessThanOrEqual(2);

    // 即使 blockIndex 因空段落发生偏移，凭借上下文片段仍能精准对齐原块
    const driftedOffset = anchorToSourceOffset(doc, { ...endAnchor, blockIndex: endAnchor.blockIndex + 2 });
    expect(Math.abs(driftedOffset - endTarget)).toBeLessThanOrEqual(2);
    expect(pickBestBlockIndex(["甲段", "乙段", "结尾段落用于定位测试。"], (s) => s, { ...endAnchor, blockIndex: 0 })).toBe(2);
  });

  test("extended source format/insert helpers and highlight presets work accurately", () => {
    expect(normalizeHighlightColor("green")).toBe("green");
    expect(normalizeHighlightColor("pink")).toBe("pink");
    expect(normalizeHighlightColor("invalid")).toBe(DEFAULT_HIGHLIGHT_COLOR);

    const mathFmt = applySourceFormat("a+b", 0, 3, "math");
    expect(mathFmt.insert).toBe("$a+b$");

    expect(nextFootnoteIndex("已有 [^1] 和 [^3]")).toBe(4);
    expect(nextLinkRefId("[ref]: https://a.com\n[ref2]: https://b.com")).toBe("ref3");

    const fn = buildSourceInsert("footnote", DEFAULT_TIME_FORMAT, false, "示例 [^2]");
    expect(fn.insert).toBe("[^3]");
    expect(fn.appendDoc).toBe("[^3]: 脚注内容");

    const img = buildSourceInsert("image", DEFAULT_TIME_FORMAT, false);
    expect(img.insert).toBe("![图片描述](https://)");
    expect(img.selectLen).toBe(8);

    const toc = buildSourceInsert("toc", DEFAULT_TIME_FORMAT, true);
    expect(toc.insert).toBe("[TOC]\n");

    expect(filterSlashItems("toc").some((i) => i.id === "toc")).toBe(true);
    expect(filterSlashItems("图像").some((i) => i.id === "image")).toBe(true);
    expect(filterSlashItems("脚注").some((i) => i.id === "footnote")).toBe(true);
  });
});


describe("notes v4: find/replace, custom highlight history, Typora shortcuts, panel bounds & image helpers", () => {
  test("findTextRanges supports case, wholeWord, regex, invalid regex, and group replacement", () => {
    const src = "Foo foo foobar FOO_1";
    expect(findTextRanges(src, { query: "foo", caseSensitive: false, wholeWord: false, regex: false }).matches.length).toBe(4);
    expect(findTextRanges(src, { query: "foo", caseSensitive: true, wholeWord: false, regex: false }).matches.length).toBe(2);
    expect(findTextRanges(src, { query: "foo", caseSensitive: false, wholeWord: true, regex: false }).matches.length).toBe(2);
    const rx = findTextRanges("id=12, id=345", { query: "id=(\\d+)", caseSensitive: false, wholeWord: false, regex: true });
    expect(rx.matches).toEqual([{ from: 0, to: 5 }, { from: 7, to: 13 }]);
    expect(expandReplacement("id=12", { query: "id=(\\d+)", caseSensitive: false, wholeWord: false, regex: true }, "[$1]")).toBe("[12]");
    expect(findTextRanges("abc", { query: "[", caseSensitive: false, wholeWord: false, regex: true }).error).toBeTruthy();
  });

  test("custom highlight hex normalization, history LRU, and RGBA resolution", () => {
    expect(normalizeHighlightColor("#0F8")).toBe("#00ff88");
    expect(normalizeHighlightColor("#fde047")).toBe("yellow");
    const vars = resolveHighlightVars("#00ff88");
    expect(vars.light).toBe("rgba(0, 255, 136, 0.56)");
    expect(vars.dark).toBe("rgba(0, 255, 136, 0.36)");

    let hist: string[] = [];
    hist = pushHighlightHistory(hist, "#fde047"); // preset ignored
    expect(hist).toEqual([]);
    for (const c of ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"]) {
      hist = pushHighlightHistory(hist, c, 5);
    }
    expect(hist).toEqual(["#666666", "#555555", "#444444", "#333333", "#222222"]);
    hist = pushHighlightHistory(hist, "#333333", 5);
    expect(hist[0]).toBe("#333333");
    expect(hist.length).toBe(5);
  });

  test("Typora shortcuts match Shift+[ / Shift+] physical keys, exclude Ctrl+0/=/−, and detect conflicts", () => {
    expect(defaultShortcuts.h1).toBe("Ctrl+1");
    expect(defaultShortcuts.codeBlock).toBe("Ctrl+Shift+K");
    expect(defaultShortcuts.orderedList).toBe("Ctrl+Shift+[");
    expect(defaultShortcuts.bulletList).toBe("Ctrl+Shift+]");
    expect(Object.values(defaultShortcuts)).not.toContain("Ctrl+0");
    expect(Object.values(defaultShortcuts)).not.toContain("Ctrl+=");
    expect(Object.values(defaultShortcuts)).not.toContain("Ctrl+-");

    const ev = { key: "{", code: "BracketLeft", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, isComposing: false };
    expect(shortcutOf(ev)).toBe("Ctrl+Shift+[");
    expect(matchShortcutAction(ev, defaultShortcuts)).toBe("orderedList");

    const indented = applySourceIndent("a\nb", 0, 3, "indent");
    expect(indented.insert).toBe("  a\n  b");
    const outdented = applySourceIndent("  a\n  b", 0, 7, "outdent");
    expect(outdented.insert).toBe("a\nb");

    const dup = findShortcutConflicts({ ...defaultShortcuts, h2: "Ctrl+1" });
    expect(dup.has("h1") && dup.has("h2")).toBe(true);
  });

  test("parameterized panel bounds clamp cleanly without breaking editor minimum width", () => {
    const b = normalizePanelBounds({ defaultWidth: 500, minWidth: 180, maxWidth: 420 }, { defaultWidth: 210, minWidth: 150, maxWidth: 380 });
    expect(b).toEqual({ defaultWidth: 420, minWidth: 180, maxWidth: 420 });
    const w = computePanelWidths({
      containerWidth: 1200,
      sidebarOpen: true,
      outlineOpen: true,
      sidebarWidth: 410,
      outlineWidth: 220,
      sidebarBounds: b,
    });
    expect(w.sidebar).toBe(410);
    expect(clampDragWidth({ which: "sidebar", rawWidth: 100, containerWidth: 1200, otherWidth: 200, otherOpen: true, bounds: b })).toBe(180);
  });

  test("image dir resolution, relative path security, filename sanitization & response URL extraction", () => {
    expect(resolveImageDir("./img/", "work/weekly.md")).toEqual({ storeDir: "work/img", mdPrefix: "./img/" });
    expect(resolveImageDir("./${filename}.assets/", "work/weekly.md")).toEqual({ storeDir: "work/weekly.assets", mdPrefix: "./weekly.assets/" });
    expect(resolveImageDir("/img/", "work/weekly.md")).toEqual({ storeDir: "img", mdPrefix: "../img/" });

    expect(resolveNoteRelativePath("work/weekly.md", "./img/a.png")).toBe("work/img/a.png");
    expect(resolveNoteRelativePath("work/weekly.md", "../../etc/passwd")).toBeNull();
    expect(resolveNoteRelativePath("work/weekly.md", "https://cdn.example.com/a.png")).toBeNull();

    expect(sanitizeImageName("架构图:v1/2", ".png")).toBe("架构图-v1-2.png");
    expect(buildImageFilename("photo.jpg", "image/jpeg", "timestamp", new Date(2026, 10, 19, 20, 35, 5))).toBe("20261119-203505.jpg");

    expect(extractUrlByPath({ data: { url: "https://cdn.a.com/1.png" } }, "data.url")).toBe("https://cdn.a.com/1.png");
    expect(extractUrlByPath({ result: ["https://cdn.a.com/2.png"] }, "result[0]")).toBe("https://cdn.a.com/2.png");
    expect(extractUrlByPath({ nested: { link: "https://cdn.a.com/3.png" } }, "")).toBe("https://cdn.a.com/3.png");
  });
});
