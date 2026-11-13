import { useEffect, useState } from "preact/hooks";
import { onFileDrop } from "mygo-runtime";
import { FileUp } from "lucide-preact";
import { DevTools, type FileHash } from "../mygo";
import { Btn, CopyBtn, Toggle, formatBytes, useDebounced, useFocus } from "./ui";
import type { FeatureProps } from "./types";

const algos = [
  { id: "md5", label: "MD5" },
  { id: "sha1", label: "SHA-1" },
  { id: "sha256", label: "SHA-256" },
  { id: "sha512", label: "SHA-512" },
];

export function HashTool({ input, args, ctx }: FeatureProps) {
  const [text, setText] = useState(input);
  const [upper, setUpper] = useState(false);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [file, setFile] = useState<FileHash | null>(null);
  const area = useFocus<HTMLTextAreaElement>();
  const debounced = useDebounced(text, 120);
  const focus = args.algo ?? "";

  useEffect(() => setText(input), [input]);
  useEffect(() => {
    if (args.file) void DevTools.hashPath(args.file).then((f) => f && setFile(f), (e: Error) => ctx.toast(e.message, true));
  }, [args.file]);
  useEffect(() => ctx.remember(text), [text]);
  useEffect(() => {
    if (file) return;
    void DevTools.hash(debounced).then(setHashes);
  }, [debounced, file]);
  useEffect(
    () =>
      onFileDrop(({ paths }) => {
        if (paths[0]) void DevTools.hashPath(paths[0]).then((f) => f && setFile(f), (e: Error) => ctx.toast(e.message, true));
      }),
    [ctx],
  );

  const shown = file ? file.hashes : hashes;
  const fmt = (v: string) => (upper ? v.toUpperCase() : v);

  return (
    <div class="fx-page">
      {file ? (
        <div class="fx-file">
          <FileUp size={18} />
          <div class="fx-file-name">
            <b>{file.name}</b>
            <span>{formatBytes(file.size)}</span>
          </div>
          <Btn small onClick={() => setFile(null)}>
            改为计算文字
          </Btn>
        </div>
      ) : (
        <textarea
          ref={area}
          class="ui-area fx-grow-1"
          placeholder="输入要计算哈希的文字，或把文件拖进来"
          value={text}
          spellcheck={false}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      )}
      <div class="fx-toolbar">
        <Btn small onClick={() => void DevTools.hashFile().then((f) => f && setFile(f), (e: Error) => ctx.toast(e.message, true))}>
          <FileUp size={14} /> 选择文件
        </Btn>
        <span class="fx-spacer" />
        <label class="fx-inline">
          大写 <Toggle checked={upper} onChange={setUpper} label="大写" />
        </label>
      </div>
      <div class="fx-rows">
        {algos.map((a) => (
          <div key={a.id} class={`fx-kv${focus === a.id ? " is-focus" : ""}`}>
            <span class="fx-kv-key">{a.label}</span>
            <code class="fx-kv-val">{shown[a.id] ? fmt(shown[a.id]!) : ""}</code>
            <CopyBtn text={shown[a.id] ? fmt(shown[a.id]!) : ""} copy={ctx.copy} />
          </div>
        ))}
      </div>
    </div>
  );
}
