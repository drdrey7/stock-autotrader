import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardPayload } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("public API contract", () => {
  it("validates the central demo data against the dashboard schema", () => {
    const parsed = dashboardPayload.parse(demoData);
    expect(parsed.demo).toBe(true);
    expect(parsed.scan.universe).toBe(1648);
    expect(parsed.portfolio.initialCapital).toBe(10000);
    expect(parsed.candidates.length).toBeGreaterThan(0);
  });

  it("parses a live API payload (demo:false) with the same schema", async () => {
    const livePayload = { ...demoData, demo: false };
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(JSON.stringify(livePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    vi.stubEnv("VITE_DEMO_MODE", "false");
    vi.resetModules();
    const { getDashboardData } = await import("./api");
    const data = await getDashboardData();
    expect(data.demo).toBe(false);
    expect(data.status.apiHealth).toBe("healthy");
  });

  it("falls back to demo data when VITE_DEMO_MODE is not false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("should not be called");
    }));
    vi.resetModules();
    const { getDashboardData } = await import("./api");
    const data = await getDashboardData();
    expect(data.demo).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on non-ok API responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    vi.stubEnv("VITE_DEMO_MODE", "false");
    vi.resetModules();
    const { getDashboardData } = await import("./api");
    await expect(getDashboardData()).rejects.toThrow("Public API returned 503");
  });
});
