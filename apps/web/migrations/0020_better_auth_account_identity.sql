-- 0020_better_auth_account_identity.sql — Better Auth 1.7 account identity.
--
-- Better Auth 1.7 scopes external identities by the unique pair
-- (issuer, accountId). Migration 0019 is already applied in production, so we
-- preserve it and evolve the schema sequentially here.
--
-- SQLite cannot add NOT NULL to an existing column in place, so rebuild the
-- account table. We intentionally copy NULL into issuer: with the expected
-- empty account table the copy is a no-op; if any legacy account row exists,
-- the NOT NULL constraint aborts the migration instead of inventing an
-- untrusted issuer. Backfill of real identities must be explicit and provider-
-- aware if that situation ever occurs.

CREATE TABLE `account_v17` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`issuer` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

INSERT INTO `account_v17` (
	`id`,
	`account_id`,
	`issuer`,
	`provider_id`,
	`user_id`,
	`access_token`,
	`refresh_token`,
	`id_token`,
	`access_token_expires_at`,
	`refresh_token_expires_at`,
	`scope`,
	`password`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`account_id`,
	NULL,
	`provider_id`,
	`user_id`,
	`access_token`,
	`refresh_token`,
	`id_token`,
	`access_token_expires_at`,
	`refresh_token_expires_at`,
	`scope`,
	`password`,
	`created_at`,
	`updated_at`
FROM `account`;

DROP TABLE `account`;
ALTER TABLE `account_v17` RENAME TO `account`;

CREATE UNIQUE INDEX `account_issuer_accountId_uidx`
ON `account` (`issuer`, `account_id`);
