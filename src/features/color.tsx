import { useEffect, useMemo, useState } from "preact/hooks";
import { CopyBtn, useFocus } from "./ui";
import type { FeatureProps } from "./types";

type RGB = [number, number, number];

/** 解析出的颜色；alpha 没写时是 undefined，调用方可以保留原来的透明度。 */
export interface Parsed {
  rgb: RGB;
  alpha?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 透明度的写法：0.5 或 50%。 */
function parseAlpha(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const v = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
  return Number.isFinite(v) ? clamp(v, 0, 1) : undefined;
}

/**
 * 解析颜色，带透明度：#rgb、#rgba、#rrggbb、#rrggbbaa、rgb()/rgba()、hsl()/hsla()
 * （逗号写法和空格加斜杠的新写法都认），以及颜色名。
 */
export function parseColor(input: string): Parsed | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    const h = m[1]!.length <= 4 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
    const n = parseInt(h.slice(0, 6), 16);
    const rgb: RGB = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return h.length === 8 ? { rgb, alpha: Math.round((parseInt(h.slice(6), 16) / 255) * 1000) / 1000 } : { rgb };
  }
  const num = "([\\d.]+%?)";
  const sep = "(?:\\s*,\\s*|\\s+)";
  const tail = `(?:\\s*[,/]\\s*${num})?\\s*\\)?$`;
  m = new RegExp(`^rgba?\\(\\s*${num}${sep}${num}${sep}${num}${tail}`).exec(s);
  if (m) {
    const ch = (v: string) => clamp(Math.round(v.endsWith("%") ? (Number(v.slice(0, -1)) / 100) * 255 : Number(v)), 0, 255);
    return { rgb: [ch(m[1]!), ch(m[2]!), ch(m[3]!)], alpha: parseAlpha(m[4]) };
  }
  m = new RegExp(`^hsla?\\(\\s*([\\d.]+)(?:deg)?${sep}([\\d.]+)%${sep}([\\d.]+)%${tail}`).exec(s);
  if (m) return { rgb: hslToRgb(Number(m[1]) % 360, clamp(Number(m[2]) / 100, 0, 1), clamp(Number(m[3]) / 100, 0, 1)), alpha: parseAlpha(m[4]) };
  if (s === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const probe = document.createElement("span");
  probe.style.color = s;
  if (!probe.style.color) return null;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const r = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(c);
  return r ? { rgb: [Number(r[1]), Number(r[2]), Number(r[3])], alpha: parseAlpha(r[4]) } : null;
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHsl([r, g, b]: RGB) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

const hex = (rgb: RGB) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

function luminance(rgb: RGB) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
/** 透明度写成小数，最多三位，去掉多余的零。 */
const alphaText = (a: number) => String(Math.round(a * 1000) / 1000);
/** 半透明的颜色叠在一个底色上是什么颜色。 */
const flatten = (rgb: RGB, a: number, under: RGB): RGB => rgb.map((v, i) => Math.round(v * a + under[i]! * (1 - a))) as RGB;

export function ColorTool({ input, ctx }: FeatureProps) {
  const [text, setText] = useState(input || "#2f6bff");
  const [rgb, setRgb] = useState<RGB>(() => parseColor(input)?.rgb ?? [47, 107, 255]);
  const [alpha, setAlpha] = useState(() => parseColor(input)?.alpha ?? 1);
  const field = useFocus<HTMLInputElement>();
  useEffect(() => {
    if (input) setText(input);
  }, [input]);
  useEffect(() => ctx.remember(text), [text]);
  useEffect(() => {
    const c = parseColor(text);
    if (!c) return;
    setRgb(c.rgb);
    // 输入里没写透明度就保留滑块上的值，免得改个色值透明度被冲掉。
    if (c.alpha !== undefined) setAlpha(c.alpha);
  }, [text]);

  const hsl = useMemo(() => rgbToHsl(rgb), [rgb]);
  const opaque = alpha >= 1;
  const a = alphaText(alpha);
  const pct = `${Math.round(alpha * 100)}%`;
  const hex8 = hex(rgb) + hex2(alpha * 255);
  const rows = [
    ["HEX", opaque ? hex(rgb) : hex8],
    ["RGB", opaque ? `rgb(${rgb.join(", ")})` : `rgba(${rgb.join(", ")}, ${a})`],
    ["HSL", opaque ? `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)` : `hsla(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%, ${a})`],
    ["CSS 新写法", opaque ? `rgb(${rgb.join(" ")})` : `rgb(${rgb.join(" ")} / ${pct})`],
    ["Android", `#${hex2(alpha * 255)}${hex(rgb).slice(1)}`.toUpperCase()],
    ["小数", [...rgb.map((v) => (v / 255).toFixed(3)), ...(opaque ? [] : [alpha.toFixed(3)])].join(", ")],
  ];
  if (!opaque) {
    rows.push(["叠在白底上", hex(flatten(rgb, alpha, [255, 255, 255]))], ["叠在黑底上", hex(flatten(rgb, alpha, [0, 0, 0]))]);
  }
  // 对比度按实际看到的颜色算：半透明时先叠到白底上。
  const seen = flatten(rgb, alpha, [255, 255, 255]);
  const cw = contrast(seen, [255, 255, 255]);
  const cb = contrast(seen, [0, 0, 0]);
  const css = `rgba(${rgb.join(", ")}, ${a})`;

  return (
    <div class="fx-page fx-color">
      <div class="fx-color-top">
        <label class="fx-swatch" title="点击取色">
          <span class="fx-swatch-fill" style={{ background: css }} />
          <input type="color" value={hex(rgb)} onInput={(e) => setText(opaque ? (e.target as HTMLInputElement).value : (e.target as HTMLInputElement).value + hex2(alpha * 255))} />
        </label>
        <div class="fx-color-side">
          <input
            ref={field}
            class={`ui-input is-mono fx-input-lg${text && !parseColor(text) ? " is-invalid" : ""}`}
            placeholder="#2f6bff80、rgba(47,107,255,0.5)、hsl(… / 50%)、颜色名"
            value={text}
            spellcheck={false}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <label class="fx-alpha">
            <span class="fx-meta">透明度</span>
            <span class="fx-alpha-track">
              <span class="fx-alpha-grad" style={{ background: `linear-gradient(90deg, rgba(${rgb.join(",")},0), rgb(${rgb.join(",")}))` }} />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(alpha * 100)}
                aria-label="透明度"
                onInput={(e) => setAlpha(Number((e.target as HTMLInputElement).value) / 100)}
              />
            </span>
            <input
              class="ui-input is-mono fx-alpha-num"
              type="number"
              min={0}
              max={100}
              value={Math.round(alpha * 100)}
              aria-label="透明度百分比"
              onInput={(e) => setAlpha(clamp(Number((e.target as HTMLInputElement).value) || 0, 0, 100) / 100)}
            />
            <span class="fx-meta">%</span>
          </label>
          <div class="fx-contrast">
            <span style={{ background: hex(seen), color: "#fff" }}>白字 {cw.toFixed(2)}</span>
            <span style={{ background: hex(seen), color: "#000" }}>黑字 {cb.toFixed(2)}</span>
            <span class="fx-meta">对比度 ≥ 4.5 适合正文{opaque ? "" : "（按叠在白底上算）"}</span>
          </div>
        </div>
      </div>
      <div class="fx-rows">
        {rows.map(([k, v]) => (
          <div class="fx-kv" key={k}>
            <span class="fx-kv-key">{k}</span>
            <code class="fx-kv-val">{v}</code>
            <CopyBtn text={v!} copy={ctx.copy} />
          </div>
        ))}
      </div>
    </div>
  );
}
