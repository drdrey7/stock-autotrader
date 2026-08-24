-- 0028_better_auth_camelcase_columns.sql
--
-- Repair the production Better Auth 1.7 D1 schema column-name mismatch.
--
-- Migrations 0019/0020 created the Better Auth tables with snake_case column
-- names (email_verified, created_at, account_id, ...), but the Better Auth
-- D1/Kysely adapter queries columns by the schema's default camelCase
-- fieldName (emailVerified, createdAt, accountId, ...) with no snake_case
-- conversion. The result: every email/password signup fails at the user
-- INSERT with:
--
--   D1_ERROR: table user has no column named emailVerified: SQLITE_ERROR
--
-- The real D1 schema therefore had the right tables/indexes but the wrong
-- physical column names for the adapter.
--
-- Because this repair target table set (user / session / account /
-- verification) was confirmed empty in production, we rebuild each table
-- deterministically to the exact Better Auth 1.7 default camelCase field
-- names and Better Auth 1.7 SQLite semantics (date -> integer, boolean ->
-- integer 0/1). The Tables are dropped and recreated; no application data
-- table is touched.
--
-- This is a destructive rebuild of the four Better Auth tables only. It MUST
-- NOT be applied if any of them contains unexpected rows — the orchestration
-- gate re-checks row counts immediately before applying, and stops if any row
-- is present.
--
-- Only the four Better Auth base tables are affected. All key constraints the
-- productions schema already enforced are preserved:
--   - PRIMARY KEY (id) on every table
--   - UNIQUE on user.email
--   - UNIQUE on session.token
--   - UNIQUE (issuer, accountId) on account
--   - FK account.userId -> user.id ON DELETE CASCADE
--   - FK session.userId -> user.id ON DELETE CASCADE
--   - account.issuer NOT NULL
--   - user.emailVerified NOT NULL (integer 0/1, default false)
--
-- SQLite cannot add/rename a full column set in place, so DROP + CREATE is the
-- only deterministic path. Statement-splitting marker matches the repo's
-- existing wrangler migration style. This is Cloudflare D1 (SQLite).

--> statement-breakpoint
DROP TABLE IF EXISTS `verification`;
--> statement-breakpoint
DROP TABLE IF EXISTS `session`;
--> statement-breakpoint
DROP TABLE IF EXISTS `account`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user`;
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL DEFAULT false,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`issuer` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_uidx` ON `account` (`issuer`, `accountId`);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);