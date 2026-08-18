import { describe, expect, it } from "vitest";
import { FinnhubQuoteProvider, mapWithConcurrency, normalizeFinnhubQuote } from "./finnhub";
import { FinnhubRequestGate, fetchJsonWithRetry } from "../earnings/providers";

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

  it("does NOT retry a 429 — marks rate limited, keeps the other symbols, single attempt", async () => {
    let rateCalls = 0;
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload((input) => {
      const symbol = input.split("symbol=")[1] ?? "";
      if (symbol === "RATE") {
        rateCalls += 1;
        return Promise.resolve(new Response("{}", { status: 429 }));
      }
      return Promise.resolve(ok(VALID_PAYLOAD));
    }), noSleep, 8_000, instantGate());

    const result = await provider.collect(["AAPL", "RATE"]);
    expect(result.rateLimited).toBe(true);
    expect(result.observations.map((observation) => observation.symbol)).toEqual(["AAPL"]);
    expect(result.warnings[0]).toContain("RATE");
    // 429 is per-minute budget exhaustion: retrying within the same window
    // only amplifies pressure. Exactly one attempt — the next cron recovers.
    expect(rateCalls).toBe(1);
  });

  it("does not sleep out a Retry-After on 429 (degraded now, recovering next cron)", async () => {
    const slept: number[] = [];
    const sleeper = async (ms: number) => { slept.push(ms); };
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload(() => {
      return Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    }), sleeper, 8_000, instantGate());

    const result = await provider.collect(["AAPL"]);
    expect(result.rateLimited).toBe(true);
    expect(result.observations).toHaveLength(0);
    // No 30s (or any) wait was incurred for the Retry-After hint.
    expect(slept.some((ms) => ms >= 30_000)).toBe(false);
  });

  it("preserves canonical US ADR / cross-listed symbols in quote URLs (FASE 4/5)", async () => {
    const urls: string[] = [];
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload((input) => {
      urls.push(String(input));
      return Promise.resolve(ok(VALID_PAYLOAD));
    }), noSleep, 8_000, instantGate());

    // TSM (NYSE ADR), NVO (NYSE ADR), ASML (NASDAQ US listing), NVDA (NASDAQ).
    const result = await provider.collect(["TSM", "NVO", "ASML", "NVDA"]);
    expect(result.observations.map((observation) => observation.symbol)).toEqual(["TSM", "NVO", "ASML", "NVDA"]);
    // Result/symbol order is preserved; physical request order is bounded and
    // concurrent, so compare URL sets.
    expect([...urls].sort()).toEqual([
      "https://finnhub.io/api/v1/quote?symbol=ASML",
      "https://finnhub.io/api/v1/quote?symbol=NVDA",
      "https://finnhub.io/api/v1/quote?symbol=NVO",
      "https://finnhub.io/api/v1/quote?symbol=TSM",
    ]);
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

  it("collects serially so the shared gate can pace every request", async () => {
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
    // QUOTES_BOUNDED_CONCURRENCY = 1: a synchronized 5-at-once burst must
    // never reach the provider (that burst pattern tripped the limiter in
    // production at 10 req/min).
    expect(maxActive).toBe(1);
  });

  it("is bounded by the execution deadline under a slow provider", async () => {
    const hung = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    });
    const started = Date.now();
    const provider = new FinnhubQuoteProvider(
      "k", hung as unknown as typeof fetch, noSleep, 50, instantGate(), 5,
    );
    const result = await provider.collect(["A", "B", "C", "D", "E"]);
    const elapsed = Date.now() - started;
    expect(result.observations).toHaveLength(0);
    // The first symbol's timed-out attempt overruns the tiny deadline, then
    // the guard stops issuing requests for the rest — no 30s wall risk.
    const skipped = result.warnings.filter((warning) => warning.includes("execution deadline exceeded"));
    expect(skipped).toHaveLength(4);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("preserves partial observations when a later symbol hits the deadline", async () => {
    const provider = new FinnhubQuoteProvider("k", fetcherForPayload(async (input, init) => {
      const symbol = input.split("symbol=")[1] ?? "";
      if (symbol === "C") {
        // Abort-aware like real fetch: the per-request timeout rejects fast.
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        });
      }
      return ok(VALID_PAYLOAD);
    }), noSleep, 30, instantGate(), 40);

    const result = await provider.collect(["A", "B", "C", "D", "E"]);
    // A and B land fast; C times out on its per-request abort; D/E are skipped
    // by the deadline. Good observations survive the shard.
    expect(result.observations.map((observation) => observation.symbol)).toEqual(["A", "B"]);
    const skipped = result.warnings.filter((warning) => warning.includes("execution deadline exceeded"));
    expect(skipped).toHaveLength(2);
    expect(result.warnings).toHaveLength(3);
  });

  it("default fetchJsonWithRetry still retries a 429 (earnings behaviour preserved)", async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return new Response("{}", { status: 429 }); };
    // noRetryOn429 defaults to false — the quotes opt-in must not leak into
    // the earnings adapters (they keep the 2-attempt retry on 429).
    await expect(
      fetchJsonWithRetry(fetcher as unknown as typeof fetch, new URL("https://example.test/q"), {}, noSleep,
        1_000, () => new FinnhubRequestGate(0, noSleep).beforeAttempt()),
    ).rejects.toThrow("HTTP 429");
    expect(calls).toBe(2);
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
