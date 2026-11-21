import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { MeshApp } from "./components/mesh/MeshApp";

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
