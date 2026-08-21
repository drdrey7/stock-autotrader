import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Static-assets routing regression tests (issue #37).
 *
 * The production Worker serves both a React SPA (Workers Static Assets with
 * `not_found_handling: single-page-application`) and a backend (healthz, /api,
 * signed ingest, deployment bootstrap). Since compatibility_date >= 2025-04-01,
 * browser NAVIGATION requests (Sec-Fetch-Mode: navigate) never invoke the
 * Worker unless the path matches an explicit `assets.run_worker_first` pattern
 * — that is exactly how /healthz/sources and /api/* used to be swallowed by
 * the SPA fallback for navigation callers.
 *
 * These tests assert the INVARIANT the config must satisfy, not the literal
 * config text: every path the Worker fetch handlers answer directly must be
 * Worker-first, and every frontend/asset path must stay asset-first. The
 * probe lists below mirror the actual routers (worker/index.ts,
 * preview-worker.ts), which are the source of truth.
 *
 * NOTE: this file sits at apps/web root (like preview-worker.test.ts) because
 * tsconfig.worker.json only typechecks worker/ and the preview entrypoints;
 * the configs are JSONC so they are read at runtime rather than imported.
 */

interface AssetsConfig {
  not_found_handling?: string;
  run_worker_first?: string[];
}

interface WranglerConfig {
  assets?: AssetsConfig;
}

function loadConfig(fileName: string): WranglerConfig {
  const url = new URL(fileName, import.meta.url);
  const raw = readFileSync(url, "utf8");
  // The committed configs are strict JSON (CI validates them with
  // JSON.parse), so no JSONC comment stripping is needed — and a naive
  // stripper would corrupt cron expressions such as "*/15 * * * *" and
  // wildcard paths like "/api/*".
  return JSON.parse(raw) as WranglerConfig;
}

const productionConfig = loadConfig("wrangler.jsonc");
const previewConfig = loadConfig("wrangler.preview.jsonc");

/**
 * Cloudflare run_worker_first pattern matcher. Equivalent to CF's glob
 * matcher (generateGlobOnlyRuleRegExp in @cloudflare/workers-shared:
 * `*` -> `.*`, anchored `^...$`, matched against the pathname only) for the
 * actual pattern set used here (letters, `/`, `*`).
 */
function patternMatches(pattern: string, pathname: string): boolean {
  if (pattern.startsWith("!")) return false; // negative patterns never match
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

function isWorkerFirst(config: WranglerConfig, pathname: string): boolean {
  return (config.assets?.run_worker_first ?? []).some((pattern) =>
    patternMatches(pattern, pathname),
  );
}

/**
 * Every pathname the production fetch handler can answer directly (i.e. every
 * branch before the final `env.ASSETS.fetch(request)` fallback in
 * worker/index.ts), including the /api/* JSON-404 catch-all.
 */
const productionBackendPaths = [
  "/healthz",
  "/healthz/sources",
  "/api/status",
  "/api/briefs/latest",
  "/api/briefs/2026-08-15/morning",
  "/api/x/posts",
  "/api/market-data",
  "/api/market-context",
  "/api/stocks/AAPL",
  "/api/earnings",
  "/api/screener",
  "/api/portfolio/shadow",
  "/api/strategies",
  "/api/not-a-real-route",
  "/ingest/events",
  "/__internal/deployment/bootstrap",
] as const;

/**
 * Frontend routes and static-asset paths that must keep asset-first behavior
 * (SPA shell / built assets / React NotFound fallback for unknown routes).
 */
const frontendPaths = [
  "/",
  "/x",
  "/earnings",
  "/screener",
  "/stocks/MSFT",
  "/dashboard",
  "/status",
  "/index.html",
  // Any asset path (hashed filenames change on every build) must stay
  // asset-first; the routing invariant does not depend on a real file.
  "/assets/app-bundle.js",
  "/some/unknown/frontend/route",
] as const;

describe("production wrangler.jsonc static-assets routing", () => {
  it("keeps the SPA fallback enabled", () => {
    expect(productionConfig.assets?.not_found_handling).toBe("single-page-application");
  });

  it("uses an explicit, non-global run_worker_first pattern list", () => {
    const patterns = productionConfig.assets?.run_worker_first;
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns?.length).toBeGreaterThan(0);
    expect(new Set(patterns).size).toBe(patterns?.length); // no duplicates
    for (const pattern of patterns ?? []) {
      // CF rules must start with "/" (or "!/" for negatives, which are
      // rejected here by the leading-slash requirement).
      expect(pattern.startsWith("/")).toBe(true);
    }
  });

  it("routes every Worker-handled backend path Worker-first", () => {
    for (const pathname of productionBackendPaths) {
      expect(isWorkerFirst(productionConfig, pathname), `${pathname} must be Worker-first`).toBe(true);
    }
  });

  it("leaves every frontend/asset path asset-first (SPA behavior preserved)", () => {
    for (const pathname of frontendPaths) {
      expect(isWorkerFirst(productionConfig, pathname), `${pathname} must stay asset-first`).toBe(false);
    }
  });
});

describe("preview wrangler.preview.jsonc static-assets routing", () => {
  /** Paths the preview Worker answers directly (preview-worker.ts). */
  const previewBackendPaths = [
    "/api",
    "/api/status",
    "/api/briefs/latest",
    "/__preview/diagnostics",
  ] as const;

  /** Production-only backend paths the preview must NOT route to itself. */
  const previewForbiddenBackendPaths = [
    "/healthz",
    "/healthz/sources",
    "/ingest/events",
    "/__internal/deployment/bootstrap",
  ] as const;

  it("routes every preview Worker-handled path Worker-first", () => {
    for (const pathname of previewBackendPaths) {
      expect(isWorkerFirst(previewConfig, pathname), `${pathname} must be Worker-first`).toBe(true);
    }
  });

  it("does not expose production-only backend paths through the preview", () => {
    for (const pathname of previewForbiddenBackendPaths) {
      expect(isWorkerFirst(previewConfig, pathname), `${pathname} must not be Worker-first on preview`).toBe(false);
    }
  });

  it("leaves frontend/asset paths asset-first on preview", () => {
    for (const pathname of frontendPaths) {
      expect(isWorkerFirst(previewConfig, pathname), `${pathname} must stay asset-first on preview`).toBe(false);
    }
  });
});
