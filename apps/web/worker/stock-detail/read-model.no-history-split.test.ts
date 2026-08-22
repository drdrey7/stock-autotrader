import { describe, expect, it } from "vitest";
import { servedSplitScaleState } from "./read-model";

describe("Stock Detail split safety without weekly history", () => {
  const effectiveSplits = [{ effective_date: "2026-08-10", split_factor: 10 }];

  it("keeps a valid post-split quote safe when there is no chart history to reconcile", () => {
    expect(servedSplitScaleState(
      { price: 50, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      null,
      [],
      effectiveSplits,
    )).toBe("safe");
  });

  it("still rejects a pre-split cached quote when there is no chart history", () => {
    expect(servedSplitScaleState(
      { price: 500, provider_timestamp: "2026-08-07T20:00:00.000Z" },
      null,
      [],
      effectiveSplits,
    )).toBe("mismatch");
  });
});
