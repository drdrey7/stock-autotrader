const STORAGE_KEY = "how-are-the-markets-ai-analysis-pending-v1";
const MAX_PENDING_AGE_MS = 30 * 60_000;

interface PendingRequest {
  symbol: string;
  key: string;
  createdAt: number;
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PendingRequest>;
  return typeof candidate.symbol === "string"
    && /^[A-Z][A-Z0-9-]{0,11}$/.test(candidate.symbol)
    && typeof candidate.key === "string"
    && /^[0-9a-f-]{36}$/i.test(candidate.key)
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt);
}

export function pendingAnalysisKey(symbol: string, now = Date.now()): string {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isPendingRequest(parsed)
        && parsed.symbol === symbol
        && now >= parsed.createdAt
        && now - parsed.createdAt <= MAX_PENDING_AGE_MS) {
        return parsed.key;
      }
    }
  } catch {
    // A blocked/full session store still leaves backend idempotency available
    // for the current in-memory click through the returned key.
  }

  const key = crypto.randomUUID();
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ symbol, key, createdAt: now }));
  } catch {
    // The request remains valid even if the browser refuses storage.
  }
  return key;
}

export function clearPendingAnalysisKey(key?: string): void {
  try {
    if (key) {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (isPendingRequest(parsed) && parsed.key !== key) return;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else is required; the stored entry expires before reuse.
  }
}

