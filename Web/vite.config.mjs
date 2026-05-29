import { defineConfig } from "vite";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "./",
  define: {
    "import.meta": "{}",
  },
  plugins: [
    {
      name: "copy-differ-html-shell",
      closeBundle() {
        copyFileSync(
          resolve(import.meta.dirname, "index.html"),
          resolve(import.meta.dirname, "../Sources/Differ/Resources/Web/index.html"),
        );
      },
    },
  ],
  build: {
    outDir: resolve(import.meta.dirname, "../Sources/Differ/Resources/Web"),
    emptyOutDir: true,
    assetsDir: "assets",
    chunkSizeWarningLimit: 12_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/main.ts"),
      output: {
        entryFileNames: "assets/differ.js",
        assetFileNames: "assets/differ[extname]",
        format: "iife",
        name: "DifferWebBundle",
      },
    },
  },
});
