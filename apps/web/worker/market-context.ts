import type { Env } from "./index";

export const MARKET_CONTEXT_STALE_AFTER_SECONDS = 26 * 60 * 60;
// Legacy flat gate kept for callers that still pass a constant; market-aware
// sentiment freshness is computed by sentimentStaleAfterSeconds().
export const SENTIMENT_STALE_AFTER_SECONDS = 72 * 60 * 60;
// A healthy sentiment run refreshes every 30 minutes during the session; a
// value older than ~2.5h inside a session means several expected updates
// were missed and the reading is stale.
export const SENTIMENT_SESSION_STALE_AFTER_SECONDS = 2.5 * 60 * 60;
// Outside a session (weekend, holiday, pre-market, overnight) the last value
// of the previous valid session stays usable for up to 7 days.
export const SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;
const MAX_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type MarketIndexSymbol = "SPX" | "NDX" | "DJI" | "VIX";
export type SentimentRating = "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";

export interface MarketIndexObservation {
  symbol: MarketIndexSymbol;
  name: string;
  value: number;
  changePct: number;
  sourceTimestamp: string;
  collectedAt: string;
  provider: string;
}

export interface SentimentObservation {
  score: number;
  rating: SentimentRating;
  sourceTimestamp: string;
  collectedAt: string;
  provider: string;
}

export interface MarketDataProvider {
  collect(collectedAt: string): Promise<{ observations: MarketIndexObservation[]; warnings: string[] }>;
}

export interface SentimentProvider {
  readonly name: string;
  collect(collectedAt: string): Promise<SentimentObservation>;
}

export interface PublicMarketIndex {
  symbol: MarketIndexSymbol;
  name: string;
  value: number;
  change: number;
  updatedAt: string;
}

export interface PublicSentiment {
  provider: string;
  score: number;
  rating: SentimentRating;
  asOf: string;
}

export interface MarketContextReadModel {
  indices: PublicMarketIndex[];
  sentiment: PublicSentiment | null;
  provider: string | null;
  latestSourceTimestamp: string | null;
  latestCollectedAt: string | null;
}

export interface MarketContextHealthRecord {
  provider: string;
  status: "running" | "ok" | "degraded" | "skipped";
  lastAttemptAt: string | null;
  lastSuccessfulUpdate: string | null;
  lastError: string | null;
  httpStatuses: number[];
  rowsWritten: number;
  lastKnownGoodPreserved: boolean;
}

export const MARKET_CONTEXT_HEALTH_META_KEY = "marketContextHealth";
export const SENTIMENT_HEALTH_META_KEY = "sentimentHealth";

export interface SentimentHealthRecord {
  provider: string;
  status: "running" | "ok" | "degraded" | "skipped";
  lastAttemptAt: string;
  lastSuccessfulUpdate: string | null;
  lastSourceTimestamp: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export async function readSentimentHealth(db: D1Database): Promise<SentimentHealthRecord | null> {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
      .bind(SENTIMENT_HEALTH_META_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<SentimentHealthRecord>;
    if (!parsed || typeof parsed.provider !== "string") return null;
    return {
      provider: parsed.provider,
      status: ["running", "ok", "degraded", "skipped"].includes(String(parsed.status))
        ? parsed.status as SentimentHealthRecord["status"]
        : "degraded",
      lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : new Date(0).toISOString(),
      lastSuccessfulUpdate: typeof parsed.lastSuccessfulUpdate === "string" ? parsed.lastSuccessfulUpdate : null,
      lastSourceTimestamp: typeof parsed.lastSourceTimestamp === "string" ? parsed.lastSourceTimestamp : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      consecutiveFailures: Number.isFinite(Number(parsed.consecutiveFailures)) ? Number(parsed.consecutiveFailures) : 0,
    };
  } catch {
    return null;
  }
}

async function rememberSentimentHealth(db: D1Database, health: SentimentHealthRecord): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(SENTIMENT_HEALTH_META_KEY, JSON.stringify(health)).run();
  } catch (error) {
    console.error(JSON.stringify({ job: "sentiment", phase: "health-write", status: "failed", error: errorMessage(error).slice(0, 180) }));
  }
}

