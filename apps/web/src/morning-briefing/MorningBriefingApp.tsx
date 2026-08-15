import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDownRight, ArrowLeft, ArrowUpRight, BarChart3,
  ChevronRight, ExternalLink, Moon, Sun, TrendingUp, X,
} from "lucide-react";
import { marketIndexes as marketCardDefinitions, quickStats } from "./data/market";
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
import { Card, dateFromKey, formatUpdatedAt, LazyPageErrorBoundary, PageLoadingFallback, PostCard, SectionTitle, spring } from "./shared";
import "./morning-briefing.css";

// Code-split: X Pulse and the Earnings Calendar are visited less often than
// the default Morning Briefing page and pull in their own data-shaping
// logic — loading them on demand keeps the initial bundle to just what the
// landing page needs.
const XPulsePage = lazy(() => import("./XPulsePage"));
const EarningsPage = lazy(() => import("./EarningsCalendarPage"));

type Page = "briefing" | "surge" | "earnings";
type Theme = "light" | "dark";
const tabs: { id: Page; label: string }[] = [
  { id: "briefing", label: "Morning Briefing" },
  { id: "surge", label: "X Pulse" },
  { id: "earnings", label: "Earnings" },
];
const pagePaths: Record<Page, string> = { briefing: "/", surge: "/x", earnings: "/earnings" };

function formatBriefingDate(key: string | null): string {
  const date = dateFromKey(key ?? marketTodayKey());
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long" }).format(date);
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(date);
  return `${weekday} · ${date.getDate()} ${month}`.toUpperCase();
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><BarChart3 size={20}/></span><span><strong>Morning Briefing</strong><small>Markets • Opportunities • Insights</small></span></div>;
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return <button className="theme-toggle" onClick={onToggle} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
    <Sun size={16}/><span className="toggle-track"><i/></span><Moon size={15}/>
  </button>;
}

function AppHeader({ page, setPage, theme, setTheme }: { page: Page; setPage: (p: Page) => void; theme: Theme; setTheme: (t: Theme) => void }) {
  return <header className="app-header">
    <div className="header-top"><Brand/><nav className="desktop-tabs" aria-label="Primary navigation"><TabButtons page={page} setPage={setPage}/></nav><ThemeToggle theme={theme} onToggle={() => setTheme(theme === "light" ? "dark" : "light")}/></div>
    <nav className="mobile-tabs" aria-label="Primary navigation"><TabButtons page={page} setPage={setPage}/></nav>
  </header>;
}

function TabButtons({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  return <>{tabs.map(tab => <button key={tab.id} aria-current={page === tab.id ? "page" : undefined} className={page === tab.id ? "active" : ""} onClick={() => setPage(tab.id)}>{page === tab.id && <motion.span layoutId="active-tab" className="tab-highlight"/>}<span>{tab.label}</span></button>)}</>;
}

function formatAnalysisDate(key: string | null): string | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = dateFromKey(key);
  return `${date.getDate()} ${new Intl.DateTimeFormat("en", { month: "short" }).format(date)}`;
}

