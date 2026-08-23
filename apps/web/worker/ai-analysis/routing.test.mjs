import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("AI Analysis routing and bindings", () => {
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
