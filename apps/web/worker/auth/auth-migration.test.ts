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
const migration0028 = readFileSync(
  resolve(__dirname, "../../migrations/0028_better_auth_camelcase_columns.sql"),
  "utf8",
);
const migrationSequence = `${migration0019}\n${migration0020}\n${migration0028}`;

function tableDefinition(sql: string, table: string): string {
  const marker = "CREATE TABLE `" + table + "` (";
  const start = sql.indexOf(marker);
  expect(start, `missing CREATE TABLE for ${table}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = sql.indexOf("\n);", bodyStart);
  expect(end, `unterminated CREATE TABLE for ${table}`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, end);
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

  it("rebuilds user table with camelCase physical columns (0028)", () => {
    const user = tableDefinition(migration0028, "user");
    // exact Better Auth 1.7 default camelCase field names
    for (const col of ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"]) {
      expect(user).toContain(`\`${col}\``);
    }
    expect(user).toContain("`emailVerified` integer NOT NULL DEFAULT false");
    // old incompatible snake_case columns must be gone
    expect(user).not.toContain("email_verified");
    expect(user).not.toContain("created_at");
    expect(user).not.toContain("updated_at");
    // uniques preserved
    expect(migration0028).toContain("CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`)");
  });

  it("rebuilds session table with camelCase columns and FK cascade (0028)", () => {
    const session = tableDefinition(migration0028, "session");
    for (const col of ["id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"]) {
      expect(session).toContain(`\`${col}\``);
    }
    expect(session).toContain(
      "FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade",
    );
    expect(session).not.toContain("user_id");
    expect(migration0028).toContain("CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`)");
  });

  it("rebuilds account table with camelCase columns, issuer NOT NULL, unique identity (0028)", () => {
    const account = tableDefinition(migration0028, "account");
    for (const col of [
      "id",
      "accountId",
      "issuer",
      "providerId",
      "userId",
      "accessToken",
      "refreshToken",
      "idToken",
      "accessTokenExpiresAt",
      "refreshTokenExpiresAt",
      "scope",
      "password",
      "createdAt",
      "updatedAt",
    ]) {
      expect(account).toContain(`\`${col}\``);
    }
    expect(account).toContain("`issuer` text NOT NULL");
    expect(account).toContain(
      "FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade",
    );
    expect(migration0028).toContain(
      "CREATE UNIQUE INDEX `account_issuer_accountId_uidx` ON `account` (`issuer`, `accountId`)",
    );
    // old snake_case names gone
    expect(account).not.toContain("account_id");
    expect(account).not.toContain("provider_id");
  });

  it("rebuilds verification table with camelCase columns (0028)", () => {
    const verification = tableDefinition(migration0028, "verification");
    for (const col of ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"]) {
      expect(verification).toContain(`\`${col}\``);
    }
  });

  it("0028 does not reference or leak plugin-only tables", () => {
    expect(migration0028).not.toContain("`twoFactor`");
    expect(migration0028).not.toContain("`organization`");
    expect(migration0028).not.toContain("`stripe`");
    expect(migration0028).not.toContain("`ai_credit`");
  });

  it("does not contain any inline secret or credential values", () => {
    // Column names like `password` and `token` are expected — but actual
    // secret values (long random strings, API keys) should never appear.
    expect(migrationSequence).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
    expect(migrationSequence).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(migrationSequence).not.toMatch(/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
  });
});
