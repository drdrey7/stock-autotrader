import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, BarChart3,
  Check, ChevronLeft, ChevronRight, ExternalLink, Heart, MessageCircle, Moon,
  Repeat2, Sun, TrendingUp, X,
} from "lucide-react";
import { chartPoints, quickStats } from "./data/market";
import { type Opportunity } from "./data/opportunities";
import { trackedXAccounts, type XPost } from "./data/xSurge";
import { takeaways, type EarningsCompany } from "./data/earnings";
import {
  BackendRibbon,
  DataSourceBadge,
  MorningBriefingDataProvider,
  useMorningBriefingData,
} from "./MorningBriefingData";
import type { DataSource } from "./data/source";
import "./morning-briefing.css";

type Page = "briefing" | "surge" | "earnings";
type Theme = "light" | "dark";
const tabs: { id: Page; label: string }[] = [
  { id: "briefing", label: "Morning Briefing" },
  { id: "surge", label: "X Pulse" },
  { id: "earnings", label: "Earnings" },
];
const spring = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
const pagePaths: Record<Page, string> = { briefing: "/", surge: "/x", earnings: "/earnings" };

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatBriefingDate(key: string | null): string {
  const date = key ? dateFromKey(key) : new Date(Date.now());
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

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <motion.section className={`card ${className}`} whileHover={{ y: -2 }} transition={spring}>{children}</motion.section>;
}

function SectionTitle({ title, action, onAction, source }: { title: string; action?: string; onAction?: () => void; source?: DataSource }) {
  return <div className="section-title"><span className="section-title-copy"><h2>{title}</h2>{source && <DataSourceBadge source={source}/>}</span>{action && <button onClick={onAction}>{action} <ArrowRight size={14}/></button>}</div>;
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
  const { marketIndexes } = useMorningBriefingData();
  return <div className="market-grid">{marketIndexes.map(item => <Card key={item.symbol} className="market-card"><div><span>{item.name}</span><small>{item.symbol} {item.source && <DataSourceBadge source={item.source}/>}</small></div><strong><AnimatedValue value={item.value}/></strong><em className={item.change >= 0 ? "positive" : "negative"}>{item.change >= 0 ? <ArrowUpRight/> : <ArrowDownRight/>}{item.change > 0 ? "+" : ""}{item.change.toFixed(2)}%</em></Card>)}</div>;
}

function IntradayChart() {
  const reduce = useReducedMotion();
  return <div className="hero-chart-wrap"><span className="chart-demo-label">Demo chart</span><svg className="hero-chart" viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#19a15f" stopOpacity=".18"/><stop offset="1" stopColor="#19a15f" stopOpacity="0"/></linearGradient></defs>
    <polygon points={`${chartPoints} 600,100 0,100`} fill="url(#chartFill)"/>
    <motion.polyline points={chartPoints} fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 1.1, ease: "easeOut" }}/>
  </svg></div>;
}

function OpportunityMove({ change }: { change: number }) {
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
    <span className={`confidence ${item.confidence.toLowerCase()}`}>{item.confidence}</span>
    <ChevronRight className="row-arrow" size={16}/>
  </button>)}</div>;
}

function Sentiment() {
  return <Card className="sentiment-card"><SectionTitle title="Market Sentiment" source="mock"/><div className="gauge"><svg viewBox="0 0 160 86" aria-hidden="true"><path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/><motion.path className="gauge-value" d="M15 75 A65 65 0 0 1 145 75" initial={{pathLength:0}} animate={{pathLength:.72}} transition={{duration:.8,ease:"easeOut"}}/></svg><div className="gauge-mask"><strong>72</strong><span>Greed</span></div></div><h3>Bullish momentum</h3><p><i/> Risk appetite high</p></Card>;
}

function QuickStats() {
  return <Card className="quick-card"><SectionTitle title="Quick Market Stats" source="mock"/><div className="quick-list">{quickStats.map(item => <div key={item.label}><span><b className="desktop-only">{item.label}</b><b className="mobile-only">{item.short}</b></span><strong>{item.value}</strong><em className={item.change >= 0 ? "positive" : "negative"}>{item.change >= 0 ? "▲" : "▼"}</em></div>)}</div></Card>;
}