async function readLatestSentimentSourceTimestamp(db: D1Database, provider: string): Promise<string | null> {
  try {
    const row = await db.prepare(
      "SELECT source_timestamp FROM market_sentiment WHERE provider = ? ORDER BY source_timestamp DESC, collected_at DESC, id DESC LIMIT 1",
    ).bind(provider).first<{ source_timestamp: string | null }>();
    return row?.source_timestamp ?? null;
  } catch {
    return null;
  }
}

const validIsoTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() + MAX_SOURCE_FUTURE_SKEW_MS;
};

const validMarketObservation = (observation: MarketIndexObservation): boolean =>
  INDEX_DEFINITIONS.some((definition) => definition.symbol === observation.symbol)
  && observation.name.length > 0
  && Number.isFinite(observation.value) && observation.value > 0
  && Number.isFinite(observation.changePct)
  && validIsoTimestamp(observation.sourceTimestamp)
  && validIsoTimestamp(observation.collectedAt)
  && observation.provider.length > 0;

const validSentimentObservation = (observation: SentimentObservation): boolean =>
  Number.isInteger(observation.score) && observation.score >= 0 && observation.score <= 100
  && Object.values(RATING_ALIASES).includes(observation.rating)
  && validIsoTimestamp(observation.sourceTimestamp)
  && validIsoTimestamp(observation.collectedAt)
  && observation.provider.length > 0;

interface IndexDefinition {
  symbol: MarketIndexSymbol;
  name: string;
  providerSymbol: string;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { symbol: "SPX", name: "S&P 500", providerSymbol: "^GSPC" },
  { symbol: "NDX", name: "Nasdaq-100", providerSymbol: "^NDX" },
  { symbol: "DJI", name: "Dow Jones", providerSymbol: "^DJI" },
  { symbol: "VIX", name: "VIX", providerSymbol: "^VIX" },
];

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const toIsoTimestamp = (value: unknown, unit: "seconds" | "auto" = "auto"): string | null => {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const number = finiteNumber(value);
  if (number === null) return null;
  const milliseconds = unit === "seconds" || number < 100_000_000_000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const httpStatusesFrom = (messages: readonly string[]): number[] => [...new Set(messages.flatMap((message) => {
  const statuses: number[] = [];
  for (const match of message.matchAll(/HTTP (\d{3})/g)) statuses.push(Number(match[1]));
  return statuses;
}))].slice(0, 8);
const PROVIDER_TIMEOUT_MS = 8_000;
const YAHOO_USER_AGENT = "StockAutotrader/1.0 (+https://stock-autotrader-web.barroso-labs.workers.dev)";

async function fetchWithTimeout(fetcher: Fetcher, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Yahoo Finance's public chart endpoint is used as a temporary zero-cost
 * adapter. It is not an official public API and has no published SLA or
 * guaranteed quota. The normalized contract keeps this limitation isolated:
 * replacing it must not change D1, the Worker API, or the UI.
 */
export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  readonly name = "yahoo-finance-chart";

  constructor(private readonly fetcher: Fetcher = fetch) {}

  async collect(collectedAt: string): Promise<{ observations: MarketIndexObservation[]; warnings: string[] }> {
    const results = await Promise.all(INDEX_DEFINITIONS.map(async (definition) => {
      try {
        return { observation: await this.fetchOne(definition, collectedAt), warning: null };
      } catch (error) {
        return {
          observation: null,
          warning: `${definition.symbol}: ${errorMessage(error).slice(0, 180)}`,
        };
      }
    }));

    return {
      observations: results.flatMap((result) => result.observation ? [result.observation] : []),
      warnings: results.flatMap((result) => result.warning ? [result.warning] : []),
    };
  }

  private async fetchOne(definition: IndexDefinition, collectedAt: string): Promise<MarketIndexObservation> {
    const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(definition.providerSymbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "15m");
    url.searchParams.set("includePrePost", "false");
    const response = await fetchWithTimeout(this.fetcher, url, {
      headers: {
        Accept: "application/json",
        // Yahoo's edge returns HTTP 429 to the default Workers fetch identity.
        // An explicit application identity is accepted by the same provider
        // and does not change the provider, endpoint, or request cadence.
        "User-Agent": YAHOO_USER_AGENT,
      },
    });
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);

    const payload = await response.json() as unknown;
    const chart = payload && typeof payload === "object" ? (payload as Record<string, unknown>).chart : null;
    const result = chart && typeof chart === "object" ? (chart as Record<string, unknown>).result : null;
    const row = Array.isArray(result) ? result[0] : null;
    if (!row || typeof row !== "object") throw new Error("provider returned no chart");
    const meta = (row as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object") throw new Error("provider returned no metadata");
    const record = meta as Record<string, unknown>;
    const value = finiteNumber(record.regularMarketPrice);
    const previousClose = finiteNumber(record.chartPreviousClose ?? record.previousClose);
    const regularMarketTime = toIsoTimestamp(record.regularMarketTime, "seconds");
    const changePct = value !== null && previousClose !== null && previousClose > 0
      ? ((value - previousClose) / previousClose) * 100
      : null;
    if (value === null || value <= 0) throw new Error("invalid price");
    if (changePct === null || !Number.isFinite(changePct)) throw new Error("invalid daily change");
    if (!regularMarketTime) throw new Error("missing source timestamp");

    return {
      symbol: definition.symbol,
      name: definition.name,
      value,
      changePct,
      sourceTimestamp: regularMarketTime,
      collectedAt,
      provider: this.name,
    };
  }
}

const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const RATING_ALIASES: Record<string, SentimentRating> = {
  "extreme fear": "extreme_fear",
  fear: "fear",
  neutral: "neutral",
  greed: "greed",
  "extreme greed": "extreme_greed",
};

export class CnnSentimentProvider implements SentimentProvider {
  readonly name = "cnn-fear-greed";

  constructor(private readonly fetcher: Fetcher = fetch) {}

  async collect(collectedAt: string): Promise<SentimentObservation> {
    const response = await fetchWithTimeout(this.fetcher, CNN_URL, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://www.cnn.com",
        Referer: "https://www.cnn.com/",
        "User-Agent": "Mozilla/5.0 (compatible; StockAutotrader/1.0)",
      },
    });
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const block = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).fear_and_greed
      : null;
    if (!block || typeof block !== "object") throw new Error("missing fear_and_greed block");
    const record = block as Record<string, unknown>;
    const rawScore = finiteNumber(record.score);
    const score = rawScore === null ? null : Math.round(rawScore);
    const rating = RATING_ALIASES[String(record.rating ?? "").trim().toLowerCase()];
    const sourceTimestamp = toIsoTimestamp(record.timestamp, "seconds");
    if (score === null || score < 0 || score > 100) throw new Error("invalid score");
    if (!rating) throw new Error("invalid rating");
    if (!sourceTimestamp) throw new Error("missing source timestamp");
    return { score, rating, sourceTimestamp, collectedAt, provider: this.name };
  }
}

