import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Better Auth migration regression tests (PR1).
 *
 * Verifies the generated migration creates the exact tables and constraints
 * Better Auth 1.7.x expects for the base auth schema (no plugins).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(__dirname, "../../migrations/0019_better_auth.sql"), "utf8");

describe("Better Auth migration 0019_better_auth.sql", () => {
  it("creates the four required base tables", () => {
    expect(migration).toContain("CREATE TABLE `user`");
    expect(migration).toContain("CREATE TABLE `session`");
    expect(migration).toContain("CREATE TABLE `account`");
    expect(migration).toContain("CREATE TABLE `verification`");
  });

  it("defines user.email as UNIQUE NOT NULL", () => {
    expect(migration).toMatch(/`email` text NOT NULL[\s\S]*?UNIQUE/);
    expect(migration).toContain("`user_email_unique`");
  });

  it("defines session.token as UNIQUE", () => {
    expect(migration).toContain("`session_token_unique`");
  });

  it("enforces FK cascade from session/account to user", () => {
    expect(migration).toContain("REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade");
  });

  it("does not reference any plugin-only tables", () => {
    expect(migration).not.toContain("`twoFactor`");
    expect(migration).not.toContain("`organization`");
    expect(migration).not.toContain("`stripe`");
    expect(migration).not.toContain("`ai_credit`");
  });

  it("does not contain any inline secret or credential values", () => {
    // Column names like `password` and `token` are expected — but actual
    // secret values (long random strings, API keys) should never appear.
    expect(migration).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
    expect(migration).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(migration).not.toMatch(/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
  });
});