function PostCard({ post, compact = false }: { post: XPost; compact?: boolean }) {
  return <article className={`post-card ${compact ? "compact" : ""}`}><div className="post-head"><span className="avatar" style={{ "--avatar": post.color } as React.CSSProperties}>{post.name.slice(0,1)}</span><span><strong>{post.name}</strong><small>{post.handle}</small></span><span className="post-status"><DataSourceBadge source={post.source ?? "mock"}/><time>{post.time}</time></span></div><p>{post.text}</p><div className="post-meta"><span><Heart/> {post.likes}</span><span><Repeat2/> {post.reposts}</span><span><MessageCircle/> {post.replies}</span>{!compact && <a href={post.url} target="_blank" rel="noreferrer">Open on X <ExternalLink/></a>}</div></article>;
}

function EarningsSummary({ goEarnings, onSelect }: { goEarnings: () => void; onSelect: (e: EarningsCompany) => void }) {
  const { earnings, sources } = useMorningBriefingData();
  const upcoming = earnings.filter(e => e.result === "Upcoming").sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const recent = earnings.filter(e => e.result !== "Upcoming").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  return <Card className="earnings-summary"><SectionTitle title="Earnings Summary" action="View Full Calendar" onAction={goEarnings} source={sources.earnings}/><p className="card-subtitle">Upcoming reports and recent results.</p><div className="earnings-mini">{upcoming.map(e => <button key={`${e.ticker}-${e.date}`} onClick={() => onSelect(e)}><span className="date-tile"><small>{dateFromKey(e.date).toLocaleDateString("en", { month: "short" })}</small><strong>{Number(e.date.slice(-2))}</strong></span><span className="company-icon" style={{ "--company": e.color } as React.CSSProperties}>{e.ticker.slice(0,1)}</span><span><strong>{e.company}</strong><small>{e.ticker} · {e.timing}</small></span><ChevronRight/></button>)}</div><div className="recent-results">{recent.map(e => <button key={`${e.ticker}-${e.date}`} onClick={() => onSelect(e)}><span>{e.company}</span><strong className={e.result === "Beat" ? "positive" : e.result === "Miss" ? "negative" : "mixed"}>{e.result}</strong><small className={e.reaction?.startsWith("+") ? "positive" : e.reaction?.startsWith("-") ? "negative" : "mixed"}>{e.reaction ?? "Not published"}</small></button>)}</div></Card>;
}

function MorningBriefing({ setPage, selectOpportunity, selectEarnings }: { setPage: (p: Page) => void; selectOpportunity: (o: Opportunity) => void; selectEarnings: (e: EarningsCompany) => void }) {
  const { sources, xPosts, marketIndexes, editionDate } = useMorningBriefingData();
  const leadMarket = marketIndexes[0];
  const leadChange = leadMarket?.change ?? 0;
  return <div className="page-content"><BackendRibbon/><Card className="welcome-card"><div className="welcome-copy"><span className="eyebrow">{formatBriefingDate(editionDate)}</span><h1>Good morning.</h1><p>Here are today&apos;s top opportunities.</p><span className={`market-status ${leadChange >= 0 ? "positive" : "negative"}`}>{leadChange >= 0 ? <TrendingUp/> : <ArrowDownRight/>} {leadMarket?.name ?? "Market"} {leadChange >= 0 ? "up" : "down"} <strong>{leadChange > 0 ? "+" : ""}{leadChange.toFixed(2)}%</strong><DataSourceBadge source={leadMarket?.source ?? "mock"}/></span></div><IntradayChart/></Card><MarketCards/><div className="main-grid"><Card className="opportunities-card"><SectionTitle title="Top Opportunities" source={sources.opportunities}/><OpportunityList onSelect={selectOpportunity}/></Card><Sentiment/><QuickStats/></div><div className="lower-grid"><EarningsSummary goEarnings={() => setPage("earnings")} onSelect={selectEarnings}/><Card className="x-preview"><SectionTitle title="X Pulse" action="View More" onAction={() => setPage("surge")} source={sources.x}/><p className="card-subtitle">Curated insights from selected accounts.</p>{xPosts.slice(0,3).map(post => <PostCard key={post.url} post={post} compact/>)}</Card></div></div>;
}

