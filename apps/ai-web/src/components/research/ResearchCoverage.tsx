import {
  BarChart3,
  ChevronDown,
  FileSearch,
  Landmark,
  MessageCircle,
  Newspaper,
  Scale,
  ShieldCheck,
} from "lucide-react";
import "./research-coverage.css";

/** Public product labels for the real multi-agent analysis graph. */
const specialistRoles = [
  { stage: "01", title: "Market Analyst", focus: "Price, volume and technical structure" },
  { stage: "02", title: "Sentiment Analyst", focus: "Retail narrative and discussion tone" },
  { stage: "03", title: "News Analyst", focus: "Company news, macro and event odds" },
  { stage: "04", title: "Fundamentals Analyst", focus: "Statements, quality and capital" },
  { stage: "05", title: "Bull Researcher", focus: "Strongest evidence-backed upside case" },
  { stage: "06", title: "Bear Researcher", focus: "Assumption stress-test and downside" },
  { stage: "07", title: "Research Manager", focus: "Judges the debate and sets the plan" },
  { stage: "08", title: "Trader", focus: "Turns research into a concrete plan" },
  { stage: "09", title: "Aggressive Risk", focus: "Higher-conviction risk lens" },
  { stage: "10", title: "Neutral Risk", focus: "Balanced risk lens" },
  { stage: "11", title: "Conservative Risk", focus: "Capital-preservation risk lens" },
  { stage: "12", title: "Portfolio Manager", focus: "Final rating, thesis and target" },
] as const;

const researchLayers = [
  {
    icon: BarChart3,
    title: "Market & technical research",
    summary: "OHLCV history, indicator selection and a verified market snapshot before any price claim.",
    details: [
      "Historical open / high / low / close / volume",
      "Complementary indicators: SMA, EMA, MACD, RSI, Bollinger, ATR, VWMA",
      "Verified market snapshot as the source of truth for exact levels",
      "Trend, momentum, volatility and volume structure in one market brief",
    ],
  },
  {
    icon: MessageCircle,
    title: "Investor sentiment",
    summary: "Three complementary narrative feeds — not a single social scrape.",
    details: [
      "Yahoo Finance headlines for institutional framing",
      "StockTwits messages with bullish / bearish tags",
      "Reddit discussion from r/wallstreetbets, r/stocks and r/investing",
      "Confidence notes when a source is thin or unavailable",
    ],
  },
  {
    icon: Newspaper,
    title: "News & macro context",
    summary: "Company news plus broader world state that can move the name.",
    details: [
      "Ticker-specific news over a recent window",
      "Global / macroeconomic news",
      "FRED macro series when relevant: CPI, unemployment, Fed funds, 10Y, yield curve",
      "Prediction-market odds for forward-looking events when available",
    ],
  },
  {
    icon: Landmark,
    title: "Fundamentals & financial statements",
    summary: "Company profile and reported statements across annual and quarterly cuts.",
    details: [
      "Comprehensive fundamentals overview",
      "Income statement analysis",
      "Balance sheet analysis",
      "Cash-flow statement analysis",
    ],
  },
  {
    icon: Scale,
    title: "Bull vs Bear research",
    summary: "The same evidence is argued from opposite sides, then judged.",
    details: [
      "Bull Researcher builds the strongest upside case from the four briefs",
      "Bear Researcher attacks assumptions and downside paths",
      "Research Manager evaluates the disagreement and writes the investment plan",
      "Trader converts that plan into a concrete buy / hold / sell proposal",
    ],
  },
  {
    icon: ShieldCheck,
    title: "Three-way risk review & final brief",
    summary: "The proposed view is challenged from three risk temperaments before the final call.",
    details: [
      "Aggressive risk analysis",
      "Neutral risk analysis",
      "Conservative risk analysis",
      "Portfolio Manager synthesises the final view: rating, thesis, optional target and horizon",
    ],
  },
] as const;

export function ResearchCoverage() {
  return (
    <section className="research-coverage" aria-labelledby="research-coverage-title">
      <div className="editorial-section-head research-coverage-head">
        <span>03 / What one credit buys</span>
        <h2 id="research-coverage-title">
          One ticker.
          <br />
          <em>Twelve specialists.</em>
        </h2>
        <p>
          One analysis credit does not buy a chatbot paragraph. It runs a full
          multi-agent research desk on a single company: four evidence lanes,
          a bull–bear debate, a trade plan, a three-way risk review, and one
          structured brief with a final rating.
        </p>
      </div>

      <div className="research-value-strip" aria-label="One credit research workflow">
        <div>
          <span>01</span>
          <b>Evidence</b>
          <small>Market · sentiment · news · fundamentals</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>02</span>
          <b>Debate</b>
          <small>Bull · Bear · Research Manager · Trader</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>03</span>
          <b>Risk council</b>
          <small>Aggressive · Neutral · Conservative</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>04</span>
          <b>Final brief</b>
          <small>Rating · thesis · optional target</small>
        </div>
      </div>

      <div className="research-roster" aria-label="Specialist research roles">
        <div className="research-roster-head">
          <span>The desk</span>
          <p>Each run sequences twelve specialist roles over the same ticker.</p>
        </div>
        <ol className="research-roster-grid">
          {specialistRoles.map((role) => (
            <li key={role.title}>
              <span>{role.stage}</span>
              <b>{role.title}</b>
              <small>{role.focus}</small>
            </li>
          ))}
        </ol>
      </div>

      <div className="research-accordion">
        {researchLayers.map(({ icon: Icon, title, summary, details }, index) => (
          <details key={title} className="research-item" open={index === 0}>
            <summary>
              <span className="research-item-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="research-item-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="research-item-copy">
                <b>{title}</b>
                <small>{summary}</small>
              </span>
              <ChevronDown className="research-chevron" size={20} aria-hidden="true" />
            </summary>
            <div className="research-item-body">
              <FileSearch size={17} aria-hidden="true" />
              <ul>
                {details.map((detail) => <li key={detail}>{detail}</li>)}
              </ul>
            </div>
          </details>
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
