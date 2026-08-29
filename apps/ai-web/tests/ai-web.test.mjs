import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("AI Web keeps its deployable app and backend boundary", async () => {
  const config = await read("wrangler.preview.jsonc");
  assert.match(config, /"name": "ai-web-preview"/);
  assert.match(config, /"main": "\.\/dist\/server\/entry\.mjs"/);
  assert.match(config, /"binding": "AI_BACKEND"/);
  assert.doesNotMatch(config, /d1_databases|queues|secrets|FINNHUB|INGEST_SECRET/i);
});

test("public copy contains no unsupported social proof", async () => {
  const landing = await read("src/pages/index.astro");
  assert.doesNotMatch(landing, /99\.9|50K|users|testimonials|average analysis time/i);
  assert.match(landing, /Multi-agent AI stock analysis/);
});
