export const formatMoney = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 999 ? 0 : 2,
  }).format(value);

const BILLION = 1_000_000_000;
const MILLION = 1_000_000;

/** `3.10` → `3.1`, `843.00` → `843` — strips trailing zero decimals. */
const trimZeroes = (value: string): string => value.replace(/\.?0+$/, "");

/**
 * EPS / share-price style amount: `2.02` → `$2.02`, `-1.17` → `-$1.17`
 * (sign before the currency symbol, consistent negative convention).
 */
export const formatShareValue = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value < 0 ? "-$" : "$"}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

/**
 * Compact money for large financial values. Never shows the raw integer:
 *   109,417,000,000 → $109.4B
 *    11,536,000,000 → $11.54B
 *     1,220,068,000 → $1.22B
 *       843,000,000 → $843M
 *        -1,220,068 → -$1.22M
 * Small values fall back to share-style currency.
 */
export const formatCompactMoney = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= BILLION) {
    const scaled = abs / BILLION;
    return `${sign}$${trimZeroes(scaled.toFixed(scaled >= 100 ? 1 : 2))}B`;
  }
  if (abs >= MILLION) {
    // Just below 1B a 1-decimal M value can round to 1000M — promote to B so
    // "999,999,999" renders as $1B, never $1000M.
    if (abs / MILLION >= 999.95) {
      return `${sign}$${trimZeroes((abs / BILLION).toFixed(2))}B`;
    }
    const scaled = abs / MILLION;
    return `${sign}$${trimZeroes(scaled.toFixed(scaled >= 100 ? 1 : 2))}M`;
  }
  return formatShareValue(value);
};

/** `1.7643` → `+1.76%`, `-0.894` → `-0.89%`, null → `N/A`. */
export const formatPercent = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

export const formatDate = (value: string | null) => {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(parsed);
};

export const dashboardCtaLabel = (demo: boolean) =>
  demo ? "View Dashboard" : "View Live Dashboard";
