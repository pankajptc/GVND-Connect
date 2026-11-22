import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [tailwindcss(), viteReact()],
  server: {
    watch: {
      ignored: ["**/android/**", "**/.output/**", "**/node_modules/**"],
    },
  },
  build: {
    outDir: ".output/public",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: "cap-index.html",
    },
  },
});
