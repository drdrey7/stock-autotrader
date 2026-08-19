import { describe, expect, it } from "vitest";
import {
  countQuoteStates,
  collectorStateFromRows,
  quoteState,
  quotesMarketState,
  quoteStaleAfterSeconds,
  QUOTES_OFF_SESSION_STALE_AFTER_SECONDS,
  QUOTES_SESSION_STALE_AFTER_SECONDS,
  withinMarketOpenGrace,
} from "./freshness";

// 2026-08-13 Thursday; 2026-08-14 Friday (EDT, UTC-4).
const FRIDAY_CLOSE = "2026-08-14T20:45:00.000Z"; // 16:45 ET Friday (post-close run)
const SATURDAY = new Date("2026-08-15T14:00:00.000Z"); // weekend
const MONDAY_PREOPEN = new Date("2026-08-17T12:00:00.000Z"); // 08:00 ET
const MONDAY_0930 = new Date("2026-08-17T13:30:00.000Z"); // 09:30 ET open
const MONDAY_0935 = new Date("2026-08-17T13:35:00.000Z"); // 09:35 ET (in grace)
const MONDAY_1000 = new Date("2026-08-17T14:00:00.000Z"); // 10:00 ET (after grace)
const MONDAY_1400 = new Date("2026-08-17T18:00:00.000Z"); // 14:00 ET mid-session

describe("market-aware quote freshness", () => {
  it("classifies the US equity session via the shared New York market calendar", () => {
    expect(quotesMarketState(MONDAY_0930)).toBe("regular");
    expect(quotesMarketState(new Date("2026-08-17T20:30:00Z"))).toBe("post_close"); // 16:30 ET
    expect(quotesMarketState(MONDAY_PREOPEN)).toBe("closed");
    expect(quotesMarketState(SATURDAY)).toBe("closed");
  });

  it("uses a short stale window in-session and a long one when closed", () => {
    expect(quoteStaleAfterSeconds(MONDAY_0930)).toBe(QUOTES_SESSION_STALE_AFTER_SECONDS);
    expect(quoteStaleAfterSeconds(SATURDAY)).toBe(QUOTES_OFF_SESSION_STALE_AFTER_SECONDS);
  });

  it("detects the post-open grace window only right after 09:30 ET", () => {
    expect(withinMarketOpenGrace(MONDAY_0930)).toBe(true);
    expect(withinMarketOpenGrace(MONDAY_0935)).toBe(true);
    expect(withinMarketOpenGrace(MONDAY_1000)).toBe(false);
    expect(withinMarketOpenGrace(MONDAY_1400)).toBe(false);
    expect(withinMarketOpenGrace(SATURDAY)).toBe(false); // weekend, not a session open
  });
});

describe("market-open grace (P2-1)", () => {
  it("keeps Friday close Cached over the weekend", () => {
    expect(quoteState(FRIDAY_CLOSE, SATURDAY)).toBe("Cached");
  });

  it("keeps Friday close Cached on Monday before the open", () => {
    expect(quoteState(FRIDAY_CLOSE, MONDAY_PREOPEN)).toBe("Cached");
  });

  it("keeps Friday close Cached at 09:30 ET while the sweep catches up", () => {
    expect(quoteState(FRIDAY_CLOSE, MONDAY_0930)).toBe("Cached");
    expect(quoteState(FRIDAY_CLOSE, MONDAY_0935)).toBe("Cached");
  });

  it("marks the first refresh of the session Live", () => {
    const firstRefresh = "2026-08-17T13:31:00.000Z"; // collected 09:31 ET
    expect(quoteState(firstRefresh, new Date("2026-08-17T13:32:00.000Z"))).toBe("Live");
    expect(quoteState(firstRefresh, MONDAY_0935)).toBe("Live");
  });

  it("lets a symbol without a current-session refresh become Stale after grace", () => {
    expect(quoteState(FRIDAY_CLOSE, MONDAY_1000)).toBe("Stale");
    expect(quoteState(FRIDAY_CLOSE, MONDAY_1400)).toBe("Stale");
  });

  it("never flashes ancient rows as Cached during the grace window", () => {
    const ancient = "2026-07-01T20:45:00.000Z"; // >7 days before the Monday open
    expect(quoteState(ancient, MONDAY_0935)).toBe("Stale");
  });

  it("is DST-safe: the same grace applies in EST (January)", () => {
    // Friday 2026-01-09 close (16:45 ET = 21:45Z) → Monday 2026-01-12 09:30 ET (14:30Z).
    const januaryFridayClose = "2026-01-09T21:45:00.000Z";
    const januaryMondayOpen = new Date("2026-01-12T14:30:00.000Z");
    expect(quoteState(januaryFridayClose, januaryMondayOpen)).toBe("Cached");
    const januaryMondayLate = new Date("2026-01-12T15:00:00.000Z"); // 10:00 ET
    expect(quoteState(januaryFridayClose, januaryMondayLate)).toBe("Stale");
  });

  it("never creates false stale on market holidays (closed stay Cached)", () => {
    // Memorial Day 2026-05-25 (Monday); previous Friday close stays Cached,
    // and the collector also reads healthy (all Cached, zero Stale).
    const holidayMonday = new Date("2026-05-25T14:00:00.000Z"); // 10:00 ET holiday
    const fridayClose = "2026-05-22T20:45:00.000Z";
    expect(quotesMarketState(holidayMonday)).toBe("closed");
    expect(quoteState(fridayClose, holidayMonday)).toBe("Cached");
  });

  it("still marks genuinely old closed-market data Stale", () => {
    const ancient = "2026-06-01T14:00:00.000Z";
    expect(quoteState(ancient, SATURDAY)).toBe("Stale");
  });

  it("treats missing or unreadable rows as Unavailable", () => {
    expect(quoteState(null, MONDAY_0930)).toBe("Unavailable");
    expect(quoteState("not-a-date", MONDAY_0930)).toBe("Unavailable");
  });
});

