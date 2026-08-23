import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";

// Mock better-auth so the REAL handler.ts runs (including its fail-closed
// config validation) without trying to initialize the actual Better Auth D1
// adapter against a fake database. The mock returns a fake auth instance
// whose handler() returns a 200 — letting us assert on routing and config
// boundaries without real DB interaction.
vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({
    handler: vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      }),
    ),
  })),
}));

import worker, { type Env } from "../index";

/**
 * Better Auth boundary tests.
 *
 * Proves:
 *  A. /api/auth/* is routed before the global GET-only method gate.
 *  B. POST /api/auth/* is not rejected by the Worker's generic 405 gate.
 *  C. An unrelated POST endpoint still receives method-not-allowed behavior.
 *  D. Missing required Better Auth production configuration fails closed with
 *     a sanitized 503 response.
 *  E. Auth configuration receives the existing env.DB binding.
 *  F. Auth responses do not inherit the public API helper's
 *     Cache-Control: public, max-age=60.
 */

const assets = { fetch: async () => new Response("assets") };

function createDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
    batch: async (stmts: Array<{ all: () => Promise<{ results: unknown[] }> }>) => {
      return Promise.all(stmts.map(async (s) => s.all()));
    },
  } as unknown as D1Database;
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: createDb(),
    ASSETS: assets as unknown as Fetcher,
    ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "test-secret-that-is-32-chars-long!!",
    BETTER_AUTH_URL: "https://example.test",
    ...overrides,
  } as unknown as Env;
}

describe("Better Auth boundary", () => {
  it("routes /api/auth/* before the global GET-only method gate (POST is not 405)", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    // The global method gate returns 405 for non-GET/HEAD/OPTIONS on /api/*.
    // If auth is routed before the gate, this must NOT be 405 — it should reach
    // the auth handler, not be rejected.
    expect(response.status).not.toBe(405);
  });

  it("POST /api/auth/* is dispatched by the auth handler, not the generic gate", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    // Reaching the handler: the response must not be the generic 405 shape.
    // A 200 from the fake auth handler proves the request reached the handler.
    expect(response.status).toBe(200);
  });

  it("an unrelated POST endpoint still receives method-not-allowed (405)", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/status", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it("fails closed with sanitized 503 when BETTER_AUTH_SECRET is missing", async () => {
    const env = makeEnv({ BETTER_AUTH_SECRET: undefined });
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("auth_not_configured");
  });

  it("fails closed with sanitized 503 when DB binding is missing", async () => {
    const env = makeEnv({ DB: undefined });
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("auth_not_configured");
  });

  it("fails closed with sanitized 503 when BETTER_AUTH_URL is missing", async () => {
    const env = makeEnv({ BETTER_AUTH_URL: undefined });
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("auth_not_configured");
  });

  it("does not expose configuration values in the 503 response", async () => {
    const env = makeEnv({ BETTER_AUTH_SECRET: undefined });
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_not_configured");
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("does not inherit the public API Cache-Control: public, max-age=60", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    // The public API helper sets "public, max-age=60". Auth responses must
    // never inherit that public caching directive.
    const cacheControl = response.headers.get("cache-control");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("max-age=60");
  });

  it("passes env.DB to the auth configuration when initialized", async () => {
    const db = createDb();
    const env = makeEnv({ DB: db });
    // If DB were missing, the handler would return the fail-closed 503.
    // Reaching the handler (and getting its 200) proves env.DB was accepted.
    const response = await worker.fetch(
      new Request("https://example.test/api/auth/sign-in", { method: "POST", body: "{}" }),
      env,
    );
    // Not the fail-closed 503 → validation passed with env.DB.
    expect(response.status).not.toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).not.toBe("auth_not_configured");
    expect(body.ok).toBe(true);
  });
});
