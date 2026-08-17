import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useLocation } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink, X,
} from "lucide-react";
import { useShellTheme } from "../shell/theme";
import { EconomicCalendar, MarketOverview, TopStories, MARKET_OVERVIEW_SECTIONS } from "./TradingView";
import {
  displayMetricResult,
  formatMetric,
  formatPercent,
  resultClass,
  type EarningsCompany,
} from "./data/earnings-view";
import {
  MorningBriefingDataProvider,
  useMorningBriefingData,
} from "./MorningBriefingData";
import { Card, formatUpdatedAt, LazyPageErrorBoundary, PageLoadingFallback, SectionTitle, spring } from "./shared";
import { localDateLabel, marketGreeting } from "./local-time";
// morning-briefing.css is imported by the app entry (src/main.tsx), ordered
// AFTER the global stylesheets, so its scoped component rules reliably win the
// cascade against the global .hero/.eyebrow/.table-head/.empty-state classes.

// Code-split: X Pulse and the Earnings Calendar are visited less often than
// the default Morning Briefing page and pull in their own data-shaping
// logic — loading them on demand keeps the initial bundle to just what the
// landing page needs.
const XPulsePage = lazy(() => import("./XPulsePage"));
const EarningsPage = lazy(() => import("./EarningsCalendarPage"));

type Page = "briefing" | "surge" | "earnings";

const SENTIMENT_META: Record<string, { label: string; color: string }> = {
  extreme_fear: { label: "Extreme Fear", color: "#e5484d" },
  fear: { label: "Fear", color: "#f76b15" },
  neutral: { label: "Neutral", color: "#8b8d98" },
  greed: { label: "Greed", color: "#f5a524" },
  extreme_greed: { label: "Extreme Greed", color: "#30a46c" },
};

// Semicircle gauge: length of the arc M15 75 A65 65 0 0 1 145 75 is π·r.
const GAUGE_ARC_LENGTH = Math.PI * 65;

function Sentiment() {
  const { sentiment } = useMorningBriefingData();
  if (!sentiment) {
    return <Card className="sentiment-card"><SectionTitle title="Fear & Greed"/><div className="gauge gauge-unavailable"><svg viewBox="0 0 160 86" aria-hidden="true"><path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/></svg><div className="gauge-mask"><strong>Not available</strong><span>Fear & Greed</span></div></div></Card>;
  }
  const meta = SENTIMENT_META[sentiment.rating] ?? { label: "Neutral", color: "#8b8d98" };
  const dash = (sentiment.score / 100) * GAUGE_ARC_LENGTH;
  return (
    <Card className="sentiment-card">
      <SectionTitle title="Fear & Greed"/>
      <div className="gauge">
        <svg viewBox="0 0 160 86" aria-hidden="true">
          <path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/>
          <path className="gauge-value gauge-live" d="M15 75 A65 65 0 0 1 145 75" stroke={meta.color} strokeDasharray={`${dash} ${GAUGE_ARC_LENGTH}`}/>
        </svg>
        <div className="gauge-mask">
          <strong style={{ color: meta.color }}>{sentiment.score}</strong>
          <span style={{ color: meta.color }}>{meta.label}</span>
        </div>
      </div>
      <p className="card-subtitle">Updated {formatUpdatedAt(sentiment.asOf)}</p>
    </Card>
  );
}

function MorningBriefing() {
  const { theme } = useShellTheme();
  return <div className="page-content">
    <div className="homepage-grid">
      <section className="mb-hero" aria-label="Morning briefing">
        <span className="eyebrow">{localDateLabel()}</span>
        <h1>{marketGreeting()}</h1>
        <p>Markets, economic calendar and top stories — at a glance.</p>
      </section>

      <Sentiment/>

      <section className="widget-block market-overview-block" aria-label="Market overview">
        <div className="widget-head"><span className="eyebrow">MARKET OVERVIEW</span><span className="section-meta">TradingView · 12M</span></div>
        <MarketOverview sections={MARKET_OVERVIEW_SECTIONS} colorTheme={theme} className="market-overview-frame"/>
      </section>

      <section className="widget-block calendar-block" aria-label="Economic calendar">
        <div className="widget-head"><span className="eyebrow">ECONOMIC CALENDAR</span><span className="section-meta">TradingView</span></div>
        <EconomicCalendar/>
      </section>

      <section className="widget-block stories-block" aria-label="Top stories">
        <div className="widget-head"><span className="eyebrow">TOP STORIES</span><span className="section-meta">TradingView</span></div>
        <TopStories/>
      </section>
    </div>
  </div>;
}

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
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);
  return dialogRef;
}

