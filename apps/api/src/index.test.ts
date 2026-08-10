import { describe, expect, it } from "vitest";
import { handleDemoRequest } from "./index";

describe("read-only public API", () => {
  it("returns a validated candidate collection", async () => {
    const response = handleDemoRequest(new Request("https://example.test/api/candidates"));
    expect(response.status).toBe(200);
    const payload = await response.json() as Array<{ symbol: string }>;
    expect(payload[0]?.symbol).toBe("NVDA");
  });

  it("fails closed for unknown and invalid resources", () => {
    expect(handleDemoRequest(new Request("https://example.test/api/stocks/../../secret")).status).toBe(404);
    expect(handleDemoRequest(new Request("https://example.test/api/unknown")).status).toBe(404);
  });
});

