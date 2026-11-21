import fs from "node:fs";
import { execSync } from "node:child_process";

execSync("npx vite build --config vite.cap.config.ts", { stdio: "inherit" });
if (fs.existsSync(".output/public/cap-index.html")) {
  fs.copyFileSync(".output/public/cap-index.html", ".output/public/index.html");
}
console.log("✅ Built standalone Capacitor SPA into .output/public/index.html");