function EarningsDetail({ item, onClose }: { item: EarningsCompany; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const formattedDate = item.scheduledDate
    ? new Date(`${item.scheduledDate}T12:00:00`).toLocaleDateString("en", { month: "long", day: "numeric", year: "numeric" })
    : "N/A";
  const link = (label: string, url: string | null) => url
    ? <a className="official-link" href={url} target="_blank" rel="noreferrer">{label} <ExternalLink/></a>
    : <span className="official-link disabled">{label} · N/A</span>;
  const metric = (name: string, estimate: number | null, actual: number | null, surprisePct: number | null, result: string) => (
    <section className="earnings-metric"><span>{name}</span><div className="metric-row"><small>Estimate</small><strong>{formatMetric(estimate)}</strong></div><div className="metric-row"><small>Actual</small><strong>{formatMetric(actual)}</strong></div><div className="metric-row"><small>Surprise %</small><strong>{formatPercent(surprisePct)}</strong></div><div className="metric-row"><small>Result</small><strong className={resultClass(result)}>{displayMetricResult(result)}</strong></div></section>
  );
  return <motion.div className="drawer-backdrop" onClick={onClose} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="earnings-detail-title" className="earnings-drawer" onClick={e=>e.stopPropagation()} initial={{x:"100%"}} animate={{x:0}} exit={{x:"100%"}} transition={spring}><div className="drawer-head"><button data-dialog-initial-focus aria-label="Back" onClick={onClose}><ArrowLeft/></button><span id="earnings-detail-title">Earnings Detail</span><button aria-label="Close earnings detail" onClick={onClose}><X/></button></div><div className="drawer-company"><span className="company-icon large" style={{ "--company": item.color } as React.CSSProperties}>{item.symbol.slice(0,1)}</span><div><h2>{item.company}</h2><p>{item.symbol} · {formattedDate} · {item.timing}</p></div><em className={`result ${resultClass(item.result)}`}>{item.result}</em></div><div className="drawer-metadata"><span>Fiscal quarter<strong>{item.fiscalPeriod ?? "N/A"}</strong></span><span>Status<strong>{item.status}</strong></span></div><div className="report-grid">{metric("EPS", item.epsEstimate, item.epsActual, item.epsSurprisePct, item.epsResult)}{metric("Revenue", item.revenueEstimate, item.revenueActual, item.revenueSurprisePct, item.revenueResult)}</div><div className="detail-metrics"><span>Overall result<strong className={resultClass(item.overallResult)}>{displayMetricResult(item.overallResult)}</strong></span><span>Reported at<strong>{formatUpdatedAt(item.reportedAt) ?? "N/A"}</strong></span></div><div className="drawer-links">{link("Official Earnings Report", item.officialReportUrl)}{link("SEC Filing", item.secFilingUrl)}{link("Investor Relations", item.investorRelationsUrl)}</div></motion.aside></motion.div>;
}

function MorningBriefingShell() {
  const location = useLocation();
  const page: Page = location.pathname === "/x" ? "surge" : location.pathname === "/earnings" ? "earnings" : "briefing";
  const [selectedEarnings, setSelectedEarnings] = useState<EarningsCompany | null>(null);
  useEffect(() => {
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [page]);
  useEffect(() => { setSelectedEarnings(null); }, [page]);
  return <div className="mb-demo"><AnimatePresence mode="wait"><motion.div key={page} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-4}} transition={spring}><LazyPageErrorBoundary resetKey={page}><Suspense fallback={<PageLoadingFallback/>}>{page === "briefing" && <MorningBriefing/>} {page === "surge" && <XPulsePage/>} {page === "earnings" && <EarningsPage onSelect={setSelectedEarnings}/>}</Suspense></LazyPageErrorBoundary></motion.div></AnimatePresence><footer><span>Morning Briefing</span><p>Public, read-only market intelligence.</p></footer><AnimatePresence>{selectedEarnings && <EarningsDetail item={selectedEarnings} onClose={() => setSelectedEarnings(null)}/>}</AnimatePresence></div>;
}


export default function MorningBriefingApp() {
  return <MotionConfig reducedMotion="user"><MorningBriefingDataProvider><MorningBriefingShell/></MorningBriefingDataProvider></MotionConfig>;
}
