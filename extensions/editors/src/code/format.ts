import { Scratch } from "../host";

/** 浏览器里就能格式化的语言 → Prettier 的解析器。 */
const prettierParsers: Record<string, string> = {
  javascript: "babel",
  typescript: "typescript",
  json: "json",
  css: "css",
  html: "html",
  markdown: "markdown",
  yaml: "yaml",
};

async function withPrettier(parser: string, code: string): Promise<string> {
  const prettier = await import("prettier/standalone");
  const plugins: unknown[] = [];
  switch (parser) {
    case "babel":
    case "json":
      plugins.push(await import("prettier/plugins/babel"), await import("prettier/plugins/estree"));
      break;
    case "typescript":
      plugins.push(await import("prettier/plugins/typescript"), await import("prettier/plugins/estree"));
      break;
    case "css":
      plugins.push(await import("prettier/plugins/postcss"));
      break;
    case "html":
      plugins.push(await import("prettier/plugins/html"), await import("prettier/plugins/postcss"), await import("prettier/plugins/babel"), await import("prettier/plugins/estree"));
      break;
    case "markdown":
      plugins.push(await import("prettier/plugins/markdown"));
      break;
    case "yaml":
      plugins.push(await import("prettier/plugins/yaml"));
      break;
  }
  return prettier.format(code, { parser, plugins: plugins as never[], printWidth: 100, tabWidth: 2 });
}

/** 给 XML 重新排缩进：标签各占一行，只有文字的元素留在一行里。 */
export function formatXML(src: string, indent = "  "): string {
  const tokens = src.replace(/>\s+</g, "><").trim().match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/[^>]+>|<[^>]+>|[^<]+/g);
  if (!tokens) return src;
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const text = (k: number) => tokens[k] !== undefined && !tokens[k]!.startsWith("<");
    if (t.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      out.push(indent.repeat(depth) + t);
    } else if (/^<[^!?][^>]*[^/]>$|^<[^!?/]>$/.test(t)) {
      // 开标签：后面紧跟文字再紧跟对应的闭标签时，三个并成一行。
      if (text(i + 1) && tokens[i + 2]?.startsWith("</")) {
        out.push(indent.repeat(depth) + t + tokens[i + 1]!.trim() + tokens[i + 2]);
        i += 2;
      } else if (tokens[i + 1]?.startsWith("</")) {
        out.push(indent.repeat(depth) + t + tokens[i + 1]);
        i += 1;
      } else {
        out.push(indent.repeat(depth) + t);
        depth++;
      }
    } else if (t.startsWith("<")) {
      out.push(indent.repeat(depth) + t);
    } else if (t.trim()) {
      out.push(indent.repeat(depth) + t.trim());
    }
  }
  return out.join("\n") + "\n";
}

/** 这种语言能不能在浏览器里格式化（不用问后端）。 */
export function canFormatLocally(lang: string): boolean {
  return lang in prettierParsers || lang === "sql" || lang === "xml";
}

/**
 * 格式化代码。网页相关的语言用 Prettier，SQL 用 sql-formatter，XML 自己排；
 * 其余交给后端（Go 内置；Python、Rust、C/C++、Shell 等要看本机装没装对应的工具）。
 * 格式化不了时抛出带说明的错误。
 */
export async function formatCode(lang: string, code: string): Promise<string> {
  if (!code.trim()) return code;
  if (lang === "json") {
    // JSON 完全展开，每个键一行：这样对比时才能逐行看出差别（Prettier 会把短对象留在一行里）。
    try {
      return JSON.stringify(JSON.parse(code), null, 2) + "\n";
    } catch {
      /* 带注释或多余逗号的 JSON 标准解析不了，交给下面的 Prettier */
    }
  }
  try {
    const parser = prettierParsers[lang];
    if (parser) return await withPrettier(parser, code);
    if (lang === "sql") {
      const { format } = await import("sql-formatter");
      return format(code, { keywordCase: "upper" }) + "\n";
    }
    if (lang === "xml") return formatXML(code);
  } catch (e) {
    // Prettier 的报错带着一大段代码框，只留第一行。
    const msg = (e as Error).message.split("\n")[0] ?? "格式化失败";
    throw new Error(`代码有语法错误：${msg}`);
  }
  return Scratch.format(lang, code);
}
