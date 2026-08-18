import { describe, expect, it } from "vitest";
import {
  quoteState,
  quotesCollectorState,
  quotesMarketState,
  quoteStaleAfterSeconds,
  QUOTES_OFF_SESSION_STALE_AFTER_SECONDS,
  QUOTES_SESSION_STALE_AFTER_SECONDS,
} from "./freshness";

// 2026-08-13 is a Thursday.
const REGULAR = new Date("2026-08-13T14:00:00Z"); // 10:00 ET
const POST_CLOSE = new Date("2026-08-13T20:30:00Z"); // 16:30 ET
const OVERNIGHT = new Date("2026-08-13T04:00:00Z"); // 00:00 ET
const SATURDAY = new Date("2026-08-15T14:00:00Z"); // weekend

describe("market-aware quote freshness", () => {
  it("classifies the New York session via the shared market calendar", () => {
    expect(quotesMarketState(REGULAR)).toBe("regular");
    expect(quotesMarketState(POST_CLOSE)).toBe("post_close");
    expect(quotesMarketState(OVERNIGHT)).toBe("closed");
    expect(quotesMarketState(SATURDAY)).toBe("closed");
  });

  it("uses a short stale window in-session and a long one when closed", () => {
    expect(quoteStaleAfterSeconds(REGULAR)).toBe(QUOTES_SESSION_STALE_AFTER_SECONDS);
    expect(quoteStaleAfterSeconds(POST_CLOSE)).toBe(QUOTES_SESSION_STALE_AFTER_SECONDS);
    expect(quoteStaleAfterSeconds(SATURDAY)).toBe(QUOTES_OFF_SESSION_STALE_AFTER_SECONDS);
  });

  it("marks a fresh in-session refresh Live and a missed one Stale", () => {
    expect(quoteState(new Date(REGULAR.getTime() - 10_000).toISOString(), REGULAR)).toBe("Live");
    expect(quoteState(new Date(REGULAR.getTime() - 20 * 60 * 1000).toISOString(), REGULAR)).toBe("Stale");
  });

  it("never marks overnight/weekend data stale on its own", () => {
    // Friday 16:45 ET close read over the weekend stays Cached (age < 7d).
    const fridayClose = new Date("2026-08-14T20:45:00Z").toISOString();
    expect(quoteState(fridayClose, SATURDAY)).toBe("Cached");
    // A very old closed-market row is Stale.
    const ancient = new Date("2026-06-01T14:00:00Z").toISOString();
    expect(quoteState(ancient, SATURDAY)).toBe("Stale");
  });

  it("treats missing or unreadable rows as Unavailable", () => {
    expect(quoteState(null, REGULAR)).toBe("Unavailable");
    expect(quoteState("not-a-date", REGULAR)).toBe("Unavailable");
  });

  it("derives the collector state from the last successful run", () => {
    const justRan = new Date(REGULAR.getTime() - 10_000).toISOString();
    expect(quotesCollectorState(justRan, REGULAR)).toBe("Live");
    expect(quotesCollectorState(new Date(REGULAR.getTime() - 60 * 60 * 1000).toISOString(), REGULAR)).toBe("Stale");
    // Closed market with a recent Friday close: Cached, never Stale.
    const fridayClose = new Date("2026-08-14T20:45:00Z").toISOString();
    expect(quotesCollectorState(fridayClose, SATURDAY)).toBe("Cached");
    expect(quotesCollectorState(null, REGULAR)).toBe("Unavailable");
  });
});