function AnimatedValue({ value, decimals = 2 }: { value: number; decimals?: number }) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => { const progress = Math.min((now - start) / 700, 1); setDisplay(value * (1 - Math.pow(1 - progress, 3))); if (progress < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [value, reduce]);
  return <>{(reduce ? value : display).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

function MarketCards() {
  const { marketIndexes: liveIndexes, marketUpdatedAt, marketStale } = useMorningBriefingData();
  const aliases: Record<string, string[]> = {
    "S&P 500": ["SPX", "S&P 500"],
    "Nasdaq-100": ["NDX", "NASDAQ", "NASDAQ-100"],
    "Dow Jones": ["DJI", "DIA", "DOW JONES"],
    VIX: ["VIX"],
  };
  const findLive = (name: string) => liveIndexes.find((item) => {
    const itemName = item.name.toUpperCase();
    const itemSymbol = item.symbol.toUpperCase();
    return itemName === name.toUpperCase() || (aliases[name] ?? []).some((alias) => alias === itemName || alias === itemSymbol);
  });
  return <section className={`market-section${marketStale ? " market-stale" : ""}`} aria-label="Market overview">{marketUpdatedAt && <p className="card-subtitle">Updated {formatUpdatedAt(marketUpdatedAt)}{marketStale ? " · Stale" : ""}</p>}<div className="market-grid">{marketCardDefinitions.map(({ name, symbol }) => {
    const item = findLive(name);
    return <Card key={symbol} className="market-card"><div><span>{name}</span><small>{item?.symbol ?? symbol}</small></div>{item ? <><strong><AnimatedValue value={item.value}/></strong><em className={item.change > 0 ? "positive" : item.change < 0 ? "negative" : "neutral"}>{item.change > 0 ? <ArrowUpRight/> : item.change < 0 ? <ArrowDownRight/> : null}{item.change > 0 ? "+" : ""}{item.change.toFixed(2)}%</em></> : <><strong className="neutral">Not available</strong><em className="neutral" aria-hidden="true">—</em></>}</Card>;
  })}</div></section>;
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

function QuickStats() {
  return <Card className="quick-card"><SectionTitle title="Quick Market Stats"/><div className="quick-list">{quickStats.map(item => <div key={item.label}><span><b className="desktop-only">{item.label}</b><b className="mobile-only">{item.short}</b></span><strong className="neutral">Not available</strong><em className="neutral" aria-hidden="true">—</em></div>)}</div></Card>;
}

function EarningsSummary({ goEarnings, onSelect }: { goEarnings: () => void; onSelect: (e: EarningsCompany) => void }) {
  const { earnings: storedEarnings, earningsAvailable } = useMorningBriefingData();
  const earnings = earningsAvailable ? storedEarnings : [];
  const upcoming = earnings.filter(e => e.status === "scheduled" && e.scheduledDate).sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? "")).slice(0, 3);
  const recent = earnings.filter(e => e.status === "reported").sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? "")).slice(0, 4);
  return <Card className="earnings-summary"><SectionTitle title="Earnings Summary" action="View Full Calendar" onAction={goEarnings}/><p className="card-subtitle">Upcoming reports and recent results.</p><div className="earnings-mini">{upcoming.length ? upcoming.map(e => <button key={e.id} onClick={() => onSelect(e)}><span className="date-tile"><small>{e.scheduledDate ? dateFromKey(e.scheduledDate).toLocaleDateString("en", { month: "short" }) : "—"}</small><strong>{e.scheduledDate ? Number(e.scheduledDate.slice(-2)) : "—"}</strong></span><span className="company-icon" style={{ "--company": e.color } as React.CSSProperties}>{e.symbol.slice(0,1)}</span><span><strong>{e.company}</strong><small>{e.symbol} · {e.timing}</small></span><ChevronRight/></button>) : <p className="empty-state">No upcoming earnings published.</p>}</div><div className="recent-results">{recent.length ? recent.map(e => <button key={e.id} onClick={() => onSelect(e)}><span>{e.company}</span><strong className={resultClass(e.result)}>{e.result}</strong><small>{formatPercent(e.epsSurprisePct)}</small></button>) : <p className="empty-state">No recent earnings published.</p>}</div></Card>;
}

