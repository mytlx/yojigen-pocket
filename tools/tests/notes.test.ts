import { describe, expect, test } from "bun:test";
import { splitFrontmatter, joinFrontmatter } from "../../extensions/editors/src/notes/frontmatter";
import { outlineOf } from "../../extensions/editors/src/notes/outline";
import { defaultShortcuts, insertLine, lineAction, shortcutOf } from "../../extensions/editors/src/notes/shortcuts";
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
