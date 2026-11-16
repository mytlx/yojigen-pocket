import { describe, expect, test } from "bun:test";
import { splitFrontmatter, joinFrontmatter } from "../../extensions/editors/src/notes/frontmatter";
import { applyBlankLinesToAst } from "../../extensions/editors/src/notes/blanklines";
import { matchStandaloneHtmlSnippet } from "../../extensions/editors/src/notes/liveinline";
import { outlineOf, outlineTree } from "../../extensions/editors/src/notes/outline";
import { defaultShortcuts, insertLine, lineAction, shortcutOf } from "../../extensions/editors/src/notes/shortcuts";
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
