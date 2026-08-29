import { describe, expect, it } from "vitest";
import { classifyChangedPaths, evaluateRegression } from "./production-regression-gate.mjs";

function snapshot({
  live = true,
  readable = true,
  down = [],
  states = { market: "Live", earnings: "Live" },
  engineStates = {},
} = {}) {
  return {
    liveness: { ok: live, httpStatus: live ? 200 : 503 },
    sources: {
      readable,
      httpStatus: readable ? (down.length > 0 ? 503 : 200) : 503,
      critical: readable ? ["market", "earnings"] : [],
      down: readable ? down : [],
      states: readable ? states : {},
      engineStates: readable ? engineStates : {},
    },
  };
}

const healthyBootstrap = {
  core: { initialized: true, activeCount: 50, expectedCount: 50, universeVersion: 1 },
  calendar: { status: "ok", detail: "updated" },
};

describe("classifyChangedPaths", () => {
  it("keeps a frontend-only change out of backend critical-source scope", () => {
    expect(classifyChangedPaths(["apps/web/src/App.tsx"])).toMatchObject({
      runtime: false,
      core: false,
      criticalSources: [],
    });
  });

  it("scopes an earnings implementation change to earnings", () => {
    expect(classifyChangedPaths(["apps/web/worker/earnings/logic.ts"])).toMatchObject({
      runtime: true,
      core: false,
      criticalSources: ["earnings"],
    });
  });

  it("marks earnings storage as Core-sensitive", () => {
    expect(classifyChangedPaths(["apps/web/worker/earnings/storage.ts"])).toMatchObject({
      runtime: true,
      core: true,
      criticalSources: ["earnings"],
    });
  });

  it("scopes market-context changes to market", () => {
    expect(classifyChangedPaths(["apps/web/worker/market-context.ts"])).toMatchObject({
      runtime: true,
      core: false,
      criticalSources: ["market"],
    });
  });

  it("treats the production cron dispatcher as shared critical runtime", () => {
    expect(classifyChangedPaths(["apps/web/worker/cron-dispatcher.ts"])).toMatchObject({
      runtime: true,
      core: false,
      criticalSources: ["earnings", "market"],
    });
  });

  it("treats migrations as Core and both critical sources", () => {
    expect(classifyChangedPaths(["apps/web/migrations/0030_example.sql"])).toMatchObject({
      runtime: true,
      core: true,
      criticalSources: ["earnings", "market"],
    });
  });

  it("treats deploy-workflow changes as deployment-sensitive across the runtime", () => {
    expect(classifyChangedPaths([".github/workflows/deploy.yml"])).toMatchObject({
      runtime: true,
      criticalSources: ["earnings", "market"],
    });
  });
});

