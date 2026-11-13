import { useCallback, useEffect, useState } from "preact/hooks";
import { onFileDrop } from "mygo-runtime";
import { Clipboard, ImageUp, Languages, ScanText, ShieldAlert } from "lucide-preact";
import { OCR, Settings, type OcrResult } from "../mygo";
import { Icon } from "../shared/icons";
import { Btn, CopyBtn, Empty } from "./ui";
import type { FeatureProps } from "./types";

export function OcrTool({ args, ctx }: FeatureProps) {
  const [image, setImage] = useState(args.image ?? "");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<OcrResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(args.error ?? "");
  const [allowed, setAllowed] = useState(true);

  const recognize = useCallback(async (path: string) => {
    if (!path) return;
    setImage(path);
    setUrl(await OCR.imageURL(path));
    setBusy(true);
    setError("");
    setText("");
    setResult(null);
    try {
      const r = await OCR.recognize(path);
      setResult(r);
      setText(r.text);
      if (!r.text.trim()) setError("没有识别到文字。可以把要识别的区域截大一点，或在设置里换成大模型识别");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void OCR.permission().then(setAllowed);
    if (args.image && !args.error) void recognize(args.image);
    else if (args.image) void OCR.imageURL(args.image).then((u) => (setImage(args.image!), setUrl(u)));
    return onFileDrop(({ paths }) => {
      const p = paths.find((x) => /\.(png|jpe?g|gif|bmp|webp|tiff?|heic)$/i.test(x));
      if (p) void recognize(p);
    });
  }, []);
  useEffect(() => {
    if (args.image && args.image !== image) void recognize(args.image);
  }, [args.image]);

  const capture = async () => {
    try {
      const p = await OCR.capture();
      if (p) void recognize(p);
    } catch (e) {
      setError((e as Error).message);
      void OCR.permission().then(setAllowed);
    }
  };
  const fromClipboard = async () => {
    const p = await OCR.clipboardImage();
    if (p) void recognize(p);
    else ctx.toast("剪贴板里没有图片", true);
  };
  const pick = async () => {
    const p = await OCR.pickImage();
    if (p) void recognize(p);
  };

  const actions = (
    <div class="fx-toolbar fx-ocr-actions">
      <Btn primary onClick={() => void capture()}>
        <ScanText size={15} /> 截图识别
      </Btn>
      <Btn onClick={() => void fromClipboard()}>
        <Clipboard size={15} /> 识别剪贴板图片
      </Btn>
      <Btn onClick={() => void pick()}>
        <ImageUp size={15} /> 选择图片
      </Btn>
    </div>
  );

  const permission = !allowed && (
    <div class="fx-warn">
      <ShieldAlert size={15} />
      <span>截图需要「屏幕录制」权限：在系统设置里允许本应用，然后重启。识别剪贴板里的图片不需要这个权限。</span>
      <Btn small onClick={() => void OCR.requestPermission()}>去授权</Btn>
      <Btn small onClick={() => void Settings.relaunch()}>重启应用</Btn>
    </div>
  );

  if (!image) {
    return (
      <div class="fx-page">
        <Empty icon={<Icon icon="svg:scan-text" size={52} />} title="识别图片里的文字" desc="截一块屏幕、用剪贴板里的图片，或把图片拖进来。默认用系统自带的离线识别，可以在设置里换成大模型。">
          {actions}
          {error && !(permission && error.includes("屏幕录制")) && <div class="fx-error-line">{error}</div>}
          {permission}
        </Empty>
      </div>
    );
  }

  return (
    <div class="fx-page">
      <div class="fx-split fx-grow-1 fx-ocr">
        <div class="fx-ocr-image">{url && <img src={url} alt="" draggable={false} />}</div>
        <div class="fx-out">
          {busy ? (
            <div class="fx-ocr-busy">
              <span class="ui-spinner" /> 正在识别…
            </div>
          ) : (
            <textarea class="ui-area fx-ocr-text" value={text} placeholder={error || "识别结果"} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          )}
          <div class="fx-out-bar">
            <span class={error ? "fx-error-text" : "fx-meta"}>{error || (result ? `${Array.from(text).length} 字 · ${result.engine === "system" ? "系统离线识别" : "大模型识别"}` : "")}</span>
            <span class="fx-spacer" />
            <Btn small disabled={!text.trim()} onClick={() => ctx.open("translate", text)}>
              <Languages size={14} /> 翻译
            </Btn>
            <CopyBtn text={text} copy={ctx.copy} label="复制" />
          </div>
        </div>
      </div>
      {permission}
      {actions}
    </div>
  );
}
