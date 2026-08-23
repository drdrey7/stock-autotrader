/**
 * Better Auth browser client (PR1 — stub for future use).
 *
 * This client is intentionally minimal. PR1 installs Better Auth and wires the
 * backend — no login provider is implemented yet. Future PRs (Google OAuth,
 * email/password, magic links) should import from `better-auth/react` and use
 * the official `createAuthClient` with the appropriate plugins.
 *
 * @see https://www.better-auth.com/docs/client-creation
 */

export function createAuthClient() {
  return {
    signIn: {
      social: async () => {
        throw new Error("Better Auth provider not implemented in PR1");
      },
      email: async () => {
        throw new Error("Better Auth provider not implemented in PR1");
      },
    },
    signOut: async () => {
      throw new Error("Better Auth provider not implemented in PR1");
    },
    getSession: async () => {
      throw new Error("Better Auth provider not implemented in PR1");
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
