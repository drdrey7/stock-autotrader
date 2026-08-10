import { describe, expect, it } from "vitest";
import { handleDemoRequest } from "./index";
import { scanSchema, strategySchema } from "./schemas";
import { openApiDocument } from "./openapi";

describe("read-only public API", () => {
  it("returns a validated candidate collection", async () => {
    const response = handleDemoRequest(
      new Request("https://example.test/api/candidates"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Array<{ symbol: string }>;
    expect(payload[0]?.symbol).toBe("NVDA");
  });

  it("fails closed for unknown and invalid resources", () => {
    expect(
      handleDemoRequest(
        new Request("https://example.test/api/stocks/../../secret"),
      ).status,
    ).toBe(404);
    expect(
      handleDemoRequest(new Request("https://example.test/api/unknown")).status,
    ).toBe(404);
  });

  it("accepts every strategy lifecycle state supported by D1", () => {
    const strategy = {
      id: "trend_breakout_v1",
      name: "Trend Breakout",
      version: "1.0.0",
      description: "Point-in-time baseline",
      state: "Out-of-Sample",
      enabled: true,
      universe: "US Core",
      holdingPeriod: "5–30 sessions",
      signalsToday: 0,
      openPositions: 0,
      parameters: {},
    };
    expect(strategySchema.parse(strategy).state).toBe("Out-of-Sample");
  });

  it("documents required path parameters without advertising absent rate limiting", () => {
    const stockPath = openApiDocument.paths["/api/stocks/{symbol}"];
    if (!stockPath) throw new Error("Stock path must be documented");
    expect(stockPath.get.parameters?.[0]).toMatchObject({
      name: "symbol",
      in: "path",
      required: true,
    });
    expect(
      stockPath.get.responses["200"].content["application/json"].schema,
    ).toEqual({
      $ref: "#/components/schemas/Candidate",
    });
    expect(JSON.stringify(openApiDocument)).not.toContain('"429"');
    expect(openApiDocument.components.schemas.Candidate.required).toEqual([
      "symbol",
      "company",
      "sector",
      "marketCap",
      "price",
      "quantScore",
      "strategyId",
      "strategyVersion",
      "strategy",
      "trend",
      "momentum",
      "relativeStrength",
      "relativeVolume",
      "earningsDate",
      "earningsProximityDays",
      "status",
      "direction",
      "updatedAt",
      "reasons",
    ]);
  });

  it("uses one validated scan DTO in demo mode", async () => {
    const response = handleDemoRequest(
      new Request("https://example.test/api/scans/latest"),
    );
    expect(response.status).toBe(200);
    const scan = scanSchema.parse(await response.json());
    expect(scan).toMatchObject({
      scanType: "SMOKE",
      status: "COMPLETED",
      candidates: 14,
      demo: true,
    });
  });
});
