import { useEffect, useMemo, useState } from "preact/hooks";
import { CopyBtn, useFocus } from "./ui";
import type { FeatureProps } from "./types";

export function UrlTool({ input, ctx }: FeatureProps) {
  const [text, setText] = useState(input);
  const field = useFocus<HTMLInputElement>();
  useEffect(() => setText(input), [input]);
  useEffect(() => ctx.remember(text), [text]);

  const parsed = useMemo(() => {
    const s = text.trim();
    if (!s) return null;
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s);
    } catch {
      return "error" as const;
    }
  }, [text]);

  const params = parsed && parsed !== "error" ? Array.from(parsed.searchParams.entries()) : [];
  const parts =
    parsed && parsed !== "error"
      ? [
          ["协议", parsed.protocol.replace(/:$/, "")],
          ["主机", parsed.hostname],
          ["端口", parsed.port || "（默认）"],
          ["路径", decodeURIComponent(parsed.pathname)],
          ["锚点", decodeURIComponent(parsed.hash.replace(/^#/, ""))],
          ["来源", parsed.origin],
        ].filter(([, v]) => v)
      : [];

  return (
    <div class="fx-page">
      <input
        ref={field}
        class="ui-input is-mono fx-input-lg"
        placeholder="粘贴网址，例如 https://example.com/search?q=口袋&page=2#top"
        value={text}
        spellcheck={false}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
      />
      {parsed === "error" && <div class="fx-error-line">不是合法的网址</div>}
      {parsed && parsed !== "error" && (
        <div class="fx-scroll fx-grow-1 fx-appear">
          <div class="fx-rows">
            {parts.map(([k, v]) => (
              <div class="fx-kv" key={k}>
                <span class="fx-kv-key">{k}</span>
                <code class="fx-kv-val">{v}</code>
                <CopyBtn text={v!} copy={ctx.copy} />
              </div>
            ))}
          </div>
          {params.length > 0 && (
            <>
              <div class="fx-out-title fx-section-title">
                查询参数 · {params.length}
                <span class="fx-spacer" />
                <CopyBtn text={JSON.stringify(Object.fromEntries(params), null, 2)} copy={ctx.copy} label="复制为 JSON" />
              </div>
              <div class="fx-rows">
                {params.map(([k, v], i) => (
                  <div class="fx-kv" key={i}>
                    <span class="fx-kv-key is-mono">{k}</span>
                    <code class="fx-kv-val">{v}</code>
                    <CopyBtn text={v} copy={ctx.copy} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
