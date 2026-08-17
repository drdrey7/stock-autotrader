import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CompanyLogo } from "./EarningsLogo";
import {
  formatPercent,
  resultClass,
  type EarningsCompany,
} from "./data/earnings-view";
import { Card, dateFromKey, SectionTitle } from "./shared";
import { monthDays } from "../lib/calendar";
import {
  type CalendarPeriod,
  marketTodayKey,
  useEarningsMonth,
  useEarningsSummary,
  usePastEarnings,
  EARNINGS_CLIENT_PAST_DAYS,
} from "./useEarnings";

function EarningsCalendar({
  period,
  setPeriod,
  onSelect,
  earnings,
}: {
  period: CalendarPeriod;
  setPeriod: (period: CalendarPeriod) => void;
  onSelect: (event: EarningsCompany) => void;
  earnings: EarningsCompany[];
}) {
  const { year, month } = period;
  const days = monthDays(month, year);
  const monthName = new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(year, month));
  const todayKey = marketTodayKey();

  const moveMonth = (offset: number) => {
    const next = new Date(year, month + offset, 1);
    setPeriod({ year: next.getFullYear(), month: next.getMonth() });
  };

  const goToday = () => {
    const today = dateFromKey(marketTodayKey());
    setPeriod({ year: today.getFullYear(), month: today.getMonth() });
  };

  return (
    <Card className="calendar-card">
      <div className="calendar-head">
        <div>
          <span className="eyebrow">MONTHLY CALENDAR</span>
          <h2>{monthName} {year}</h2>
        </div>
        <div>
          <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft/></button>
          <button className="today" onClick={goToday}>Today</button>
          <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight/></button>
        </div>
      </div>

      <div className="weekdays">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}
      </div>

      <div className="calendar-grid">
        {days.map((day, index) => {
          const date = day ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : "";
          const reports = earnings.filter((event) => event.scheduledDate === date);
          const calendarDateLabel = day
            ? new Intl.DateTimeFormat("en", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              }).format(dateFromKey(date))
            : "";

          return (
            <div key={index} className={!day ? "empty" : date === todayKey ? "is-today" : ""}>
              {day && (
                <>
                  <span className="day-number">{day}</span>
                  <div className="calendar-events">
                    {reports.map((event) => (
                      <button
                        key={event.id}
                        aria-label={`${event.symbol} ${event.company}, ${event.timing}, ${calendarDateLabel}`}
                        onClick={() => onSelect(event)}
                        title={`${event.company} · ${event.timing}`}
                      >
                        <CompanyLogo event={event} className="calendar-logo"/>
                        <b>{event.symbol}</b>
                        <small>{event.timing}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PastEarnings({
  onSelect,
  earnings,
  available,
}: {
  onSelect: (event: EarningsCompany) => void;
  earnings: EarningsCompany[];
  available: boolean;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? earnings.filter((event) => (
      event.symbol.toLowerCase().includes(normalizedQuery)
      || event.company.toLowerCase().includes(normalizedQuery)
    ))
    : earnings;

  const stateLabel = (event: EarningsCompany) => event.status === "reported"
    ? `Reported · ${event.timing}`
    : event.status === "cancelled"
      ? "Cancelled"
      : `Unknown · ${event.timing}`;

  return (
    <Card className="past-card">
      <SectionTitle title="Past Earnings" meta={`Last ${EARNINGS_CLIENT_PAST_DAYS} days`}/>
      <label className="earnings-search">
        <span className="visually-hidden">Search company or ticker</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search company or ticker"
        />
      </label>

      <div className="earnings-table">
        <div className="table-head">
          <span>Company</span>
          <span>Date / status</span>
          <span>EPS surprise %</span>
          <span>Revenue surprise %</span>
          <span>Result</span>
        </div>

        {available ? (
          visible.length ? visible.map((event) => (
            <button key={event.id} onClick={() => onSelect(event)}>
              <span className="table-company">
                <CompanyLogo event={event} className="table-logo"/>
                <b>{event.company}</b>
                <small>{event.symbol}</small>
              </span>
              <span className="table-date-state">
                {event.scheduledDate
                  ? dateFromKey(event.scheduledDate).toLocaleDateString("en", { month: "short", day: "numeric" })
                  : "N/A"}
                <small>{stateLabel(event)}</small>
              </span>
              <span data-label="EPS surprise">{formatPercent(event.epsSurprisePct)}</span>
              <span data-label="Revenue surprise">{formatPercent(event.revenueSurprisePct)}</span>
              <span><em className={`result ${resultClass(event.result)}`}>{event.result}</em></span>
              <ChevronRight/>
            </button>
          )) : (
            <p className="empty-state">
              {normalizedQuery
                ? "No company matches the search."
                : `No earnings in the last ${EARNINGS_CLIENT_PAST_DAYS} days.`}
            </p>
          )
        ) : (
          <p className="empty-state">Earnings data is not available yet.</p>
        )}
      </div>
    </Card>
  );
}

/** Lazy-loaded via React.lazy() in MorningBriefingApp.tsx so earnings code/data stays out of the initial bundle. */
export default function EarningsCalendarPage({ onSelect }: { onSelect: (event: EarningsCompany) => void }) {
  const today = dateFromKey(marketTodayKey());
  const manualPeriod = useRef(false);

  const initialPeriod = (): CalendarPeriod => {
    try {
      const stored = sessionStorage.getItem("earnings-calendar-period");
      const parsed = stored ? JSON.parse(stored) as Partial<CalendarPeriod> : null;
      if (
        parsed
        && Number.isInteger(parsed.year)
        && Number.isInteger(parsed.month)
        && parsed.month! >= 0
        && parsed.month! <= 11
      ) {
        manualPeriod.current = true;
        return { year: parsed.year!, month: parsed.month! };
      }
    } catch {
      // Unavailable storage should not block the calendar.
    }
    return { year: today.getFullYear(), month: today.getMonth() };
  };

  const [period, setPeriod] = useState<CalendarPeriod>(initialPeriod);

  const setManualPeriod = (next: CalendarPeriod) => {
    manualPeriod.current = true;
    setPeriod(next);
    try {
      sessionStorage.setItem("earnings-calendar-period", JSON.stringify(next));
    } catch {
      // Best effort only.
    }
  };

  useEffect(() => {
    const syncCalendarMonth = () => {
      const current = dateFromKey(marketTodayKey());
      if (manualPeriod.current) return;
      setPeriod((previous) => (
        previous.year === current.getFullYear() && previous.month === current.getMonth()
          ? previous
          : { year: current.getFullYear(), month: current.getMonth() }
      ));
    };

    syncCalendarMonth();
    const timer = window.setInterval(syncCalendarMonth, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Three independent D1 surfaces — never Finnhub from the browser.
  const month = useEarningsMonth(period);
  const past = usePastEarnings();
  const summary = useEarningsSummary();

  const count = (value: number) => summary.available ? String(value) : "—";
  const countLabel = summary.available ? "reports" : "N/A";

  return (
    <div className="page-content inner-page">
      <div className="page-heading">
        <span className="eyebrow">REPORTS & CONSENSUS</span>
        <h1>Earnings Calendar</h1>
        <p>Automatic scheduled reports, published results and official filings.</p>
      </div>

      <div className="earnings-top-summary" aria-label="Earnings summary">
        <Card><span>TODAY</span><strong>{count(summary.today)}</strong><small>{countLabel}</small></Card>
        <Card><span>THIS WEEK</span><strong>{count(summary.thisWeek)}</strong><small>{countLabel}</small></Card>
        <Card><span>NEXT 30 DAYS</span><strong>{count(summary.next30Days)}</strong><small>{countLabel}</small></Card>
      </div>

      <EarningsCalendar
        period={period}
        setPeriod={setManualPeriod}
        onSelect={onSelect}
        earnings={month.earnings}
      />
      <PastEarnings onSelect={onSelect} earnings={past.earnings} available={past.available}/>
    </div>
  );
}
