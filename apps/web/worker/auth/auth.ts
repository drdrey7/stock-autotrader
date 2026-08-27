import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import type { D1Database } from "@cloudflare/workers-types";

function shouldUseSecureCookies(baseURL?: string): boolean {
  if (!baseURL) return true;

  try {
    const url = new URL(baseURL);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    return !(url.protocol === "http:" && isLoopback);
  } catch {
    // A malformed runtime URL should never cause cookies to degrade to
    // insecure transport. Better Auth can surface the configuration error.
    return true;
  }
}

/**
 * Build a Better Auth instance bound to a Cloudflare D1 database.
 *
 * Better Auth 1.7+ supports Cloudflare D1 natively — pass the `D1Database`
 * binding directly as `database`. No Drizzle wrapper needed (and wrapping
 * the same D1 binding twice can fight over SQLite's write lock in local dev).
 *
 * @see https://better-auth.com/blog/1-5#cloudflare-d1-support
 */
export function createAuth(
  d1: D1Database,
  baseURL?: string,
  secret?: string,
  apiKey?: string,
) {
  return betterAuth({
    database: d1,
    baseURL,
    secret,
    trustedOrigins: baseURL ? [baseURL] : [],
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      dash({ apiKey }),
    ],
    advanced: {
      // Production stays fail-secure. Only loopback HTTP is allowed to drop
      // the Secure cookie attribute so local `wrangler dev` can exercise auth.
      useSecureCookies: shouldUseSecureCookies(baseURL),
    },
  });
}
