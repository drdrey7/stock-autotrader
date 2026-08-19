/**
 * ISO-week helpers for the live SMA200W anchor logic.
 *
 * The live formula anchors the 199-week historical basis to the TRADING WEEK
 * of the latest quote (latest_quotes.provider_timestamp), never to wall-clock
 * "today". ISO weeks (Monday-based) are the stable week identity here:
 * Alpha Vantage weekly buckets are keyed by the week's last trading day (a
 * Thursday when Friday is a holiday, e.g. Good Friday 2025-04-17), and ISO
 * weeks keep the anchor comparison correct for holiday weeks, early closes,
 * weekends, Monday pre-open and year boundaries — no Friday-based date
 * arithmetic that would break on holiday weeks.
 *
 * Mirrors apps/history-ingestor/history_ingestor/weeks.py on purpose: the
 * Python side (maintenance) and this side (read path) must agree on what a
 * "week" is. Both compute the ISO week of an America/New_York calendar date.
 */

import { localNewYorkParts } from "../market-context";

export interface IsoWeek {
  year: number;
  week: number;
}

/**
 * ISO (year, week) of a calendar date (Gregorian, interpreted as a NY
 * calendar date). Thursday-based per ISO 8601.
 */
export function isoWeekOfDate(year: number, month: number, day: number): IsoWeek {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay(); // 0 = Sunday
  const isoWeekday = (weekday + 6) % 7; // 0 = Monday .. 6 = Sunday
  // Thursday of the same ISO week (may be in the previous calendar week for
  // Fri/Sat/Sun, hence a possibly-negative offset).
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (3 - isoWeekday));
  const thursdayYear = thursday.getUTCFullYear();
  // Monday of ISO week 1 of thursdayYear (Jan 4 is always in week 1).
  const jan4 = new Date(Date.UTC(thursdayYear, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = Math.floor((thursday.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return { year: thursdayYear, week };
}

/** ISO week of the NY calendar date of an instant (DST-safe). */
export function isoWeekOfNyInstant(instant: Date): IsoWeek | null {
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = localNewYorkParts(instant);
  if (!parts) return null;
  return isoWeekOfDate(parts.year, parts.month, parts.day);
}

/** ISO week of an Alpha Vantage date key (YYYY-MM-DD). */
export function isoWeekOfDateKey(dateKey: string): IsoWeek | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null; // impossible calendar date (e.g. 2026-02-30)
  }
  return isoWeekOfDate(year, month, day);
}

/** Monday (UTC midnight) of an ISO week — canonical week comparator. */
export function isoMonday(week: IsoWeek): Date {
  const jan4 = new Date(Date.UTC(week.year, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week.week - 1) * 7);
  return monday;
}

/** Whole days between two ISO weeks: a - b (positive when a is later). */
export function weekDiffDays(a: IsoWeek, b: IsoWeek): number {
  return (isoMonday(a).getTime() - isoMonday(b).getTime()) / 86_400_000;
}
