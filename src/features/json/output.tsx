import { useLayoutEffect, useRef } from "preact/hooks";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, placeholder } from "@codemirror/view";
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

export function Output({
  text,
  mode,
  wrap = false,
}: {
  text: string;
  mode: Mode;
  wrap?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    view = useRef<EditorView>(),
    wrapComp = useRef(new Compartment());

  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: root.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({
            "aria-label": "转换结果",
            spellcheck: "false",
          }),
          placeholder("等待有效输入以生成转换结果…"),
          mode === "xml" ? xml() : mode === "unescape" ? [] : json(),
          syntaxHighlighting(palette),
        ],
      }),
    });
    view.current = editor;
    return () => editor.destroy();
  }, [mode]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: wrapComp.current.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);

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
