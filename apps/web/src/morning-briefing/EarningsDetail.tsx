import { useEffect, useRef } from "react";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { motion } from "motion/react";
import { CompanyLogo } from "./EarningsLogo";
import {
  displayMetricResult,
  displayTiming,
  fiscalPeriodLabel,
  formatMetric,
  formatPercent,
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

  const link = (label: string, url: string | null) => url
    ? <a className="official-link" href={url} target="_blank" rel="noreferrer">{label} <ExternalLink/></a>
    : <span className="official-link disabled">{label} · N/A</span>;

  const metric = (
    name: string,
    estimate: number | null,
    actual: number | null,
    surprisePct: number | null,
    result: string,
  ) => (
    <section className="earnings-metric">
      <span>{name}</span>
      <div className="metric-row"><small>Estimate</small><strong>{formatMetric(estimate)}</strong></div>
      <div className="metric-row"><small>Actual</small><strong>{formatMetric(actual)}</strong></div>
      <div className="metric-row"><small>Surprise %</small><strong>{formatPercent(surprisePct)}</strong></div>
      <div className="metric-row"><small>Result</small><strong className={resultClass(result)}>{displayMetricResult(result)}</strong></div>
    </section>
  );

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
          <div>
            <h2>{item.company}</h2>
            <p>{item.symbol} · {fiscalLabel} · {formattedDate} · {displayTiming(item.timing)}</p>
          </div>
          <em className={`result ${resultClass(item.result)}`}>{item.result}</em>
        </div>

        <div className="drawer-metadata">
          <span>Fiscal quarter<strong>{fiscalLabel}</strong></span>
          <span>Status<strong>{item.status}</strong></span>
        </div>

        <div className="report-grid">
          {metric("EPS", item.epsEstimate, item.epsActual, item.epsSurprisePct, item.epsResult)}
          {metric("Revenue", item.revenueEstimate, item.revenueActual, item.revenueSurprisePct, item.revenueResult)}
        </div>

        <div className="detail-metrics">
          <span>Overall result<strong className={resultClass(item.overallResult)}>{displayMetricResult(item.overallResult)}</strong></span>
          <span>Reported at<strong>{formatUpdatedAt(item.reportedAt) ?? "N/A"}</strong></span>
        </div>

        <div className="drawer-links">
          {link("Official Earnings Report", item.officialReportUrl)}
          {link("SEC Filing", item.secFilingUrl)}
          {link("Investor Relations", item.investorRelationsUrl)}
        </div>
      </motion.aside>
    </motion.div>
  );
}
