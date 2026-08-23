/**
 * Better Auth browser client.
 *
 * Uses the official Better Auth React client. The frontend and /api/auth
 * are same-origin, so no explicit baseURL is required — the client
 * inherits the page origin.
 *
 * @see https://www.better-auth.com/docs/client-creation
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export type AuthClient = typeof authClient;