describe("collector state from per-stock states (P2-2)", () => {
  const counts = (over: Partial<ReturnType<typeof countQuoteStates>>): ReturnType<typeof countQuoteStates> => ({
    total: 50,
    live: 0,
    cached: 0,
    stale: 0,
    unavailable: 0,
    ...over,
  });

  it("reports Live only when every stock is fresh during market hours", () => {
    expect(collectorStateFromRows(counts({ live: 50 }), "regular")).toBe("Live");
  });

  it("is NOT Live when one stock is stale (49 fresh + 1 stale)", () => {
    expect(collectorStateFromRows(counts({ live: 49, stale: 1 }), "regular")).toBe("Stale");
  });

  it("is NOT Live when ten stocks are stale (40 fresh + 10 stale)", () => {
    expect(collectorStateFromRows(counts({ live: 40, stale: 10 }), "regular")).toBe("Stale");
  });

  it("does not penalize the market-open grace as an outage", () => {
    // 40 refreshed today (Live) + 10 previous-session closes still inside the
    // grace window (Cached) → healthy, not degraded.
    expect(collectorStateFromRows(counts({ live: 40, cached: 10 }), "regular")).toBe("Live");
    // After grace those 10 are Stale → non-Live.
    expect(collectorStateFromRows(counts({ live: 40, stale: 10 }), "regular")).toBe("Stale");
  });

  it("reads Cached (never a false Live or outage) right at the open before the sweep lands", () => {
    expect(collectorStateFromRows(counts({ cached: 50 }), "regular")).toBe("Cached");
  });

  it("is not Live while coverage is incomplete (unavailable symbols)", () => {
    expect(collectorStateFromRows(counts({ live: 10, unavailable: 40 }), "regular")).toBe("Stale");
    expect(collectorStateFromRows(counts({ unavailable: 50, total: 50 }), "regular")).toBe("Unavailable");
  });

  it("reads Cached when the market is closed and nothing is stale", () => {
    expect(collectorStateFromRows(counts({ cached: 50 }), "closed")).toBe("Cached");
    expect(collectorStateFromRows(counts({ cached: 45, stale: 5 }), "closed")).toBe("Stale");
  });

  it("reports Unavailable when there are no rows at all", () => {
    expect(collectorStateFromRows(counts({ total: 0, live: 0, cached: 0, stale: 0, unavailable: 0 }), "regular")).toBe("Unavailable");
    expect(collectorStateFromRows(counts({ total: 0 }), "closed")).toBe("Unavailable");
  });

  it("tallies counts from row states and folds Error into stale", () => {
    const rows = [
      { state: "Live" as const }, { state: "Live" as const }, { state: "Cached" as const },
      { state: "Stale" as const }, { state: "Error" as const }, { state: "Unavailable" as const },
    ];
    expect(countQuoteStates(rows)).toEqual({ total: 6, live: 2, cached: 1, stale: 2, unavailable: 1 });
  });

  it("recovers to Live once the shard is refreshed (all 50 fresh again)", () => {
    expect(collectorStateFromRows(counts({ live: 50 }), "regular")).toBe("Live");
    expect(collectorStateFromRows(counts({ stale: 50 }), "regular")).toBe("Stale");
  });
});

describe("post_close is OFF-session for per-row freshness (P2)", () => {
  // 2026-08-17 Monday regular day: close 16:00 ET = 20:00Z; post_close window
  // is 20:15–20:45Z (16:15–16:45 ET). The WS ingestor stops writing at close +
  // 5-min grace, so the last real write is ~20:05Z.
  const lastWrite = "2026-08-17T20:05:00.000Z"; // 16:05 ET close flush
  const queried1630 = new Date("2026-08-17T20:30:00.000Z"); // 16:30 ET post_close

  it("uses the long off-session staleness window during post_close", () => {
    expect(quotesMarketState(queried1630)).toBe("post_close");
    expect(quoteStaleAfterSeconds(queried1630)).toBe(QUOTES_OFF_SESSION_STALE_AFTER_SECONDS);
  });

  it("keeps the final-close row Cached at 16:30, NOT Stale", () => {
    expect(quoteState(lastWrite, queried1630)).toBe("Cached");
  });

  it("never reports Live during post_close even for a very recent write", () => {
    const recentWrite = "2026-08-17T20:28:00.000Z"; // 2 min before the query
    expect(quoteState(recentWrite, queried1630)).toBe("Cached");
  });

  it("decays to Stale only after the 7-day off-session window", () => {
    const ancient = "2026-08-01T20:05:00.000Z"; // >7 days before the query
    expect(quoteState(ancient, queried1630)).toBe("Stale");
  });

  it("applies the same semantics on an early-close day (Black Friday)", () => {
    // 2026-11-27 Black Friday: close 13:00 ET (18:00Z), post_close 18:15–18:45Z.
    const bfQueried = new Date("2026-11-27T18:30:00.000Z"); // 13:30 ET
    expect(quotesMarketState(bfQueried)).toBe("post_close");
    const bfLastWrite = "2026-11-27T18:05:00.000Z"; // 13:05 ET final flush
    expect(quoteState(bfLastWrite, bfQueried)).toBe("Cached");
    expect(quoteStaleAfterSeconds(bfQueried)).toBe(QUOTES_OFF_SESSION_STALE_AFTER_SECONDS);
  });

  it("still marks a fresh in-session write Live during the regular session", () => {
    const inSession = new Date("2026-08-17T18:00:00.000Z"); // 14:00 ET
    expect(quoteState("2026-08-17T17:59:00.000Z", inSession)).toBe("Live");
  });
});
