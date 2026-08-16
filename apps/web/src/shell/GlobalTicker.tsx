import { TICKER_SYMBOLS, TickerTape } from "../morning-briefing/TradingView";
import { useShellTheme } from "./theme";

/**
 * Global live market tape rendered by the app shell directly beneath the main
 * header/navigation. It lives outside <Routes>, so it survives every route
 * change without remounting — no module reload, no flash, and it stays visible
 * on Morning Briefing, X Pulse and Earnings alike. It is intentionally not
 * sticky: it scrolls away with the page.
 */
export function GlobalTicker() {
  const { theme } = useShellTheme();
  return (
    <section className="global-ticker" aria-label="Live market ticker">
      <TickerTape symbols={TICKER_SYMBOLS} colorTheme={theme} />
    </section>
  );
}
