if (import.meta.env.PROD || (typeof window !== "undefined" && Boolean((window as any).Capacitor))) {
  const noop = () => {};
  console.log = noop; console.info = noop; console.warn = noop; console.error = noop; console.debug = noop;
}
import React, { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MeshApp } from "@/components/mesh/MeshApp";

function reportClientError(_source: string, _message: string, _stack?: string) {}

class MeshErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null; info: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { err: null, info: "" };
  }
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    this.setState({ err, info: info.componentStack || "" });
    reportClientError("REACT_RENDER_CRASH", err.message, err.stack || info.componentStack || "");
  }
  render() {
    if (this.state.err) {
      return (
        <main
          style={{
            minHeight: "100dvh",
            backgroundColor: "#140909",
            color: "#fecaca",
            padding: "16px",
            fontFamily: "monospace",
            fontSize: "12px",
            overflow: "auto",
          }}
        >
          <h2 style={{ fontSize: "16px", fontWeight: "bold", color: "#f87171", marginBottom: "8px" }}>
            GVND Connect Render Error
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {String(this.state.err.stack || this.state.err.message)}
          </pre>
          <pre style={{ marginTop: "12px", whiteSpace: "pre-wrap", fontSize: "11px", color: "#fcd34d" }}>
            {this.state.info}
          </pre>
        </main>
      );
    }
    return this.props.children;
  }
}

function ClientEntry() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <main
        style={{
          display: "grid",
          height: "100dvh",
          placeItems: "center",
          backgroundColor: "#0b141a",
          color: "#e8edef",
          padding: "24px",
          textAlign: "center",
          fontFamily: "sans-serif",
        }}
      >
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 600 }}>GVND Connect</h1>
          <p style={{ marginTop: "8px", fontSize: "14px", color: "#8b9aa3" }}>Starting offline mesh...</p>
        </div>
      </main>
    );
  }

  return (
    <MeshErrorBoundary>
      <MeshApp />
    </MeshErrorBoundary>
  );
}

export const Route = createFileRoute("/")({
  component: ClientEntry,
});
