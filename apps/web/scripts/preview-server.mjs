#!/usr/bin/env node
/**
 * Production-like static preview server for the Playwright E2E suite.
 *
 * `vite preview` never reads Cloudflare's `_headers`, so the E2E tests would
 * run without the Content-Security-Policy (and other security headers) the
 * deployed site enforces — the gap OpenCode flagged as a P2. This tiny server
 * serves the built `dist/` exactly as Cloudflare Workers Static Assets would,
 * applying the production `_headers` rules parsed from the single source of
 * truth (`public/_headers`). It keeps the SPA fallback (`index.html`) for the
 * client-side routes and serves `/assets/*` with the immutable cache header.
 *
 * Usage: node scripts/preview-server.mjs [port]
 * (Playwright's `webServer` runs it after `npm run build`.)
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const distDir = path.join(webDir, "dist");
const headersFile = path.join(webDir, "public", "_headers");
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);

/** Parse a Cloudflare `_headers` file into [{ selector, headers }] rules. */
function parseCloudflareHeaders(source) {
  const rules = [];
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    if (/^\s/.test(rawLine)) {
      // Indented header line belonging to the current selector.
      const index = rawLine.indexOf(":");
      if (index === -1 || !current) continue;
      const name = rawLine.slice(0, index).trim();
      const value = rawLine.slice(index + 1).trim();
      if (name && value) current.headers.push([name, value]);
    } else {
      current = { selector: rawLine.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

const headerPathMatches = (selector, pathname) => {
  if (selector === "*" || selector === "/*") return true;
  const pattern = selector.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${pattern}$`).test(pathname);
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const headersRules = parseCloudflareHeaders(readFileSync(headersFile, "utf8"));

function applyHeaders(res, pathname) {
  for (const rule of headersRules) {
    if (!headerPathMatches(rule.selector, pathname)) continue;
    for (const [name, value] of rule.headers) {
      // Only set headers the response doesn't already carry so a later, more
      // specific rule can still win (Cloudflare merges the same way).
      if (!res.getHeader(name)) res.setHeader(name, value);
    }
  }
}

function sendFile(res, filePath, pathname) {
  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  applyHeaders(res, pathname);
  createReadStream(filePath).pipe(res);
}

function sendIndexFallback(res, pathname) {
  const indexFile = path.join(distDir, "index.html");
  if (!existsSync(indexFile)) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("dist/index.html missing — run `npm run build` first");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  applyHeaders(res, pathname);
  createReadStream(indexFile).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Decode once and collapse trailing slashes before resolving against dist.
  const decoded = decodeURIComponent(url.pathname);
  let candidate = path.normalize(path.join(distDir, decoded));

  // Path traversal guard: the resolved path must stay inside dist.
  const relative = path.relative(distDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(res, candidate, url.pathname);
    return;
  }

  // `/assets/*` files are always real files; everything else is a client-side
  // route that gets the SPA fallback.
  if (decoded.startsWith("/assets/")) {
    res.statusCode = 404;
    applyHeaders(res, url.pathname);
    res.end("Not found");
    return;
  }

  sendIndexFallback(res, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Production-headers preview server serving ${distDir} at http://127.0.0.1:${port}`);
});
