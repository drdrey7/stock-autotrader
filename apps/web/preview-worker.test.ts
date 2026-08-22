import { describe, expect, it, vi } from "vitest";
import type { StockDetailApiResponse } from "@stock-autotrader/contracts";
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

  it("serves an isolated typed Stock Detail fixture without calling production", async () => {
    const productionApi = { fetch: vi.fn(async () => new Response("must not run")) };
    const { env } = previewEnv(new Response("branch asset"), productionApi);

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/msft/detail"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-stock-detail-preview-fixture")).toBe("1");
    const body = await response.json() as StockDetailApiResponse;
    expect(body.symbol).toBe("MSFT");
    expect(body.company.name).toBe("Microsoft Corporation");
    expect(body.quote.price).toBe(500);
    expect(body.quote.scaleState).toBe("safe");
    expect(body.chart.priceHistory).toHaveLength(260);
    expect(body.chart.intrinsicValueHistory).toEqual([]);
    expect(productionApi.fetch).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("keeps all four NVDA supports and IV visible in the visual fixture", async () => {
    const { env, productionApi } = previewEnv();
    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/NVDA/detail"),
      env,
    );
    const body = await response.json() as StockDetailApiResponse;

    expect(response.status).toBe(200);
    expect(body.valuation.intrinsicValue?.base).toBe(212.04);
    expect(body.technical.supports.map((support) => support.price)).toEqual([204.99, 187.16, 169.34, 151.51]);
    expect(body.technical.supports.map((support) => support.level)).toEqual([1, 2, 3, 4]);
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("represents CRCL insufficient history honestly in the visual fixture", async () => {
    const { env, productionApi } = previewEnv();
    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/CRCL/detail"),
      env,
    );
    const body = await response.json() as StockDetailApiResponse;
    expect(response.status).toBe(200);
    expect(body.valuation.intrinsicValue).toBeNull();
    expect(body.technical.sma200w).toBeNull();
    expect(body.technical.sma200wHistory).toEqual([]);
    expect(body.chart.priceHistory).toHaveLength(60);
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("does not turn an un-fixtured Core symbol into a false not-found", async () => {
    const { env, productionApi } = previewEnv();
    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/AAPL/detail"),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "preview_stock_detail_fixture_unavailable" });
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("returns the real not-found contract for invalid Stock Detail symbols", async () => {
    const { env, productionApi } = previewEnv();
    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/stocks/INVALID/detail"),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "stock_not_found" });
    expect(productionApi.fetch).not.toHaveBeenCalled();
  });

  it("rejects Stock Detail preview mutations without invoking production", async () => {
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
