import {
  BarChart3,
  Landmark,
  MessageCircle,
  Newspaper,
  Scale,
  ShieldCheck,
} from "lucide-react";
import "./research-coverage.css";

const researchLayers = [
  {
    icon: BarChart3,
    title: "Market & technical research",
    summary: "Price action, candles, indicators and a verified market snapshot.",
    details: [
      "Historical OHLCV candles: open, high, low, close and volume",
      "Technical indicators: SMA, EMA, MACD, RSI, Bollinger, ATR and VWMA",
      "Trend, momentum, volatility and volume structure",
      "Verified market snapshot before exact price-level claims",
    ],
  },
  {
    icon: MessageCircle,
    title: "Investor sentiment",
    summary: "Multiple investor-discussion sources, read together rather than as one social signal.",
    details: [
      "Reddit: r/wallstreetbets, r/stocks and r/investing",
      "StockTwits messages with bullish / bearish sentiment tags",
      "Yahoo Finance headlines and market narrative",
      "Confidence notes when a source is thin or unavailable",
    ],
  },
  {
    icon: Newspaper,
    title: "News & macro context",
    summary: "Company-specific developments plus the broader macro environment.",
    details: [
      "Ticker-specific company news over a recent window",
      "Global and macroeconomic news",
      "FRED data when relevant: CPI, unemployment, Fed funds, 10Y and yield curve",
      "Prediction-market context for forward-looking events when available",
    ],
  },
  {
    icon: Landmark,
    title: "Fundamentals & financial statements",
    summary: "Company fundamentals and reported financial statements across annual and quarterly views.",
    details: [
      "Company profile and comprehensive fundamentals overview",
      "Income statement analysis",
      "Balance sheet analysis",
      "Cash-flow statement analysis",
    ],
  },
  {
    icon: Scale,
    title: "Bull vs Bear challenge",
    summary: "The same evidence is argued from opposite sides before a plan is accepted.",
    details: [
      "Bull Researcher builds the strongest evidence-backed upside case",
      "Bear Researcher stress-tests assumptions and downside paths",
      "Research Manager judges the disagreement and writes the investment plan",
      "Trader converts the plan into a concrete buy / hold / sell proposal",
    ],
  },
  {
    icon: ShieldCheck,
    title: "Three-way risk review & final brief",
    summary: "Three risk temperaments challenge the proposal before the Portfolio Manager synthesises the result.",
    details: [
      "Aggressive risk analysis",
      "Neutral risk analysis",
      "Conservative risk analysis",
      "Portfolio Manager final view: rating, thesis, optional target and horizon",
    ],
  },
] as const;

export function ResearchCoverage() {
  return (
    <section className="research-coverage" aria-labelledby="research-coverage-title">
      <div className="editorial-section-head research-coverage-head">
        <span>03 / What one credit buys</span>
        <h2 id="research-coverage-title">
          What they actually
          <br />
          <em>research for you.</em>
        </h2>
        <p>
          One analysis credit runs the twelve-specialist research process on one
          company. The value is the evidence gathered across market data,
          financial statements, news, investor discussion and macro context —
          then challenged, risk-reviewed and assembled into one final brief.
        </p>
      </div>

      <div className="research-coverage-grid" aria-label="Research included in one analysis credit">
        {researchLayers.map(({ icon: Icon, title, summary, details }, index) => (
          <article className="research-source-card" key={title}>
            <div className="research-source-card-head">
              <span className="research-item-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="research-item-icon" aria-hidden="true"><Icon size={19} /></span>
            </div>
            <h3>{title}</h3>
            <p>{summary}</p>
            <ul>
              {details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </article>
        ))}
      </div>

      <p className="research-source-note">
        Data availability varies by company, date and upstream source. The
        research agents decide which available evidence is relevant to each run;
        the site does not claim that every source is used in every analysis.
      </p>
    </section>
  );
}
