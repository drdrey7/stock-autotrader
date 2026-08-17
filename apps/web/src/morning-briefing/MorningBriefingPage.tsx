import { useShellTheme } from "../shell/theme";
import { EconomicCalendar, MarketOverview, TopStories, MARKET_OVERVIEW_SECTIONS } from "./TradingView";
import { Card, SectionTitle } from "./shared";
import { localDateLabel, marketGreeting } from "./local-time";
import { useSentiment } from "./useSentiment";

const SENTIMENT_META: Record<string, { label: string; color: string }> = {
  extreme_fear: { label: "Extreme Fear", color: "#e5484d" },
  fear: { label: "Fear", color: "#f76b15" },
  neutral: { label: "Neutral", color: "#8b8d98" },
  greed: { label: "Greed", color: "#f5a524" },
  extreme_greed: { label: "Extreme Greed", color: "#30a46c" },
};

const GAUGE_ARC_LENGTH = Math.PI * 65;

function Sentiment() {
  const sentiment = useSentiment();

  if (!sentiment) {
    return (
      <Card className="sentiment-card">
        <SectionTitle title="Fear & Greed"/>
        <div className="gauge gauge-unavailable">
          <svg viewBox="0 0 160 86" aria-hidden="true">
            <path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/>
          </svg>
          <div className="gauge-mask">
            <strong>Not available</strong>
            <span>Fear & Greed</span>
          </div>
        </div>
      </Card>
    );
  }

  const meta = SENTIMENT_META[sentiment.rating] ?? { label: "Neutral", color: "#8b8d98" };
  const dash = (sentiment.score / 100) * GAUGE_ARC_LENGTH;

  return (
    <Card className="sentiment-card">
      <SectionTitle title="Fear & Greed"/>
      <div className="gauge">
        <svg viewBox="0 0 160 86" aria-hidden="true">
          <path className="gauge-bg" d="M15 75 A65 65 0 0 1 145 75"/>
          <path
            className="gauge-value gauge-live"
            d="M15 75 A65 65 0 0 1 145 75"
            stroke={meta.color}
            strokeDasharray={`${dash} ${GAUGE_ARC_LENGTH}`}
          />
        </svg>
        <div className="gauge-mask">
          <strong style={{ color: meta.color }}>{sentiment.score}</strong>
          <span style={{ color: meta.color }}>{meta.label}</span>
        </div>
      </div>
    </Card>
  );
}

export default function MorningBriefingPage() {
  const { theme } = useShellTheme();

  return (
    <div className="page-content">
      <div className="homepage-grid">
        <section className="mb-hero" aria-label="Morning briefing">
          <span className="eyebrow">{localDateLabel()}</span>
          <h1>{marketGreeting()}</h1>
          <p>Markets, economic calendar and top stories — at a glance.</p>
        </section>

        <Sentiment/>

        <section className="widget-block market-overview-block" aria-label="Market overview">
          <div className="widget-head">
            <span className="eyebrow">MARKET OVERVIEW</span>
            <span className="section-meta">TradingView · 12M</span>
          </div>
          <MarketOverview sections={MARKET_OVERVIEW_SECTIONS} colorTheme={theme} className="market-overview-frame"/>
        </section>

        <section className="widget-block calendar-block" aria-label="Economic calendar">
          <div className="widget-head">
            <span className="eyebrow">ECONOMIC CALENDAR</span>
            <span className="section-meta">TradingView</span>
          </div>
          <EconomicCalendar/>
        </section>

        <section className="widget-block stories-block" aria-label="Top stories">
          <div className="widget-head">
            <span className="eyebrow">TOP STORIES</span>
            <span className="section-meta">TradingView</span>
          </div>
          <TopStories/>
        </section>
      </div>
    </div>
  );
}
