import type { Env } from "../index";
import { createAuth } from "../auth/auth";

export interface AuthenticatedBillingUser {
  id: string;
  email: string;
}
export class BillingAuthUnavailableError extends Error {
  constructor() {
    super("billing_auth_unavailable");
    this.name = "BillingAuthUnavailableError";
  }
}

/** Better Auth is the only identity authority for Billing routes. */
export async function readAuthenticatedBillingUser(
  request: Request,
  env: Env,
): Promise<AuthenticatedBillingUser | null> {
  if (!env.DB || !env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    throw new BillingAuthUnavailableError();
  }

  try {
    const auth = createAuth(env.DB, env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET);
    const session = await auth.api.getSession({ headers: request.headers });
    const id = session?.user?.id;
    const email = session?.user?.email;
    return typeof id === "string" && id.length > 0 && typeof email === "string" && email.length > 0
      ? { id, email }
      : null;
  } catch {
    throw new BillingAuthUnavailableError();
  }
}
