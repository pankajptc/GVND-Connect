import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [viteReact()],
  build: {
    outDir: ".output/public",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: "cap-index.html",
    },
  },
});
