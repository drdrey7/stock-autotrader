/**
 * SEC EDGAR companyfacts / XBRL resolution for official GAAP metrics.
 *
 * This module resolves the OFFICIAL GAAP diluted EPS and quarterly revenue for
 * one earnings event from the SEC's machine-readable XBRL facts (companyfacts).
 * It is shared by the one-shot VPS backfill script
 * (scripts/earnings-official-last-quarter-backfill.ts) and its vitest suite.
 *
 * Hard rules (safety over completeness):
 *  - Never trust an arbitrary XBRL fact just because it exists.
 *  - A canonical value is only resolved when ALL of these hold:
 *      * concept matches the explicit GAAP concept list
 *      * unit matches (USD/shares for EPS, USD for revenue)
 *      * fiscal identity matches the event (fy + fp, e.g. 2026 + Q3)
 *      * duration is a single quarter (70-120 days), never YTD/annual
 *      * the fact comes from a 10-Q / 10-K (8-K only as a last resort)
 *      * no conflicting values exist for the same period/context
 *  - Anything less → null value + explicit blocker reason. Never guess.
 *
 * The worker never calls this at runtime (no new subrequests); the cron budget
 * is unchanged. Resolution happens on the VPS/Hermes via the backfill script.
 */

/** Normalized unit strings. EPS is a per-share measure; revenue is a pure USD amount. */
export const EPS_UNIT = "USD/shares";
export const REVENUE_UNIT = "USD";

/** Accepted quarterly duration window in days (13-week / 3-month quarters). */
export const QUARTER_DURATION_MIN_DAYS = 70;
export const QUARTER_DURATION_MAX_DAYS = 120;

/** Accepted filing forms for quarterly GAAP facts. 8-K is a last resort. */
export const ACCEPTED_FORMS = ["10-Q", "10-K", "8-K"] as const;
const FORM_PREFERENCE = new Map<string, number>([
  ["10-Q", 0],
  ["10-K", 1],
  ["8-K", 2],
]);

export const EPS_DILUTED_CONCEPTS = ["EarningsPerShareDiluted"] as const;
export const REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
] as const;

export interface XbrlFactInstance {
  concept: string;
  unit: string | null;
  start: string | null;
  end: string | null;
  val: number | null;
  accn: string | null;
  fy: number | null;
  fp: string | null;
  form: string | null;
  filed: string | null;
}

export interface CompanyFacts {
  cik: string;
  /** All facts from the us-gaap taxonomy, one entry per (concept, unit, instance). */
  facts: XbrlFactInstance[];
  warnings: string[];
}

/** Fiscal identity the backfill validates against. */
export interface FiscalIdentity {
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  /** Scheduled earnings release date (YYYY-MM-DD); used for period-end sanity. */
  scheduledDate: string | null;
  /** Expected fiscal period end (YYYY-MM-DD) when the provider exposed it. */
  fiscalPeriodEnd: string | null;
}

export type MetricConfidence = "high" | "medium" | "low";

export interface OfficialMetricSelection {
  /** The resolved canonical value, or null when not confidently determined. */
  value: number | null;
  concept: string | null;
  unit: string | null;
  /** Accession number of the filing carrying the winning fact. */
  accn: string | null;
  form: string | null;
  /** Filing date (YYYY-MM-DD) of the winning fact. */
  filed: string | null;
  /** Fiscal period end (YYYY-MM-DD) the fact covers. */
  periodEnd: string | null;
  /** Fiscal period start (YYYY-MM-DD) the fact covers. */
  periodStart: string | null;
  fiscalYear: number | null;
  /** Fiscal period tag from the filing taxonomy ("Q1".."Q4"). */
  fiscalPeriod: string | null;
  confidence: MetricConfidence;
  /** Why the value was/was-not resolved. Non-empty when value is null. */
  blockers: string[];
}

export interface ResolvedOfficialMetrics {
  eps: OfficialMetricSelection;
  revenue: OfficialMetricSelection;
  /** Best-known fiscal period end across the two resolutions. */
  periodEnd: string | null;
  source: "sec-xbrl";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
  return (to - from) / DAY_MS;
}

