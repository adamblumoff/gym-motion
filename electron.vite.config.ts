import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@core": path.resolve(__dirname, "desktop/core"),
        "@main": path.resolve(__dirname, "desktop/main"),
      },
    },
    build: {
      lib: {
        entry: path.resolve(__dirname, "desktop/main/index.ts"),
      },
      outDir: "out/main",
    },
  },
  preload: {
    resolve: {
      alias: {
        "@core": path.resolve(__dirname, "desktop/core"),
      },
    },
    build: {
      lib: {
        entry: path.resolve(__dirname, "desktop/preload/index.ts"),
      },
      outDir: "out/preload",
    },
  },
  renderer: {
    root: path.resolve(__dirname, "desktop/ui"),
    resolve: {
      alias: {
        "@core": path.resolve(__dirname, "desktop/core"),
        "@ui": path.resolve(__dirname, "desktop/ui/src"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, "desktop/ui/index.html"),
      },
      outDir: path.resolve(__dirname, "dist"),
    },
  },
});
