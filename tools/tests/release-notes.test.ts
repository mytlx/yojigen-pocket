import { describe, expect, test } from "bun:test";
import { buildAppReleaseNotes } from "../release-notes";

describe("buildAppReleaseNotes", () => {
  test("groups conventional commits, strips merge noise, and appends extensions table + compare link", () => {
    const out = buildAppReleaseNotes({
      tag: "v0.3.0",
      prevTag: "v0.2.0",
      repo: "mytlx/yojigen-pocket",
      tagSummary: "本次带来应用内扩展商店和批量拖入支持。",
      commits: [
        "Merge pull request #2 from dev",
        "feat(store): add remote extension store",
        "feat: support batch drag and drop",
        "feat(store): add remote extension store",
        "fix(windows): fix blank extension iframe",
        "docs: update guide",
        "chore(release): bump version to 0.3.0",
        "清理遗留临时脚本",
      ],
      extensions: [
        { id: "editors", name: "写作与代码", version: "1.0.1", api: 1 },
        { id: "peer", name: "口袋直传", version: "1.1.0", api: 2 },
      ],
    });

    expect(out).toContain("本次带来应用内扩展商店和批量拖入支持。");
    expect(out).toContain("### ✨ 新功能\n\n- **store**：add remote extension store\n- support batch drag and drop");
    expect(out).toContain("### 🐛 问题修复\n\n- **windows**：fix blank extension iframe");
    expect(out).toContain("### 📚 文档更新\n\n- update guide");
    expect(out).toContain("### 🔧 工程与维护\n\n- **release**：bump version to 0.3.0");
    expect(out).toContain("### 📌 其他变更\n\n- 清理遗留临时脚本");
    expect(out).toContain("| 写作与代码（`editors`） | `1.0.1` | API v1 |");
    expect(out).toContain("[v0.2.0...v0.3.0](https://github.com/mytlx/yojigen-pocket/compare/v0.2.0...v0.3.0)");
  });

  test("handles empty commit list gracefully", () => {
    const out = buildAppReleaseNotes({ tag: "v0.2.1", prevTag: "v0.2.0", commits: [] });
    expect(out).toContain("常规版本发布与维护更新");
  });
});
