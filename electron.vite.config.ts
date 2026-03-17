import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "shared"),
        "@core": path.resolve(__dirname, "shared"),
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
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "shared"),
        "@core": path.resolve(__dirname, "shared"),
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
        "@shared": path.resolve(__dirname, "shared"),
        "@core": path.resolve(__dirname, "shared"),
        "@ui": path.resolve(__dirname, "desktop/ui/src"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, "desktop/ui/index.html"),
      },
      outDir: path.resolve(__dirname, "dist"),
    },
  },
});
