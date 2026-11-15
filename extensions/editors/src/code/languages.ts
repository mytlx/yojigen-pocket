import type { Extension } from "@codemirror/state";

/** 一种语言：怎么高亮。id 和后端 runner 里的语言 ID 对应。 */
export interface LangDef {
  id: string;
  name: string;
  /** 搜索时也能用的别名和扩展名。 */
  aliases: string[];
  /** 按需加载高亮，用到哪种才下载哪种。 */
  load: () => Promise<Extension>;
}

const legacy = async (mode: Promise<Record<string, unknown>>, name: string): Promise<Extension> => {
  const [{ StreamLanguage }, mod] = await Promise.all([import("@codemirror/language"), mode]);
  return StreamLanguage.define(mod[name] as Parameters<typeof StreamLanguage.define>[0]);
};

export const languages: LangDef[] = [
  { id: "text", name: "纯文本", aliases: ["txt", "plain", "wenben"], load: async () => [] },
  { id: "javascript", name: "JavaScript", aliases: ["js", "jsx", "mjs", "node"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })) },
  { id: "typescript", name: "TypeScript", aliases: ["ts", "tsx"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })) },
  { id: "json", name: "JSON", aliases: ["json5"], load: () => import("@codemirror/lang-json").then((m) => m.json()) },
  { id: "python", name: "Python", aliases: ["py"], load: () => import("@codemirror/lang-python").then((m) => m.python()) },
  { id: "go", name: "Go", aliases: ["golang"], load: () => import("@codemirror/lang-go").then((m) => m.go()) },
  { id: "java", name: "Java", aliases: [], load: () => import("@codemirror/lang-java").then((m) => m.java()) },
  { id: "c", name: "C", aliases: ["h"], load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()) },
  { id: "cpp", name: "C++", aliases: ["cc", "cxx", "hpp"], load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()) },
  { id: "csharp", name: "C#", aliases: ["cs"], load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "csharp") },
  { id: "rust", name: "Rust", aliases: ["rs"], load: () => import("@codemirror/lang-rust").then((m) => m.rust()) },
  { id: "kotlin", name: "Kotlin", aliases: ["kt", "kts"], load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "kotlin") },
  { id: "swift", name: "Swift", aliases: [], load: () => legacy(import("@codemirror/legacy-modes/mode/swift"), "swift") },
  { id: "php", name: "PHP", aliases: [], load: () => import("@codemirror/lang-php").then((m) => m.php()) },
  { id: "ruby", name: "Ruby", aliases: ["rb"], load: () => legacy(import("@codemirror/legacy-modes/mode/ruby"), "ruby") },
  { id: "lua", name: "Lua", aliases: [], load: () => legacy(import("@codemirror/legacy-modes/mode/lua"), "lua") },
  { id: "perl", name: "Perl", aliases: ["pl"], load: () => legacy(import("@codemirror/legacy-modes/mode/perl"), "perl") },
  { id: "r", name: "R", aliases: [], load: () => legacy(import("@codemirror/legacy-modes/mode/r"), "r") },
  { id: "shell", name: "Shell", aliases: ["sh", "bash", "zsh"], load: () => legacy(import("@codemirror/legacy-modes/mode/shell"), "shell") },
  { id: "powershell", name: "PowerShell", aliases: ["ps1", "pwsh"], load: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), "powerShell") },
  { id: "batch", name: "批处理", aliases: ["bat", "cmd"], load: async () => [] },
  { id: "sql", name: "SQL", aliases: ["mysql", "postgres"], load: () => import("@codemirror/lang-sql").then((m) => m.sql()) },
  { id: "html", name: "HTML", aliases: ["htm", "vue"], load: () => import("@codemirror/lang-html").then((m) => m.html()) },
  { id: "css", name: "CSS", aliases: ["scss", "less"], load: () => import("@codemirror/lang-css").then((m) => m.css()) },
  { id: "xml", name: "XML", aliases: ["svg", "plist"], load: () => import("@codemirror/lang-xml").then((m) => m.xml()) },
  { id: "yaml", name: "YAML", aliases: ["yml"], load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) },
  { id: "toml", name: "TOML", aliases: [], load: () => legacy(import("@codemirror/legacy-modes/mode/toml"), "toml") },
  { id: "ini", name: "INI / Properties", aliases: ["properties", "conf", "env"], load: () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties") },
  { id: "dockerfile", name: "Dockerfile", aliases: ["docker"], load: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile") },
  { id: "markdown", name: "Markdown", aliases: ["md"], load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  { id: "diff", name: "Diff / Patch", aliases: ["patch"], load: () => legacy(import("@codemirror/legacy-modes/mode/diff"), "diff") },
];

export function findLang(id: string): LangDef {
  return languages.find((l) => l.id === id) ?? languages[0]!;
}

/** 按名字、ID、别名搜索语言。 */
export function searchLangs(query: string, list: LangDef[] = languages): LangDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const score = (l: LangDef) => {
    const names = [l.id, l.name.toLowerCase(), ...l.aliases];
    if (names.includes(q)) return 0;
    if (names.some((n) => n.startsWith(q))) return 1;
    if (names.some((n) => n.includes(q))) return 2;
    return 9;
  };
  return list.map((l) => [score(l), l] as const).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}

/** 从内容猜语言（粘贴进来一段东西时用）。猜不出来返回空串。 */
export function guessLang(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* 不是 JSON，接着猜 */
    }
  }
  if (/^<\?xml|^<svg[\s>]/i.test(t)) return "xml";
  if (/^<!doctype html|^<html[\s>]|<\/(div|span|body|p)>/i.test(t)) return "html";
  if (/^package\s+\w+\s*$/m.test(t) && /\bfunc\s+\w*\(/.test(t)) return "go";
  if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(t) || /^\s*(import\s+\w+|from\s+[\w.]+\s+import)\b/m.test(t)) return "python";
  if (/\b(public|private)\s+(static\s+)?(class|void|int|String)\b/.test(t)) return "java";
  if (/^\s*#include\s*[<"]/m.test(t)) return "cpp";
  if (/^\s*(select|insert\s+into|update|delete\s+from|create\s+table|alter\s+table)\b/im.test(t)) return "sql";
  if (/^#!.*\b(ba|z)?sh\b/.test(t)) return "shell";
  if (/\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean)\b/.test(t)) return "typescript";
  if (/\b(const|let|var|function)\s+\w+|=>\s*[{(]|console\.log\(/.test(t)) return "javascript";
  if (/^[\w.#-]+\s*\{[^}]*:[^}]*;/m.test(t)) return "css";
  if (/^[\w-]+:\s+\S/m.test(t) && !/[;{}]/.test(t)) return "yaml";
  if (/^#{1,6}\s+\S/m.test(t)) return "markdown";
  return "";
}
