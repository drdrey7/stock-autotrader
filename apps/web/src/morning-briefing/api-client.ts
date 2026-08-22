const REQUEST_TIMEOUT_MS = 8_000;

export interface ApiJsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Central Morning Briefing HTTP boundary for consumers that need to distinguish
 * 404 from systemic errors. Network/timeout/invalid-JSON failures throw.
 */
export async function requestJson(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<ApiJsonResponse> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json() as unknown,
    };
  } finally {
    options?.signal?.removeEventListener("abort", onExternalAbort);
    window.clearTimeout(timeout);
  }
}

/** Legacy best-effort helper retained for existing Morning Briefing features. */
export async function fetchJson<T>(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<T | null> {
  try {
    const response = await requestJson(path, options);
    if (!response.ok) return null;
    return response.body as T;
  } catch {
    return null;
  }
}

export function isWithinWindow(value: string | null | undefined, maxAgeMs: number, now = Date.now()): boolean {
  const timestamp = Date.parse(value ?? "");
  const ageMs = now - timestamp;
  return Number.isFinite(timestamp) && ageMs >= 0 && ageMs <= maxAgeMs;
}