interface NewYorkParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: number;
  minute: number;
}

// Constructing an Intl.DateTimeFormat is the expensive part of this call
// (locale/timezone data resolution) — formatToParts() on an already-built
// instance is cheap, so this is built once and reused, not per call.
// marketDataOverdue() in dashboard.ts calls marketCollectionWindow() (and
// so this) in a tight loop while scanning a multi-hour span; without this,
// that scan rebuilds the formatter on every sample.
const NEW_YORK_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function localNewYorkParts(instant: Date): NewYorkParts | null {
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = NEW_YORK_PARTS_FORMATTER.formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const weekday = value("weekday");
  return weekday && [year, month, day, hour, minute].every(Number.isInteger)
    ? { year, month, day, weekday, hour, minute }
    : null;
}

const dateKey = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function observedFixedHoliday(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nthWeekday(year: number, month: number, weekday: number, ordinal: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + ((ordinal - 1) * 7);
  return dateKey(year, month, day);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return dateKey(year, month, day);
}

function goodFriday(year: number): string {
  // Gregorian Easter calculation, then two calendar days earlier.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const friday = new Date(Date.UTC(year, month - 1, day - 2));
  return dateKey(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate());
}

// Keyed by year — the holiday set for a given year never changes, and
// marketDataOverdue() in dashboard.ts calls marketCollectionWindow() (and
// so this) in a tight loop while scanning a multi-hour span, which would
// otherwise rebuild the same one or two years' worth of holiday dates
// (including a Gauss's-algorithm Easter computation) on every sample.
const holidaySetCache = new Map<number, Set<string>>();

function holidaysForYear(year: number): Set<string> {
  const cached = holidaySetCache.get(year);
  if (cached) return cached;
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1), // New Year's Day
    observedFixedHoliday(year + 1, 1, 1), // New Year's Day observed on prior Dec 31
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Presidents' Day
    goodFriday(year),
    lastWeekday(year, 5, 1), // Memorial Day
    observedFixedHoliday(year, 6, 19), // Juneteenth
    observedFixedHoliday(year, 7, 4), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observedFixedHoliday(year, 12, 25), // Christmas Day
  ]);
  holidaySetCache.set(year, holidays);
  return holidays;
}

