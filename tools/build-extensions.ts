// 构建 extensions/ 下的官方扩展：每个扩展单独用 Vite 构建，再打成一个 zip。
//   bun tools/build-extensions.ts            全部
//   bun tools/build-extensions.ts pet notes  只构建指定的
// 产物在 build/extensions/<id>/ 和 build/extensions/<id>-<版本>.zip。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "extensions");
const out = join(root, "build", "extensions");
const only = process.argv.slice(2);

/**
 * KaTeX 的样式表给每个字体列了 woff2、woff、ttf 三种格式。应用里的 WebView 都认 woff2，
 * 另外两种只是白占一兆多的体积：构建完从样式表里去掉引用，并删掉文件。
 */
function slimFonts(target: string) {
  const assets = join(target, "assets");
  if (!existsSync(assets)) return;
  for (const name of readdirSync(assets)) {
    const file = join(assets, name);
    if (name.endsWith(".css")) {
      const css = readFileSync(file, "utf8");
      const slim = css.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g, "");
      if (slim !== css) writeFileSync(file, slim);
    } else if (/^KaTeX_.*\.(woff|ttf)$/.test(name)) {
      rmSync(file);
    }
  }
}

const ids = readdirSync(source).filter((id) => existsSync(join(source, id, "plugin.json")) && (only.length === 0 || only.includes(id)));
mkdirSync(out, { recursive: true });

for (const id of ids) {
  const dir = join(source, id);
  const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as { version?: string };
  const target = join(out, id);
  rmSync(target, { recursive: true, force: true });
  if (existsSync(join(dir, "index.html"))) {
    await build({
      root: dir,
      base: "./", // 扩展从自己的地址加载，资源用相对路径
      logLevel: "warn",
      build: { outDir: target, emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
    });
    slimFonts(target);
  } else {
    mkdirSync(target, { recursive: true });
  }
  // 清单、图标、后端程序这些不经过构建的文件原样带上。
  for (const name of readdirSync(dir)) {
    if (["src", "index.html", "node_modules"].includes(name) || name.startsWith(".")) continue;
    cpSync(join(dir, name), join(target, name), { recursive: true });
  }
  const zip = join(out, `${id}-${manifest.version ?? "0.0.0"}.zip`);
  rmSync(zip, { force: true });
  const r = spawnSync("go", ["run", "./tools/pack-ext", target, zip], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`✓ ${id} → ${zip.slice(root.length + 1)}`);
}
