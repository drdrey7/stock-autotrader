import type { Env } from "../index";
import { createAuth } from "../auth/auth";

export interface AuthenticatedAiUser {
  id: string;
}

export class AiAnalysisAuthUnavailableError extends Error {
  constructor() {
    super("ai_analysis_auth_unavailable");
    this.name = "AiAnalysisAuthUnavailableError";
  }
}

/** Better Auth is the sole authority for protected AI Analysis routes. */
export async function readAuthenticatedAiUser(
  request: Request,
  env: Env,
): Promise<AuthenticatedAiUser | null> {
  if (!env.DB || !env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    throw new AiAnalysisAuthUnavailableError();
  }

  try {
    const auth = createAuth(env.DB, env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET);
    const session = await auth.api.getSession({ headers: request.headers });
    const id = session?.user?.id;
    return typeof id === "string" && id.length > 0 ? { id } : null;
  } catch {
    throw new AiAnalysisAuthUnavailableError();
  }
}