export function isUsMarketHoliday(instant: Date): boolean {
  const parts = localNewYorkParts(instant);
  if (!parts) return false;
  const { year, month, day } = parts;
  return holidaysForYear(year).has(dateKey(year, month, day));
}

export function marketCollectionWindow(scheduledTime: Date): "regular" | "post_close" | null {
  const parts = localNewYorkParts(scheduledTime);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun" || isUsMarketHoliday(scheduledTime)) return null;
  const minutes = parts.hour * 60 + parts.minute;
  const closeMinutes = isEarlyClose(parts) ? 13 * 60 : 16 * 60;
  if (minutes >= 9 * 60 + 30 && minutes < closeMinutes) return "regular";
  if (minutes >= closeMinutes + 15 && minutes <= closeMinutes + 45) return "post_close";
  return null;
}

function isEarlyClose(parts: NewYorkParts): boolean {
  const current = dateKey(parts.year, parts.month, parts.day);
  const thanksgiving = nthWeekday(parts.year, 11, 4, 4);
  const thanksgivingFriday = new Date(`${thanksgiving}T00:00:00Z`);
  thanksgivingFriday.setUTCDate(thanksgivingFriday.getUTCDate() + 1);
  const christmasWeekday = new Date(Date.UTC(parts.year, 11, 25)).getUTCDay();
  const independenceWeekday = new Date(Date.UTC(parts.year, 6, 4)).getUTCDay();
  const thanksgivingFridayKey = dateKey(
    thanksgivingFriday.getUTCFullYear(),
    thanksgivingFriday.getUTCMonth() + 1,
    thanksgivingFriday.getUTCDate(),
  );
  return current === thanksgivingFridayKey
    || (current === dateKey(parts.year, 12, 24) && christmasWeekday >= 1 && christmasWeekday <= 5)
    || (current === dateKey(parts.year, 7, 3) && independenceWeekday >= 1 && independenceWeekday <= 5);
}

export function isNewYorkWeekday(instant: Date): boolean {
  const parts = localNewYorkParts(instant);
  return Boolean(parts && parts.weekday !== "Sat" && parts.weekday !== "Sun");
}

/**
 * Market-aware sentiment freshness: during a live NYSE session the reading is
 * expected to refresh every 30 minutes, so a value older than 2.5h is stale.
 * Outside the session (weekend, holiday, pre-market, overnight) the last value
 * of the previous valid session stays usable for up to 7 days — Friday's final
 * reading must not vanish over the weekend.
 */
export function sentimentStaleAfterSeconds(now: Date): number {
  const parts = localNewYorkParts(now);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun" || isUsMarketHoliday(now)) {
    return SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS;
  }
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 9 * 60 + 30 && minutes <= 16 * 60 + 45) {
    return SENTIMENT_SESSION_STALE_AFTER_SECONDS;
  }
  return SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS;
}

