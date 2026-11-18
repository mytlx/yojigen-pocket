import { defineConfig } from "mygo-cli";

import { spawnSync } from "node:child_process";

// Pin the identity per checkout so subsequent builds use the same certificate.
const localIdentity = process.platform === "darwin" && !process.env.CI
  ? spawnSync("git", ["config", "--local", "--get", "pocket.signingIdentity"], { encoding: "utf8" }).stdout?.trim()
  : undefined;

export default defineConfig({
  name: "Yojigen Pocket",
  slug: "yojigen-pocket",
  identifier: "com.yojigen.pocket",
  version: "0.2.0",
  copyright: "© 2026 Yojigen Pocket",
  publisher: "Yojigen Pocket",
  // `mygo dev` 运行 devCommand 并加载 devUrl；`mygo build` 运行 buildCommand 并把 frontendDist 打进程序。
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  urlSchemes: ["yojigen-pocket"],
  macos: {
    // macOS 的图标四周要留边，Windows 的要撑满，所以分开两份（都由 tools/gen-icons 生成）。
    icon: "resources/icon.icns",
    // 没有程序坞图标，常驻后台。
    // 声明支持中文：系统的文件对话框、应用名等才会按中文给。
    infoPlist: {
      LSUIElement: true,
      CFBundleDevelopmentRegion: "zh_CN",
      CFBundleLocalizations: ["zh_CN", "en"],
      CFBundleAllowMixedLocalizations: true,
    },
    minimumSystemVersion: "13.0",
    // 签名。不设置就是 ad-hoc：每次构建的签名都不一样，系统会把新版本当成另一个应用，
    // 辅助功能、屏幕录制这些权限每次更新后都要重新授权。设置了固定的证书就不会
    //（做法见 docs/guide.md 的“macOS 的权限和签名”）。
    signingIdentity: process.env.POCKET_SIGN_IDENTITY || localIdentity || undefined,
  },
  windows: {
    displayName: "Yojigen Pocket",
  },
});
