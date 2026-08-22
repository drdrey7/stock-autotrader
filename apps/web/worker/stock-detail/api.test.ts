import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- Vite resolves test-only ?raw imports; Worker typecheck intentionally has no Vite client types.
import indexSource from "../index.ts?raw";

const readModelMock = vi.hoisted(() => ({ readStockDetailApi: vi.fn() }));
vi.mock("./read-model", () => ({ readStockDetailApi: readModelMock.readStockDetailApi }));

import { handleStockDetailApi } from "./api";
import type { Env } from "../index";

const env = { DB: {} as D1Database } as Env;

beforeEach(() => vi.clearAllMocks());

describe("handleStockDetailApi", () => {
  it("normalizes a Core Universe ticker and serves a short-cache public response", async () => {
    readModelMock.readStockDetailApi.mockResolvedValue({ schemaVersion: 1, symbol: "MSFT" });
    const response = await handleStockDetailApi("msft", env, new Date("2026-08-21T15:00:00.000Z"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(readModelMock.readStockDetailApi).toHaveBeenCalledWith(env, "MSFT", expect.any(Date));
  });

  it("returns 404 for a symbol outside Core Universe without touching D1/read model", async () => {
    const response = await handleStockDetailApi("INVALID", env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "stock_not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readModelMock.readStockDetailApi).not.toHaveBeenCalled();
  });

  it("returns 404 when a configured symbol is not active in the runtime Core universe", async () => {
    readModelMock.readStockDetailApi.mockRejectedValue(new Error("stock_not_found"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleStockDetailApi("MSFT", env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "stock_not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("returns sanitized 503 when the D1-backed read model fails", async () => {
    readModelMock.readStockDetailApi.mockRejectedValue(new Error("D1 secret internal detail"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleStockDetailApi("MSFT", env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "stock_detail_store_unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("routes /detail before the legacy /api/stocks/:symbol candidate endpoint", () => {
    const detailRoute = indexSource.indexOf("const stockDetailMatch");
    const legacyRoute = indexSource.indexOf("const stockMatch");
    expect(detailRoute).toBeGreaterThan(0);
    expect(legacyRoute).toBeGreaterThan(detailRoute);
    expect(indexSource).toContain("readCandidateBySymbol(env.DB, symbol)");
  });
});