export async function writeMarketIndices(db: D1Database, observations: MarketIndexObservation[]): Promise<number> {
  const valid = observations.filter(validMarketObservation);
  if (valid.length === 0) return 0;
  const results = await db.batch(valid.map((observation) => db.prepare(
    `INSERT OR IGNORE INTO market_indices
      (symbol, name, value, change_pct, source_timestamp, collected_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    observation.symbol,
    observation.name,
    observation.value,
    observation.changePct,
    observation.sourceTimestamp,
    observation.collectedAt,
    observation.provider,
  )));
  return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
}

export async function writeSentiment(db: D1Database, observation: SentimentObservation): Promise<void> {
  if (!validSentimentObservation(observation)) throw new Error("invalid sentiment observation");
  await db.prepare(
    `INSERT OR IGNORE INTO market_sentiment
      (score, rating, source_timestamp, collected_at, provider)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    observation.score,
    observation.rating,
    observation.sourceTimestamp,
    observation.collectedAt,
    observation.provider,
  ).run();
}

/**
 * Parses a persisted Market Context health record, throwing when the value is
 * present but not a readable record (malformed JSON or an unknown shape).
 * The lenient wrapper below collapses that to null for the public UI, which
 * treats an unreadable record the same as an absent one; the strict reader
 * used by /healthz/sources must not conflate the two (fail closed instead).
 */
const parseMarketContextHealth = (value: unknown): MarketContextHealthRecord => {
  if (typeof value !== "string") throw new Error("marketContextHealth value is not a string");
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || typeof parsed.provider !== "string") {
    throw new Error("marketContextHealth record is malformed");
  }
  const status = parsed.status;
  if (typeof status !== "string" || !["running", "ok", "degraded", "skipped"].includes(status)) {
    throw new Error("marketContextHealth record has an invalid status");
  }
  // The runtime always persists the complete shape (nullable timestamps and
  // error included). Validate the full record instead of filling omitted
  // fields in: a structurally incomplete record is malformed, and an absent
  // error must never read as healthy. Non-null timestamps must be strict
  // ISO instants (what the runtime writes via toISOString) — a garbage or
  // merely Date.parse-compatible string would otherwise be accepted and
  // silently fall back to other timestamps downstream. lastError is free
  // text and must NOT be date-validated.
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  const validIsoOrNull = (candidate: unknown): candidate is string | null =>
    candidate === null
    || (typeof candidate === "string" && ISO_INSTANT.test(candidate) && Number.isFinite(Date.parse(candidate)));
  const validErrorOrNull = (candidate: unknown): candidate is string | null =>
    candidate === null || typeof candidate === "string";
  const lastAttemptAt = parsed.lastAttemptAt;
  const lastSuccessfulUpdate = parsed.lastSuccessfulUpdate;
  const lastError = parsed.lastError;
  if (!validIsoOrNull(lastAttemptAt) || !validIsoOrNull(lastSuccessfulUpdate) || !validErrorOrNull(lastError)) {
    throw new Error("marketContextHealth record has invalid timestamp/error fields");
  }
  const httpStatuses = parsed.httpStatuses;
  if (!Array.isArray(httpStatuses) || !httpStatuses.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)) {
    throw new Error("marketContextHealth record has invalid httpStatuses");
  }
  const rowsWritten = parsed.rowsWritten;
  if (typeof rowsWritten !== "number" || !Number.isFinite(rowsWritten)) {
    throw new Error("marketContextHealth record has invalid rowsWritten");
  }
  const lastKnownGoodPreserved = parsed.lastKnownGoodPreserved;
  if (typeof lastKnownGoodPreserved !== "boolean") {
    throw new Error("marketContextHealth record has invalid lastKnownGoodPreserved");
  }
  const record: MarketContextHealthRecord = {
    provider: parsed.provider,
    status: status as MarketContextHealthRecord["status"],
    lastAttemptAt,
    lastSuccessfulUpdate,
    lastError,
    httpStatuses: httpStatuses.slice(0, 8),
    rowsWritten,
    lastKnownGoodPreserved,
  };
  // The runtime always records an error with a degraded status. A degraded
  // record without one is structurally invalid — normalizing the missing
  // error to null would let buildMarketContextHealth read Live off a fresh
  // set while the runtime is actually failing.
  if (record.status === "degraded" && record.lastError === null) {
    throw new Error("degraded marketContextHealth record carries no error");
  }
  return record;
};

const marketContextHealthFromValue = (value: unknown): MarketContextHealthRecord | null => {
  try {
    return parseMarketContextHealth(value);
  } catch {
    return null;
  }
};

export async function readMarketContextHealth(db: D1Database): Promise<MarketContextHealthRecord | null> {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
      .bind(MARKET_CONTEXT_HEALTH_META_KEY)
      .first<{ value: string | null }>();
    return marketContextHealthFromValue(row?.value);
  } catch (error) {
    console.error(JSON.stringify({ job: "market-context", phase: "health-read", status: "failed", error: errorMessage(error).slice(0, 180) }));
    return null;
  }
}

/**
 * Strict variant for uptime monitoring. The lenient reader above collapses
 * "record absent", "read failed" and "record unreadable" into null — fine
 * for the UI, but /healthz/sources must fail closed when the critical health
 * record cannot be read or parsed (a persisted provider error would
 * otherwise be invisible and the endpoint could report healthy during an
 * active collection outage). This throws on read/parse failure and returns
 * null only for a genuinely absent record.
 */
