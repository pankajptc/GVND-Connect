import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// Reuse already-compiled Tailwind CSS from npm run build (.output/public/assets/*.css) -> .output/public/app.css
const assetsDir = ".output/public/assets";
if (fs.existsSync(assetsDir)) {
  const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".css") && !f.startsWith("cap-"));
  if (cssFiles.length > 0) {
    fs.copyFileSync(path.join(assetsDir, cssFiles[0]), ".output/public/app.css");
    console.log("✅ Copied compiled Tailwind CSS:", cssFiles[0], "-> .output/public/app.css");
  }
}

execSync("npx vite build --config vite.cap.config.ts", { stdio: "inherit" });
if (fs.existsSync(".output/public/cap-index.html")) {
  fs.copyFileSync(".output/public/cap-index.html", ".output/public/index.html");
}
console.log("✅ Built standalone Capacitor SPA into .output/public/index.html in <2s");
