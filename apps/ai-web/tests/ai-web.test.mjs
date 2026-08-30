import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("AI Web keeps its deployable app and narrow backend boundary", async () => {
  const [config, worker] = await Promise.all([read("wrangler.preview.jsonc"), read("worker.js")]);
  assert.match(config, /"name": "ai-web-preview"/);
  assert.match(config, /"main": "\.\/worker\.js"/);
  assert.match(config, /"directory": "\.\/dist"/);
  assert.match(config, /"binding": "AI_BACKEND"/);
  assert.match(config, /"service": "stock-autotrader-web"/);
  assert.doesNotMatch(config, /d1_databases|queues|secrets|FINNHUB|INGEST_SECRET/i);
  assert.match(worker, /\/api\/auth\//);
  assert.match(worker, /\/api\/ai-analysis\//);
  assert.match(worker, /cross_site_request_rejected/);
  assert.match(worker, /AI_BACKEND\.fetch/);
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

test("public copy contains no unsupported social proof", async () => {
  const landing = await read("src/pages/LandingPage.tsx");
  assert.doesNotMatch(landing, /99\.9|50K|users|testimonials|average analysis time/i);
  assert.match(landing, /Multi-Agent AI Research/);
});
