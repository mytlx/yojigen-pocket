import { useEffect, useMemo, useState } from "preact/hooks";
import { ArrowLeftRight } from "lucide-preact";
import { Btn, CopyBtn, Seg, useFocus } from "./ui";
import type { FeatureProps } from "./types";

type Mode = "base64" | "url" | "unicode" | "html" | "hex";
type Dir = "encode" | "decode";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: false });

function b64encode(s: string) {
  const bytes = utf8.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(s: string) {
  let t = s.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  return fromUtf8.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function unicodeEncode(s: string) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) out += ch;
    else if (cp > 0xffff) out += `\\u{${cp.toString(16)}}`;
    else out += `\\u${cp.toString(16).padStart(4, "0")}`;
  }
  return out;
}
function unicodeDecode(s: string) {
  return s
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
function htmlEncode(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function htmlDecode(s: string) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${s.replace(/</g, "&lt;")}`, "text/html");
  return doc.body.textContent ?? "";
}
function hexEncode(s: string) {
  return Array.from(utf8.encode(s), (b) => b.toString(16).padStart(2, "0")).join(" ");
}
function hexDecode(s: string) {
  const clean = s.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2) throw new Error("十六进制的位数应为偶数");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return fromUtf8.decode(bytes);
}

const impl: Record<Mode, Record<Dir, (s: string) => string>> = {
  base64: { encode: b64encode, decode: b64decode },
  url: { encode: encodeURIComponent, decode: (s) => decodeURIComponent(s.replace(/\+/g, " ")) },
  unicode: { encode: unicodeEncode, decode: unicodeDecode },
  html: { encode: htmlEncode, decode: htmlDecode },
  hex: { encode: hexEncode, decode: hexDecode },
};

export function CodecTool({ input, args, ctx }: FeatureProps) {
  const [mode, setMode] = useState<Mode>((args.mode as Mode) || "base64");
  const [dir, setDir] = useState<Dir>((args.dir as Dir) || "encode");
  const [text, setText] = useState(input);
  const area = useFocus<HTMLTextAreaElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);
  useEffect(() => {
    if (args.mode) setMode(args.mode as Mode);
    if (args.dir) setDir(args.dir as Dir);
  }, [args.mode, args.dir]);

  const result = useMemo(() => {
    if (!text) return { out: "", error: "" };
    try {
      return { out: impl[mode][dir](text), error: "" };
    } catch (e) {
      return { out: "", error: dir === "decode" ? "无法解码：内容不是合法的 " + mode : String(e) };
    }
  }, [text, mode, dir]);

  return (
    <div class="fx-page">
      <div class="fx-toolbar">
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { value: "base64", label: "Base64" },
            { value: "url", label: "URL" },
            { value: "unicode", label: "Unicode" },
            { value: "html", label: "HTML 实体" },
            { value: "hex", label: "十六进制" },
          ]}
        />
        <span class="fx-spacer" />
        <Seg value={dir} onChange={setDir} options={[{ value: "encode", label: "编码" }, { value: "decode", label: "解码" }]} />
      </div>
      <div class="fx-split fx-grow-1">
        <textarea
          ref={area}
          class="ui-area is-mono"
          placeholder={dir === "encode" ? "输入原文" : "输入要解码的内容"}
          value={text}
          spellcheck={false}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <div class="fx-out">
          <pre class={`fx-out-text${result.error ? " is-error" : ""}`}>{result.error || result.out || <span class="fx-hint">结果会显示在这里</span>}</pre>
          <div class="fx-out-bar">
            <Btn
              small
              ghost
              title="把结果换到左边，并切换编码/解码"
              disabled={!result.out}
              onClick={() => {
                setText(result.out);
                setDir(dir === "encode" ? "decode" : "encode");
              }}
            >
              <ArrowLeftRight size={14} /> 交换
            </Btn>
            <CopyBtn text={result.out} copy={ctx.copy} label="复制" />
          </div>
        </div>
      </div>
    </div>
  );
}
