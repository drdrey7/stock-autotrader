import type { Env } from "../index.js";
import { createAuth } from "./auth.js";

/**
 * Fail-closed: refuse to initialize Better Auth when required runtime
 * configuration is missing. Returns a sanitized 503 that does not leak
 * which key is absent or any secret value.
 */
function validateAuthConfig(env: Env): Response | null {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "auth_not_configured" }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (!env.BETTER_AUTH_SECRET) {
    return new Response(JSON.stringify({ error: "auth_not_configured" }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (!env.BETTER_AUTH_URL) {
    return new Response(JSON.stringify({ error: "auth_not_configured" }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return null;
}

/**
 * Handle every Better Auth request under /api/auth/*.
 *
 * The Worker's global method gate rejects methods other than GET/HEAD/OPTIONS
 * — that gate runs AFTER this function is invoked, so /api/auth/* POST/PUT/
 * DELETE/PATCH requests must be routed here. See worker/index.ts fetch().
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const configError = validateAuthConfig(env);
  if (configError) return configError;

  const auth = createAuth(env.DB, env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET);
  return auth.handler(request);
}
