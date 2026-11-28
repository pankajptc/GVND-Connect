import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { MeshApp } from "./components/mesh/MeshApp";

if (typeof window !== "undefined") {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isApk = Boolean((window as any).AndroidBridge) || window.location.port !== "18081";
    if (isApk && (rawUrl.startsWith("/api/mesh") || rawUrl.startsWith("/api/rtc"))) {
      const localTarget = "http://127.0.0.1:18081" + rawUrl;
      // Also mirror POST sync/ack to any LAN-discovered peer nodes in background
      if (init?.method === "POST" && rawUrl.startsWith("/api/mesh") && (window as any).AndroidBridge?.getDiscoveredNodes) {
        try {
          const nodes: string[] = JSON.parse((window as any).AndroidBridge.getDiscoveredNodes() || "[]");
          for (const nodeOrigin of nodes) {
            if (nodeOrigin && !nodeOrigin.includes("127.0.0.1")) {
              void origFetch(nodeOrigin + rawUrl, init).catch(() => {});
            }
          }
        } catch {}
      }
      return origFetch(localTarget, init);
    }
    return origFetch(input, init);
  };
}

if (import.meta.env.PROD || (typeof window !== "undefined" && Boolean((window as any).Capacitor))) {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  console.trace = noop;
  console.table = noop;
}

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<MeshApp />);
}
