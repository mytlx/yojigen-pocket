// 主程序发布说明生成器：按 Conventional Commit 类型自动分类，并附带随版本打包的扩展清单。
// 用法：bun tools/release-notes.ts --tag v0.2.0 --repo mytlx/yojigen-pocket [--out release-notes.md]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findPreviousTagMatching,
  flagStr,
  git,
  listAllExtensionIDs,
  parseFlags,
  readAnnotatedTagMessage,
  readHostAPIVersion,
  readManifest,
  validateExtensionManifest,
} from "./extension-registry";

interface CommitGroup {
  key: string;
  heading: string;
  pattern: RegExp;
}

const COMMIT_GROUPS: CommitGroup[] = [
  { key: "feat", heading: "✨ 新功能", pattern: /^feat(?:\(([^)]+)\))?!?:\s*(.+)$/i },
  { key: "fix", heading: "🐛 问题修复", pattern: /^fix(?:\(([^)]+)\))?!?:\s*(.+)$/i },
  { key: "perf", heading: "⚡ 体验与重构", pattern: /^(?:perf|refactor)(?:\(([^)]+)\))?!?:\s*(.+)$/i },
  { key: "docs", heading: "📚 文档更新", pattern: /^docs(?:\(([^)]+)\))?!?:\s*(.+)$/i },
  { key: "chore", heading: "🔧 工程与维护", pattern: /^(?:chore|build|ci|test|style)(?:\(([^)]+)\))?!?:\s*(.+)$/i },
];

export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  api: number;
}

export function buildAppReleaseNotes(opts: {
  tag: string;
  prevTag: string | null;
  commits: string[];
  repo?: string;
  tagSummary?: string;
  extensions?: ExtensionSummary[];
}): string {
  const buckets = new Map<string, string[]>();
  for (const g of COMMIT_GROUPS) buckets.set(g.key, []);
  buckets.set("other", []);

  const seen = new Set<string>();
  for (const raw of opts.commits) {
    const subject = raw.trim();
    if (!subject || /^Merge\b/i.test(subject)) continue;
    if (seen.has(subject)) continue;
    seen.add(subject);

    let matched = false;
    for (const g of COMMIT_GROUPS) {
      const m = g.pattern.exec(subject);
      if (m) {
        const scope = m[1]?.trim();
        const desc = m[2].trim();
        buckets.get(g.key)!.push(scope ? `- **${scope}**：${desc}` : `- ${desc}`);
        matched = true;
        break;
      }
    }
    if (!matched) {
      buckets.get("other")!.push(`- ${subject}`);
    }
  }

  const sections: string[] = [];
  if (opts.tagSummary?.trim()) {
    sections.push(opts.tagSummary.trim());
  }

  for (const g of COMMIT_GROUPS) {
    const lines = buckets.get(g.key)!;
    if (lines.length > 0) {
      sections.push(`### ${g.heading}\n\n${lines.join("\n")}`);
    }
  }
  const otherLines = buckets.get("other")!;
  if (otherLines.length > 0) {
    sections.push(`### 📌 其他变更\n\n${otherLines.join("\n")}`);
  }

  if (sections.length === 0) {
    sections.push("### 更新说明\n\n- 常规版本发布与维护更新");
  }

  if (opts.extensions && opts.extensions.length > 0) {
    const rows = opts.extensions.map((e) => `| ${e.name}（\`${e.id}\`） | \`${e.version}\` | API v${e.api} |`);
    sections.push(
      `### 🧩 配套扩展包\n\n扩展包不内置于安装包中，可在应用内「道具库 → 扩展管理」在线安装或批量拖入对应 \`.zip\` 包：\n\n| 扩展 | 版本 | 接口要求 |\n| --- | --- | --- |\n${rows.join("\n")}`,
    );
  }

  if (opts.prevTag && opts.repo) {
    sections.push(`---\n完整提交记录：[${opts.prevTag}...${opts.tag}](https://github.com/${opts.repo}/compare/${encodeURIComponent(opts.prevTag)}...${encodeURIComponent(opts.tag)})`);
  }

  return sections.join("\n\n") + "\n";
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  const tag = flagStr(flags, "tag") ?? "HEAD";
  const repo = flagStr(flags, "repo");
  const out = flagStr(flags, "out");
  const root = resolve(import.meta.dirname, "..");

  const prevTag = findPreviousTagMatching(root, (t) => /^v[0-9]/.test(t), tag);
  const rangeArgs = prevTag ? [`${prevTag}..HEAD`] : ["-n", "100", "HEAD"];
  const rawLog = git(root, ["log", ...rangeArgs, "--no-merges", "--format=%s"]);
  const commits = rawLog ? rawLog.split(/\r?\n/) : [];
  const tagSummary = readAnnotatedTagMessage(root, tag);

  const hostApi = readHostAPIVersion(root);
  const extensions = listAllExtensionIDs(root).map((id) => validateExtensionManifest(readManifest(root, id), id, hostApi));

  const notes = buildAppReleaseNotes({ tag, prevTag, commits, repo, tagSummary, extensions });
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, notes, "utf8");
  } else {
    process.stdout.write(notes);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
