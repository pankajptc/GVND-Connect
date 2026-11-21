import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  plugins: [tailwindcss(), viteReact()],
  build: {
    outDir: ".output/public",
    emptyOutDir: false,
    rollupOptions: {
      input: "cap-index.html",
    },
  },
});
