import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingAnalysisKey, pendingAnalysisKey } from "./idempotency";

const firstKey = "11111111-1111-4111-8111-111111111111";
const secondKey = "22222222-2222-4222-8222-222222222222";
const thirdKey = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(firstKey)
    .mockReturnValueOnce(secondKey)
    .mockReturnValue(thirdKey);
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("analysis request idempotency", () => {
  it("reuses one session key for repeated clicks on the same stock", () => {
    expect(pendingAnalysisKey("AAPL", 1_000)).toBe(firstKey);
    expect(pendingAnalysisKey("AAPL", 2_000)).toBe(firstKey);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("rotates the key for another stock or an expired request", () => {
    expect(pendingAnalysisKey("AAPL", 1_000)).toBe(firstKey);
    expect(pendingAnalysisKey("MSFT", 2_000)).toBe(secondKey);
    // The stored MSFT request is still present but has aged past
    // MAX_PENDING_AGE_MS, so the expiry path must rotate to a fresh key without
    // needing a manual clear.
    expect(pendingAnalysisKey("MSFT", 31 * 60_000)).toBe(thirdKey);
  });

  it("only clears the pending request that completed", () => {
    pendingAnalysisKey("AAPL", 1_000);
    clearPendingAnalysisKey(secondKey);
    expect(pendingAnalysisKey("AAPL", 2_000)).toBe(firstKey);
    clearPendingAnalysisKey(firstKey);
    expect(pendingAnalysisKey("AAPL", 3_000)).toBe(secondKey);
  });
});