export async function readMarketContextHealthStrict(db: D1Database): Promise<MarketContextHealthRecord | null> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
    .bind(MARKET_CONTEXT_HEALTH_META_KEY)
    .first<{ value: string | null }>();
  // Distinguish a missing row / SQL NULL from an empty stored value: an
  // empty string is a present-but-unreadable record and must fail closed,
  // not read as absent.
  if (row?.value === null || row?.value === undefined) return null;
  return parseMarketContextHealth(row.value);
}

async function writeMarketContextHealth(db: D1Database, health: MarketContextHealthRecord): Promise<void> {
  await db.prepare(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(MARKET_CONTEXT_HEALTH_META_KEY, JSON.stringify(health)).run();
}

async function rememberMarketContextHealth(
  db: D1Database,
  health: MarketContextHealthRecord,
): Promise<void> {
  try {
    await writeMarketContextHealth(db, health);
  } catch (error) {
    console.error(JSON.stringify({ job: "market-context", phase: "health-write", status: "failed", error: errorMessage(error).slice(0, 180) }));
  }
}

interface MarketIndexRow {
  symbol: MarketIndexSymbol;
  name: string;
  value: number;
  change_pct: number;
  source_timestamp: string;
  collected_at: string;
  provider: string;
}

interface SentimentRow {
  score: number;
  rating: SentimentRating;
  source_timestamp: string;
  collected_at: string;
  provider: string;
}

async function readMarketIndices(db: D1Database): Promise<MarketIndexRow[]> {
  try {
    const result = await db.prepare(
      `SELECT symbol, name, value, change_pct, source_timestamp, collected_at, provider
         FROM market_indices AS current
        WHERE NOT EXISTS (
          SELECT 1
            FROM market_indices AS newer
           WHERE newer.symbol = current.symbol
             AND (
               newer.source_timestamp > current.source_timestamp
               OR (newer.source_timestamp = current.source_timestamp AND newer.collected_at > current.collected_at)
               OR (newer.source_timestamp = current.source_timestamp AND newer.collected_at = current.collected_at AND newer.provider > current.provider)
             )
        )
        ORDER BY CASE symbol WHEN 'SPX' THEN 1 WHEN 'NDX' THEN 2 WHEN 'DJI' THEN 3 WHEN 'VIX' THEN 4 ELSE 5 END`,
    ).all<MarketIndexRow>();
    return result.results ?? [];
  } catch (error) {
    console.error("market indices read failed", errorMessage(error));
    return [];
  }
}

async function readMarketSentiment(db: D1Database): Promise<SentimentRow | null> {
  try {
    return await db.prepare(
      `SELECT score, rating, source_timestamp, collected_at, provider
         FROM market_sentiment
        ORDER BY source_timestamp DESC, collected_at DESC, id DESC
        LIMIT 1`,
    ).first<SentimentRow>();
  } catch (error) {
    console.error("market sentiment read failed", errorMessage(error));
    return null;
  }
}

export async function readMarketContext(db: D1Database): Promise<MarketContextReadModel> {
  const [rows, sentimentResult] = await Promise.all([readMarketIndices(db), readMarketSentiment(db)]);
  const indices = rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    value: Number(row.value),
    change: Number(row.change_pct),
    updatedAt: row.source_timestamp,
  }));
  const latestIndex = rows.reduce<MarketIndexRow | null>(
    (latest, row) => !latest || row.source_timestamp > latest.source_timestamp
      || (row.source_timestamp === latest.source_timestamp && row.collected_at > latest.collected_at)
      ? row
      : latest,
    null,
  );
  return {
    indices,
    sentiment: sentimentResult ? {
      provider: sentimentResult.provider,
      score: Number(sentimentResult.score),
      rating: sentimentResult.rating,
      asOf: sentimentResult.source_timestamp,
    } : null,
    provider: latestIndex?.provider ?? null,
    latestSourceTimestamp: latestIndex?.source_timestamp ?? null,
    latestCollectedAt: latestIndex?.collected_at ?? null,
  };
}

