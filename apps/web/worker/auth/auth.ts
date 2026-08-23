import { betterAuth } from "better-auth";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * Build a Better Auth instance bound to a Cloudflare D1 database.
 *
 * Better Auth 1.7+ supports Cloudflare D1 natively — pass the `D1Database`
 * binding directly as `database`. No Drizzle wrapper needed (and wrapping
 * the same D1 binding twice can fight over SQLite's write lock in local dev).
 *
 * @see https://better-auth.com/blog/1-5#cloudflare-d1-support
 */
export function createAuth(d1: D1Database, baseURL?: string, secret?: string) {
  return betterAuth({
    database: d1,
    baseURL,
    secret,
    trustedOrigins: baseURL ? [baseURL] : [],
    advanced: {
      useSecureCookies: true,
    },
  });
}
