import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";

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
    const production = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
    const preview = JSON.parse(readFileSync(new URL("../../wrangler.preview.jsonc", import.meta.url), "utf8"));
    expect(production.queues.producers).toEqual([
      { binding: "AI_ANALYSIS_QUEUE", queue: "stock-autotrader-ai-analysis" },
    ]);
    expect(preview.queues).toBeUndefined();
  });
});
