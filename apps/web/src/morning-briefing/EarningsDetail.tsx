import { useEffect, useRef } from "react";
import { ArrowLeft, BookOpen, ExternalLink, X } from "lucide-react";
import { motion } from "motion/react";
import { CompanyLogo } from "./EarningsLogo";
import {
  dataQualityLabel,
  displayMetricResult,
  displayTiming,
  fiscalPeriodLabel,
  formatCompactMoney,
  formatFilingDate,
  formatPercent,
  formatShareValue,
  marketEarningsView,
  officialEarningsView,
  releaseTimestamp,
  resultClass,
  type EarningsCompany,
} from "./data/earnings-view";
import { formatUpdatedAt, spring } from "./shared";

function useDialogA11y<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus], button, a[href]")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
      ];
      if (!focusable.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return dialogRef;
}

/** One labelled value row; N/A renders in the same slot so missing data never shifts layout. */
function MetricRow({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="metric-row">
      <small>{label}</small>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

type UrlLinkProps = { label: string; url: string | null };

/** A real action link only; no large disabled buttons for missing sources. */
function UrlLink({ label, url }: UrlLinkProps) {
  if (!url) return null;
  return (
    <a className="official-link" href={url} target="_blank" rel="noreferrer">
      {label} <ExternalLink/>
    </a>
  );
}

const GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: "EPS", meaning: "EPS is the company’s profit divided by the number of shares. It helps show how much profit belongs to each share." },
  { term: "Consensus Estimate", meaning: "The average expectation from analysts before the company reports results." },
  { term: "Adjusted EPS", meaning: "An EPS number that removes some unusual or one-off items. Investors often use it to compare results with Wall Street expectations." },
  { term: "GAAP EPS", meaning: "The official EPS calculated under standard accounting rules. It can be different from Adjusted EPS." },
  { term: "Beat / Miss", meaning: "Beat means the reported market result was above analysts’ expectations. Miss means it was below." },
];

