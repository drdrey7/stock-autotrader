import { TradingViewIframeWidget } from "./IframeWidget";
import { ECONOMIC_CALENDAR_CONFIG } from "./tradingview-config";

interface EconomicCalendarProps {
  lazy?: boolean;
  className?: string;
}

/**
 * Official TradingView Economic Calendar embed widget.
 *
 * Shows the macro calendar for the US, Eurozone and UK with every importance
 * level (`countryFilter` lowercase ids, `importanceFilter` "-1,0,1" — see
 * tradingview-config.ts for the official config contract).
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
