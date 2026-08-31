import { API_BASE_URL } from "../config/env";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
};

export type AuthSession = {
  user: AuthUser;
  session?: Record<string, unknown>;
};

export class AuthApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
  }
}

function path(value: string): string {
  return `${API_BASE_URL}${value}`;
}

async function request<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path(endpoint), {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...init.headers,
    },
  });

  let body: unknown = null;
  if (response.status !== 204) {
    try {
      body = await response.json() as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "code" in body && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : typeof body === "object" && body !== null && "message" in body && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `http_${response.status}`;
    throw new AuthApiError(code, response.status);
  }

  return body as T;
}

export async function getSession(signal?: AbortSignal): Promise<AuthSession | null> {
  return request<AuthSession | null>("/api/auth/get-session", { signal });
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  const result = await request<{ user: AuthUser }>("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { user: result.user };
}

export async function signUp(name: string, email: string, password: string): Promise<AuthSession> {
  const result = await request<{ user: AuthUser }>("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  return { user: result.user };
}

export async function signOut(): Promise<void> {
  await request<unknown>("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}
