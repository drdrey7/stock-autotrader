import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("formats valid timestamps", () => {
    expect(formatDate("2026-08-10T20:16:12Z")).toContain("Aug");
  });

  it("fails safely for malformed timestamps", () => {
    expect(formatDate("not-a-timestamp")).toBe("Unavailable");
  });
});
