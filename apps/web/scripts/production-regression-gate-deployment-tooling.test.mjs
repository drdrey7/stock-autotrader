import { describe, expect, it } from "vitest";
import { classifyChangedPaths } from "./production-regression-gate.mjs";

describe("deployment tooling scope", () => {
  it("treats the scheduled production smoke as runtime-critical deployment tooling", () => {
    expect(classifyChangedPaths(["apps/web/scripts/production-scheduled-smoke.mjs"])).toMatchObject({
      runtime: true,
      core: false,
      criticalSources: ["earnings", "market"],
    });
  });
});
