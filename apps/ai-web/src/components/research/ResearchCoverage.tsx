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

const researchLayers = [
  {
    icon: BarChart3,
    title: "Market & technical research",
    summary: "Price history, market structure and technical context.",
    details: [
      "Historical price and volume data",
      "Technical indicators and market structure",
      "Broader market and industry context",
    ],
  },
  {
    icon: Landmark,
    title: "Fundamentals & financial statements",
    summary: "Company fundamentals across reported annual and quarterly data.",
    details: [
      "Income statement analysis",
      "Balance sheet analysis",
      "Cash-flow statement analysis",
      "Earnings quality, margins and capital structure",
    ],
  },
  {
    icon: Newspaper,
    title: "News & current developments",
    summary: "Recent company, industry and macro developments relevant to the thesis.",
    details: [
      "Recent company news",
      "Industry and market-moving developments",
      "Macro-economic context",
      "Insider activity when available to the research tools",
    ],
  },
  {
    icon: MessageCircle,
    title: "Investor sentiment",
    summary: "Public investor discussion and narrative signals where available.",
    details: [
      "Reddit investor discussions",
      "StockTwits sentiment",
      "Yahoo Finance news and market narrative",
      "Positioning and investor reaction signals",
    ],
  },
  {
    icon: Scale,
    title: "Bull vs Bear research",
    summary: "The same evidence is challenged from opposing investment viewpoints.",
    details: [
      "Bull researcher builds the strongest upside case",
      "Bear researcher stress-tests assumptions and downside",
      "Research Manager evaluates the disagreement",
      "Trader stage converts the research into an actionable plan",
    ],
  },
  {
    icon: ShieldCheck,
    title: "Three-way risk review",
    summary: "The proposed view is reviewed from aggressive, neutral and conservative risk perspectives.",
    details: [
      "Aggressive risk analysis",
      "Neutral risk analysis",
      "Conservative risk analysis",
      "Portfolio Manager synthesises the final view",
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
          <em>A full research process.</em>
        </h2>
        <p>
          One analysis credit activates the complete research workflow — not a
          single AI answer. The system gathers evidence from multiple data
          categories, challenges the thesis and assembles one structured report.
        </p>
      </div>

      <div className="research-value-strip" aria-label="One credit research workflow">
        <div>
          <span>01</span>
          <b>Research</b>
          <small>Market · financials · news · sentiment</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>02</span>
          <b>Challenge</b>
          <small>Bull · Bear · Research Manager</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>03</span>
          <b>Review</b>
          <small>3 risk perspectives · Portfolio Manager</small>
        </div>
        <i aria-hidden="true" />
        <div>
          <span>04</span>
          <b>Report</b>
          <small>One structured research brief</small>
        </div>
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
