import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildReleaseDownloadURL,
  compareSemver,
  formatCommitsChangelog,
  mergeRegistry,
  parseExtTag,
  parseHostAPIVersion,
  resolveExtensionChangelog,
  validateExtensionManifest,
  type ExtensionRegistry,
  type IncomingExtensionRelease,
} from "../extension-registry";

function sampleItem(overrides: Partial<IncomingExtensionRelease> = {}): IncomingExtensionRelease {
  return {
    id: "editors",
    name: "写作与代码",
    description: "Markdown 笔记、代码草稿、文本对比",
    icon: "svg:notebook",
    version: "1.0.0",
    api: 1,
    url: buildReleaseDownloadURL("mytlx/yojigen-pocket", "ext-editors-v1.0.0", "editors-1.0.0.zip"),
    tag: "ext-editors-v1.0.0",
    asset: "editors-1.0.0.zip",
    sha256: "aaaa1111",
    size: 1024,
    publishedAt: "2026-11-18T10:00:00Z",
    changelog: "- feat(notes): initial release",
    ...overrides,
  };
}

describe("extension tag & semver parsing", () => {
  test("parseExtTag parses valid extension tags and rejects invalid ones", () => {
    expect(parseExtTag("ext-editors-v1.0.1")).toEqual({ id: "editors", version: "1.0.1" });
    expect(parseExtTag("ext-my-tool-2-v1.2.3-beta.1")).toEqual({ id: "my-tool-2", version: "1.2.3-beta.1" });
    expect(parseExtTag("v0.2.0")).toBeNull();
    expect(parseExtTag("ext-Editors-v1.0.0")).toBeNull();
    expect(parseExtTag("ext-editors-1.0.0")).toBeNull();
    expect(parseExtTag("ext-editors-v1.0")).toBeNull();
  });

  test("compareSemver orders versions and prereleases correctly", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
  });

  test("parseHostAPIVersion and validateExtensionManifest enforce host api bounds", () => {
    const api = parseHostAPIVersion("package providers\nconst APIVersion = 2\n");
    expect(api).toBe(2);

    expect(
      validateExtensionManifest({ id: "peer", name: "口袋直传", version: "1.1.0", api: 2 }, "peer", api),
    ).toEqual({ id: "peer", name: "口袋直传", version: "1.1.0", api: 2 });

    expect(() =>
      validateExtensionManifest({ id: "peer", version: "1.2.0", api: 3 }, "peer", api),
    ).toThrow("超出当前宿主支持范围");

    expect(() =>
      validateExtensionManifest({ id: "other", version: "1.0.0", api: 1 }, "peer", api),
    ).toThrow("不一致");
  });

  test("formatCommitsChangelog cleans merge noise, deduplicates, and provides fallback", () => {
    expect(
      formatCommitsChangelog([
        "  Merge pull request #12 from dev  ",
        "feat(notes): add outline",
        "feat(notes): add outline",
        "",
        "fix(diff): scroll sync",
      ]),
    ).toBe("- feat(notes): add outline\n- fix(diff): scroll sync");

    expect(formatCommitsChangelog(["Merge branch 'main'"])).toBe("- 维护更新");
  });
});

describe("mergeRegistry", () => {
  test("creates new registry and preserves unrelated extensions sorted by id", () => {
    const first = mergeRegistry(null, sampleItem({ id: "pet", name: "桌面宠物", asset: "pet-1.0.0.zip", tag: "ext-pet-v1.0.0", url: "https://example.com/pet.zip" }));
    expect(first.changed).toBe(true);
    expect(first.registry.extensions.map((e) => e.id)).toEqual(["pet"]);

    const second = mergeRegistry(first.registry, sampleItem());
    expect(second.changed).toBe(true);
    expect(second.registry.extensions.map((e) => e.id)).toEqual(["editors", "pet"]);
    expect(second.registry.extensions[0].compat["1"].version).toBe("1.0.0");
  });

  test("preserves existing tag, url, publishedAt, and changelog when version and sha256 match", () => {
    const initial = mergeRegistry(null, sampleItem()).registry;
    const rebuiltOnMainRelease = mergeRegistry(
      initial,
      sampleItem({
        tag: "v0.2.0",
        url: buildReleaseDownloadURL("mytlx/yojigen-pocket", "v0.2.0", "editors-1.0.0.zip"),
        publishedAt: "2026-11-20T00:00:00Z",
        changelog: "- 维护更新",
      }),
    );

    expect(rebuiltOnMainRelease.changed).toBe(false);
    expect(rebuiltOnMainRelease.registry.updatedAt).toBe("2026-11-18T10:00:00Z");
    expect(rebuiltOnMainRelease.registry.extensions[0].tag).toBe("ext-editors-v1.0.0");
    expect(rebuiltOnMainRelease.registry.extensions[0].changelog).toBe("- feat(notes): initial release");
  });

  test("keeps historical api compat slot when upgrading to newer api, and patches older api without downgrading latest", () => {
    let reg: ExtensionRegistry = mergeRegistry(null, sampleItem({ id: "peer", name: "口袋直传", version: "1.1.0", api: 2, sha256: "h2", tag: "ext-peer-v1.1.0", asset: "peer-1.1.0.zip", url: "u2", changelog: "- v1.1.0" })).registry;

    reg = mergeRegistry(
      reg,
      sampleItem({ id: "peer", name: "口袋直传", version: "2.0.0", api: 3, sha256: "h3", tag: "ext-peer-v2.0.0", asset: "peer-2.0.0.zip", url: "u3", publishedAt: "2026-12-01T00:00:00Z", changelog: "- v2.0.0 new api" }),
    ).registry;

    let peer = reg.extensions[0];
    expect(peer.version).toBe("2.0.0");
    expect(peer.api).toBe(3);
    expect(peer.compat["2"].version).toBe("1.1.0");
    expect(peer.compat["3"].version).toBe("2.0.0");

    // 针对老版本宿主接口（api 2）补发 1.1.1：compat["2"] 应升级，而顶层仍保留 2.0.0。
    reg = mergeRegistry(
      reg,
      sampleItem({ id: "peer", name: "口袋直传", version: "1.1.1", api: 2, sha256: "h21", tag: "ext-peer-v1.1.1", asset: "peer-1.1.1.zip", url: "u21", publishedAt: "2026-12-02T00:00:00Z", changelog: "- hotfix for api 2" }),
    ).registry;

    peer = reg.extensions[0];
    expect(peer.version).toBe("2.0.0");
    expect(peer.api).toBe(3);
    expect(peer.compat["2"].version).toBe("1.1.1");
    expect(peer.compat["2"].changelog).toBe("- hotfix for api 2");
    expect(peer.compat["3"].version).toBe("2.0.0");
  });
});