export async function runMarketContextJob(
  env: Env,
  scheduledTime: Date,
  provider: MarketDataProvider = new YahooFinanceMarketDataProvider(),
  options: { cron?: string } = {},
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  const startedAt = Date.now();
  const window = marketCollectionWindow(scheduledTime);
  const namedProvider = provider as unknown as { name?: unknown };
  const providerName = typeof namedProvider.name === "string"
    ? namedProvider.name
    : "unknown";
  if (!window) {
    console.info(JSON.stringify({
      job: "market-context",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      cron: options.cron ?? "unknown",
      provider: providerName,
      status: "skipped",
      durationMs: Date.now() - startedAt,
      httpStatuses: [],
      rowsWritten: 0,
      lastKnownGoodPreserved: true,
      detail: "outside_market_collection_window",
    }));
    return { status: "skipped", detail: "outside_market_collection_window" };
  }
  const collectedAt = new Date().toISOString();
  const previousHealth = await readMarketContextHealth(env.DB);
  const previousLastSuccessfulUpdate = previousHealth?.lastSuccessfulUpdate
    ?? (previousHealth ? null : (await readMarketContext(env.DB)).latestCollectedAt);
  const hadLastKnownGood = Boolean(previousLastSuccessfulUpdate);
  await rememberMarketContextHealth(env.DB, {
    provider: providerName,
    status: "running",
    lastAttemptAt: collectedAt,
    lastSuccessfulUpdate: previousLastSuccessfulUpdate,
    lastError: previousHealth?.lastError ?? null,
    httpStatuses: previousHealth?.httpStatuses ?? [],
    rowsWritten: 0,
    lastKnownGoodPreserved: hadLastKnownGood,
  });
  console.info(JSON.stringify({
    job: "market-context",
    phase: "start",
    scheduledTime: scheduledTime.toISOString(),
    cron: options.cron ?? "unknown",
    provider: providerName,
  }));

  const writeResultHealth = async (health: MarketContextHealthRecord): Promise<void> => {
    await rememberMarketContextHealth(env.DB, health);
    console.info(JSON.stringify({
      job: "market-context",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      cron: options.cron ?? "unknown",
      provider: providerName,
      status: health.status,
      durationMs: Date.now() - startedAt,
      httpStatuses: health.httpStatuses,
      rowsWritten: health.rowsWritten,
      lastKnownGoodPreserved: health.lastKnownGoodPreserved,
      ...(health.lastError ? { error: health.lastError } : {}),
    }));
  };

  try {
    const result = await provider.collect(collectedAt);
    const scheduleParts = localNewYorkParts(scheduledTime);
    const warnings = [...result.warnings];
    const observations = result.observations.filter((observation) => {
      const sourceParts = localNewYorkParts(new Date(observation.sourceTimestamp));
      const sameDate = Boolean(sourceParts && scheduleParts
        && dateKey(sourceParts.year, sourceParts.month, sourceParts.day)
          === dateKey(scheduleParts.year, scheduleParts.month, scheduleParts.day));
      if (!sameDate) warnings.push(`${observation.symbol}: source quote is not from the current New York session date`);
      return sameDate;
    });
    const validObservations = observations.filter(validMarketObservation);
    if (validObservations.length !== observations.length) warnings.push("provider returned invalid market observations");
    const complete = validObservations.length === INDEX_DEFINITIONS.length && warnings.length === 0;
    // A partial provider response is not authoritative. Keep the complete
    // last-known-good set instead of mixing a new partial session with old
    // symbols and making the read model appear current.
    const rowsWritten = complete ? await writeMarketIndices(env.DB, validObservations) : 0;
    const boundedWarnings = warnings.slice(0, 8).map((warning) => warning.slice(0, 180));
    const httpStatuses = httpStatusesFrom(boundedWarnings);
    const boundedError = boundedWarnings.join("; ").slice(0, 480);
    if (boundedWarnings.length > 0) console.warn("market context degraded", boundedWarnings);
    const status = complete ? "ok" : "degraded";
    await writeResultHealth({
      provider: providerName,
      status,
      lastAttemptAt: collectedAt,
      lastSuccessfulUpdate: complete ? collectedAt : previousLastSuccessfulUpdate,
      lastError: complete ? null : boundedError || "provider returned no complete market index set",
      httpStatuses: complete ? [] : httpStatuses,
      rowsWritten,
      lastKnownGoodPreserved: !complete && hadLastKnownGood,
    });
    return { status, detail: `${window}:${validObservations.length}/${INDEX_DEFINITIONS.length}` };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 200);
    console.error(JSON.stringify({
      job: "market-context",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      cron: options.cron ?? "unknown",
      provider: providerName,
      status: "degraded",
      durationMs: Date.now() - startedAt,
      httpStatuses: httpStatusesFrom([detail]),
      rowsWritten: 0,
      lastKnownGoodPreserved: hadLastKnownGood,
      error: detail,
    }));
    await rememberMarketContextHealth(env.DB, {
      provider: providerName,
      status: "degraded",
      lastAttemptAt: collectedAt,
      lastSuccessfulUpdate: previousLastSuccessfulUpdate,
      lastError: detail,
      httpStatuses: httpStatusesFrom([detail]),
      rowsWritten: 0,
      lastKnownGoodPreserved: hadLastKnownGood,
    });
    return { status: "degraded", detail };
  }
}

