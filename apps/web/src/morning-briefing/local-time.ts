// Local-time hero helpers, isolated from the component tree so they can be
// imported by both the hero and the unit tests. The local-time Date
// constructor interprets the components in the machine's own timezone, so the
// helpers (and their explicit-Date tests) are deterministic on Linux, macOS and
// Windows without any process-level TZ pinning.

export function localDateLabel(now: Date = new Date(Date.now())): string {
  // The hero's day/date follows the visitor's own clock and locale, so a
  // morning visitor on the other side of the world sees their local day, not
  // the New York market date.
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long" }).format(now);
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(now);
  return `${weekday} · ${now.getDate()} ${month}`.toUpperCase();
}

export function marketGreeting(now: Date = new Date(Date.now())): string {
  // Time-of-day greeting in the visitor's local timezone (the browser clock,
  // not the market's): a morning visitor sees "Good morning.".
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  return "Good evening.";
}
