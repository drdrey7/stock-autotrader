import type { Env } from "./index";

export const MARKET_CRON = "*/15 * * * mon-fri";
export const SENTIMENT_CRON = "0 14,19 * * mon-fri";

export const MARKET_CONTEXT_STALE_AFTER_SECONDS = 26 * 60 * 60;
export const SENTIMENT_STALE_AFTER_SECONDS = 72 * 60 * 60;

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

/**
 * FMP's documented index quote endpoint supports ^GSPC, ^NDX, ^DJI and ^VIX.
 * The adapter intentionally exposes only the small normalized contract used by
 * D1 and the UI, so changing provider does not change either boundary.
 */
export class FmpMarketDataProvider implements MarketDataProvider {
  readonly name = "financial-modeling-prep";

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async collect(collectedAt: string): Promise<{ observations: MarketIndexObservation[]; warnings: string[] }> {
    if (!this.apiKey) {
      return { observations: [], warnings: ["FMP_API_KEY is not configured."] };
    }

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
    const url = new URL("https://financialmodelingprep.com/stable/quote");
    url.searchParams.set("symbol", definition.providerSymbol);
    url.searchParams.set("apikey", this.apiKey);
    const response = await this.fetcher(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);

    const payload = await response.json() as unknown;
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row !== "object") throw new Error("provider returned no quote");
    const record = row as Record<string, unknown>;
    if (typeof record.error === "string" || typeof record["Error Message"] === "string") {
      throw new Error(String(record.error ?? record["Error Message"]));
    }

    const value = finiteNumber(record.price);
    const changePct = finiteNumber(record.changePercentage ?? record.changesPercentage);
    const sourceTimestamp = toIsoTimestamp(record.timestamp, "seconds");
    if (value === null || value <= 0) throw new Error("invalid price");
    if (changePct === null) throw new Error("invalid daily change");
    if (!sourceTimestamp) throw new Error("missing source timestamp");

    return {
      symbol: definition.symbol,
      name: definition.name,
      value,
      changePct,
      sourceTimestamp,
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
    const response = await this.fetcher(CNN_URL, {
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

function localNewYorkParts(instant: Date): NewYorkParts | null {
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
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

export function isUsMarketHoliday(instant: Date): boolean {
  const parts = localNewYorkParts(instant);
  if (!parts) return false;
  const { year, month, day } = parts;
  const current = dateKey(year, month, day);
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1), // New Year's Day
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
  return holidays.has(current);
}

export function marketCollectionWindow(scheduledTime: Date): "regular" | "post_close" | null {
  const parts = localNewYorkParts(scheduledTime);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun" || isUsMarketHoliday(scheduledTime)) return null;
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (parts.hour === 16 && parts.minute === 15) return "post_close";
  return null;
}

export function isNewYorkWeekday(instant: Date): boolean {
  const parts = localNewYorkParts(instant);
  return Boolean(parts && parts.weekday !== "Sat" && parts.weekday !== "Sun");
}

export async function writeMarketIndices(db: D1Database, observations: MarketIndexObservation[]): Promise<void> {
  if (observations.length === 0) return;
  await db.batch(observations.map((observation) => db.prepare(
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
}

export async function writeSentiment(db: D1Database, observation: SentimentObservation): Promise<void> {
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

export async function readMarketContext(db: D1Database): Promise<MarketContextReadModel> {
  try {
    const [indicesResult, sentimentResult] = await Promise.all([
      db.prepare(
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
      ).all<MarketIndexRow>(),
      db.prepare(
        `SELECT score, rating, source_timestamp, collected_at, provider
           FROM market_sentiment
          ORDER BY source_timestamp DESC
          LIMIT 1`,
      ).first<SentimentRow>(),
    ]);
    const rows = indicesResult.results ?? [];
    const indices = rows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      value: Number(row.value),
      change: Number(row.change_pct),
      updatedAt: row.source_timestamp,
    }));
    const latestIndex = rows.reduce<MarketIndexRow | null>(
      (latest, row) => !latest || row.source_timestamp > latest.source_timestamp ? row : latest,
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
  } catch (error) {
    console.error("market context read failed", errorMessage(error));
    return { indices: [], sentiment: null, provider: null, latestSourceTimestamp: null, latestCollectedAt: null };
  }
}

export async function runMarketContextJob(
  env: Env,
  scheduledTime: Date,
  provider: MarketDataProvider = new FmpMarketDataProvider(env.FMP_API_KEY ?? ""),
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  const window = marketCollectionWindow(scheduledTime);
  if (!window) return { status: "skipped", detail: "outside_market_collection_window" };
  const collectedAt = new Date().toISOString();
  try {
    const result = await provider.collect(collectedAt);
    await writeMarketIndices(env.DB, result.observations);
    const status = result.observations.length === INDEX_DEFINITIONS.length && result.warnings.length === 0 ? "ok" : "degraded";
    if (result.warnings.length > 0) console.warn("market context degraded", result.warnings);
    return { status, detail: `${window}:${result.observations.length}/${INDEX_DEFINITIONS.length}` };
  } catch (error) {
    console.error("market context collection failed", errorMessage(error));
    return { status: "degraded", detail: errorMessage(error).slice(0, 200) };
  }
}

export async function runSentimentJob(
  env: Env,
  scheduledTime: Date,
  provider: SentimentProvider = new CnnSentimentProvider(),
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  if (!isNewYorkWeekday(scheduledTime)) return { status: "skipped", detail: "weekend" };
  try {
    const observation = await provider.collect(new Date().toISOString());
    await writeSentiment(env.DB, observation);
    return { status: "ok", detail: observation.sourceTimestamp };
  } catch (error) {
    console.error("sentiment collection failed", errorMessage(error));
    return { status: "degraded", detail: errorMessage(error).slice(0, 200) };
  }
}
