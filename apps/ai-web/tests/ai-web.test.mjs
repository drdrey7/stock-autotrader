import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker.js";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("AI Web keeps its deployable app and narrow backend boundary", async () => {
  const [config, source] = await Promise.all([read("wrangler.preview.jsonc"), read("worker.js")]);
  assert.match(config, /"name": "ai-web-preview"/);
  assert.match(config, /"main": "\.\/worker\.js"/);
  assert.match(config, /"directory": "\.\/dist"/);
  assert.match(config, /"binding": "AI_BACKEND"/);
  assert.match(config, /"service": "stock-autotrader-web"/);
  assert.doesNotMatch(config, /d1_databases|queues|secrets|FINNHUB|INGEST_SECRET/i);
  assert.match(source, /\/api\/auth\//);
  assert.match(source, /\/api\/ai-analysis\//);
  assert.match(source, /cross_site_request_rejected/);
  assert.match(source, /AI_BACKEND\.fetch/);
});

test("AI Web rejects private APIs and cross-site writes", async () => {
  let calls = 0;
  const env = {
    AI_BACKEND_ORIGIN: "https://stock-autotrader-web.barroso-labs.workers.dev",
    AI_BACKEND: { fetch: async () => { calls += 1; return new Response("{}"); } },
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  };

  for (const path of [
    "/api/quotes",
    "/api/screener",
    "/api/fundamentals",
    "/api/intrinsic-value",
    "/api/admin",
  ]) {
    const privateResponse = await worker.fetch(new Request(`https://ai.example${path}`), env);
    assert.equal(privateResponse.status, 404, `${path} must stay private`);
  }

  const csrfResponse = await worker.fetch(new Request("https://ai.example/api/ai-analysis/runs", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ symbol: "NVDA" }),
  }), env);
  assert.equal(csrfResponse.status, 403);
  assert.equal(csrfResponse.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
});

test("AI Web rewrites approved API requests to the canonical backend origin", async () => {
  let captured;
  const env = {
    AI_BACKEND_ORIGIN: "https://stock-autotrader-web.barroso-labs.workers.dev",
    AI_BACKEND: {
      fetch: async (request) => {
        captured = request;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "set-cookie": "session=test; Path=/; HttpOnly" },
        });
      },
    },
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  };

  const response = await worker.fetch(new Request("https://ai.example/api/ai-analysis/runs?source=workspace", {
    method: "POST",
    headers: {
      origin: "https://ai.example",
      referer: "https://ai.example/app",
      cookie: "session=abc",
      "content-type": "application/json",
      "idempotency-key": "12345678-1234-4234-9234-123456789012",
    },
    body: JSON.stringify({ symbol: "NVDA" }),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), "session=test; Path=/; HttpOnly");
  assert.ok(captured);
  assert.equal(new URL(captured.url).origin, env.AI_BACKEND_ORIGIN);
  assert.equal(new URL(captured.url).pathname, "/api/ai-analysis/runs");
  assert.equal(new URL(captured.url).search, "?source=workspace");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.get("origin"), env.AI_BACKEND_ORIGIN);
  assert.equal(captured.headers.get("referer"), `${env.AI_BACKEND_ORIGIN}/api/ai-analysis/runs?source=workspace`);
  assert.equal(captured.headers.get("cookie"), "session=abc");
  assert.equal(captured.headers.get("idempotency-key"), "12345678-1234-4234-9234-123456789012");
  assert.deepEqual(await captured.json(), { symbol: "NVDA" });
});

test("AI Analysis client uses the canonical backend contracts", async () => {
  const analysis = await read("src/lib/api/analysis.ts");
  assert.match(analysis, /@stock-autotrader\/contracts/);
  assert.match(analysis, /\/api\/ai-analysis\/catalog/);
  assert.match(analysis, /\/api\/ai-analysis\/viewer/);
  assert.match(analysis, /\/api\/ai-analysis\/runs/);
  assert.match(analysis, /idempotency-key/);
  assert.match(analysis, /\/api\/ai-analysis\/history/);
});

test("completed reports render every normalized backend section", async () => {
  const report = await read("src/pages/ReportPage.tsx");
  for (const field of [
    "executiveSummary",
    "investmentThesis",
    "marketAndTechnical",
    "fundamentals",
    "news",
    "sentiment",
    "bullCase",
    "bearCase",
    "researchManager",
    "traderPlan",
    "risk.aggressive",
    "risk.neutral",
    "risk.conservative",
    "portfolioManager",
    "priceTarget",
    "timeHorizon",
  ]) {
    assert.match(report, new RegExp(field.replace(".", "\\.")));
  }
  assert.match(report, /Final View/);
});

test("public copy contains no unsupported social proof", async () => {
  const landing = await read("src/pages/LandingPage.tsx");
  assert.doesNotMatch(landing, /99\.9|50K|users|testimonials|average analysis time/i);
  assert.match(landing, /Multi-Agent AI Research/);
});

test("landing explains what one analysis credit researches without overclaiming provenance", async () => {
  const coverage = await read("src/components/research/ResearchCoverage.tsx");
  assert.match(coverage, /What one credit buys/);
  assert.match(coverage, /Reddit investor discussions/);
  assert.match(coverage, /StockTwits sentiment/);
  assert.match(coverage, /Yahoo Finance news and market narrative/);
  assert.match(coverage, /Income statement analysis/);
  assert.match(coverage, /Balance sheet analysis/);
  assert.match(coverage, /Cash-flow statement analysis/);
  assert.match(coverage, /Aggressive risk analysis/);
  assert.match(coverage, /Portfolio Manager synthesises the final view/);
  assert.match(coverage, /does not claim that every source is used in every analysis/);
});

test("disclosure and sponsor-marquee controls remain keyboard accessible", async () => {
  const [coverage, sponsors, styles] = await Promise.all([
    read("src/components/research/ResearchCoverage.tsx"),
    read("src/components/sponsors/SponsorRail.tsx"),
    read("src/styles/globals.css"),
  ]);
  assert.match(coverage, /<details/);
  assert.match(coverage, /<summary>/);
  assert.match(styles, /summary:focus-visible/);
  assert.match(sponsors, /tabIndex=\{decorative \? -1 : undefined\}/);
});