describe("evaluateRegression", () => {
  it("does not block a frontend-only deploy for an unchanged pre-existing earnings incident", () => {
    const before = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const after = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    expect(evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap })).toEqual({ ok: true, reasons: [] });
  });

  it("fails when a critical source becomes newly down", () => {
    const before = snapshot();
    const after = snapshot({ down: ["market"], states: { market: "Error", earnings: "Live" } });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("critical source newly down: market");
  });

  it("fails when a touched source worsens inside an already-down generic state", () => {
    const before = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Stale" } });
    const after = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const scope = classifyChangedPaths(["apps/web/worker/earnings/logic.ts"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("touched critical source worsened: earnings (Stale -> Error)");
  });

  it("uses canonical earnings engineState to detect STALE to DEGRADED worsening", () => {
    const before = snapshot({
      down: ["earnings"],
      states: { market: "Live", earnings: "Stale" },
      engineStates: { earnings: "STALE" },
    });
    const after = snapshot({
      down: ["earnings"],
      states: { market: "Live", earnings: "Stale" },
      engineStates: { earnings: "DEGRADED" },
    });
    const scope = classifyChangedPaths(["apps/web/worker/earnings/logic.ts"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("touched critical source worsened: earnings (STALE -> DEGRADED)");
  });

  it("does not block frontend-only work when source diagnostics were already unreadable", () => {
    const before = snapshot({ readable: false });
    const after = snapshot({ readable: false });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    expect(evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap })).toEqual({ ok: true, reasons: [] });
  });

  it("does not invent a new frontend regression when an unreadable baseline later reveals a pre-existing source incident", () => {
    const before = snapshot({ readable: false });
    const after = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    expect(evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap })).toEqual({ ok: true, reasons: [] });
  });

  it("fails a scoped source change when the baseline is unreadable and that source is down after deploy", () => {
    const before = snapshot({ readable: false });
    const after = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const scope = classifyChangedPaths(["apps/web/worker/earnings/logic.ts"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("touched critical source is down and no readable baseline exists: earnings");
  });

  it("fails runtime changes when canonical source health cannot be verified", () => {
    const before = snapshot({ readable: false });
    const after = snapshot({ readable: false });
    const scope = classifyChangedPaths(["apps/web/worker/ai-analysis/api.ts"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("canonical /healthz/sources is unreadable, so runtime changes cannot be regression-verified");
  });

  it("fails an earnings-scoped deploy when bootstrap newly degrades", () => {
    const before = snapshot();
    const after = snapshot();
    const scope = classifyChangedPaths(["apps/web/worker/earnings/logic.ts"]);
    const bootstrap = { ...healthyBootstrap, calendar: { status: "degraded", detail: "provider unavailable" } };

    const result = evaluateRegression({ before, after, scope, bootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("earnings bootstrap degraded after a change that touches earnings");
  });

  it("does not blame a new deploy for an already-down earnings bootstrap", () => {
    const before = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const after = snapshot({ down: ["earnings"], states: { market: "Live", earnings: "Error" } });
    const scope = classifyChangedPaths(["apps/web/worker/earnings/logic.ts"]);
    const bootstrap = { ...healthyBootstrap, calendar: { status: "degraded", detail: "provider unavailable" } };

    expect(evaluateRegression({ before, after, scope, bootstrap })).toEqual({ ok: true, reasons: [] });
  });

  it("fails when Worker liveness regresses after deploy", () => {
    const before = snapshot();
    const after = snapshot({ live: false });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Worker liveness regressed after deploy (HTTP 503)");
  });

  it("does not block frontend-only work for an unchanged pre-existing Worker outage", () => {
    const before = snapshot({ live: false });
    const after = snapshot({ live: false });
    const scope = classifyChangedPaths(["apps/web/src/App.tsx"]);

    expect(evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap })).toEqual({ ok: true, reasons: [] });
  });

  it("fails runtime changes when Worker liveness was already unavailable and remains unavailable", () => {
    const before = snapshot({ live: false });
    const after = snapshot({ live: false });
    const scope = classifyChangedPaths(["apps/web/worker/ai-analysis/api.ts"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: healthyBootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Worker liveness is unavailable, so runtime changes cannot be regression-verified");
  });

  it("fails the Core invariant when Core-sensitive files changed", () => {
    const before = snapshot();
    const after = snapshot();
    const scope = classifyChangedPaths(["apps/web/migrations/0030_example.sql"]);
    const bootstrap = {
      core: { initialized: false, activeCount: 49, expectedCount: 50, universeVersion: 1 },
      calendar: { status: "ok", detail: "updated" },
    };

    const result = evaluateRegression({ before, after, scope, bootstrap });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Core Universe invariant failed (49/50)");
  });

  it("fails closed when a Core-scoped change has no bootstrap report", () => {
    const before = snapshot();
    const after = snapshot();
    const scope = classifyChangedPaths(["apps/web/migrations/0030_example.sql"]);

    const result = evaluateRegression({ before, after, scope, bootstrap: null });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Core Universe invariant failed (unknown/unknown)");
  });
});