describe("extension-registry CLI", () => {
  test("check and update subcommands work against repository manifests", () => {
    const root = join(import.meta.dirname, "..", "..");
    const check = spawnSync("bun", ["tools/extension-registry.ts", "check", "--id", "all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
    const parsed = JSON.parse(check.stdout) as { hostApi: number; extensions: Array<{ id: string }> };
    expect(parsed.hostApi).toBeGreaterThanOrEqual(2);
    expect(parsed.extensions.map((e) => e.id)).toEqual(["editors", "peer", "pet"]);

    const tempDir = mkdtempSync(join(tmpdir(), "pocket-reg-test-"));
    try {
      const zipPath = join(tempDir, "pet-1.0.0.zip");
      const regPath = join(tempDir, "extensions.json");
      const logPath = join(tempDir, "changelog.md");
      writeFileSync(zipPath, "fake-zip-bytes");
      writeFileSync(logPath, "- feat(pet): test entry\n");

      const update = spawnSync(
        "bun",
        [
          "tools/extension-registry.ts",
          "update",
          "--registry",
          regPath,
          "--id",
          "pet",
          "--zip",
          zipPath,
          "--tag",
          "ext-pet-v1.0.0",
          "--repo",
          "mytlx/yojigen-pocket",
          "--changelog-file",
          logPath,
          "--changelog-explicit",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(update.status).toBe(0);

      const reg = JSON.parse(readFileSync(regPath, "utf8")) as ExtensionRegistry;
      expect(reg.schema).toBe(1);
      expect(reg.extensions).toHaveLength(1);
      expect(reg.extensions[0].id).toBe("pet");
      expect(reg.extensions[0].changelog).toBe("- feat(pet): test entry");
      expect(reg.extensions[0].url).toBe("https://github.com/mytlx/yojigen-pocket/releases/download/ext-pet-v1.0.0/pet-1.0.0.zip");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves scoped changelog from git history and annotated tags accurately", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "pocket-git-log-"));
    const runGit = (args: string[]) =>
      execFileSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    try {
      runGit(["init"]);
      mkdirSync(join(repoDir, "extensions", "editors"), { recursive: true });
      mkdirSync(join(repoDir, "extensions", "pet"), { recursive: true });
      writeFileSync(join(repoDir, "extensions", "editors", "a.txt"), "v1");
      writeFileSync(join(repoDir, "extensions", "pet", "a.txt"), "v1");
      runGit(["add", "."]);
      runGit(["commit", "-m", "chore: initial baseline"]);
      runGit(["tag", "v0.1.0"]);

      // 修改 editors 与无关的 pet：pet 的标签不应截断 editors 的历史范围。
      writeFileSync(join(repoDir, "extensions", "editors", "a.txt"), "v2");
      runGit(["add", "."]);
      runGit(["commit", "-m", "feat(editors): improve markdown outline"]);

      writeFileSync(join(repoDir, "extensions", "pet", "a.txt"), "v2");
      runGit(["add", "."]);
      runGit(["commit", "-m", "feat(pet): new hat"]);
      runGit(["tag", "ext-pet-v1.0.1"]);

      writeFileSync(join(repoDir, "extensions", "editors", "a.txt"), "v3");
      runGit(["add", "."]);
      runGit(["commit", "-m", "fix(editors): restore cursor position"]);

      const resolved = resolveExtensionChangelog({ root: repoDir, id: "editors", tag: "ext-editors-v1.0.1" });
      expect(resolved.prevTag).toBe("v0.1.0");
      expect(resolved.explicit).toBe(false);
      expect(resolved.changelog).toBe("- fix(editors): restore cursor position\n- feat(editors): improve markdown outline");

      // 附注 tag（含签名块）应提取正文并自动剥离签名块。
      runGit(["tag", "-a", "ext-editors-v1.0.1", "-m", "- curated release note\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----"]);
      const annotated = resolveExtensionChangelog({ root: repoDir, id: "editors", tag: "ext-editors-v1.0.1" });
      expect(annotated.explicit).toBe(true);
      expect(annotated.changelog).toBe("- curated release note");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