export async function runSentimentJob(
  env: Env,
  scheduledTime: Date,
  provider: SentimentProvider = new CnnSentimentProvider(),
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  const startedAt = Date.now();
  const providerName = provider.name;
  if (!isNewYorkWeekday(scheduledTime) || isUsMarketHoliday(scheduledTime)) {
    return { status: "skipped", detail: "weekend_or_holiday" };
  }
  const collectedAt = new Date().toISOString();
  const previousHealth = await readSentimentHealth(env.DB);
  const lastSourceTimestamp = previousHealth?.lastSourceTimestamp
    ?? await readLatestSentimentSourceTimestamp(env.DB, providerName);
  await rememberSentimentHealth(env.DB, {
    provider: providerName,
    status: "running",
    lastAttemptAt: collectedAt,
    lastSuccessfulUpdate: previousHealth?.lastSuccessfulUpdate ?? null,
    lastSourceTimestamp: previousHealth?.lastSourceTimestamp ?? lastSourceTimestamp,
    lastError: previousHealth?.lastError ?? null,
    consecutiveFailures: previousHealth?.consecutiveFailures ?? 0,
  });
  try {
    const observation = await provider.collect(collectedAt);
    if (observation.sourceTimestamp === lastSourceTimestamp) {
      // Provider value unchanged since the last persisted row: success/no-op,
      // no duplicate row, no health failure.
      await rememberSentimentHealth(env.DB, {
        provider: providerName,
        status: "ok",
        lastAttemptAt: collectedAt,
        lastSuccessfulUpdate: previousHealth?.lastSuccessfulUpdate ?? collectedAt,
        lastSourceTimestamp,
        lastError: null,
        consecutiveFailures: 0,
      });
      console.info(JSON.stringify({ job: "sentiment", phase: "result", status: "ok", noop: true, sourceTimestamp: observation.sourceTimestamp, durationMs: Date.now() - startedAt }));
      return { status: "ok", detail: `noop:${observation.sourceTimestamp}` };
    }
    await writeSentiment(env.DB, observation);
    await rememberSentimentHealth(env.DB, {
      provider: providerName,
      status: "ok",
      lastAttemptAt: collectedAt,
      lastSuccessfulUpdate: collectedAt,
      lastSourceTimestamp: observation.sourceTimestamp,
      lastError: null,
      consecutiveFailures: 0,
    });
    console.info(JSON.stringify({ job: "sentiment", phase: "result", status: "ok", sourceTimestamp: observation.sourceTimestamp, durationMs: Date.now() - startedAt }));
    return { status: "ok", detail: observation.sourceTimestamp };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 200);
    // Last-known-good stays untouched: failed runs never write rows and keep
    // the previous source timestamp as the still-displayable value.
    await rememberSentimentHealth(env.DB, {
      provider: providerName,
      status: "degraded",
      lastAttemptAt: collectedAt,
      lastSuccessfulUpdate: previousHealth?.lastSuccessfulUpdate ?? null,
      lastSourceTimestamp: previousHealth?.lastSourceTimestamp ?? lastSourceTimestamp,
      lastError: detail,
      consecutiveFailures: Math.min(999, (previousHealth?.consecutiveFailures ?? 0) + 1),
    });
    console.error(JSON.stringify({ job: "sentiment", phase: "result", status: "degraded", error: detail, durationMs: Date.now() - startedAt }));
    return { status: "degraded", detail };
  }
}
