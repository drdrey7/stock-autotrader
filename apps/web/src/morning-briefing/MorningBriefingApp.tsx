import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useLocation } from "react-router-dom";
import {
  ArrowDownRight, ArrowLeft, ArrowUpRight,
  ChevronRight, ExternalLink, X,
} from "lucide-react";
import { useShellTheme } from "../shell/theme";
import { EconomicCalendar, MarketOverview, TopStories, MARKET_OVERVIEW_SECTIONS } from "./TradingView";
import { type Opportunity } from "./data/opportunities";
import {
  displayMetricResult,
  formatMetric,
  formatPercent,
  resultClass,
  type EarningsCompany,
} from "./data/earnings-view";
import {
  MorningBriefingDataProvider,
  marketTodayKey,
  useMorningBriefingData,
} from "./MorningBriefingData";
import { Card, dateFromKey, formatUpdatedAt, LazyPageErrorBoundary, PageLoadingFallback, SectionTitle, spring } from "./shared";
import "./morning-briefing.css";

// Code-split: X Pulse and the Earnings Calendar are visited less often than
// the default Morning Briefing page and pull in their own data-shaping
// logic — loading them on demand keeps the initial bundle to just what the
// landing page needs.
const XPulsePage = lazy(() => import("./XPulsePage"));
const EarningsPage = lazy(() => import("./EarningsCalendarPage"));

type Page = "briefing" | "surge" | "earnings";

function formatBriefingDate(key: string | null): string {
  const date = dateFromKey(key ?? marketTodayKey());
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long" }).format(date);
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(date);
  return `${weekday} · ${date.getDate()} ${month}`.toUpperCase();
}

function marketGreeting(now: Date = new Date(Date.now())): string {
  // Time-of-day greeting in the canonical product timezone.
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  return "Good evening.";
}

function formatAnalysisDate(key: string | null): string | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = dateFromKey(key);
  return `${date.getDate()} ${new Intl.DateTimeFormat("en", { month: "short" }).format(date)}`;
}

function OpportunityMove({ change }: { change: number | null }) {
  if (change === null) return <span className="move neutral">Not published</span>;
  const direction = change > 0 ? "positive" : change < 0 ? "negative" : "neutral";
  return <span className={`move ${direction}`}>{change > 0 ? <ArrowUpRight/> : change < 0 ? <ArrowDownRight/> : null}{change > 0 ? "+" : ""}{change.toFixed(2)}%</span>;
}

function OpportunityList({ onSelect, compact = false }: { onSelect: (o: Opportunity) => void; compact?: boolean }) {
  const { opportunities } = useMorningBriefingData();
  if (opportunities.length === 0) return <p className="empty-state">No qualified opportunities were published for this edition.</p>;
  return <div className={`opportunity-list ${compact ? "compact" : ""}`}>{opportunities.map(item => <button className="opportunity-row" key={item.ticker} onClick={() => onSelect(item)}>
    <span className="company-icon" style={{ "--company": item.color } as React.CSSProperties}>{item.ticker.slice(0, 1)}</span>
    <span className="company-name"><strong>{item.ticker}</strong><small>{item.company}</small></span>
    <OpportunityMove change={item.change}/>
    <span className={`confidence ${item.confidence?.toLowerCase() ?? "unpublished"}`}>{item.confidence ?? "Not published"}</span>
    <ChevronRight className="row-arrow" size={16}/>
  </button>)}</div>;
}

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
    return <Card className="sentiment-card"><SectionTitle title="Fear & Greed"/><div className="gauge gauge-unavailable"><svg viewBox="0 0 160 86" aria-hidden="true"><path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/></svg><div className="gauge-mask"><strong>Not available</strong><span>Fear & Greed</span></div></div><h3>Momentum <span className="neutral">Not available</span></h3><p><i/> Risk appetite <span className="neutral">Not available</span></p></Card>;
  }
  const meta = SENTIMENT_META[sentiment.rating] ?? { label: "Neutral", color: "#8b8d98" };
  const dash = (sentiment.score / 100) * GAUGE_ARC_LENGTH;
  const riskAppetite = sentiment.score >= 50 ? "Risk-on" : "Risk-off";
  return (
    <Card className="sentiment-card">
      <SectionTitle title="Fear & Greed"/>
      <p className="card-subtitle">Updated {formatUpdatedAt(sentiment.asOf)}</p>
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
      <h3>Momentum <span style={{ color: meta.color }}>{meta.label}</span></h3>
      <p><i style={{ background: meta.color }}/> Risk appetite <span style={{ color: meta.color }}>{riskAppetite}</span></p>
    </Card>
  );
}

