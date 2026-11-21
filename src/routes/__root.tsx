import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";

const APP_NAME = "GVND Connect";

export const Route = createRootRoute({
  notFoundComponent: () => null,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: APP_NAME },
      {
        name: "description",
        content: "GVND Connect — decentralized offline & online mesh.",
      },
      { name: "theme-color", content: "#0b141a" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: "/app.css" },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning style={{ backgroundColor: "#0b141a", color: "#e8edef" }}>
      <head>
        <HeadContent />
      </head>
      <body style={{ margin: 0, backgroundColor: "#0b141a", color: "#e8edef" }}>
        <div
          id="__gvnd_err"
          style={{
            display: "none",
            position: "fixed",
            inset: 12,
            zIndex: 99999,
            backgroundColor: "#1a0b0b",
            color: "#fecaca",
            border: "2px solid #ef4444",
            borderRadius: 12,
            padding: 14,
            fontFamily: "monospace",
            fontSize: 12,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                function showErr(tag, msg, stack) {
                  var el = document.getElementById('__gvnd_err');
                  if (el) {
                    el.style.display = 'block';
                    el.textContent += '[' + tag + '] ' + msg + '\\n' + (stack || '') + '\\n---\\n';
                  }
                  try {
                    fetch('/api/mesh', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'debug', id: 'win_err', status: tag, detail: String(msg) + ' | ' + String(stack || '').slice(0, 400) })
                    }).catch(function(){});
                  } catch(e) {}
                }
                window.addEventListener('error', function(e) {
                  showErr('JS_ERROR', e.message || e.error, (e.filename || '') + ':' + (e.lineno || '') + ' ' + (e.error && e.error.stack ? e.error.stack : ''));
                });
                window.addEventListener('unhandledrejection', function(e) {
                  var r = e.reason;
                  showErr('PROMISE_ERR', r && r.message ? r.message : String(r), r && r.stack ? r.stack : '');
                });
              })();
            `,
          }}
        />
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
