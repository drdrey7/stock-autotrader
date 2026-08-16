import { TradingViewIframeWidget } from "./IframeWidget";
import { TOP_STORIES_CONFIG } from "./tradingview-config";

interface TopStoriesProps {
  lazy?: boolean;
  className?: string;
}

/**
 * Official TradingView Top Stories embed widget.
 *
 * Feeds every tracked symbol (`feedMode: "all_symbols"`) in the regular news
 * layout (`displayMode: "regular"`) — see tradingview-config.ts.
 */
export function TopStories({ lazy = true, className = "" }: TopStoriesProps) {
  return (
    <TradingViewIframeWidget
      id="timeline"
      script={TOP_STORIES_CONFIG.script}
      config={TOP_STORIES_CONFIG.config}
      height={TOP_STORIES_CONFIG.height}
      lazy={lazy}
      className={className}
    />
  );
}