function XPulsePage() {
  const { xPosts, sources } = useMorningBriefingData();
  const [account, setAccount] = useState("All");
  const accountTabs = ["All", ...trackedXAccounts];
  const shown = [...(account === "All"
    ? xPosts
    : xPosts.filter((post) => post.handle.toLowerCase() === account.toLowerCase()))]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <div className="page-content inner-page"><div className="page-heading"><span className="eyebrow">CURATED SOCIAL SIGNALS</span><h1>X Pulse <DataSourceBadge source={sources.x}/></h1><p>The posts that matter from the accounts we track.</p></div><div className="filter-row" aria-label="Tracked X accounts">{accountTabs.map(item => <button key={item} aria-pressed={account === item} className={account === item ? "active" : ""} onClick={() => setAccount(item)}>{item}</button>)}</div><div className="surge-layout"><div className="feed">{shown.length ? shown.map(post => <Card key={post.url} className="post-shell"><PostCard post={post}/></Card>) : <Card><p className="empty-state">No posts are available from this account yet.</p></Card>}</div></div></div>;
}

function monthDays(month: number, year: number) {
  const first = new Date(year, month, 1); const days = new Date(year, month + 1, 0).getDate();
  return [...Array(first.getDay()).fill(null), ...Array.from({length: days}, (_, i) => i + 1)];
}

type CalendarPeriod = { year: number; month: number };

function EarningsCalendar({ period, setPeriod, onSelect }: { period: CalendarPeriod; setPeriod: (period: CalendarPeriod) => void; onSelect: (e: EarningsCompany) => void }) {
  const { earnings } = useMorningBriefingData();
  const { year, month } = period; const days = monthDays(month, year); const monthName = new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(year, month));
  const today = new Date(Date.now()); const todayKey = dateKey(today);
  const moveMonth = (offset: number) => { const next = new Date(year, month + offset, 1); setPeriod({ year: next.getFullYear(), month: next.getMonth() }); };
  const goToday = () => { const now = new Date(Date.now()); setPeriod({ year: now.getFullYear(), month: now.getMonth() }); };
  return <Card className="calendar-card"><div className="calendar-head"><div><span className="eyebrow">MONTHLY CALENDAR</span><h2>{monthName} {year}</h2></div><div><button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft/></button><button className="today" onClick={goToday}>Today</button><button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight/></button></div></div><div className="weekdays">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-grid">{days.map((day, index) => { const date = day ? `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}` : ""; const reports = earnings.filter(e => e.date === date); return <div key={index} className={!day ? "empty" : date === todayKey ? "is-today" : ""}>{day && <><span className="day-number">{day}</span><div className="calendar-events">{reports.map(e => <button key={`${e.ticker}-${e.date}`} onClick={() => onSelect(e)} title={`${e.company} ${e.timing}`}><i style={{ "--company": e.color } as React.CSSProperties}/><b>{e.ticker}</b><small>{e.timing}</small></button>)}</div></>}</div>; })}</div></Card>;
}

