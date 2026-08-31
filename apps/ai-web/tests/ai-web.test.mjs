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
  assert.match(config, /"run_worker_first"/);
  assert.match(config, /"\/api\/\*"/);
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
  assert.doesNotMatch(landing, /Invite a friend|receive one analysis credit/i);
  assert.match(landing, /referral rewards are not available/i);
  assert.match(landing, /Multi-Agent AI Research/);
});

test("workspace reuses pending analysis idempotency keys", async () => {
  const [appPage, idempotency] = await Promise.all([
    read("src/pages/AppPage.tsx"),
    read("src/lib/analysis/idempotency.ts"),
  ]);
  assert.match(appPage, /pendingAnalysisKey\(/);
  assert.match(appPage, /clearPendingAnalysisKey\(/);
  assert.match(appPage, /error\.status >= 400/);
  assert.match(appPage, /error\.status < 500/);
  assert.match(appPage, /error\.status !== 409/);
  assert.match(idempotency, /ai-web-analysis-pending-v1/);
  assert.match(idempotency, /MAX_PENDING_AGE_MS/);
});

test("report polling retries transient failures and renders sanitized markdown", async () => {
  const [report, markdown] = await Promise.all([
    read("src/pages/ReportPage.tsx"),
    read("src/components/report/SafeMarkdown.tsx"),
  ]);
  assert.match(report, /RETRY_POLL_MS/);
  assert.match(report, /connectionInterrupted/);
  assert.match(report, /isTerminalPollError/);
  assert.match(report, /SafeMarkdown/);
  assert.doesNotMatch(report, /ReportText/);
  assert.match(markdown, /react-markdown/);
  assert.match(markdown, /skipHtml/);
  assert.match(markdown, /safeMarkdownUrl/);
});

test("landing mirrors the canonical twelve-stage research sequence without repetition", async () => {
  const [landing, coverage] = await Promise.all([
    read("src/pages/LandingPage.tsx"),
    read("src/components/research/ResearchCoverage.tsx"),
  ]);
  for (const role of [
    "Market Analyst",
    "Sentiment Analyst",
    "News Analyst",
    "Fundamentals Analyst",
    "Bull Researcher",
    "Bear Researcher",
    "Research Manager",
    "Trader",
    "Aggressive Risk",
    "Neutral Risk",
    "Conservative Risk",
    "Portfolio Manager",
  ]) {
    assert.match(landing, new RegExp(role));
  }
  assert.match(landing, /twelve specialist roles/i);
  assert.doesNotMatch(landing, /seven specialists/i);
  assert.doesNotMatch(coverage, /research-roster|The desk|specialistRoles/);
});

test("one-credit section exposes valuable research sources without interaction", async () => {
  const coverage = await read("src/components/research/ResearchCoverage.tsx");
  assert.match(coverage, /What one credit buys/);
  assert.match(coverage, /What they actually/);
  assert.match(coverage, /Historical OHLCV candles/);
  assert.match(coverage, /Reddit: r\/wallstreetbets, r\/stocks and r\/investing/);
  assert.match(coverage, /StockTwits messages/);
  assert.match(coverage, /Yahoo Finance headlines/);
  assert.match(coverage, /FRED data when relevant/);
  assert.match(coverage, /Income statement analysis/);
  assert.match(coverage, /Balance sheet analysis/);
  assert.match(coverage, /Cash-flow statement analysis/);
  assert.match(coverage, /Bull Researcher/);
  assert.match(coverage, /Bear Researcher/);
  assert.match(coverage, /Research Manager/);
  assert.match(coverage, /Aggressive risk analysis/);
  assert.match(coverage, /Portfolio Manager final view/);
  assert.match(coverage, /does not claim that every source is used in every analysis/);
  assert.doesNotMatch(coverage, /<details|<summary|research-value-strip/);
  assert.doesNotMatch(coverage, /TradingAgents|Tauric|LangGraph/i);
});

test("sponsor marquee controls remain keyboard accessible", async () => {
  const sponsors = await read("src/components/sponsors/SponsorRail.tsx");
  assert.match(sponsors, /tabIndex=\{decorative \? -1 : undefined\}/);
});
