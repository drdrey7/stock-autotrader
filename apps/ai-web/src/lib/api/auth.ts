import { api } from "./client";
export type Viewer = { id: string; name?: string; email: string };
export const authApi = { session: () => api<Viewer | null>("/api/auth/session"), signIn: (email: string, password: string) => api<Viewer>("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ email, password }) }), signOut: () => api<void>("/api/auth/sign-out", { method: "POST", body: "{}" }) };
