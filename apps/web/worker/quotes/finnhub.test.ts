import { describe, expect, it } from "vitest";
import { FinnhubQuoteProvider, mapWithConcurrency, normalizeFinnhubQuote } from "./finnhub";
import { FinnhubRequestGate } from "../earnings/providers";

const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const instantGate = () => new FinnhubRequestGate(0, () => Promise.resolve());
const noSleep = () => new Promise<void>((resolve) => resolve());

const VALID_PAYLOAD = { c: 232.5, d: 2.1, dp: 0.91, h: 234, l: 230, o: 231, pc: 230.4, t: 1_786_000_000 };

const fetcherForPayload = (f: (input: string, init?: RequestInit) => Promise<Response>) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => f(String(input), init)) as unknown as typeof fetch;

describe("normalizeFinnhubQuote", () => {
  it("maps Finnhub fields to provider-neutral observations", () => {
    const observation = normalizeFinnhubQuote("AAPL", VALID_PAYLOAD);
    expect(observation).toEqual({
      symbol: "AAPL",
      price: 232.5,
      changeAbs: 2.1,
      changePct: 0.91,
      dayHigh: 234,
      dayLow: 230,
      dayOpen: 231,
      previousClose: 230.4,
      asOf: new Date(1_786_000_000 * 1000).toISOString(),
      provider: "finnhub-quote",
    });
  });

  it("keeps Finnhub vocabulary out of the internal shape", () => {
    const observation = normalizeFinnhubQuote("MSFT", VALID_PAYLOAD);
    expect(observation).not.toHaveProperty("c");
    expect(observation).not.toHaveProperty("d");
    expect(observation).not.toHaveProperty("dp");
    expect(observation).not.toHaveProperty("pc");
    expect(observation).toHaveProperty("price", 232.5);
    expect(observation).toHaveProperty("provider", "finnhub-quote");
  });

  it("returns null for malformed or incomplete payloads", () => {
    expect(normalizeFinnhubQuote("AAPL", null)).toBeNull();
    expect(normalizeFinnhubQuote("AAPL", { c: "nope", d: 1, dp: 1, t: 1 })).toBeNull();
    expect(normalizeFinnhubQuote("AAPL", { c: 100, d: 1, dp: 1 })).toBeNull(); // missing t
    expect(normalizeFinnhubQuote("AAPL", { c: 0, d: 1, dp: 1, t: 1 })).toBeNull(); // zero price
    expect(normalizeFinnhubQuote("AAPL", { c: 100, d: null, dp: 1, t: 1 })).toBeNull();
    expect(normalizeFinnhubQuote("AAPL", { c: 100, d: 1, dp: null, t: 1 })).toBeNull();
    expect(normalizeFinnhubQuote("AAPL", { c: 100, d: 1, dp: 1, t: 0 })).toBeNull();
  });
});

describe("FinnhubQuoteProvider", () => {
  it("sends the token via X-Finnhub-Token header and never in the URL", async () => {
    const urls: string[] = [];
    const headers: Record<string, string | undefined> = {};
    const provider = new FinnhubQuoteProvider("secret-key", fetcherForPayload((input, init) => {
      urls.push(input);
      const raw = init?.headers as Record<string, string> | undefined;
      headers["token"] = raw?.["X-Finnhub-Token"];
      return Promise.resolve(ok(VALID_PAYLOAD));
    }), noSleep, 8_000, instantGate());

    const result = await provider.collect(["AAPL"]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.symbol).toBe("AAPL");
    expect(urls[0]).toBe("https://finnhub.io/api/v1/quote?symbol=AAPL");
    expect(urls[0]).not.toContain("secret-key");
    expect(headers["token"]).toBe("secret-key");
  });

  it("keeps valid quotes when one symbol fails (partial shard)", async () => {
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload((input) => {
      const symbol = input.split("symbol=")[1] ?? "";
      return symbol === "MSFT"
        ? Promise.resolve(new Response("boom", { status: 500 }))
        : Promise.resolve(ok(VALID_PAYLOAD));
    }), noSleep, 8_000, instantGate());

    const result = await provider.collect(["AAPL", "MSFT"]);
    expect(result.observations.map((observation) => observation.symbol)).toEqual(["AAPL"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("MSFT");
    expect(result.rateLimited).toBe(false);
  });

  it("flags rate limiting on 429 after retries without losing other symbols", async () => {
    let rateCalls = 0;
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload((input) => {
      const symbol = input.split("symbol=")[1] ?? "";
      if (symbol === "RATE") {
        rateCalls += 1;
        return Promise.resolve(new Response("{}", { status: 429 }));
      }
      return Promise.resolve(ok(VALID_PAYLOAD));
    }), (ms) => new Promise((resolve) => setTimeout(resolve, ms)), 8_000, instantGate());

    const result = await provider.collect(["AAPL", "RATE"]);
    expect(result.rateLimited).toBe(true);
    expect(result.observations.map((observation) => observation.symbol)).toEqual(["AAPL"]);
    expect(result.warnings[0]).toContain("RATE");
    expect(rateCalls).toBeGreaterThanOrEqual(2);
  });

  it("times out a hung provider and records the symbol as failed", async () => {
    const hung = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    });
    const provider = new FinnhubQuoteProvider(
      "k",
      hung as unknown as typeof fetch,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      30,
      instantGate(),
    );
    const result = await provider.collect(["AAPL"]);
    expect(result.observations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("AAPL");
  });

  it("never exceeds the bounded concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return ok(VALID_PAYLOAD);
    }), noSleep, 8_000, instantGate());

    const symbols = Array.from({ length: 10 }, (_, index) => `S${index}`);
    const result = await provider.collect(symbols);
    expect(result.observations).toHaveLength(10);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order through a bounded worker pool", async () => {
    const mapped = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 10 - value));
      return value * 2;
    });
    expect(mapped).toEqual([0, 2, 4, 6, 8]);
  });

  it("handles an empty input", async () => {
    await expect(mapWithConcurrency([], 2, async () => 1)).resolves.toEqual([]);
  });
});