function MorningBriefing({ setPage, selectOpportunity, selectEarnings }: { setPage: (p: Page) => void; selectOpportunity: (o: Opportunity) => void; selectEarnings: (e: EarningsCompany) => void }) {
  const { xPosts, marketIndexes, editionDate, editionType, opportunitiesUpdatedAt } = useMorningBriefingData();
  const leadMarket = marketIndexes[0];
  const leadChange = leadMarket?.change ?? 0;
  const postClose = editionType === "post_close";
  const editionLabel = editionType ? ` · ${postClose ? "POST-CLOSE" : "PRE-MARKET"}` : "";
  return <div className="page-content"><Card className="welcome-card"><div className="welcome-copy"><span className="eyebrow">{formatBriefingDate(editionDate)}{editionLabel}</span><h1>{postClose ? "Market close." : "Good morning."}</h1><p>{postClose ? "Here are today’s closing opportunities." : "Here are today’s top opportunities."}</p>{leadMarket ? <span className={`market-status ${leadChange > 0 ? "positive" : leadChange < 0 ? "negative" : "neutral"}`}>{leadChange > 0 ? <TrendingUp/> : leadChange < 0 ? <ArrowDownRight/> : null} {leadMarket.name} {leadChange > 0 ? "up" : leadChange < 0 ? "down" : "flat"} <strong className={leadChange > 0 ? "positive" : leadChange < 0 ? "negative" : "neutral"}>{leadChange > 0 ? "+" : ""}{leadChange.toFixed(2)}%</strong></span> : <span className="market-status neutral">Market data <strong className="neutral">Not available</strong></span>}</div></Card><MarketCards/><div className="main-grid"><Card className="opportunities-card"><SectionTitle title="Top Opportunities" meta={opportunitiesUpdatedAt ? `Analysis · ${formatAnalysisDate(editionDate)}` : null}/><OpportunityList onSelect={selectOpportunity}/></Card><Sentiment/><QuickStats/></div><div className="lower-grid"><EarningsSummary goEarnings={() => setPage("earnings")} onSelect={selectEarnings}/><Card className="x-preview"><SectionTitle title="X Pulse" action="View More" onAction={() => setPage("surge")}/><p className="card-subtitle">Curated insights from selected accounts.</p>{xPosts.length ? xPosts.slice(0,3).map(post => <PostCard key={post.url} post={post} compact/>) : <p className="empty-state">No recent posts.</p>}</Card></div></div>;
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
  const location = useLocation(); const navigate = useNavigate();
  const page: Page = location.pathname === "/x" ? "surge" : location.pathname === "/earnings" ? "earnings" : "briefing";
  const setPage = (next: Page) => navigate(pagePaths[next]); const [theme, setTheme] = useState<Theme>("light");
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null); const [selectedEarnings, setSelectedEarnings] = useState<EarningsCompany | null>(null);
  useEffect(() => { const stored = localStorage.getItem("morning-briefing-theme") as Theme | null; const preferred = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; const timer = window.setTimeout(() => setTheme(stored || preferred), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("morning-briefing-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d10" : "#f7f8f7");
  }, [theme]);
  useEffect(() => {
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [page]);
  useEffect(() => { setSelectedOpportunity(null); setSelectedEarnings(null); }, [page]);
  return <div className="mb-demo app-shell"><AppHeader page={page} setPage={setPage} theme={theme} setTheme={setTheme}/><AnimatePresence mode="wait"><motion.main key={page} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-4}} transition={spring}><LazyPageErrorBoundary resetKey={page}><Suspense fallback={<PageLoadingFallback/>}>{page === "briefing" && <MorningBriefing setPage={setPage} selectOpportunity={setSelectedOpportunity} selectEarnings={setSelectedEarnings}/>} {page === "surge" && <XPulsePage/>} {page === "earnings" && <EarningsPage onSelect={setSelectedEarnings}/>}</Suspense></LazyPageErrorBoundary></motion.main></AnimatePresence><footer><span>Morning Briefing</span><p>Public, read-only market intelligence.</p></footer><AnimatePresence>{selectedOpportunity && <OpportunityModal item={selectedOpportunity} onClose={() => setSelectedOpportunity(null)}/>} {selectedEarnings && <EarningsDetail item={selectedEarnings} onClose={() => setSelectedEarnings(null)}/>}</AnimatePresence></div>;
}


export default function MorningBriefingApp() {
  return <MotionConfig reducedMotion="user"><MorningBriefingDataProvider><MorningBriefingShell/></MorningBriefingDataProvider></MotionConfig>;
}
