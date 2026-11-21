import os from "node:os";
import { spawn } from "node:child_process";

const nets = os.networkInterfaces();
const ips = [];
for (const [name, list] of Object.entries(nets)) {
  if (/rmnet|ccmni|pdp|dummy|lo/i.test(name)) continue;
  for (const info of list || []) {
    if (info.family === "IPv4" && !info.internal) {
      ips.push({ name, address: info.address });
    }
  }
}

console.log("\n==================================================");
console.log("📡 GVND Connect — Live Hotspot & LAN Test Mode");
console.log("==================================================");
console.log("Local URL:   http://localhost:18081");
if (ips.length === 0) {
  console.log("⚠️  Koi active Hotspot/Wi-Fi IP nahi mila! Pehle Mobile Hotspot ON karein.");
} else {
  for (const item of ips) {
    console.log(`Hotspot/LAN (${item.name}): http://${item.address}:18081`);
  }
}
console.log("==================================================\n");

const child = spawn("npm", ["run", "dev", "--", "--host", "0.0.0.0", "--port", "18081"], {
  stdio: "inherit",
  shell: true
});
child.on("exit", (code) => process.exit(code ?? 0));
