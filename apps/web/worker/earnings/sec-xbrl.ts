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
/** Accepted forms used by foreign IFRS filers in companyfacts. */
export const FOREIGN_ACCEPTED_FORMS = [
  ...ACCEPTED_FORMS,
  "20-F",
  "40-F",
  "6-K",
] as const;
const FORM_PREFERENCE = new Map<string, number>([
  ["10-Q", 0],
  ["10-K", 1],
  ["8-K", 2],
  ["20-F", 3],
  ["40-F", 4],
  ["6-K", 5],
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
  taxonomy: string | null;
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
  /** Normalized fiscal period label, including Q4 for an annual FY fact. */
  fiscalPeriod?: string | null;
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

export function normalizedForm(form: string | null): string | null {
  if (!form) return null;
  return form.replace(/\/A$/, "").trim().toUpperCase();
}

export function acceptedFormsForTaxonomy(taxonomy: string | null): readonly string[] {
  // Filing form is issuer-specific, not taxonomy-specific: a foreign issuer
  // can report SEC us-gaap facts in a 20-F/6-K just as it can report IFRS.
  // Taxonomy isolation remains a separate hard filter.
  void taxonomy;
  return FOREIGN_ACCEPTED_FORMS;
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
 * Taxonomies to parse from a companyfacts payload, in priority order.
 * us-gaap first (US filers), then ifrs-full (foreign issuers), then dei (metadata).
 */
export const PARSED_TAXONOMIES = ["us-gaap", "ifrs-full", "dei"] as const;
export type ParsedTaxonomy = (typeof PARSED_TAXONOMIES)[number];

/**
 * Parse a raw companyfacts payload into a flat fact list. Malformed units or
 * instances are skipped with a warning instead of failing the whole company.
 *
 * Generalised to support multiple taxonomies: us-gaap (US GAAP filers),
 * ifrs-full (foreign issuers such as ASML, NVO, TSM), and dei (entity metadata
 * like sharesOutstanding). Each fact carries its source taxonomy so downstream
 * resolvers can preserve provenance and avoid mixing GAAP/IFRS concepts.
 *
 * Backward-compatible: existing callers that only need us-gaap continue to work.
 */
export function parseCompanyFacts(payload: unknown): CompanyFacts {
  const root = isRecord(payload) ? payload : null;
  if (!root) return { cik: "", facts: [], warnings: ["malformed companyfacts payload"] };
  const cik = String(root.cik ?? "").padStart(10, "0");
  const factsObject = isRecord(root.facts) ? root.facts : null;
  const facts: XbrlFactInstance[] = [];
  const warnings: string[] = [];

  // Track whether ANY taxonomy produced facts
  let hasAnyTaxonomy = false;

  for (const taxonomy of PARSED_TAXONOMIES) {
    const taxonomyObject = factsObject ? isRecord(factsObject[taxonomy]) ? factsObject[taxonomy] : null : null;
    if (!taxonomyObject) continue;
    hasAnyTaxonomy = true;

    for (const [concept, rawConcept] of Object.entries(taxonomyObject)) {
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
            taxonomy: taxonomy as ParsedTaxonomy,
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
  }

  if (!hasAnyTaxonomy) {
    warnings.push("companyfacts payload has no supported taxonomy (us-gaap, ifrs-full, dei)");
  }
  if (facts.length === 0) {
    warnings.push("no usable fact instances in companyfacts payload");
  }
  return { cik, facts, warnings };
}

export interface SelectOptions {
  /** Require at least one candidate to pass every hard validation step. */
  strict?: boolean;
  /** Keep US-GAAP, IFRS, and DEI candidates isolated at resolution time. */
  taxonomy?: string | null;
  /** Override accepted filing forms for a taxonomy-specific resolver. */
  acceptedForms?: readonly string[];
  /** Match a reporting-currency unit while retaining the actual unit. */
  unitMatches?: (unit: string | null) => boolean;
  /** Select a quarterly or accumulated duration (H1/9M/FY) fact. */
  durationKind?: "quarter" | "accumulated";
  /** Raw fp labels accepted for the requested duration. */
  acceptedFiscalPeriods?: readonly string[];
}

const isQuarterlyDuration = (start: string | null, end: string | null): boolean => {
  if (!start || !end) return false;
  const duration = daysBetween(start, end);
  return Number.isFinite(duration) && duration > 0
    && duration >= QUARTER_DURATION_MIN_DAYS
    && duration <= QUARTER_DURATION_MAX_DAYS;
};

const isAccumulatedDuration = (
  start: string | null,
  end: string | null,
  fiscalPeriod: string | null,
): boolean => {
  if (!start || !end) return false;
  const duration = daysBetween(start, end);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (fiscalPeriod === "Q1") return isQuarterlyDuration(start, end);
  if (fiscalPeriod === "H1" || fiscalPeriod === "Q2") return duration >= 150 && duration <= 220;
  if (fiscalPeriod === "9M" || fiscalPeriod === "Q3") return duration >= 230 && duration <= 320;
  if (fiscalPeriod === "FY" || fiscalPeriod === "Q4") return duration >= 300 && duration <= 430;
  return false;
};

const isWithinPeriodEndSanity = (end: string | null, identity: FiscalIdentity): boolean => {
  if (!end) return false;
  if (identity.fiscalPeriodEnd) {
    const expected = daysBetween(end, identity.fiscalPeriodEnd);
    if (Number.isFinite(expected) && Math.abs(expected) === 0) return true;
    // Provider fiscal-period metadata can occasionally be off by a few days;
    // use the tolerance only when no exact context is available.
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
  const candidates = facts.facts.filter((fact) => fact.concept === concept
    && (options.taxonomy === undefined || fact.taxonomy === options.taxonomy));
  if (candidates.length === 0) {
    blockers.push(`no ${concept} facts in companyfacts`);
    return emptySelection(blockers);
  }

  // 1. unit
  const unitMatches = options.unitMatches ?? ((candidate: string | null) => candidate === unit);
  const pool = candidates.filter((fact) => unitMatches(fact.unit));
  if (pool.length === 0) {
    blockers.push(`no ${concept} facts with unit ${unit}`);
    return emptySelection(blockers);
  }

  // 2. fiscal identity
  const acceptedFiscalPeriods = options.acceptedFiscalPeriods
    ?? [`Q${identity.fiscalQuarter}`];
  const withFiscal = pool.filter((fact) => fact.fy === identity.fiscalYear
    && fact.fp !== null
    && acceptedFiscalPeriods.includes(fact.fp));
  if (withFiscal.length === 0) {
    blockers.push(
      `no ${concept} facts matching fiscal identity ${identity.fiscalYear} Q${identity.fiscalQuarter}`
      + ` (facts span ${describeFiscalRange(pool)})`,
    );
    return emptySelection(blockers);
  }

  // 3. quarterly duration (quarter-only, never YTD / annual / H1)
  const durationKind = options.durationKind ?? "quarter";
  const quarterly = withFiscal.filter((fact) => durationKind === "quarter"
    ? isQuarterlyDuration(fact.start, fact.end)
    : isAccumulatedDuration(fact.start, fact.end, fact.fp));
  if (quarterly.length === 0) {
    blockers.push(durationKind === "quarter"
      ? `only ${concept} non-quarterly durations present (annual/YTD/H1); quarterly GAAP value not resolvable`
      : `only ${concept} durations outside the requested accumulated period are present`);
    return emptySelection(blockers);
  }

  // 4. period-end sanity
  const exactPeriod = identity.fiscalPeriodEnd
    ? quarterly.filter((fact) => fact.end === identity.fiscalPeriodEnd)
    : [];
  const inWindow = exactPeriod.length > 0
    ? exactPeriod
    : quarterly.filter((fact) => isWithinPeriodEndSanity(fact.end, identity));
  if (inWindow.length === 0 && identity.fiscalPeriodEnd) {
    blockers.push(`no ${concept} facts whose period end matches fiscalPeriodEnd ${identity.fiscalPeriodEnd}`);
    return emptySelection(blockers);
  }
  const windowed = inWindow.length > 0 ? inWindow : quarterly;

  // 5. form acceptance (must carry real form metadata ∈ {10-Q, 10-K, 8-K})
  const acceptedForms = new Set((options.acceptedForms ?? ACCEPTED_FORMS).map((form) => normalizedForm(form)));
  const withForm = windowed.filter((fact) => {
    const form = normalizedForm(fact.form);
    return form !== null && acceptedForms.has(form);
  });
  if (withForm.length === 0) {
    blockers.push(`${concept} facts exist only without accepted form metadata (${[...new Set(windowed.map((f) => f.form ?? "?"))].join(", ")})`);
    return emptySelection(blockers);
  }
  const formScore = (fact: XbrlFactInstance): number => FORM_PREFERENCE.get(normalizedForm(fact.form) as string) ?? 99;
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
