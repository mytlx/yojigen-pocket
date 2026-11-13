import { useEffect, useMemo, useState } from "preact/hooks";
import { CopyBtn, highlightJSON, useFocus } from "./ui";
import type { FeatureProps } from "./types";

function decodePart(part: string): unknown {
  let s = part.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const timeClaims: Record<string, string> = { exp: "过期时间", iat: "签发时间", nbf: "生效时间", auth_time: "认证时间" };

export function JwtTool({ input, ctx }: FeatureProps) {
  const [token, setToken] = useState(input);
  const area = useFocus<HTMLTextAreaElement>();
  useEffect(() => setToken(input), [input]);
  useEffect(() => ctx.remember(token), [token]);

  const parsed = useMemo(() => {
    const t = token.trim().replace(/^Bearer\s+/i, "");
    if (!t) return null;
    const parts = t.split(".");
    if (parts.length < 2) return { error: "JWT 应该是用点分隔的三段" };
    try {
      return { header: decodePart(parts[0]!), payload: decodePart(parts[1]!) as Record<string, unknown>, signature: parts[2] ?? "" };
    } catch {
      return { error: "无法解码：不是合法的 JWT" };
    }
  }, [token]);

  const payload = parsed && "payload" in parsed ? parsed.payload : null;
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : null;

  return (
    <div class="fx-page">
      <textarea
        ref={area}
        class="ui-area is-mono fx-jwt-input"
        placeholder="粘贴 JWT（可以带 Bearer 前缀）"
        value={token}
        spellcheck={false}
        onInput={(e) => setToken((e.target as HTMLTextAreaElement).value)}
      />
      {parsed && "error" in parsed && <div class="fx-error-line">{parsed.error}</div>}
      {parsed && "header" in parsed && (
        <div class="fx-jwt fx-appear">
          <div class="fx-jwt-claims">
            {exp !== null && <span class={`fx-badge ${exp < Date.now() ? "is-bad" : "is-good"}`}>{exp < Date.now() ? "已过期" : "未过期"}</span>}
            {Object.entries(timeClaims).map(([k, label]) =>
              typeof payload?.[k] === "number" ? (
                <span class="fx-meta" key={k}>
                  {label}：{new Date((payload[k] as number) * 1000).toLocaleString()}
                </span>
              ) : null,
            )}
          </div>
          <div class="fx-split fx-grow-1">
            <div class="fx-out">
              <div class="fx-out-title">头部</div>
              <pre class="fx-out-text fx-code" dangerouslySetInnerHTML={{ __html: highlightJSON(JSON.stringify(parsed.header, null, 2)) }} />
            </div>
            <div class="fx-out">
              <div class="fx-out-title">
                载荷 <span class="fx-spacer" /> <CopyBtn text={JSON.stringify(parsed.payload, null, 2)} copy={ctx.copy} />
              </div>
              <pre class="fx-out-text fx-code" dangerouslySetInnerHTML={{ __html: highlightJSON(JSON.stringify(parsed.payload, null, 2)) }} />
            </div>
          </div>
          <div class="fx-meta">签名没有校验：这里只解码，不需要密钥。</div>
        </div>
      )}
    </div>
  );
}
