import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({ handler: vi.fn() })),
}));

import { betterAuth } from "better-auth";
import { createAuth } from "./auth";

const db = {} as D1Database;
const secret = "test-secret-that-is-at-least-32-chars";

describe("Better Auth application configuration", () => {
  it("enables the built-in email/password authenticator", () => {
    createAuth(db, "https://example.test", secret);

    expect(vi.mocked(betterAuth)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailAndPassword: { enabled: true },
      }),
    );
  });

  it("uses secure cookies except for loopback HTTP development", () => {
    createAuth(db, "https://example.test", secret);
    expect(vi.mocked(betterAuth)).toHaveBeenLastCalledWith(
      expect.objectContaining({ advanced: { useSecureCookies: true } }),
    );

    createAuth(db, "http://localhost:8787", secret);
    expect(vi.mocked(betterAuth)).toHaveBeenLastCalledWith(
      expect.objectContaining({ advanced: { useSecureCookies: false } }),
    );

    createAuth(db, "http://127.0.0.1:8787", secret);
    expect(vi.mocked(betterAuth)).toHaveBeenLastCalledWith(
      expect.objectContaining({ advanced: { useSecureCookies: false } }),
    );

    createAuth(db, "http://example.test", secret);
    expect(vi.mocked(betterAuth)).toHaveBeenLastCalledWith(
      expect.objectContaining({ advanced: { useSecureCookies: true } }),
    );
  });
});