function PastEarnings({ year, onSelect }: { year: number; onSelect: (e: EarningsCompany) => void }) {
  const { earnings, sources } = useMorningBriefingData();
  const [filter, setFilter] = useState("All"); const past = earnings.filter(e => e.result !== "Upcoming" && e.date.startsWith(`${year}-`) && (filter === "All" || e.result === filter)).sort((a, b) => b.date.localeCompare(a.date));
  return <Card className="past-card"><SectionTitle title={`Past Earnings — ${year}`} source={sources.earnings}/><div className="filter-row small">{["All","Beat","Miss","Mixed","Pending"].map(item => <button key={item} aria-pressed={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="earnings-table"><div className="table-head"><span>Company</span><span>Date</span><span>EPS</span><span>Revenue</span><span>Result</span><span>Reaction</span></div>{past.map(e => <button key={e.ticker+e.date} onClick={() => onSelect(e)}><span className="table-company"><i style={{ "--company": e.color } as React.CSSProperties}>{e.ticker.slice(0,1)}</i><b>{e.company}</b><small>{e.ticker}</small></span><span>{dateFromKey(e.date).toLocaleDateString("en", {month:"short",day:"numeric"})}</span><span>{e.epsActual ?? "Not published"}</span><span>{e.revenueActual ?? "Not published"}</span><span><em className={`result ${e.result.toLowerCase()}`}>{e.result}</em></span><span className={e.reaction?.startsWith("+") ? "positive" : e.reaction?.startsWith("-") ? "negative" : "mixed"}>{e.reaction ?? "Not published"}</span><ChevronRight/></button>)}</div></Card>;
}

function EarningsPage({ onSelect }: { onSelect: (e: EarningsCompany) => void }) {
  const { sources } = useMorningBriefingData();
  const now = new Date(Date.now()); const [period, setPeriod] = useState<CalendarPeriod>({ year: now.getFullYear(), month: now.getMonth() });
  return <div className="page-content inner-page"><div className="page-heading"><span className="eyebrow">REPORTS & GUIDANCE</span><h1>Earnings Calendar <DataSourceBadge source={sources.earnings}/></h1><p>Upcoming and past earnings in one place.</p></div><EarningsCalendar period={period} setPeriod={setPeriod} onSelect={onSelect}/><PastEarnings year={period.year} onSelect={onSelect}/></div>;
}

function OpportunityModal({ item, onClose }: { item: Opportunity; onClose: () => void }) {
  return <motion.div className="modal-backdrop" onClick={onClose} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.div role="dialog" aria-modal="true" aria-labelledby="opportunity-title" className="opportunity-modal" onClick={e=>e.stopPropagation()} initial={{opacity:0,scale:.97,y:10}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:.97}} transition={spring}><button className="close" aria-label="Close" onClick={onClose}><X/></button><span className="company-icon large" style={{ "--company": item.color } as React.CSSProperties}>{item.ticker.slice(0,1)}</span><span className="eyebrow">OPPORTUNITY DETAIL · {item.source === "live" ? "LIVE" : "DEMO"}</span><h2 id="opportunity-title">{item.ticker} <small>{item.company}</small></h2><div className="modal-verdict"><OpportunityMove change={item.change}/><em className={`confidence ${item.confidence.toLowerCase()}`}>{item.confidence} confidence</em></div><p>{item.thesis}</p><div className="detail-stats"><span>Quant score<strong>{item.score === null ? "Not published" : `${item.score}/100`}</strong></span><span>Trigger<strong>{item.trigger}</strong></span><span>Risk / invalidation<strong>{item.invalidation ?? item.risk}</strong></span></div>{item.reference && <a className="inline-source-link" href={item.reference} target="_blank" rel="noreferrer">View primary source <ExternalLink/></a>}<small className="demo-note">{item.source === "live" ? "Published backend data. Informational only." : "Demo information only."} No trading actions are available.</small></motion.div></motion.div>;
}

function EarningsDetail({ item, onClose }: { item: EarningsCompany; onClose: () => void }) {
  const upcoming = item.result === "Upcoming";
  const completed = ["Beat", "Miss", "Mixed"].includes(item.result);
  return <motion.div className="drawer-backdrop" onClick={onClose} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.aside className="earnings-drawer" onClick={e=>e.stopPropagation()} initial={{x:"100%"}} animate={{x:0}} exit={{x:"100%"}} transition={spring}><div className="drawer-head"><button aria-label="Back" onClick={onClose}><ArrowLeft/></button><span>Earnings Detail</span><button aria-label="Close earnings detail" onClick={onClose}><X/></button></div><div className="drawer-company"><span className="company-icon large" style={{ "--company": item.color } as React.CSSProperties}>{item.ticker.slice(0,1)}</span><div><h2>{item.company}</h2><p>{item.ticker} · {new Date(item.date+"T12:00:00").toLocaleDateString("en", {month:"long",day:"numeric",year:"numeric"})} · {item.timing}</p></div><em className={`result ${item.result.toLowerCase()}`}>{item.result}</em></div><div className="report-grid"><section><span>Revenue</span><div><small>{upcoming ? "Expected" : "Actual"}</small><strong>{upcoming ? item.revenueExpected : item.revenueActual ?? "Not published"}</strong></div>{!upcoming && <div><small>Expected</small><strong>{item.revenueExpected}</strong></div>}</section><section><span>EPS</span><div><small>{upcoming ? "Expected" : "Actual"}</small><strong>{upcoming ? item.epsExpected : item.epsActual ?? "Not published"}</strong></div>{!upcoming && <div><small>Expected</small><strong>{item.epsExpected}</strong></div>}</section></div><div className="detail-metrics"><span>Guidance<strong>{item.guidance}</strong></span><span>Revenue YoY<strong>{item.revenueYoy || "Pending"}</strong></span><span>EPS YoY<strong>{item.epsYoy || "Pending"}</strong></span><span>Operating margin<strong>{item.margin || "Pending"}</strong></span><span>Key segment<strong>{item.segment || "Pending"}</strong></span></div>{completed && <section className="takeaways"><h3>Key Takeaways</h3><ul>{(takeaways[item.ticker] || ["Full management commentary will be added after the official report."]).map(t => <li key={t}><Check/>{t}</li>)}</ul></section>}{item.officialUrl ? <a className="official-link" href={item.officialUrl} target="_blank" rel="noreferrer">View Official Earnings Report <ExternalLink/></a> : <span className="official-link disabled">Official Investor Relations link not published</span>}<p className="source-note">{item.source === "live" ? "Schedule from the backend. Detailed financial fields remain pending where not published." : item.source === "mixed" ? "Live schedule with clearly labelled demo result details." : "Demo data prepared for the future earnings API."}</p></motion.aside></motion.div>;
}

function MorningBriefingShell() {
  const location = useLocation(); const navigate = useNavigate();
  const page: Page = location.pathname === "/x" ? "surge" : location.pathname === "/earnings" ? "earnings" : "briefing";
  const setPage = (next: Page) => navigate(pagePaths[next]); const [theme, setTheme] = useState<Theme>("light");
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null); const [selectedEarnings, setSelectedEarnings] = useState<EarningsCompany | null>(null);
  useEffect(() => { const stored = localStorage.getItem("morning-briefing-theme") as Theme | null; const preferred = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; const timer = window.setTimeout(() => setTheme(stored || preferred), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("morning-briefing-theme", theme); }, [theme]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [page]);
  return <div className="mb-demo app-shell"><AppHeader page={page} setPage={setPage} theme={theme} setTheme={setTheme}/><AnimatePresence mode="wait"><motion.main key={page} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-4}} transition={spring}>{page === "briefing" && <MorningBriefing setPage={setPage} selectOpportunity={setSelectedOpportunity} selectEarnings={setSelectedEarnings}/>} {page === "surge" && <XPulsePage/>} {page === "earnings" && <EarningsPage onSelect={setSelectedEarnings}/>}</motion.main></AnimatePresence><footer><span>Morning Briefing</span><p>Public, read-only market intelligence. Live backend data where available; demo fields are labelled.</p></footer><AnimatePresence>{selectedOpportunity && <OpportunityModal item={selectedOpportunity} onClose={() => setSelectedOpportunity(null)}/>} {selectedEarnings && <EarningsDetail item={selectedEarnings} onClose={() => setSelectedEarnings(null)}/>}</AnimatePresence></div>;
}


export default function MorningBriefingApp() {
  return <MorningBriefingDataProvider><MorningBriefingShell/></MorningBriefingDataProvider>;
}
