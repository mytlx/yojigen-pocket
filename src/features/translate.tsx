import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Channel } from "mygo-runtime";
import { ArrowLeftRight, Settings2, Square, Volume2 } from "lucide-preact";
import { Launcher, Translator, events, type Language, type Result } from "../mygo";
import { Btn, CopyBtn, useFocus } from "./ui";
import type { FeatureProps } from "./types";
import { speak, stopSpeaking } from "../shared/speech";

const providers = [
  { value: "claude", label: "Claude" },
  { value: "openai", label: "OpenAI 兼容" },
  { value: "youdao", label: "有道" },
  { value: "baidu", label: "百度" },
];

function guessLang(text: string) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const kana = (text.match(/[぀-ヿ]/g) ?? []).length;
  const hangul = (text.match(/[가-힯]/g) ?? []).length;
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  return han / Math.max(text.replace(/\s/g, "").length, 1) > 0.2 ? "zh" : "en";
}

export function TranslateTool({ input, ctx }: FeatureProps) {
  const [text, setText] = useState(input);
  const [langs, setLangs] = useState<Language[]>([]);
  const [from, setFrom] = useState("auto");
  const [to, setTo] = useState("auto");
  const [provider, setProvider] = useState("claude");
  const autoSpeak = useRef(false);
  const [result, setResult] = useState<Result | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState<"" | "src" | "dst">("");
  const area = useFocus<HTMLTextAreaElement>();
  const channel = useRef<Channel<unknown> | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    (source = text, opts: { from?: string; to?: string; provider?: string } = {}) => {
      const q = source.trim();
      channel.current?.close();
      if (!q) {
        setResult(null);
        setPartial("");
        setError("");
        return;
      }
      const my = ++seq.current;
      setBusy(true);
      setError("");
      setPartial("");
      setResult(null);
      const ch = new Channel<{ kind: string; text?: string; result?: Result }>((ev) => {
        if (my !== seq.current) return;
        if (ev.kind === "delta") setPartial((p) => p + (ev.text ?? ""));
        if (ev.kind === "result" && ev.result) {
          setResult(ev.result);
          if (autoSpeak.current && ev.result.text) {
            setSpeaking("dst");
            void speak(ev.result.text, ev.result.to, { onEnd: () => setSpeaking(""), onNote: (n) => ctx.toast(n, true) }).catch(() => setSpeaking(""));
          }
        }
      });
      channel.current = ch as unknown as Channel<unknown>;
      Translator.translate({ text: q, from: opts.from ?? from, to: opts.to ?? to, provider: opts.provider ?? provider }, ch)
        .catch((e: Error) => my === seq.current && setError(e.message))
        .finally(() => my === seq.current && setBusy(false));
    },
    [text, from, to, provider],
  );

  useEffect(() => {
    void Translator.languages().then(setLangs);
    void Launcher.config().then((v) => {
      const t = v.config.translate;
      setFrom(t.from);
      setTo(t.to);
      setProvider(t.provider);
      autoSpeak.current = t.autoSpeak;
      if (input.trim()) run(input, { from: t.from, to: t.to, provider: t.provider });
    });
    const off = events.configChanged.on((v) => {
      autoSpeak.current = v.config.translate.autoSpeak;
    });
    return () => {
      off();
      channel.current?.close();
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    if (input && input !== text) {
      setText(input);
      run(input);
    }
  }, [input]);

  useEffect(() => ctx.remember(text), [text]);
  const output = result?.text ?? partial;
  const srcLang = from === "auto" ? guessLang(text) : from;
  const dstLang = result?.to ?? (to === "auto" ? (srcLang === "zh" ? "en" : "zh") : to);

  const toggleSpeak = (which: "src" | "dst") => {
    if (speaking === which) {
      stopSpeaking();
      setSpeaking("");
      return;
    }
    setSpeaking(which);
    const content = which === "src" ? text : output;
    void speak(content, which === "src" ? srcLang : dstLang, { onEnd: () => setSpeaking(""), onNote: (n) => ctx.toast(n, true) }).catch((e: Error) => {
      setSpeaking("");
      ctx.toast(e.message, true);
    });
  };

  return (
    <div class="fx-page">
      <div class="fx-toolbar">
        <select class="ui-select" aria-label="原文语言" value={from} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setFrom(v); run(text, { from: v }); }}>
          {langs.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <Btn small ghost icon title="交换语言" disabled={from === "auto"} onClick={() => { const f = to === "auto" ? "auto" : to; setFrom(f); setTo(from); run(text, { from: f, to: from }); }}>
          <ArrowLeftRight size={14} />
        </Btn>
        <select class="ui-select" aria-label="目标语言" value={to} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTo(v); run(text, { to: v }); }}>
          {langs.map((l) => <option key={l.code} value={l.code}>{l.code === "auto" ? "自动（中↔英）" : l.name}</option>)}
        </select>
        <span class="fx-spacer" />
        <select class="ui-select" aria-label="翻译服务" value={provider} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setProvider(v); run(text, { provider: v }); }}>
          {providers.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <Btn small ghost icon title="翻译和发音设置" onClick={() => ctx.openSettings("translate")}>
          <Settings2 size={15} />
        </Btn>
      </div>
      <div class="fx-split fx-grow-1">
        <div class="fx-out fx-src">
          <textarea
            ref={area}
            class="ui-area fx-translate-src"
            placeholder="输入要翻译的文字，回车翻译（Shift+回车换行）"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                run();
              }
            }}
          />
          <div class="fx-out-bar">
            <Btn small ghost icon title={speaking === "src" ? "停止" : "朗读原文"} disabled={!text.trim()} on={speaking === "src"} onClick={() => toggleSpeak("src")}>
              {speaking === "src" ? <Square size={13} /> : <Volume2 size={15} />}
            </Btn>
            <span class="fx-meta">{Array.from(text).length} 字</span>
            <span class="fx-spacer" />
            <Btn small primary disabled={!text.trim() || busy} onClick={() => run()}>
              {busy ? <span class="ui-spinner" /> : null} 翻译
            </Btn>
          </div>
        </div>
        <div class={`fx-out fx-dst${busy && !output ? " is-loading" : ""}`}>
          {error ? (
            <div class="fx-translate-error">
              <p>{error}</p>
              {error.includes("设置") && <Btn small onClick={() => ctx.openSettings("translate")}>去设置</Btn>}
            </div>
          ) : (
            <div class="fx-out-text is-wrap fx-translation" key={result ? "done" : "streaming"}>
              {output || (busy ? <span class="fx-hint">翻译中…</span> : <span class="fx-hint">译文会显示在这里</span>)}
              {result?.phonetic && <div class="fx-phonetic">{result.phonetic}</div>}
              {result?.explains && result.explains.length > 0 && (
                <ul class="fx-explains">
                  {result.explains.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
          <div class="fx-out-bar">
            <Btn small ghost icon title={speaking === "dst" ? "停止" : "朗读译文"} disabled={!output} on={speaking === "dst"} onClick={() => toggleSpeak("dst")}>
              {speaking === "dst" ? <Square size={13} /> : <Volume2 size={15} />}
            </Btn>
            {result && <span class="fx-meta">{providers.find((p) => p.value === result.provider)?.label}</span>}
            <span class="fx-spacer" />
            <CopyBtn text={output} copy={ctx.copy} label="复制译文" />
          </div>
        </div>
      </div>
    </div>
  );
}
