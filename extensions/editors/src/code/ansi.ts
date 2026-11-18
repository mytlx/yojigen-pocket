/**
 * 终端的颜色码（ANSI 转义序列）。
 *
 * 很多程序发现输出不是终端也照样带颜色，PowerShell 7 的表头就是：`ESC[32;1m总进程数ESC[0m`。
 * 原样显示出来是一堆 [32;1m。这里把颜色和粗体认出来、画成对应的样式，其余的控制序列
 * （移动光标、清屏、设置标题）直接丢掉。
 */
export interface AnsiSpan {
  text: string;
  /** 类名，例如 "ansi-green ansi-bold"。 */
  cls: string;
  /** 256 色 / 真彩色时直接给颜色值。 */
  color?: string;
}

const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
// 颜色（SGR）| 其他 CSI | OSC（设置标题等）| 字符集切换等两三个字符的序列
const sequence = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?<=>!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78cDEHMNOZ]/g;
// 一块输出的末尾可能正好把一个序列截成两半：留到下一块再认。
const partial = /\x1b(?:\[[0-9;?<=>!]*[ -/]*|\][^\x07\x1b]*|[()])?$/;

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const c = n - 16;
  const level = (i: number) => (i === 0 ? 0 : 55 + i * 40);
  return `rgb(${level(Math.floor(c / 36))}, ${level(Math.floor(c / 6) % 6)}, ${level(c % 6)})`;
}

/** 一路输出（标准输出、错误输出各一个）的解析器：记着当前的样式，一块一块地喂。 */
export class AnsiParser {
  private fg = "";
  private rgb: string | undefined;
  private bold = false;
  private dim = false;
  private italic = false;
  private underline = false;
  private carry = "";

  private apply(codes: number[]) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) {
        this.fg = "";
        this.rgb = undefined;
        this.bold = this.dim = this.italic = this.underline = false;
      } else if (c === 1) this.bold = true;
      else if (c === 2) this.dim = true;
      else if (c === 3) this.italic = true;
      else if (c === 4) this.underline = true;
      else if (c === 22) this.bold = this.dim = false;
      else if (c === 23) this.italic = false;
      else if (c === 24) this.underline = false;
      else if (c >= 30 && c <= 37) [this.fg, this.rgb] = [names[c - 30]!, undefined];
      else if (c >= 90 && c <= 97) [this.fg, this.rgb] = [`bright-${names[c - 90]!}`, undefined];
      else if (c === 39) [this.fg, this.rgb] = ["", undefined];
      else if (c === 38 || c === 48) {
        // 38;5;n 是 256 色，38;2;r;g;b 是真彩色；48 开头的是背景色，认出来但不画。
        const mode = codes[i + 1];
        let value: string | undefined;
        if (mode === 5) {
          const n = codes[i + 2] ?? -1;
          value = n >= 0 && n < 8 ? `@${names[n]}` : n >= 8 && n < 16 ? `@bright-${names[n - 8]}` : color256(n);
          i += 2;
        } else if (mode === 2) {
          value = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
          i += 4;
        }
        if (c === 38 && value) {
          if (value.startsWith("@")) [this.fg, this.rgb] = [value.slice(1), undefined];
          else [this.fg, this.rgb] = ["", value];
        }
      }
    }
  }

  private style(): Pick<AnsiSpan, "cls" | "color"> {
    const cls = [this.fg && `ansi-${this.fg}`, this.bold && "ansi-bold", this.dim && "ansi-dim", this.italic && "ansi-italic", this.underline && "ansi-underline"].filter(Boolean).join(" ");
    return this.rgb ? { cls, color: this.rgb } : { cls };
  }

  push(chunk: string): AnsiSpan[] {
    let text = this.carry + chunk;
    this.carry = "";
    const cut = partial.exec(text);
    if (cut && cut.index >= 0 && cut[0] !== "") {
      this.carry = cut[0];
      text = text.slice(0, cut.index);
    }
    const out: AnsiSpan[] = [];
    let last = 0;
    for (const m of text.matchAll(sequence)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ text: text.slice(last, at), ...this.style() });
      if (m[1] !== undefined) this.apply(m[1] === "" ? [0] : m[1].split(";").map((n) => Number(n) || 0));
      last = at + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), ...this.style() });
    return out;
  }
}

/** 去掉所有转义序列，只留文字（复制输出时用）。 */
export function stripAnsi(text: string): string {
  return text.replace(sequence, "").replace(/\x1b/g, "");
}
