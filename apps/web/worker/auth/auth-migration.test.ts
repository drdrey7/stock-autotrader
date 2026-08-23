import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Better Auth migration regression tests (PR1).
 *
 * Verifies the sequential migrations create the Better Auth 1.7.x base auth
 * schema and its issuer-scoped account identity contract (no plugins).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration0019 = readFileSync(resolve(__dirname, "../../migrations/0019_better_auth.sql"), "utf8");
const migration0020 = readFileSync(
  resolve(__dirname, "../../migrations/0020_better_auth_account_identity.sql"),
  "utf8",
);
const migrationSequence = `${migration0019}\n${migration0020}`;

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE \\`${table}\\` \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `missing CREATE TABLE for ${table}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Better Auth migration sequence", () => {
  it("creates the four required base tables", () => {
    expect(migration0019).toContain("CREATE TABLE `user`");
    expect(migration0019).toContain("CREATE TABLE `session`");
    expect(migration0019).toContain("CREATE TABLE `account`");
    expect(migration0019).toContain("CREATE TABLE `verification`");
  });

  it("defines user.email as UNIQUE NOT NULL", () => {
    expect(migration0019).toMatch(/`email` text NOT NULL[\s\S]*?UNIQUE/);
    expect(migration0019).toContain("`user_email_unique`");
  });

  it("defines session.token as UNIQUE", () => {
    expect(migration0019).toContain("`session_token_unique`");
  });

  it("adds the Better Auth 1.7 issuer-scoped account identity contract", () => {
    const account = tableDefinition(migration0020, "account_v17");
    expect(account).toContain("`issuer` text NOT NULL");
    expect(migration0020).toContain("ALTER TABLE `account_v17` RENAME TO `account`");
    expect(migration0020).toMatch(
      /CREATE UNIQUE INDEX `account_issuer_accountId_uidx`\s+ON `account` \(`issuer`, `account_id`\)/,
    );
  });

  it("fails closed instead of guessing issuers for pre-existing account rows", () => {
    expect(migration0020).toMatch(/SELECT[\s\S]*?`account_id`,\s*NULL,\s*`provider_id`[\s\S]*?FROM `account`/);
  });

  it("enforces FK cascade from both session and final account tables to user", () => {
    const session = tableDefinition(migration0019, "session");
    const account = tableDefinition(migration0020, "account_v17");
    const cascade = "REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade";
    expect(session).toContain(cascade);
    expect(account).toContain(cascade);
  });

  it("does not reference any plugin-only tables", () => {
    expect(migrationSequence).not.toContain("`twoFactor`");
    expect(migrationSequence).not.toContain("`organization`");
    expect(migrationSequence).not.toContain("`stripe`");
    expect(migrationSequence).not.toContain("`ai_credit`");
  });

  it("does not contain any inline secret or credential values", () => {
    // Column names like `password` and `token` are expected — but actual
    // secret values (long random strings, API keys) should never appear.
    expect(migrationSequence).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
    expect(migrationSequence).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(migrationSequence).not.toMatch(/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
  });
});
