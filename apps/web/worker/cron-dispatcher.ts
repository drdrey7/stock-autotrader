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

export function isSentimentDispatchTime(scheduledTime: Date): boolean {
  const weekday = scheduledTime.getUTCDay();
  const isWeekday = weekday >= 1 && weekday <= 5;
  const hour = scheduledTime.getUTCHours();
  return isWeekday
    && scheduledTime.getUTCMinutes() === 0
    && (hour === 14 || hour === 19);
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
