import { CalendarDays, Clock3, Sparkles, Target } from "lucide-react";
import type { AiAnalysisResultV1 } from "@stock-autotrader/contracts";
import { SafeMarkdown } from "./SafeMarkdown";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "America/New_York",
});

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function recommendationTone(recommendation: AiAnalysisResultV1["recommendation"]): string {
  if (recommendation === "BUY" || recommendation === "OVERWEIGHT") return "positive";
  if (recommendation === "SELL" || recommendation === "UNDERWEIGHT") return "negative";
  return "neutral";
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : dateFormatter.format(date);
}

interface ReportSection {
  id: string;
  title: string;
  eyebrow: string;
  markdown: string | null | undefined;
}

export function AnalysisReport({ result, company }: { result: AiAnalysisResultV1; company: string }) {
  const sections: ReportSection[] = [
    { id: "market", title: "Market & technical research", eyebrow: "Market Analyst", markdown: result.reports.marketAndTechnical },
    { id: "sentiment", title: "Sentiment", eyebrow: "Sentiment Analyst", markdown: result.reports.sentiment },
    { id: "news", title: "News & macro context", eyebrow: "News Analyst", markdown: result.reports.news },
    { id: "fundamentals", title: "Fundamentals", eyebrow: "Fundamentals Analyst", markdown: result.reports.fundamentals },
    { id: "bull", title: "Bull case", eyebrow: "Bull Researcher", markdown: result.reports.bullCase },
    { id: "bear", title: "Bear case", eyebrow: "Bear Researcher", markdown: result.reports.bearCase },
    { id: "research", title: "Research decision", eyebrow: "Research Manager", markdown: result.reports.researchManager },
    { id: "trader", title: "Trade plan", eyebrow: "Trader", markdown: result.reports.traderPlan },
    { id: "risk-aggressive", title: "Aggressive risk view", eyebrow: "Risk review", markdown: result.reports.risk.aggressive },
    { id: "risk-neutral", title: "Neutral risk view", eyebrow: "Risk review", markdown: result.reports.risk.neutral },
    { id: "risk-conservative", title: "Conservative risk view", eyebrow: "Risk review", markdown: result.reports.risk.conservative },
    { id: "portfolio", title: "Portfolio manager conclusion", eyebrow: "Final synthesis", markdown: result.reports.portfolioManager },
  ].filter((section) => Boolean(section.markdown));

  return (
    <article className="ai-report" aria-labelledby="ai-report-title">
      <header className="ai-report-hero">
        <div className="ai-report-title-row">
          <div>
            <span className="ai-kicker">AI analysis report</span>
            <h1 id="ai-report-title">{company}</h1>
            <p>{result.symbol} · TradingAgents research</p>
          </div>
          <span className={`ai-recommendation is-${recommendationTone(result.recommendation)}`}>
            {result.recommendation}
          </span>
        </div>

        <dl className="ai-report-meta">
          <div>
            <dt><CalendarDays size={15} aria-hidden="true" /> Generated</dt>
            <dd>{formatGeneratedAt(result.generatedAt)}</dd>
          </div>
          {result.priceTarget !== null ? (
            <div>
              <dt><Target size={15} aria-hidden="true" /> Price target</dt>
              <dd>{moneyFormatter.format(result.priceTarget)}</dd>
            </div>
          ) : null}
          {result.timeHorizon ? (
            <div>
              <dt><Clock3 size={15} aria-hidden="true" /> Time horizon</dt>
              <dd>{result.timeHorizon}</dd>
            </div>
          ) : null}
          <div>
            <dt><Sparkles size={15} aria-hidden="true" /> Research engine</dt>
            <dd>{result.engine.name} {result.engine.version}</dd>
          </div>
        </dl>
      </header>

      {result.executiveSummary ? (
        <section className="ai-report-summary" aria-labelledby="ai-report-summary-title">
          <span className="ai-kicker">Executive summary</span>
          <h2 id="ai-report-summary-title">The decision in brief</h2>
          <SafeMarkdown>{result.executiveSummary}</SafeMarkdown>
        </section>
      ) : null}

      {result.investmentThesis ? (
        <section className="ai-report-section" aria-labelledby="ai-report-thesis-title">
          <span className="ai-kicker">Investment thesis</span>
          <h2 id="ai-report-thesis-title">Why the team reached this view</h2>
          <SafeMarkdown>{result.investmentThesis}</SafeMarkdown>
        </section>
      ) : null}

      <div className="ai-report-sections">
        {sections.map((section) => (
          <section className="ai-report-section" id={`ai-report-${section.id}`} key={section.id}>
            <span className="ai-kicker">{section.eyebrow}</span>
            <h2>{section.title}</h2>
            <SafeMarkdown>{section.markdown!}</SafeMarkdown>
          </section>
        ))}
      </div>

      <p className="ai-report-disclaimer">
        AI-generated research can be incomplete or wrong. It is not financial or investment advice.
      </p>
    </article>
  );
}

