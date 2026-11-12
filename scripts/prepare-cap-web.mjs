import fs from "node:fs";
const outDir = ".output/public";
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
let html = fs.readFileSync("index.html", "utf8");
const assets = fs.existsSync(`${outDir}/assets`) ? fs.readdirSync(`${outDir}/assets`) : [];
const css = assets.find(f => f.endsWith(".css"));
const js = assets.find(f => f.startsWith("index-") && f.endsWith(".js"));
html = html.replace(
  /<script type="module" src="\/src\/main\.tsx"><\/script>/,
  (css ? `<link rel="stylesheet" href="/assets/${css}">\n    ` : "") +
  (js ? `<script type="module" src="/assets/${js}"></script>` : "")
);
fs.writeFileSync(`${outDir}/index.html`, html);
console.log("✅ Prepared .output/public/index.html with:", js, css);
