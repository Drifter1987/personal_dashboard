/* Verification-only server: serves the dashboard's static files and the real worker.js
 * fetch handler from ONE origin (127.0.0.1:8787), so the browser can exercise the
 * Worker-backed code paths (CSP 'self', no CORS) with the exact shipped Worker code. */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const store = new Map();
globalThis.caches = {
  default: {
    async match(r) { const k = typeof r === "string" ? r : r.url; const v = store.get(k); return v ? v.clone() : undefined; },
    async put(r, res) { const k = typeof r === "string" ? r : r.url; store.set(k, res.clone()); }
  }
};
const { default: worker } = await import("./worker.js");

const ROOT = process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8"
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:8787");
    if (url.pathname.startsWith("/api/")) {
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers }), {});
      const h = {};
      r.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(r.status, h);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (p === "/" || p === "\\") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e && e.stack || e));
  }
}).listen(8787, "127.0.0.1", () => console.log("static + worker on http://127.0.0.1:8787"));
