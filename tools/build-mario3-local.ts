// Local-only build: keep the assembled game out of the store release directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (!process.argv[2])
  throw Error(
    "用法：bun tools/build-mario3-local.ts <smb3 源码目录> [nesasm 可执行文件路径]",
  );
const source = resolve(process.argv[2]),
  assembler = process.argv[3] ? resolve(process.argv[3]) : "nesasm";
const temp = mkdtempSync(join(tmpdir(), "pocket-mario3-"));
function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(cmd + " 构建失败");
}
try {
  const game = join(temp, "source"),
    stage = join(temp, "extension");
  cpSync(source, game, {
    recursive: true,
    filter: (path) => ![".git", "smb3.nes"].includes(basename(path)),
  });
  run(assembler, ["smb3.asm"], game);
  const rom = readFileSync(join(game, "smb3.nes"));
  if (
    createHash("sha256").update(rom).digest("hex") !==
    "4377a7f5e6eb50bdd2ac6f249bf1a7085500aca8eb41f38545c3a2731c51a579"
  )
    throw Error("汇编结果不是预期的 SMB3 US PRG1。");
  run("bun", ["tools/build-extensions.ts", "mario3"], root);
  cpSync(join(root, "build/extensions/mario3"), stage, { recursive: true });
  writeFileSync(
    join(stage, "game.js"),
    "window.POCKET_SMB3=" + JSON.stringify(rom.toString("base64")) + ";",
  );
  const index = join(stage, "index.html");
  writeFileSync(
    index,
    readFileSync(index, "utf8").replace(
      "</head>",
      '<script src="./game.js"></script></head>',
    ),
  );
  const { version } = JSON.parse(
    readFileSync(join(stage, "plugin.json"), "utf8"),
  );
  const out = join(root, "build/local");
  mkdirSync(out, { recursive: true });
  run(
    "go",
    ["run", "./tools/pack-ext", stage, join(out, `mario3-${version}.zip`)],
    root,
  );
  console.log("本地游戏包：" + join(out, `mario3-${version}.zip`));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
