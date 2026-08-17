const REQUEST_TIMEOUT_MS = 8_000;

export async function fetchJson<T>(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<T | null> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    options?.signal?.removeEventListener("abort", onExternalAbort);
    window.clearTimeout(timeout);
  }
}

export function isWithinWindow(value: string | null | undefined, maxAgeMs: number, now = Date.now()): boolean {
  const timestamp = Date.parse(value ?? "");
  const ageMs = now - timestamp;
  return Number.isFinite(timestamp) && ageMs >= 0 && ageMs <= maxAgeMs;
}