function EarningsGlossary() {
  return (
    <details className="earnings-glossary">
      <summary><BookOpen/> How to read these numbers</summary>
      <dl>
        {GLOSSARY.map(({ term, meaning }) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="glossary-note">
        <strong>Important:</strong> Adjusted and GAAP EPS are different measures,
        so they should not be compared directly.
      </p>
    </details>
  );
}

export default function EarningsDetail({ item, onClose }: { item: EarningsCompany; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const formattedDate = item.scheduledDate
    ? new Date(`${item.scheduledDate}T12:00:00`).toLocaleDateString("en", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "N/A";
  const fiscalLabel = fiscalPeriodLabel(item.fiscalYear, item.fiscalQuarter, item.fiscalPeriod);
  const market = marketEarningsView(item);
  const official = officialEarningsView(item);
  const releasedAt = releaseTimestamp(item);
  const qualityNote = dataQualityLabel(item.dataQualityStatus);
  // Header badge derives from the SAME recomputed market pair that the drawer
  // displays (never from a stale stored aggregate). Upcoming stays a status,
  // not a result.
  const badgeResult = item.status === "scheduled" ? "Upcoming" : displayMetricResult(market.overallResult);
  // Preferred label: "Adjusted EPS Actual" when the provider tagged an explicit
  // adjusted value; a neutral "Market EPS Actual" when we fell back to the
  // legacy provider actual (no adjusted basis guaranteed).
  const epsActualLabel = item.epsActualAdjustedSource ? "Adjusted EPS Actual" : "Market EPS Actual";
  const surpriseTone = (pct: number | null): string => (pct === null ? "" : pct > 0 ? "positive" : pct < 0 ? "negative" : "");

  return (
    <motion.div
      className="drawer-backdrop"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="earnings-detail-title"
        className="earnings-drawer"
        onClick={(event) => event.stopPropagation()}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={spring}
      >
        <div className="drawer-head">
          <button data-dialog-initial-focus aria-label="Back" onClick={onClose}><ArrowLeft/></button>
          <span id="earnings-detail-title">Earnings Detail</span>
          <button aria-label="Close earnings detail" onClick={onClose}><X/></button>
        </div>

        <div className="drawer-company">
          <CompanyLogo event={item} className="drawer-logo"/>
          <div className="drawer-company-copy">
            <h2>{item.company}</h2>
            <p>
              {item.symbol}
              {fiscalLabel !== "N/A" ? ` · ${fiscalLabel}` : ""}
              {formattedDate !== "N/A" ? ` · ${formattedDate}` : ""}
              {` · ${displayTiming(item.timing)}`}
            </p>
          </div>
          <em className={`result ${resultClass(badgeResult)}`}>{badgeResult}</em>
        </div>

        <div className="drawer-metadata">
          <span>Fiscal quarter<strong>{fiscalLabel}</strong></span>
          <span>Status<strong className="status-capitalize">{item.status}</strong></span>
          <span>Reported at<strong>{releasedAt ? formatUpdatedAt(releasedAt) : "N/A"}</strong></span>
        </div>

        <section className="earnings-subsection" aria-label="Market earnings">
          <div className="subsection-head">
            <h3>Market Earnings</h3>
            <small>Finnhub / Market consensus</small>
          </div>

          <div className="report-grid">
            <section className="earnings-metric">
              <span>EPS</span>
              <MetricRow label="Consensus EPS" value={formatShareValue(market.epsEstimate)}/>
              <MetricRow label={epsActualLabel} value={formatShareValue(market.epsActual)}/>
              <MetricRow label="Surprise" value={formatPercent(market.epsSurprisePct)} tone={surpriseTone(market.epsSurprisePct)}/>
              <MetricRow label="Result" value={displayMetricResult(market.epsResult)} tone={resultClass(market.epsResult)}/>
            </section>
            <section className="earnings-metric">
              <span>Revenue</span>
              <MetricRow label="Consensus Revenue" value={formatCompactMoney(market.revenueEstimate)}/>
              <MetricRow label="Market Revenue Actual" value={formatCompactMoney(market.revenueActual)}/>
              <MetricRow label="Surprise" value={formatPercent(market.revenueSurprisePct)} tone={surpriseTone(market.revenueSurprisePct)}/>
              <MetricRow label="Result" value={displayMetricResult(market.revenueResult)} tone={resultClass(market.revenueResult)}/>
            </section>
          </div>

          <div className="detail-metrics detail-metrics-single">
            <span>Overall Market Result<strong className={resultClass(market.overallResult)}>{displayMetricResult(market.overallResult)}</strong></span>
          </div>
        </section>

        {qualityNote ? <p className="data-quality-note">{qualityNote}</p> : null}

        <section className="earnings-subsection official-section" aria-label="Official SEC data">
          <div className="subsection-head">
            <h3>Official SEC Data</h3>
            <small>SEC / EDGAR</small>
          </div>
          <div className="detail-metrics official-metrics">
            <span>GAAP EPS<strong>{formatShareValue(official.epsGaap)}</strong></span>
            <span>GAAP Revenue<strong>{formatCompactMoney(official.revenueGaap)}</strong></span>
            <span>SEC Form<strong>{official.secForm ?? "N/A"}</strong></span>
            <span>SEC Filed<strong>{formatFilingDate(official.secFiledAt) ?? "N/A"}</strong></span>
          </div>
          {official.secFilingUrl ? (
            <UrlLink label="View SEC Filing" url={official.secFilingUrl}/>
          ) : null}
        </section>

        <div className="drawer-links">
          <UrlLink label="Official Earnings Report" url={item.officialReportUrl}/>
          <UrlLink label="Investor Relations" url={item.investorRelationsUrl}/>
        </div>

        <EarningsGlossary/>
      </motion.aside>
    </motion.div>
  );
}