function baseForm(form: string | null): string | null {
  if (!form) return null;
  return form.replace(/\/A$/, "").trim().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Parse a raw companyfacts payload into a flat fact list. Malformed units or
 * instances are skipped with a warning instead of failing the whole company.
 */
export function parseCompanyFacts(payload: unknown): CompanyFacts {
  const root = isRecord(payload) ? payload : null;
  if (!root) return { cik: "", facts: [], warnings: ["malformed companyfacts payload"] };
  const cik = String(root.cik ?? "").padStart(10, "0");
  const factsObject = isRecord(root.facts) ? root.facts : null;
  const gaap = factsObject ? isRecord(factsObject["us-gaap"]) ? factsObject["us-gaap"] : null : null;
  const facts: XbrlFactInstance[] = [];
  const warnings: string[] = [];
  if (!gaap) return { cik, facts, warnings: ["companyfacts payload has no us-gaap taxonomy"] };
  for (const [concept, rawConcept] of Object.entries(gaap)) {
    const conceptObject = isRecord(rawConcept) ? rawConcept : null;
    const units = conceptObject ? isRecord(conceptObject.units) ? conceptObject.units : null : null;
    if (!units) continue;
    for (const [unit, rawInstances] of Object.entries(units)) {
      if (!Array.isArray(rawInstances)) continue;
      for (const rawInstance of rawInstances) {
        const instance = isRecord(rawInstance) ? rawInstance : null;
        if (!instance) continue;
        const val = finiteNumber(instance.val);
        if (val === null) continue;
        facts.push({
          concept,
          unit,
          start: textValue(instance.start),
          end: textValue(instance.end),
          val,
          accn: textValue(instance.accn),
          fy: finiteNumber(instance.fy),
          fp: textValue(instance.fp)?.toUpperCase() ?? null,
          form: textValue(instance.form)?.toUpperCase() ?? null,
          filed: textValue(instance.filed),
        });
      }
    }
  }
  if (facts.length === 0) warnings.push("no usable us-gaap fact instances in companyfacts payload");
  return { cik, facts, warnings };
}

export interface SelectOptions {
  /** Require at least one candidate to pass every hard validation step. */
  strict?: boolean;
}

const isQuarterlyDuration = (start: string | null, end: string | null): boolean => {
  if (!start || !end) return false;
  const duration = daysBetween(start, end);
  return Number.isFinite(duration) && duration > 0
    && duration >= QUARTER_DURATION_MIN_DAYS
    && duration <= QUARTER_DURATION_MAX_DAYS;
};

const isWithinPeriodEndSanity = (end: string | null, identity: FiscalIdentity): boolean => {
  if (!end) return false;
  if (identity.fiscalPeriodEnd) {
    const expected = daysBetween(end, identity.fiscalPeriodEnd);
    if (Number.isFinite(expected) && Math.abs(expected) <= 7) return true;
    return false;
  }
  if (!identity.scheduledDate) return true;
  const gap = daysBetween(end, identity.scheduledDate);
  return Number.isFinite(gap) && gap >= -1 && gap <= 180;
};

/**
 * Select the single canonical fact for one metric (EPS or revenue).
 *
 * Concepts are tried in order (primary first, fallback concepts only when the
 * primary has NO quarterly match — concepts are never mixed in one decision,
 * because two concepts for the same period can legitimately carry different
 * figures). For each concept, ALL of these must pass for a value:
 *   1. unit exact (EPS: USD/shares; revenue: USD)
 *   2. fiscal identity: fy + fp match the event quarter
 *   3. duration is a single quarter (70-120 days) — rejects YTD/annual/H1
 *   4. period end sanity (matches fiscalPeriodEnd or within release window)
 *   5. form ∈ {10-Q, 10-K, 8-K} with metadata present
 *   6. single context per period: two non-amendment instances with different
 *      values = CONFLICT; an amendment (10-Q/A / 10-K/A) supersedes the
 *      original filing, so a restated value wins and is flagged as restated
 */
export function selectOfficialMetric(
  facts: CompanyFacts,
  concepts: readonly string[],
  unit: string,
  identity: FiscalIdentity,
  options: SelectOptions = {},
): OfficialMetricSelection {
  if (identity.fiscalQuarter === null) {
    return emptySelection(["event lacks a fiscal quarter identity; quarterly GAAP value not resolvable"]);
  }
  const blockers: string[] = [];
  for (const concept of concepts) {
    const forConcept = selectForConcept(facts, concept, unit, identity, options);
    if (forConcept.value !== null) return forConcept;
    blockers.push(...forConcept.blockers);
  }
  if (blockers.length === 0) blockers.push(`no ${concepts.join("/")} facts in companyfacts`);
  return emptySelection(blockers);
}

function selectForConcept(
  facts: CompanyFacts,
  concept: string,
  unit: string,
  identity: FiscalIdentity,
  options: SelectOptions,
): OfficialMetricSelection {
  const blockers: string[] = [];
  const candidates = facts.facts.filter((fact) => fact.concept === concept);
  if (candidates.length === 0) {
    blockers.push(`no ${concept} facts in companyfacts`);
    return emptySelection(blockers);
  }

  // 1. unit
  const pool = candidates.filter((fact) => fact.unit === unit);
  if (pool.length === 0) {
    blockers.push(`no ${concept} facts with unit ${unit}`);
    return emptySelection(blockers);
  }

  // 2. fiscal identity
  const withFiscal = pool.filter((fact) => fact.fy === identity.fiscalYear
    && fact.fp === `Q${identity.fiscalQuarter}`);
  if (withFiscal.length === 0) {
    blockers.push(
      `no ${concept} facts matching fiscal identity ${identity.fiscalYear} Q${identity.fiscalQuarter}`
      + ` (facts span ${describeFiscalRange(pool)})`,
    );
    return emptySelection(blockers);
  }

  // 3. quarterly duration (quarter-only, never YTD / annual / H1)
  const quarterly = withFiscal.filter((fact) => isQuarterlyDuration(fact.start, fact.end));
  if (quarterly.length === 0) {
    blockers.push(`only ${concept} non-quarterly durations present (annual/YTD/H1); quarterly GAAP value not resolvable`);
    return emptySelection(blockers);
  }

  // 4. period-end sanity
  const inWindow = quarterly.filter((fact) => isWithinPeriodEndSanity(fact.end, identity));
  if (inWindow.length === 0 && identity.fiscalPeriodEnd) {
    blockers.push(`no ${concept} facts whose period end matches fiscalPeriodEnd ${identity.fiscalPeriodEnd}`);
    return emptySelection(blockers);
  }
  const windowed = inWindow.length > 0 ? inWindow : quarterly;

  // 5. form acceptance (must carry real form metadata ∈ {10-Q, 10-K, 8-K})
  const withForm = windowed.filter((fact) => baseForm(fact.form) !== null
    && ACCEPTED_FORMS.includes(baseForm(fact.form) as (typeof ACCEPTED_FORMS)[number]));
  if (withForm.length === 0) {
    blockers.push(`${concept} facts exist only without accepted form metadata (${[...new Set(windowed.map((f) => f.form ?? "?"))].join(", ")})`);
    return emptySelection(blockers);
  }
  const formScore = (fact: XbrlFactInstance): number => FORM_PREFERENCE.get(baseForm(fact.form) as string) ?? 99;
  const bestFormScore = Math.min(...withForm.map(formScore));
  const bestForm = withForm.filter((fact) => formScore(fact) === bestFormScore);

  // 6. single context — one (concept, start, end) period, one value
  const byContext = new Map<string, XbrlFactInstance[]>();
  for (const fact of bestForm) {
    const key = `${fact.start ?? ""}|${fact.end ?? ""}`;
    const bucket = byContext.get(key) ?? [];
    bucket.push(fact);
    byContext.set(key, bucket);
  }
  const contexts = [...byContext.entries()];
  // A context may repeat across a filing and its amendment (10-Q + 10-Q/A) or
  // across a press-release 8-K and the periodic report. Rules (safety first):
  //  - two NON-amendment instances with DIFFERENT values for the same context
  //    = CONFLICT → unresolved (never pick arbitrarily).
  //  - an amendment (10-Q/A / 10-K/A) SUPERSEDES the original filing, so a
  //    restated value is the canonical figure (flagged as restated).
  //  - synonymous duplicates collapse to the preferred form then latest filed.
  //  - multiple contexts with DIFFERENT values = CONFLICT as well.
  const amendmentOf = (fact: XbrlFactInstance): boolean => Boolean(fact.form?.endsWith("/A"));
  const pickLatestFiled = (bucket: XbrlFactInstance[]): XbrlFactInstance => {
    const sorted = [...bucket].sort((left, right) => {
      const preferred = formScore(left) - formScore(right);
      if (preferred !== 0) return preferred;
      return (right.filed ?? "").localeCompare(left.filed ?? "");
    });
    return sorted[0]!;
  };
  const conflictingValues: number[] = [];
  for (const [, bucket] of contexts) {
    const nonAmendment = bucket.filter((fact) => !amendmentOf(fact));
    const nonAmendmentValues = new Set(
      nonAmendment.map((fact) => fact.val).filter((value): value is number => value !== null),
    );
    if (nonAmendment.length > 0 && nonAmendmentValues.size > 1) {
      conflictingValues.push(...nonAmendmentValues);
    }
  }
  if (conflictingValues.length > 0) {
    blockers.push(`conflicting ${concept} values for the same period/context (${[...new Set(conflictingValues)].join(", ")})`);
    return emptySelection(blockers);
  }
  const picks = contexts.map(([key, bucket]) => {
    // Amendment supersedes: when amendments exist, the latest filed amendment
    // is the operative filing for this period.
    const amendments = bucket.filter(amendmentOf);
    return { key, bucket, winner: pickLatestFiled(amendments.length > 0 ? amendments : bucket) };
  });
  const distinctValues = new Set(picks.map(({ winner }) => winner.val));
  if (picks.length > 1 && distinctValues.size > 1) {
    blockers.push(`conflicting ${concept} values across matched periods (${[...distinctValues].join(", ")})`);
    return emptySelection(blockers);
  }
  const winner = picks[0]!.winner;
  // A restated value came from an amendment that differs from the original —
  // still the official figure, but flag it so the audit surfaces the restatement.
  const restated = amendmentOf(winner) && picks.some(({ bucket }) => {
    const originals = bucket.filter((fact) => !amendmentOf(fact));
    return originals.length > 0 && originals.some((fact) => fact.val !== winner.val);
  });
  const usedFallbackForms = bestFormScore > 0 || winner.form === "8-K";
  const blockersOut: string[] = [];
  if (usedFallbackForms) blockersOut.push(`resolved from a secondary/fallback form (${winner.form})`);
  if (restated) blockersOut.push(`resolved from an amended/restated filing (${winner.form})`);
  return {
    value: winner.val,
    concept: winner.concept,
    unit: winner.unit,
    accn: winner.accn,
    form: winner.form,
    filed: winner.filed,
    periodEnd: winner.end,
    periodStart: winner.start,
    fiscalYear: winner.fy,
    fiscalPeriod: winner.fp,
    confidence: options.strict === false || usedFallbackForms || restated ? "medium" : "high",
    blockers: blockersOut,
  };
}

function emptySelection(blockers: string[]): OfficialMetricSelection {
  return {
    value: null,
    concept: null,
    unit: null,
    accn: null,
    form: null,
    filed: null,
    periodEnd: null,
    periodStart: null,
    fiscalYear: null,
    fiscalPeriod: null,
    confidence: "low",
    blockers,
  };
}

function describeFiscalRange(pool: XbrlFactInstance[]): string {
  const tags = [...new Set(pool.map((fact) => `${fact.fy ?? "?"}:${fact.fp ?? "?"}`))].slice(0, 6);
  return tags.join(", ") || "unknown";
}

/**
 * Resolve official GAAP diluted EPS and quarterly revenue for one fiscal
 * identity from a parsed companyfacts payload.
 */
export function resolveOfficialMetrics(
  facts: CompanyFacts,
  identity: FiscalIdentity,
): ResolvedOfficialMetrics {
  const eps = selectOfficialMetric(facts, EPS_DILUTED_CONCEPTS, EPS_UNIT, identity);
  const revenue = selectOfficialMetric(facts, REVENUE_CONCEPTS, REVENUE_UNIT, identity);
  const periodEnd = revenue.periodEnd ?? eps.periodEnd;
  return { eps, revenue, periodEnd, source: "sec-xbrl" };
}

export const SEC_COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

/** Build the EDGAR filing URL for an accession (index page when no primary document). */
export function secFilingUrl(cik: string, accession: string): string | null {
  const normalized = cik.replace(/\D/g, "").padStart(10, "0");
  if (!/^\d{10}$/.test(normalized) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  const accessionPath = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(normalized)}/${accessionPath}/${accession}-index.html`;
}
/**
 * SEC EDGAR requires a descriptive User-Agent with a contact email; a generic
 * browser-style or github-only UA is rejected with HTTP 403 (verified against
 * company_tickers_exchange.json + companyfacts, 2026-08-17). Keep the contact
 * stable so the one-shot backfill and the Worker share one compliant UA.
 */
export const SEC_DEFAULT_USER_AGENT = "StockAutotrader research contact@barroso-labs.com";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Fetch a company's full XBRL fact set from SEC companyfacts (1 request per company). */
export async function fetchCompanyFacts(
  cik: string,
  options: { userAgent?: string; fetcher?: Fetcher } = {},
): Promise<CompanyFacts> {
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const normalized = cik.replace(/\D/g, "").padStart(10, "0");
  if (!/^\d{10}$/.test(normalized)) throw new Error(`invalid CIK: ${cik}`);
  const url = new URL(`${SEC_COMPANYFACTS_URL}/CIK${normalized}.json`);
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": options.userAgent ?? SEC_DEFAULT_USER_AGENT },
  });
  if (!response.ok) throw new Error(`SEC companyfacts HTTP ${response.status} for CIK ${normalized}`);
  return parseCompanyFacts(await response.json());
}

/**
 * Fetch the SEC ticker→CIK map (company_tickers_exchange.json). Returns a
 * Symbol → zero-padded CIK map, so the backfill does not depend on D1's cik
 * column (currently unpopulated in production).
 */
export async function fetchTickerCikMap(
  options: { userAgent?: string; fetcher?: Fetcher } = {},
): Promise<Map<string, string>> {
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const response = await fetcher(new URL(SEC_TICKERS_URL), {
    headers: { Accept: "application/json", "User-Agent": options.userAgent ?? SEC_DEFAULT_USER_AGENT },
  });
  if (!response.ok) throw new Error(`SEC tickers HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const map = new Map<string, string>();
  const rows = isRecord(payload) && Array.isArray(payload.fields) && Array.isArray(payload.data)
    ? payload.data
    : [];
  const fields = (isRecord(payload) && Array.isArray(payload.fields)) ? payload.fields.map(String) : [];
  const cikIndex = fields.indexOf("cik");
  const tickerIndex = fields.indexOf("ticker");
  if (cikIndex < 0 || tickerIndex < 0) throw new Error("malformed SEC tickers payload (missing cik/ticker fields)");
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const symbol = String(row[tickerIndex] ?? "").trim().toUpperCase();
    const cik = String(row[cikIndex] ?? "").replace(/\D/g, "").padStart(10, "0");
    if (symbol && /^\d{10}$/.test(cik)) map.set(symbol, cik);
  }
  return map;
}