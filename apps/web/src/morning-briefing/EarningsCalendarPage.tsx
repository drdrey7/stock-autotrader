import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  formatPercent,
  resultClass,
  type EarningsCompany,
} from "./data/earnings-view";
import { marketTodayKey, useMorningBriefingData } from "./MorningBriefingData";
import { Card, dateFromKey, dateKeyFromDate, SectionTitle } from "./shared";

function monthDays(month: number, year: number) {
  const first = new Date(year, month, 1); const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [...Array(first.getDay()).fill(null), ...Array.from({length: days}, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return cells;
}

type CalendarPeriod = { year: number; month: number };

function EarningsCalendar({ period, setPeriod, onSelect }: { period: CalendarPeriod; setPeriod: (period: CalendarPeriod) => void; onSelect: (e: EarningsCompany) => void }) {
  const { earnings: storedEarnings, earningsAvailable } = useMorningBriefingData();
  const earnings = earningsAvailable ? storedEarnings : [];
  const { year, month } = period; const days = monthDays(month, year); const monthName = new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(year, month));
  const todayKey = marketTodayKey();
  const moveMonth = (offset: number) => { const next = new Date(year, month + offset, 1); setPeriod({ year: next.getFullYear(), month: next.getMonth() }); };
  const goToday = () => { const today = dateFromKey(marketTodayKey()); setPeriod({ year: today.getFullYear(), month: today.getMonth() }); };
  const eventLabel = (event: EarningsCompany) => event.status === "scheduled"
    ? `Scheduled · ${event.timing}`
    : event.status === "reported"
      ? `Reported · ${event.timing}`
      : event.status === "cancelled" ? "Cancelled" : `Unknown · ${event.timing}`;
  return <Card className="calendar-card"><div className="calendar-head"><div><span className="eyebrow">MONTHLY CALENDAR</span><h2>{monthName} {year}</h2></div><div><button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft/></button><button className="today" onClick={goToday}>Today</button><button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight/></button></div></div><div className="weekdays">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-grid">{days.map((day, index) => { const date = day ? `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}` : ""; const reports = earnings.filter(e => e.scheduledDate === date); return <div key={index} className={!day ? "empty" : date === todayKey ? "is-today" : ""}>{day && <><span className="day-number">{day}</span><div className="calendar-events">{reports.map(e => <button key={e.id} onClick={() => onSelect(e)} title={`${e.company} · ${eventLabel(e)}`}><i style={{ "--company": e.color } as React.CSSProperties}/><b>{e.symbol}</b><small>{eventLabel(e)}</small></button>)}</div></>}</div>; })}</div></Card>;
}

function PastEarnings({ year, onSelect }: { year: number; onSelect: (e: EarningsCompany) => void }) {
  const { earnings: storedEarnings, earningsAvailable } = useMorningBriefingData();
  const earnings = earningsAvailable ? storedEarnings : [];
  const [filter, setFilter] = useState("All"); const past = earnings.filter(e => e.scheduledDate?.startsWith(`${year}-`) && e.status !== "scheduled" && (filter === "All" || e.result === filter)).sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""));
  const filters = ["All", "Beat", "Miss", "Mixed", "Met", "N/A"];
  const stateLabel = (event: EarningsCompany) => event.status === "reported" ? `Reported · ${event.timing}` : event.status === "cancelled" ? "Cancelled" : `Unknown · ${event.timing}`;
  return <Card className="past-card"><SectionTitle title={`Recent Earnings — ${year}`}/><div className="filter-row small">{filters.map(item => <button key={item} aria-pressed={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="earnings-table"><div className="table-head"><span>Company</span><span>Date / status</span><span>EPS surprise %</span><span>Revenue surprise %</span><span>Result</span></div>{past.length ? past.map(e => <button key={e.id} onClick={() => onSelect(e)}><span className="table-company"><i style={{ "--company": e.color } as React.CSSProperties}>{e.symbol.slice(0,1)}</i><b>{e.company}</b><small>{e.symbol}</small></span><span className="table-date-state">{e.scheduledDate ? dateFromKey(e.scheduledDate).toLocaleDateString("en", {month:"short",day:"numeric"}) : "N/A"}<small>{stateLabel(e)}</small></span><span>{formatPercent(e.epsSurprisePct)}</span><span>{formatPercent(e.revenueSurprisePct)}</span><span><em className={`result ${resultClass(e.result)}`}>{e.result}</em></span><ChevronRight/></button>) : <p className="empty-state">No recent earnings published.</p>}</div></Card>;
}

/** Lazy-loaded via React.lazy() in MorningBriefingApp.tsx — kept in its own file so it isn't in the initial bundle. */
export default function EarningsCalendarPage({ onSelect }: { onSelect: (e: EarningsCompany) => void }) {
  const today = dateFromKey(marketTodayKey());
  const manualPeriod = useRef(false);
  const initialPeriod = (): CalendarPeriod => {
    try {
      const stored = sessionStorage.getItem("earnings-calendar-period");
      const parsed = stored ? JSON.parse(stored) as Partial<CalendarPeriod> : null;
      if (parsed && Number.isInteger(parsed.year) && Number.isInteger(parsed.month) && parsed.month! >= 0 && parsed.month! <= 11) {
        manualPeriod.current = true;
        return { year: parsed.year!, month: parsed.month! };
      }
    } catch { /* unavailable storage should not block the calendar */ }
    return { year: today.getFullYear(), month: today.getMonth() };
  };
  const [period, setPeriod] = useState<CalendarPeriod>(initialPeriod);
  const setManualPeriod = (next: CalendarPeriod) => {
    manualPeriod.current = true;
    setPeriod(next);
    try { sessionStorage.setItem("earnings-calendar-period", JSON.stringify(next)); } catch { /* best effort */ }
  };
  const { earnings: storedEarnings, earningsAvailable } = useMorningBriefingData();
  const earnings = earningsAvailable ? storedEarnings : [];
  const todayKey = marketTodayKey();
  useEffect(() => {
    const syncCalendarMonth = () => {
      const current = dateFromKey(marketTodayKey());
      if (manualPeriod.current) return;
      setPeriod((previous) => previous.year === current.getFullYear() && previous.month === current.getMonth()
        ? previous
        : { year: current.getFullYear(), month: current.getMonth() });
    };
    syncCalendarMonth();
    const timer = window.setInterval(syncCalendarMonth, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const offsetDate = (days: number) => { const date = new Date(today); date.setDate(date.getDate() + days); return dateKeyFromDate(date); };
  const thisWeekStartDate = new Date(today); thisWeekStartDate.setDate(today.getDate() - today.getDay());
  const thisWeekStart = dateKeyFromDate(thisWeekStartDate);
  const thisWeekEndDate = new Date(thisWeekStartDate); thisWeekEndDate.setDate(thisWeekStartDate.getDate() + 6);
  const thisWeekEnd = dateKeyFromDate(thisWeekEndDate);
  const counts = {
    today: earnings.filter(e => e.scheduledDate === todayKey).length,
    week: earnings.filter(e => e.scheduledDate !== null && e.scheduledDate >= thisWeekStart && e.scheduledDate <= thisWeekEnd).length,
    next60: earnings.filter(e => e.scheduledDate !== null && e.scheduledDate >= todayKey && e.scheduledDate <= offsetDate(60)).length,
  };
  const count = (value: number) => earningsAvailable ? String(value) : "—";
  const countLabel = earningsAvailable ? "reports" : "N/A";
  return <div className="page-content inner-page"><div className="page-heading"><span className="eyebrow">REPORTS & CONSENSUS</span><h1>Earnings Calendar</h1><p>Automatic scheduled reports, published results and official filings.</p></div><div className="earnings-top-summary" aria-label="Earnings summary"><Card><span>TODAY</span><strong>{count(counts.today)}</strong><small>{countLabel}</small></Card><Card><span>THIS WEEK</span><strong>{count(counts.week)}</strong><small>{countLabel}</small></Card><Card><span>NEXT 60 DAYS</span><strong>{count(counts.next60)}</strong><small>{countLabel}</small></Card></div><EarningsCalendar period={period} setPeriod={setManualPeriod} onSelect={onSelect}/><PastEarnings year={period.year} onSelect={onSelect}/></div>;
}
