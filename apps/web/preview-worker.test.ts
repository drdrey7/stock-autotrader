import { describe, expect, it, vi } from "vitest";
import { handlePreviewRequest, type PreviewEnv } from "./preview-worker";

type ProductionApiStub = { fetch: ReturnType<typeof vi.fn> };

const previewEnv = (
  assetResponse = new Response("branch asset"),
  productionApi: ProductionApiStub = { fetch: vi.fn(async () => new Response('{"ok":true}')) },
): { env: PreviewEnv; productionApi: ProductionApiStub } => ({
  env: {
    ENVIRONMENT: "preview",
    ASSETS: { fetch: vi.fn(async () => assetResponse) } as unknown as Fetcher,
    PRODUCTION_API: productionApi as unknown as Fetcher,
    DB: undefined as unknown as D1Database,
  },
  productionApi,
});

describe("preview Worker", () => {
  it("serves normal frontend asset paths from the branch build", async () => {
    const { env } = previewEnv();
    const response = await handlePreviewRequest(new Request("https://preview.example/"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("branch asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("routes Stock Detail reads through the production service binding", async () => {
    const productionApi = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const downstream = input as Request;
        expect(downstream.url).toBe("https://stock-autotrader-web/api/stocks/MSFT/detail");
        expect(downstream.method).toBe("GET");
        return new Response('{"symbol":"MSFT"}');
      }),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/MSFT/detail"),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ symbol: "MSFT" });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("adds a COIN Automatic IV fixture only when production has no automatic valuation yet", async () => {
    const productionApi = {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        symbol: "COIN",
        quote: { price: 187.2 },
        valuation: { intrinsicValue: null },
        freshness: { valuationAsOf: null },
      }))),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/COIN/detail"),
      env,
    );
    const body = await response.json() as {
      valuation: {
        automatic: { bear: number; base: number; bull: number; method: string };
        selectedIntrinsicValue: { low: number; base: number; high: number; upsidePct: number };
      };
      freshness: { valuationAsOf: string };
    };

    expect(body.valuation.automatic).toMatchObject({
      bear: 150,
      base: 190,
      bull: 230,
      method: "Automatic IV V2 · preview fixture",
    });
    expect(body.valuation.selectedIntrinsicValue).toMatchObject({ low: 150, base: 190, high: 230 });
    expect(body.valuation.selectedIntrinsicValue.upsidePct).toBeCloseTo(1.4957, 3);
    expect(body.freshness.valuationAsOf).toBe("2026-08-26");
  });

  it("preserves a production Manual selection while adding the COIN Automatic comparison", async () => {
    const manual = {
      low: null,
      base: 175,
      high: null,
      method: "manual",
      asOf: "2026-08-01",
      upsidePct: -6.5,
    };
    const productionApi = {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        symbol: "COIN",
        quote: { price: 187.2 },
        valuation: {
          intrinsicValue: manual,
          selectedIntrinsicValue: manual,
          automatic: null,
        },
        freshness: { valuationAsOf: "2026-08-01" },
      }))),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/COIN/detail"),
      env,
    );
    const body = await response.json() as {
      valuation: {
        intrinsicValue: typeof manual;
        selectedIntrinsicValue: typeof manual;
        automatic: { base: number; method: string };
      };
      freshness: { valuationAsOf: string };
    };

    expect(body.valuation.intrinsicValue).toEqual(manual);
    expect(body.valuation.selectedIntrinsicValue).toEqual(manual);
    expect(body.valuation.automatic).toMatchObject({
      base: 190,
      method: "Automatic IV V2 · preview fixture",
    });
    expect(body.freshness.valuationAsOf).toBe("2026-08-01");
  });

  it("does not replace a real production Automatic IV for COIN", async () => {
    const productionAutomatic = {
      bear: 160,
      base: 200,
      bull: 240,
      method: "real-model",
    };
    const productionApi = {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        symbol: "COIN",
        quote: { price: 187.2 },
        valuation: { intrinsicValue: null, automatic: productionAutomatic },
      }))),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/COIN/detail"),
      env,
    );
    const body = await response.json() as { valuation: { automatic: typeof productionAutomatic } };
    expect(body.valuation.automatic).toEqual(productionAutomatic);
  });

  it("adds the same COIN Base IV to the preview Screener with canonical distance semantics", async () => {
    const productionApi = {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        rows: [
          { symbol: "COIN", price: 187.2, intrinsicValue: null },
          { symbol: "NVO", price: 48.65, intrinsicValue: { base: 72.96 } },
        ],
      }))),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/screener"),
      env,
    );
    const body = await response.json() as {
      rows: Array<{
        symbol: string;
        intrinsicValue: null | { low: number; base: number; high: number; method: string; distancePct?: number | null };
      }>;
    };
    const coin = body.rows.find((row) => row.symbol === "COIN");
    const nvo = body.rows.find((row) => row.symbol === "NVO");

    expect(coin?.intrinsicValue).toMatchObject({
      low: 150,
      base: 190,
      high: 230,
      method: "Automatic IV V2 · preview fixture",
    });
    expect(coin?.intrinsicValue?.distancePct).toBeCloseTo(-1.4737, 3);
    expect(nvo?.intrinsicValue).toEqual({ base: 72.96 });
  });

  it("rejects Stock Detail mutations without invoking production", async () => {
    const productionApi = { fetch: vi.fn(async () => new Response("must not run")) };
    const { env } = previewEnv(new Response("branch asset"), productionApi);
    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/MSFT/detail", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("routes unrelated same-origin API reads through the production service binding", async () => {
    const productionApi = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const downstream = input as Request;
        expect(downstream.url).toBe("https://stock-autotrader-web/api/status");
        expect(downstream.method).toBe("GET");
        expect(downstream.headers.get("accept")).toBe("application/json");
        expect(downstream.headers.get("authorization")).toBeNull();
        expect(downstream.headers.get("cookie")).toBeNull();
        return new Response('{"ok":true}');
      }),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/status", {
        headers: { authorization: "Bearer blocked", cookie: "blocked=1" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("rejects API mutations before invoking the production service binding", async () => {
    const productionApi = { fetch: vi.fn(async () => new Response("must not run")) };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/status", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("reports compact production read-model diagnostics without returning payloads", async () => {
    const productionApi = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String((input as Request).url)).pathname;
        if (path === "/api/status") return new Response('{"market":{"indices":[1,2,3,4]}}');
        if (path === "/api/market-context") return new Response('{"indices":[1,2,3,4]}');
        if (path === "/api/earnings") return new Response('{"events":[1,2,3]}');
        if (path === "/api/x/posts") return new Response('{"posts":[1,2]}');
        return new Response('{"title":"private briefing payload"}');
      }),
    };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(new Request("https://preview.example/__preview/diagnostics"), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      environment: "preview",
      upstream: "stock-autotrader-web",
      endpoints: {
        status: { http: 200, data: true },
        marketContext: { http: 200, count: 4 },
        earnings: { http: 200, count: 3 },
        x: { http: 200, count: 2 },
        briefing: { http: 200, available: true },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private briefing payload");
    expect(productionApi.fetch).toHaveBeenCalledTimes(5);
  });

  it("has no scheduled entrypoint", async () => {
    const moduleSource = await import("./preview-worker");
    expect("scheduled" in moduleSource.default).toBe(false);
  });
});