function MorningBriefing({ selectOpportunity }: { selectOpportunity: (o: Opportunity) => void }) {
  const { editionDate, editionType, opportunitiesUpdatedAt } = useMorningBriefingData();
  const { theme } = useShellTheme();
  const postClose = editionType === "post_close";
  const editionLabel = editionType ? ` · ${postClose ? "POST-CLOSE" : "PRE-MARKET"}` : "";
  return <div className="page-content">
    <section className="hero" aria-label="Morning briefing">
      <span className="eyebrow">{formatBriefingDate(editionDate)}{editionLabel}</span>
      <h1>{marketGreeting()}</h1>
      <p>{postClose ? "Here are today’s closing opportunities." : "Here are today’s top opportunities."}</p>
    </section>

    <section className="widget-block market-overview-block" aria-label="Market overview">
      <div className="widget-head"><span className="eyebrow">MARKET OVERVIEW</span><span className="section-meta">TradingView · 12M</span></div>
      <MarketOverview sections={MARKET_OVERVIEW_SECTIONS} colorTheme={theme} className="market-overview-frame"/>
    </section>

    <Card className="opportunities-card opportunities-row"><SectionTitle title="Top Opportunities" meta={opportunitiesUpdatedAt ? `Analysis · ${formatAnalysisDate(editionDate)}` : null}/><OpportunityList onSelect={selectOpportunity}/></Card>

    <div className="secondary-grid">
      <section className="widget-block" aria-label="Economic calendar">
        <div className="widget-head"><span className="eyebrow">ECONOMIC CALENDAR</span><span className="section-meta">TradingView</span></div>
        <EconomicCalendar/>
      </section>
      <Sentiment/>
    </div>

    <section className="widget-block stories-block" aria-label="Top stories">
      <div className="widget-head"><span className="eyebrow">TOP STORIES</span><span className="section-meta">TradingView</span></div>
      <TopStories/>
    </section>
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

function OpportunityModal({ item, onClose }: { item: Opportunity; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLDivElement>(onClose);
  return <motion.div className="modal-backdrop" onClick={onClose} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="opportunity-title" className="opportunity-modal" onClick={e=>e.stopPropagation()} initial={{opacity:0,scale:.97,y:10}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:.97}} transition={spring}><button data-dialog-initial-focus className="close" aria-label="Close" onClick={onClose}><X/></button><span className="company-icon large" style={{ "--company": item.color } as React.CSSProperties}>{item.ticker.slice(0,1)}</span><span className="eyebrow">OPPORTUNITY DETAIL</span><h2 id="opportunity-title">{item.ticker} <small>{item.company}</small></h2><div className="modal-verdict"><OpportunityMove change={item.change}/><em className={`confidence ${item.confidence?.toLowerCase() ?? "unpublished"}`}>{item.confidence ? `${item.confidence} confidence` : "Confidence not published"}</em></div><p>{item.thesis}</p><div className="detail-stats"><span>Quant score<strong>{item.score === null ? "Not published" : `${item.score}/100`}</strong></span><span>Trigger<strong>{item.trigger}</strong></span><span>Risk / invalidation<strong>{item.invalidation ?? item.risk}</strong></span></div>{item.reference && <a className="inline-source-link" href={item.reference} target="_blank" rel="noreferrer">View primary source <ExternalLink/></a>}<small className="demo-note">No trading actions are available.</small></motion.div></motion.div>;
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
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null); const [selectedEarnings, setSelectedEarnings] = useState<EarningsCompany | null>(null);
  useEffect(() => {
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [page]);
  useEffect(() => { setSelectedOpportunity(null); setSelectedEarnings(null); }, [page]);
  return <div className="mb-demo"><AnimatePresence mode="wait"><motion.div key={page} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-4}} transition={spring}><LazyPageErrorBoundary resetKey={page}><Suspense fallback={<PageLoadingFallback/>}>{page === "briefing" && <MorningBriefing selectOpportunity={setSelectedOpportunity}/>} {page === "surge" && <XPulsePage/>} {page === "earnings" && <EarningsPage onSelect={setSelectedEarnings}/>}</Suspense></LazyPageErrorBoundary></motion.div></AnimatePresence><footer><span>Morning Briefing</span><p>Public, read-only market intelligence.</p></footer><AnimatePresence>{selectedOpportunity && <OpportunityModal item={selectedOpportunity} onClose={() => setSelectedOpportunity(null)}/>} {selectedEarnings && <EarningsDetail item={selectedEarnings} onClose={() => setSelectedEarnings(null)}/>}</AnimatePresence></div>;
}


export default function MorningBriefingApp() {
  return <MotionConfig reducedMotion="user"><MorningBriefingDataProvider><MorningBriefingShell/></MorningBriefingDataProvider></MotionConfig>;
}
