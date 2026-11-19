// 扩展包发布与在线索引工具（无第三方依赖，供 CI 与本地脚本共用）。
//
// 子命令：
//   bun tools/extension-registry.ts list [--id all|editors]
//   bun tools/extension-registry.ts check [--id <id|all>] [--tag <ext-id-vX.Y.Z>]
//   bun tools/extension-registry.ts changelog --id <id> [--tag <tag>] [--manual <text>] [--out <file>] [--release-notes]
//   bun tools/extension-registry.ts update --registry <extensions.json> --id <id> --zip <file.zip> --tag <tag> --repo <owner/repo> [--changelog-file <file>] [--changelog-explicit] [--force]
//   bun tools/extension-registry.ts notes --registry <extensions.json> [--repo <owner/repo>] [--out <file>]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { formatLocalTime } from "../src/shared/time";

export interface PluginPermissions {
  peer?: boolean;
  dirs?: string[];
  fetch?: string[];
  runner?: boolean;
  files?: boolean;
}

export interface PluginManifest {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  icon?: string;
  version?: string;
  author?: string;
  api?: number;
  tools?: Array<{ id: string; title?: string }>;
  permissions?: PluginPermissions;
  backend?: unknown;
}

export interface RegistryArtifact {
  version: string;
  api: number;
  url: string;
  tag: string;
  asset: string;
  sha256: string;
  size: number;
  publishedAt: string;
  changelog: string;
}

export interface RegistryExtension extends RegistryArtifact {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  author?: string;
  tools?: string[];
  permissions?: PluginPermissions;
  backend?: boolean;
  compat: Record<string, RegistryArtifact>;
}

export interface ExtensionRegistry {
  schema: 1;
  updatedAt: string;
  extensions: RegistryExtension[];
}

export interface IncomingExtensionRelease extends RegistryArtifact {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  author?: string;
  tools?: string[];
  permissions?: PluginPermissions;
  backend?: boolean;
  changelogExplicit?: boolean;
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const EXT_TAG_RE = /^ext-([a-z0-9][a-z0-9-]*)-v(.+)$/;

export function isValidPluginID(id: string): boolean {
  return PLUGIN_ID_RE.test(id) && id.length <= 64;
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function parseExtTag(tag: string): { id: string; version: string } | null {
  const m = EXT_TAG_RE.exec(tag.trim());
  if (!m) return null;
  const [, id, version] = m;
  if (!isValidPluginID(id) || !isValidSemver(version)) return null;
  return { id, version };
}

/** 比较两个 SemVer 版本号，返回值 > 0 表示 a > b，< 0 表示 a < b，0 表示相等（忽略 build metadata）。 */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a.trim());
  const mb = SEMVER_RE.exec(b.trim());
  if (!ma || !mb) return a.localeCompare(b);

  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }

  const preA = ma[4];
  const preB = mb[4];
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;

  const partsA = preA.split(".");
  const partsB = preB.split(".");
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const na = /^[0-9]+$/.test(pa);
    const nb = /^[0-9]+$/.test(pb);
    if (na && nb) {
      const diff = Number(pa) - Number(pb);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

export function parseHostAPIVersion(pluginsGoSource: string): number {
  const m = /\bconst\s+APIVersion\s*=\s*(\d+)/.exec(pluginsGoSource);
  if (!m) {
    throw new Error("无法从 internal/providers/plugins.go 解析 APIVersion");
  }
  return Number(m[1]);
}

export function validateExtensionManifest(
  manifest: PluginManifest,
  expectedID: string,
  hostApiVersion: number,
): { id: string; name: string; version: string; api: number } {
  const id = (manifest.id || expectedID).toLowerCase();
  if (!isValidPluginID(id)) {
    throw new Error(`扩展 ID「${id}」不合法`);
  }
  if (id !== expectedID) {
    throw new Error(`扩展目录「${expectedID}」与 plugin.json 中的 id「${id}」不一致`);
  }
  const version = (manifest.version ?? "").trim();
  if (!isValidSemver(version)) {
    throw new Error(`扩展「${id}」的 version「${version}」必须是有效的 SemVer（如 1.0.0）`);
  }
  const rawApi = manifest.api ?? 1;
  const api = rawApi === 0 ? 1 : rawApi;
  if (!Number.isInteger(api) || api < 1 || api > hostApiVersion) {
    throw new Error(`扩展「${id}」要求的 api=${api} 超出当前宿主支持范围 1..${hostApiVersion}`);
  }
  const name = (manifest.name || manifest.title || id).trim();
  return { id, name, version, api };
}

export function formatCommitsChangelog(commits: string[], maxItems = 50): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of commits) {
    const line = raw.trim();
    if (!line || /^Merge\b/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(`- ${line}`);
    if (lines.length >= maxItems) break;
  }
  return lines.length > 0 ? lines.join("\n") : "- 维护更新";
}

