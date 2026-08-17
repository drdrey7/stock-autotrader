/**
 * Production keeps two Cloudflare trigger entries. The 15-minute entry fans
 * out to the jobs that need that cadence, while the job implementations keep
 * their own domain-specific windows and failure handling.
 */
export const EARNINGS_MONITOR_CRON = "*/15 * * * *";
export const EARNINGS_CALENDAR_CRON = "0 6 * * *";

export const PRODUCTION_CRON_TRIGGERS = [
  EARNINGS_MONITOR_CRON,
  EARNINGS_CALENDAR_CRON,
] as const;

export type ProductionCronJob =
  | "earnings-monitor"
  | "market-context"
  | "sentiment"
  | "earnings-calendar";

import { isUsMarketHoliday, localNewYorkParts } from "./market-context";

/**
 * Fear & Greed is collected on 30-minute slots during the useful part of the
 * US session, in America/New_York (DST-safe via Intl, no hardcoded UTC hours):
 *
 * - 09:30 ET (open) through 16:30 ET (post-close): minute 0 or 30
 * - weekends and US market holidays: never
 *
 * The shared 15-minute trigger still fires every quarter-hour; outside these
 * slots the dispatcher simply does not enqueue the sentiment job, so no HTTP
 * request reaches CNN.
 */
export const SENTIMENT_SLOT_MINUTES = new Set([0, 30]);
export const SENTIMENT_WINDOW_START_MINUTES = 9 * 60 + 30;
export const SENTIMENT_WINDOW_END_MINUTES = 16 * 60 + 30;

export function isSentimentDispatchTime(scheduledTime: Date): boolean {
  const parts = localNewYorkParts(scheduledTime);
  if (!parts) return false;
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  if (isUsMarketHoliday(scheduledTime)) return false;
  if (!SENTIMENT_SLOT_MINUTES.has(parts.minute)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= SENTIMENT_WINDOW_START_MINUTES && minutes <= SENTIMENT_WINDOW_END_MINUTES;
}

export function jobsForProductionCron(
  cron: string,
  scheduledTime: Date,
): ProductionCronJob[] {
  if (cron === EARNINGS_CALENDAR_CRON) return ["earnings-calendar"];
  if (cron !== EARNINGS_MONITOR_CRON) return [];

  const jobs: ProductionCronJob[] = ["earnings-monitor", "market-context"];
  if (isSentimentDispatchTime(scheduledTime)) jobs.push("sentiment");
  return jobs;
}
