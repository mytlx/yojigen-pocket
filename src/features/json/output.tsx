import { useLayoutEffect, useRef } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { tags } from "@lezer/highlight";
import type { Mode } from "./document";
const palette = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName], class: "jx-token-key" },
  { tag: [tags.string, tags.attributeValue], class: "jx-token-string" },
  { tag: tags.number, class: "jx-token-number" },
  { tag: [tags.bool, tags.null, tags.tagName], class: "jx-token-literal" },
  { tag: tags.punctuation, class: "jx-token-punctuation" },
]);
export function Output({ text, mode }: { text: string; mode: Mode }) {
  const root = useRef<HTMLDivElement>(null),
    view = useRef<EditorView>();
  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: root.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({
            "aria-label": "转换结果",
            spellcheck: "false",
          }),
          mode === "xml" ? xml() : mode === "unescape" ? [] : json(),
          syntaxHighlighting(palette),
        ],
      }),
    });
    view.current = editor;
    return () => editor.destroy();
  }, [mode]);
  const previous = useRef(text);
  useLayoutEffect(() => {
    const v = view.current;
    if (v && previous.current !== text)
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: text },
      });
    previous.current = text;
  }, [text]);
  return <div class="jx-editor jx-result" ref={root} />;
}
