const STORAGE_KEY = "ai-web-analysis-pending-v1";
const MAX_PENDING_AGE_MS = 30 * 60_000;

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9-]{0,11}$/;
const KEY_PATTERN = /^[0-9a-f-]{36}$/i;

interface PendingRequest {
  symbol: string;
  key: string;
  createdAt: number;
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PendingRequest>;
  return typeof candidate.symbol === "string"
    && SYMBOL_PATTERN.test(candidate.symbol)
    && typeof candidate.key === "string"
    && KEY_PATTERN.test(candidate.key)
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt);
}

// One entry per symbol so starting a second symbol never overwrites the still
// pending key of the first; a failed start can be retried with the same key.
// Pruning by age only happens on the key-request path so `clearPendingAnalysisKey`
// can always remove a specific key regardless of its age.
function readAll(now?: number): Map<string, PendingRequest> {
  const entries = new Map<string, PendingRequest>();
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const raw: unknown = JSON.parse(stored);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        for (const [symbol, value] of Object.entries(raw)) {
          if (isPendingRequest(value) && value.symbol === symbol) entries.set(symbol, value);
        }
      }
    }
  } catch {
    // A blocked/full session store still leaves backend idempotency available
    // for the current in-memory click through the returned key.
  }
  if (now !== undefined) {
    for (const [symbol, record] of entries) {
      if (now - record.createdAt > MAX_PENDING_AGE_MS) entries.delete(symbol);
    }
  }
  return entries;
}

function writeAll(entries: Map<string, PendingRequest>): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // The request remains valid even if the browser refuses storage.
  }
}

export function pendingAnalysisKey(symbol: string, now = Date.now()): string {
  const entries = readAll(now);
  const existing = entries.get(symbol);
  if (existing && now >= existing.createdAt && now - existing.createdAt <= MAX_PENDING_AGE_MS) {
    return existing.key;
  }
  const key = crypto.randomUUID();
  entries.set(symbol, { symbol, key, createdAt: now });
  writeAll(entries);
  return key;
}

export function clearPendingAnalysisKey(key?: string): void {
  const entries = readAll();
  let changed = false;
  if (key) {
    for (const [symbol, record] of entries) {
      if (record.key === key) {
        entries.delete(symbol);
        changed = true;
      }
    }
  } else {
    entries.clear();
    changed = true;
  }
  if (changed) writeAll(entries);
}
