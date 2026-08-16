import { TradingViewIframeWidget } from "./IframeWidget";
import { ECONOMIC_CALENDAR_CONFIG } from "./tradingview-config";

interface EconomicCalendarProps {
  lazy?: boolean;
  className?: string;
}

/**
 * Official TradingView Economic Calendar embed widget.
 *
 * Shows only the events that can materially move US or European markets: US +
 * Eurozone countries (`countryFilter` "us,eu") and high importance only
 * (`importanceFilter` "1" — see tradingview-config.ts for the official config
 * contract). Low-importance noise (repeated auctions, minor releases) is
 * filtered by TradingView's own high-importance flag.
 */
export function EconomicCalendar({ lazy = true, className = "" }: EconomicCalendarProps) {
  return (
    <TradingViewIframeWidget
      id="events"
      script={ECONOMIC_CALENDAR_CONFIG.script}
      config={ECONOMIC_CALENDAR_CONFIG.config}
      height={ECONOMIC_CALENDAR_CONFIG.height}
      lazy={lazy}
      className={className}
    />
  );
}
