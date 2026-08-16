import { useEffect, useState } from "react";
import type { EarningsApiResponse, EarningsEngineEvent } from "@stock-autotrader/contracts";
import { eventWithViewMetadata, type EarningsCompany } from "./data/earnings-view";
import { fetchJson } from "./api-client";

type EarningsState = {
  earnings: EarningsCompany[];
  earningsAvailable: boolean;
};

const EARNINGS_REFRESH_INTERVAL_MS = 60 * 60_000;

export function marketTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const EARNINGS_STRING_FIELDS = [
  "id", "symbol", "company", "cik", "date", "scheduledDate", "scheduledTime",
  "fiscalPeriod", "fiscalPeriodEnd", "reportedAt", "calendarProvider", "consensusProvider",
  "providerEventId", "providerUpdatedAt", "officialReportUrl", "investorRelationsUrl",
  "secFilingUrl", "secAccession", "secForm", "secFiledAt", "createdAt", "updatedAt", "lastCheckedAt",
  "logoUrl", "industry", "websiteUrl",
] as const;

const EARNINGS_NUMBER_FIELDS = [
  "fiscalYear", "fiscalQuarter", "epsEstimate", "epsActual", "epsSurprise", "epsSurprisePct",
  "revenueEstimate", "revenueActual", "revenueSurprise", "revenueSurprisePct",
] as const;

const EARNINGS_BOOLEAN_FIELDS = ["scheduled", "reported", "cancelled", "unknown"] as const;

function invalidEarningsEventField(event: Record<string, unknown>): string | null {
  if (typeof event.symbol !== "string" || event.symbol.trim().length === 0) return "symbol";
  for (const field of EARNINGS_STRING_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "string") return field;
  }
  for (const field of EARNINGS_NUMBER_FIELDS) {
    if (field in event && event[field] !== null && (typeof event[field] !== "number" || !Number.isFinite(event[field]))) return field;
  }
  for (const field of EARNINGS_BOOLEAN_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "boolean") return field;
  }
  if (event.date !== undefined && event.date !== null && !isDateKey(event.date)) return "date";
  if (event.scheduledDate !== undefined && event.scheduledDate !== null && !isDateKey(event.scheduledDate)) return "scheduledDate";
  if (event.status !== undefined && event.status !== null && !["scheduled", "reported", "cancelled", "unknown"].includes(String(event.status))) return "status";
  if (event.timing !== undefined && event.timing !== null && !["BMO", "AMC", "TBD"].includes(String(event.timing))) return "timing";
  if (event.epsResult !== undefined && event.epsResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.epsResult))) return "epsResult";
  if (event.revenueResult !== undefined && event.revenueResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.revenueResult))) return "revenueResult";
  if (event.overallResult !== undefined && event.overallResult !== null && !["Beat", "In Line", "Miss", "Mixed", "Not Available"].includes(String(event.overallResult))) return "overallResult";
  return null;
}

function earningsFromApi(payload: unknown): EarningsCompany[] | null {
  const events = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.events)
      ? payload.events
      : null;

  if (!events) return null;
  if (events.length === 0) return [];

  const valid: EarningsCompany[] = [];
  for (const event of events) {
    if (!isRecord(event)) {
      console.warn("earnings: rejected non-object event", event);
      continue;
    }
    const invalidField = invalidEarningsEventField(event);
    if (invalidField !== null) {
      console.warn("earnings: rejected malformed event", { symbol: event.symbol, field: invalidField, event });
      continue;
    }
    try {
      valid.push(eventWithViewMetadata(event as Partial<EarningsEngineEvent>));
    } catch (error) {
      console.warn("earnings: rejected event that failed to map", { symbol: event.symbol, error });
    }
  }

  return valid.length > 0 ? valid : null;
}

export function useEarnings(): EarningsState {
  const [state, setState] = useState<EarningsState>({ earnings: [], earningsAvailable: false });

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    let lastAttemptAt = 0;
    let lastAttemptDate: string | null = null;

    const refresh = async (force = false) => {
      const today = marketTodayKey();
      const now = Date.now();
      const refreshDue = force
        || lastAttemptDate !== today
        || now - lastAttemptAt >= EARNINGS_REFRESH_INTERVAL_MS;
      if (!refreshDue) return;

      lastAttemptAt = now;
      lastAttemptDate = today;
      const currentRequest = ++requestId;
      const response = await fetchJson<EarningsApiResponse | EarningsEngineEvent[]>("/api/earnings");
      if (cancelled || currentRequest !== requestId) return;

      const apiEarnings = response ? earningsFromApi(response) : null;
      setState({
        earnings: apiEarnings ?? [],
        earningsAvailable: apiEarnings !== null,
      });
    };

    void refresh(true);
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return state;
}
