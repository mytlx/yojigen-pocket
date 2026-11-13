import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // `mygo dev` 时应用加载这个地址（mygo.config.ts 的 devUrl）。
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        launcher: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        feature: resolve(import.meta.dirname, "feature.html"),
        catalog: resolve(import.meta.dirname, "catalog.html"),
      },
    },
  },
});
