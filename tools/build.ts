// MyGo 0.7.4 always requests a timestamp for non-ad-hoc macOS signatures.
// Opt in per checkout for private local certificates only; keep release builds unchanged.
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

const env = { ...process.env };
const gitConfig = (...args: string[]) =>
  spawnSync("git", ["config", "--local", ...args], { encoding: "utf8" }).stdout?.trim();
if (process.platform === "darwin" && !env.CI && !env.POCKET_SIGN_IDENTITY &&
    gitConfig("--bool", "--get", "pocket.offlineSigning") === "true") {
  const identity = gitConfig("--get", "pocket.signingIdentity");
  if (identity && identity !== "-") {
    env.POCKET_LOCAL_SIGNER = identity;
    env.PATH = join(import.meta.dirname, "macos-local-sign") + delimiter + env.PATH;
    console.log("本地构建：使用固定证书签名，不请求在线时间戳。");
  }
}
const result = spawnSync("mygo", ["build", ...process.argv.slice(2)], { env, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
