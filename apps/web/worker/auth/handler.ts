import type { Env } from "../index.js";
import { createAuth } from "./auth.js";

/**
 * Handle every Better Auth request under /api/auth/*.
 *
 * The Worker's global method gate rejects methods other than GET/HEAD/OPTIONS
 * — that gate runs AFTER this function is invoked, so /api/auth/* POST/PUT/
 * DELETE/PATCH requests must be routed here. See worker/index.ts fetch().
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const auth = createAuth(env.DB, env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET);
  return auth.handler(request);
}