export function buildReleaseDownloadURL(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

function toArtifact(item: IncomingExtensionRelease): RegistryArtifact {
  return {
    version: item.version,
    api: item.api,
    url: item.url,
    tag: item.tag,
    asset: item.asset,
    sha256: item.sha256,
    size: item.size,
    publishedAt: item.publishedAt,
    changelog: item.changelog,
  };
}

function extractManifestTools(manifest: PluginManifest, fallbackName: string): string[] {
  if (manifest.tools && manifest.tools.length > 0) {
    return manifest.tools.map((t) => (t.title || t.id || "").trim()).filter(Boolean);
  }
  const title = (manifest.title || manifest.name || fallbackName).trim();
  return title ? [title] : [];
}

function buildMetaFields(src: {
  name: string;
  description?: string;
  icon?: string;
  author?: string;
  tools?: string[];
  permissions?: PluginPermissions;
  backend?: boolean;
}) {
  return {
    name: src.name,
    ...(src.description ? { description: src.description } : {}),
    ...(src.icon ? { icon: src.icon } : {}),
    ...(src.author ? { author: src.author } : {}),
    ...(src.tools && src.tools.length > 0 ? { tools: src.tools } : {}),
    ...(src.permissions && Object.keys(src.permissions).length > 0 ? { permissions: src.permissions } : {}),
    ...(src.backend ? { backend: true } : {}),
  };
}

/** 将新发布的扩展版本合并进现有在线索引，保留历史 API 兼容槽位与未变更扩展。 */
export function mergeRegistry(
  existing: ExtensionRegistry | null | undefined,
  incoming: IncomingExtensionRelease,
  options?: { force?: boolean },
): { registry: ExtensionRegistry; changed: boolean } {
  const force = !!options?.force;
  const list: RegistryExtension[] = existing?.extensions
    ? existing.extensions.map((e) => ({
        ...e,
        compat: Object.fromEntries(Object.entries(e.compat || {}).map(([k, v]) => [k, { ...v }])),
      }))
    : [];

  const idx = list.findIndex((e) => e.id === incoming.id);
  const incomingArtifact = toArtifact(incoming);
  let changed = false;

  if (idx < 0) {
    list.push({
      id: incoming.id,
      ...buildMetaFields(incoming),
      ...incomingArtifact,
      compat: { [String(incoming.api)]: incomingArtifact },
    });
    changed = true;
  } else {
    const prev = list[idx];
    const compat: Record<string, RegistryArtifact> = { ...prev.compat };
    const prevApiKey = String(prev.api);
    if (!compat[prevApiKey]) {
      compat[prevApiKey] = toArtifact({ ...prev });
    }

    const apiKey = String(incoming.api);
    const prevSlot = compat[apiKey];
    let slotChanged = false;
    if (!prevSlot) {
      compat[apiKey] = incomingArtifact;
      slotChanged = true;
    } else {
      const slotCmp = compareSemver(incoming.version, prevSlot.version);
      const sameBinary = incoming.sha256 === prevSlot.sha256;
      if (slotCmp > 0 || force || (slotCmp === 0 && (!sameBinary || incoming.changelogExplicit))) {
        compat[apiKey] = incomingArtifact;
        slotChanged =
          !sameBinary ||
          slotCmp !== 0 ||
          incoming.url !== prevSlot.url ||
          (!!incoming.changelogExplicit && incoming.changelog !== prevSlot.changelog);
      }
    }

    const topCmp = compareSemver(incoming.version, prev.version);
    const sameTopBinary = incoming.sha256 === prev.sha256;
    const shouldUpdateTop =
      topCmp > 0 ||
      (topCmp === 0 && (force || !sameTopBinary || !!incoming.changelogExplicit)) ||
      (topCmp === 0 && incoming.api > prev.api);

    let topArtifact: RegistryArtifact;
    let meta = buildMetaFields(prev);

    if (shouldUpdateTop) {
      topArtifact =
        topCmp === 0 && sameTopBinary && !force && !incoming.changelogExplicit
          ? {
              version: prev.version,
              api: incoming.api,
              url: prev.url,
              tag: prev.tag,
              asset: prev.asset,
              sha256: prev.sha256,
              size: prev.size,
              publishedAt: prev.publishedAt,
              changelog: prev.changelog,
            }
          : incomingArtifact;
      meta = buildMetaFields(incoming);
      if (
        topArtifact.version !== prev.version ||
        topArtifact.api !== prev.api ||
        topArtifact.sha256 !== prev.sha256 ||
        topArtifact.url !== prev.url ||
        topArtifact.changelog !== prev.changelog ||
        JSON.stringify(meta) !== JSON.stringify(buildMetaFields(prev))
      ) {
        changed = true;
      }
    } else {
      topArtifact = toArtifact({ ...prev });
    }

    if (slotChanged) changed = true;

    list[idx] = {
      id: incoming.id,
      ...meta,
      ...topArtifact,
      compat,
    };
  }

  list.sort((a, b) => a.id.localeCompare(b.id));

  const registry: ExtensionRegistry = {
    schema: 1,
    updatedAt: changed || !existing ? incoming.publishedAt : existing.updatedAt,
    extensions: list,
  };
  return { registry, changed };
}

function inferRepoFromURL(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(url);
  return m?.[1];
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

function formatRegistryTimestampPair(iso: string): string {
  const trimmed = iso.trim();
  const cst = formatLocalTime(trimmed, 480);
  const utc = formatLocalTime(trimmed, 0);
  if (!cst || cst === trimmed) return trimmed ? `\`${trimmed}\`` : "-";
  return `\`${cst} (UTC+8)\` / \`${utc} UTC\``;
}

/** 为 GitHub 的 `extensions` Pre-release 生成包含同步时间与各扩展版本状态的说明文档。 */
export function buildRegistryReleaseNotes(registry: ExtensionRegistry, repo?: string): string {
  const lines: string[] = [
    "供 Yojigen Pocket 客户端在线读取官方扩展目录、版本号与更新日志（`extensions.json`）。如需安装扩展，请下载各扩展或主程序 Release 中的 `.zip` 包。",
    "",
    `- **索引最近同步时间**：${formatRegistryTimestampPair(registry.updatedAt)}`,
  ];

  if (registry.extensions.length === 0) {
    lines.push("", "暂无已收录的扩展。");
    return lines.join("\n") + "\n";
  }

  lines.push(
    "",
    "### 📦 收录扩展一览",
    "",
    "| 扩展 | ID | 最新版本 | 接口 | 发布来源 | 发布时间（UTC+8） |",
    "| --- | --- | --- | --- | --- | --- |",
  );

  for (const ext of registry.extensions) {
    const extRepo = repo?.trim() || inferRepoFromURL(ext.url);
    const tagCell = extRepo
      ? `[${ext.tag}](https://github.com/${extRepo}/releases/tag/${encodeURIComponent(ext.tag)})`
      : `\`${ext.tag}\``;
    const publishedCell = formatLocalTime(ext.publishedAt, 480) || "-";
    lines.push(
      `| ${escapeMarkdownCell(ext.name || ext.id)} | \`${ext.id}\` | \`${ext.version}\` | API v${ext.api} | ${tagCell} | \`${publishedCell}\` |`,
    );
  }

  lines.push(
    "",
    "> 说明：GitHub Release 顶部的创建日期固定为初次建页时间；实际索引同步时间与各扩展最后更新时刻以上表和 `extensions.json` 为准（未发生版本或包体 SHA-256 变化的扩展会保留原发布时间与来源 Tag）。",
  );

  return lines.join("\n") + "\n";
}

// ---- 以下为本地文件与 Git CLI 封装 ----

function repoRoot(): string {
  return resolve(import.meta.dirname, "..");
}

export function listAllExtensionIDs(root: string): string[] {
  const extRoot = join(root, "extensions");
  if (!existsSync(extRoot)) return [];
  return readdirSync(extRoot)
    .filter((id) => existsSync(join(extRoot, id, "plugin.json")))
    .sort();
}

export function readManifest(root: string, id: string): PluginManifest {
  const file = join(root, "extensions", id, "plugin.json");
  if (!existsSync(file)) {
    throw new Error(`找不到扩展清单：${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as PluginManifest;
}

export function readHostAPIVersion(root: string): number {
  const pluginsGo = join(root, "internal", "providers", "plugins.go");
  return parseHostAPIVersion(readFileSync(pluginsGo, "utf8"));
}

export function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

export function findPreviousTagMatching(root: string, match: (tag: string) => boolean, currentTag?: string): string | null {
  const headSha = git(root, ["rev-parse", "HEAD"]);
  const mergedRaw = git(root, ["tag", "--merged", "HEAD"]);
  if (!mergedRaw) return null;

  const candidates = mergedRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((t) => t && t !== currentTag && match(t));

  let bestTag: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const tag of candidates) {
    const tagSha = git(root, ["rev-parse", `${tag}^{commit}`]);
    if (!tagSha || (headSha && tagSha === headSha)) continue;
    const distRaw = git(root, ["rev-list", "--count", `${tag}..HEAD`]);
    if (distRaw === null) continue;
    const dist = Number(distRaw);
    if (Number.isFinite(dist) && dist < bestDistance) {
      bestDistance = dist;
      bestTag = tag;
    }
  }
  return bestTag;
}

export function findPreviousReleaseTag(root: string, id: string, currentTag?: string): string | null {
  return findPreviousTagMatching(root, (t) => t.startsWith(`ext-${id}-v`) || /^v[0-9]/.test(t), currentTag);
}

export function readAnnotatedTagMessage(root: string, tag?: string): string {
  if (!tag) return "";
  const tagType = git(root, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (tagType !== "tag") return "";
  const rawContents = git(root, ["tag", "-l", "--format=%(contents)", tag]);
  return (
    rawContents
      ?.replace(/\r\n/g, "\n")
      .replace(/\n?-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*$/m, "")
      .trim() ?? ""
  );
}

export function resolveExtensionChangelog(opts: {
  root: string;
  id: string;
  tag?: string;
  manualChangelog?: string;
}): { changelog: string; explicit: boolean; prevTag: string | null } {
  const manual = opts.manualChangelog?.replace(/\r\n/g, "\n").trim();
  if (manual) {
    return { changelog: manual, explicit: true, prevTag: null };
  }

  const contents = readAnnotatedTagMessage(opts.root, opts.tag);
  if (contents) {
    return { changelog: contents, explicit: true, prevTag: null };
  }

  const prevTag = findPreviousReleaseTag(opts.root, opts.id, opts.tag);
  const rangeArgs = prevTag ? [`${prevTag}..HEAD`] : ["-n", "30", "HEAD"];
  const rawLog = git(opts.root, [
    "log",
    ...rangeArgs,
    "--no-merges",
    "--format=%s",
    "--",
    `extensions/${opts.id}`,
  ]);

  const commits = rawLog ? rawLog.split(/\r?\n/) : [];
  if (commits.filter((c) => c.trim() && !/^Merge\b/i.test(c.trim())).length === 0 && !prevTag) {
    const fallbackLog = git(opts.root, ["log", "-n", "10", "--no-merges", "--format=%s", "--", `extensions/${opts.id}`]);
    if (fallbackLog) {
      return { changelog: formatCommitsChangelog(fallbackLog.split(/\r?\n/)), explicit: false, prevTag };
    }
  }
  return { changelog: formatCommitsChangelog(commits), explicit: false, prevTag };
}

const BOOLEAN_FLAGS = new Set(["release-notes", "changelog-explicit", "force"]);

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

export function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function writeCliOutput(text: string, out?: string) {
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, text, "utf8");
  } else {
    process.stdout.write(text);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);
  const root = repoRoot();

  switch (cmd) {
    case "list": {
      const requested = (flagStr(flags, "id") ?? "all").trim();
      const all = listAllExtensionIDs(root);
      const ids = requested === "all" ? all : [requested];
      for (const id of ids) {
        if (!all.includes(id)) {
          throw new Error(`找不到扩展：${id}（可选：${all.join(", ")}）`);
        }
      }
      console.log(ids.join("\n"));
      return;
    }

    case "check": {
      const hostApi = readHostAPIVersion(root);
      const tag = flagStr(flags, "tag");
      const all = listAllExtensionIDs(root);
      let ids: string[];

      if (tag) {
        const parsed = parseExtTag(tag);
        if (!parsed) {
          throw new Error(`标签「${tag}」格式无效，必须为 ext-<id>-v<x.y.z>（如 ext-editors-v1.0.1）`);
        }
        if (!all.includes(parsed.id)) {
          throw new Error(`标签「${tag}」对应的扩展「${parsed.id}」不存在`);
        }
        const manifest = readManifest(root, parsed.id);
        const info = validateExtensionManifest(manifest, parsed.id, hostApi);
        if (info.version !== parsed.version) {
          throw new Error(
            `标签版本「${parsed.version}」与 extensions/${parsed.id}/plugin.json 中的 version「${info.version}」不一致`,
          );
        }
        console.log(JSON.stringify({ hostApi, extensions: [info] }, null, 2));
        return;
      }

      const requested = (flagStr(flags, "id") ?? "all").trim();
      const manual = flagStr(flags, "manual")?.trim();
      if (requested === "all" && manual) {
        throw new Error("批量发布 all 时请将 changelog 留空，以便按各扩展的 Git 提交历史分别生成更新说明");
      }
      ids = requested === "all" ? all : [requested];
      const validated = ids.map((id) => {
        if (!all.includes(id)) {
          throw new Error(`找不到扩展：${id}`);
        }
        return validateExtensionManifest(readManifest(root, id), id, hostApi);
      });
      console.log(JSON.stringify({ hostApi, extensions: validated }, null, 2));
      return;
    }

    case "meta": {
      const tag = flagStr(flags, "tag");
      let id = flagStr(flags, "id");
      if (!id && tag) {
        const parsed = parseExtTag(tag);
        if (!parsed) throw new Error(`标签「${tag}」格式无效`);
        id = parsed.id;
      }
      if (!id) throw new Error("缺少 --id 或 --tag");
      const hostApi = readHostAPIVersion(root);
      const manifest = readManifest(root, id);
      const info = validateExtensionManifest(manifest, id, hostApi);
      const payload: Record<string, string | number> = {
        ...info,
        tag: `ext-${info.id}-v${info.version}`,
        zip: `build/extensions/${info.id}-${info.version}.zip`,
      };
      const field = flagStr(flags, "field");
      if (field) {
        if (!(field in payload)) throw new Error(`未知字段：${field}`);
        console.log(String(payload[field]));
      } else {
        console.log(JSON.stringify(payload));
      }
      return;
    }

    case "changelog": {
      const id = flagStr(flags, "id");
      if (!id) throw new Error("缺少 --id");
      const hostApi = readHostAPIVersion(root);
      const manifest = readManifest(root, id);
      const info = validateExtensionManifest(manifest, id, hostApi);
      const res = resolveExtensionChangelog({
        root,
        id,
        tag: flagStr(flags, "tag"),
        manualChangelog: flagStr(flags, "manual"),
      });
      let text = res.changelog;
      if (flags["release-notes"]) {
        const rangeHint = res.prevTag ? `\n\n变更基准：\`${res.prevTag}..HEAD\`` : "";
        text = `### 更新内容\n\n${res.changelog}\n\n---\n- 扩展 ID：\`${info.id}\`\n- 版本：\`${info.version}\`\n- 接口要求：\`API v${info.api}\`（请确保 Yojigen Pocket 支持该版本及以上扩展接口）${rangeHint}\n`;
      }
      writeCliOutput(text, flagStr(flags, "out"));
      return;
    }

    case "update": {
      const registryPath = flagStr(flags, "registry");
      const id = flagStr(flags, "id");
      const zipPath = flagStr(flags, "zip");
      const tag = flagStr(flags, "tag");
      const repo = flagStr(flags, "repo");
      if (!registryPath || !id || !zipPath || !tag || !repo) {
        throw new Error("update 需要 --registry --id --zip --tag --repo");
      }
      if (!existsSync(zipPath)) {
        throw new Error(`找不到扩展压缩包：${zipPath}`);
      }
      const hostApi = readHostAPIVersion(root);
      const manifest = readManifest(root, id);
      const info = validateExtensionManifest(manifest, id, hostApi);

      const zipData = readFileSync(zipPath);
      const sha256 = createHash("sha256").update(zipData).digest("hex");
      const size = statSync(zipPath).size;
      const asset = basename(zipPath);

      let changelog = "";
      let explicit = Boolean(flags["changelog-explicit"]);
      const changelogFile = flagStr(flags, "changelog-file");
      if (changelogFile && existsSync(changelogFile)) {
        changelog = readFileSync(changelogFile, "utf8").replace(/\r\n/g, "\n").trim();
      } else {
        const res = resolveExtensionChangelog({
          root,
          id,
          tag,
          manualChangelog: flagStr(flags, "manual"),
        });
        changelog = res.changelog;
        explicit = explicit || res.explicit;
      }

      let existing: ExtensionRegistry | null = null;
      if (existsSync(registryPath)) {
        existing = JSON.parse(readFileSync(registryPath, "utf8")) as ExtensionRegistry;
      }

      const publishedAt = flagStr(flags, "published-at") ?? new Date().toISOString();
      const { registry, changed } = mergeRegistry(
        existing,
        {
          id: info.id,
          name: info.name,
          description: manifest.description,
          icon: manifest.icon,
          author: manifest.author,
          tools: extractManifestTools(manifest, info.name),
          permissions: manifest.permissions,
          backend: Boolean(manifest.backend),
          version: info.version,
          api: info.api,
          url: buildReleaseDownloadURL(repo, tag, asset),
          tag,
          asset,
          sha256,
          size,
          publishedAt,
          changelog: changelog || "- 维护更新",
          changelogExplicit: explicit,
        },
        { force: Boolean(flags.force) },
      );

      mkdirSync(dirname(resolve(registryPath)), { recursive: true });
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
      console.log(`✓ 索引已更新：${info.id}@${info.version} (api ${info.api}, sha256=${sha256.slice(0, 12)}, changed=${changed})`);
      return;
    }

    case "notes": {
      const registryPath = flagStr(flags, "registry");
      if (!registryPath) {
        throw new Error("notes 需要 --registry <extensions.json>");
      }
      if (!existsSync(registryPath)) {
        throw new Error(`找不到扩展索引文件：${registryPath}`);
      }
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as ExtensionRegistry;
      const text = buildRegistryReleaseNotes(registry, flagStr(flags, "repo"));
      writeCliOutput(text, flagStr(flags, "out"));
      return;
    }

    default:
      throw new Error(`未知子命令：${cmd ?? "(空)"}；支持 list | check | meta | changelog | update | notes`);
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
