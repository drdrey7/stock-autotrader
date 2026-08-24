import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Small, correct JSONC reader. The repository has no reusable JSONC helper, so
// this tokenizes comment stripping AND trailing-comma removal while preserving
// string contents (including strings that look like comments). It must support
// `//` comments, `/* */` comments, trailing commas, and escaping inside strings.
function parseJsonc(raw) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  const n = raw.length;
  const skipWs = (index) => {
    while (index < n && /[ \t\r\n]/.test(raw[index])) index += 1;
    return index;
  };
  let i = 0;
  while (i < n) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 2; }
      else i += 1;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { if (i + 1 < n) { out += raw[i + 1]; i += 2; } else i += 1; continue; }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; out += c; i += 1; continue; }
    if (c === "/" && next === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
    if (c === ",") {
      const nextToken = skipWs(i + 1);
      if (nextToken < n && (raw[nextToken] === "}" || raw[nextToken] === "]")) { i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out);
}

function readJsonc(path) {
  return parseJsonc(readFileSync(path, "utf8"));
}

describe("AI Analysis routing and bindings", () => {
  it("parses JSONC comments, trailing commas, and comment-like strings", () => {
    const jsonc = `
    {
      // line comment
      /* block comment */
      "name": "stock-autotrader-ai-analysis", // tail comment
      "url": "https://example.test/a//double-slash",
      "glob": "/api/ai-analysis/*",
      "triggers": { "crons": ["*/15 * * * *", "0 6 * * *",] },
    }`;
    const parsed = parseJsonc(jsonc);
    expect(parsed.name).toBe("stock-autotrader-ai-analysis");
    expect(parsed.url).toBe("https://example.test/a//double-slash");
    expect(parsed.glob).toBe("/api/ai-analysis/*");
    expect(parsed.triggers.crons).toEqual(["*/15 * * * *", "0 6 * * *"]);
  });
  it("routes protected POSTs before the Worker's global read-only method gate", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/ai-analysis/runs", {
        method: "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ symbol: "MSFT" }),
      }),
      {
        DB: {},
        ASSETS: { fetch: vi.fn() },
        AI_ANALYSIS_QUEUE: { send: vi.fn() },
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ai_analysis_auth_unavailable" });
  });

  it("declares the producer only on the production Worker", () => {
    const production = JSON.parse(readFileSync(resolve(__dirname, "../../wrangler.jsonc"), "utf8"));
    const preview = JSON.parse(readFileSync(resolve(__dirname, "../../wrangler.preview.jsonc"), "utf8"));
    expect(production.queues.producers).toEqual([
      { binding: "AI_ANALYSIS_QUEUE", queue: "stock-autotrader-ai-analysis" },
    ]);
    expect(preview.queues).toBeUndefined();
  });
});
