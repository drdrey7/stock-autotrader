import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AiAnalysisRunResponse, AiAnalysisResultV1 } from "@stock-autotrader/contracts";
import { Shell } from "../components/layout/Shell";
import { SafeMarkdown } from "../components/report/SafeMarkdown";
import { AiAnalysisApiError, getAiAnalysisRun } from "../lib/api/analysis";

const POLL_MS = 3_000;
const RETRY_POLL_MS = 3_500;

function reportError(error: unknown): string {
  if (error instanceof AiAnalysisApiError) {
    if (error.status === 404) return "This analysis could not be found.";
    if (error.status === 403) return "You do not have access to this analysis.";
    if (error.status === 503) return "The analysis service is temporarily unavailable. This page will not fabricate a result.";
    return error.code.replaceAll("_", " ");
  }
  return "Could not load this analysis.";
}

function isTerminalPollError(error: unknown): boolean {
  return error instanceof AiAnalysisApiError
    && (error.status === 401 || error.status === 403 || error.status === 404);
}

function ReportBody({ children }: { children: string | null | undefined }) {
  const content = children?.trim();
  if (!content) {
    return <p className="muted">No content was returned for this section.</p>;
  }
  return <SafeMarkdown>{content}</SafeMarkdown>;
}

function RecommendationBadge({ value }: { value: AiAnalysisResultV1["recommendation"] }) {
  const tone = value.toLowerCase().includes("buy") || value === "OVERWEIGHT"
    ? "positive"
    : value === "SELL" || value === "UNDERWEIGHT"
      ? "negative"
      : "neutral";
  return <span className={`rec-badge rec-badge-${tone}`}>{value}</span>;
}

/** 06 — Bull vs Bear shown as two opposing panels side-by-side on desktop. */
function DebateSection({ bull, bear }: { bull: string | null; bear: string | null }) {
  return (
    <section className="report-block" aria-label="Bull vs Bear">
      <span className="report-marker">06</span>
      <div>
        <h2>Bull vs Bear</h2>
        <div className="debate-panels">
          <div className="debate-panel debate-panel-bull">
            <div className="debate-panel-label">Bull case</div>
            <ReportBody>{bull}</ReportBody>
          </div>
          <div className="debate-panel debate-panel-bear">
            <div className="debate-panel-label">Bear case</div>
            <ReportBody>{bear}</ReportBody>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 08 — Risk Council: three temperaments reviewing the same proposal. */
function RiskCouncil({
  aggressive,
  neutral,
  conservative,
}: {
  aggressive: string | null;
  neutral: string | null;
  conservative: string | null;
}) {
  return (
    <section className="report-block" aria-label="Risk Council">
      <span className="report-marker">08</span>
      <div>
        <h2>Risk Council</h2>
        <div className="risk-council">
          <div className="risk-panel">
            <div className="risk-panel-label">Aggressive</div>
            <ReportBody>{aggressive}</ReportBody>
          </div>
          <div className="risk-panel">
            <div className="risk-panel-label">Neutral</div>
            <ReportBody>{neutral}</ReportBody>
          </div>
          <div className="risk-panel">
            <div className="risk-panel-label">Conservative</div>
            <ReportBody>{conservative}</ReportBody>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Rich completed-report view. Pure presentation; safe to snapshot/test. */
export function CompletedReport({ run }: { run: Extract<AiAnalysisRunResponse, { status: "completed" }> }) {
  const result = run.result;
  const date = result.analysisDate
    ? new Date(`${result.analysisDate}T00:00:00Z`).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "";

  return (
    <main className="report-page page">
      {/* Header */}
      <header className="report-hero">
        <div className="report-hero-top">
          <div className="section-kicker">
            Analysis / Report / {run.symbol}
          </div>
          <span className="report-status">Completed</span>
        </div>
        <div className="report-hero-title">
          <h1>
            {run.symbol}
            <span className="report-company">{run.company}</span>
          </h1>
          <div className="report-hero-verdict">
            <RecommendationBadge value={result.recommendation} />
            <span className="report-date">{date}</span>
          </div>
        </div>
        <div className="report-meta-grid">
          {result.priceTarget !== null && (
            <div className="report-meta">
              <span>Price target</span>
              <b>{typeof result.priceTarget === "number" ? `$${result.priceTarget.toLocaleString()}` : result.priceTarget}</b>
            </div>
          )}
          {result.timeHorizon !== null && (
            <div className="report-meta">
              <span>Time horizon</span>
              <b>{result.timeHorizon}</b>
            </div>
          )}
          <div className="report-meta">
            <span>Engine</span>
            <b>{result.engine.name} · {result.engine.version}</b>
          </div>
          <div className="report-meta">
            <span>Recommendation</span>
            <b>{result.recommendation}</b>
          </div>
        </div>
        <p className="report-disclaimer">
          AI-generated research for informational purposes only. Not financial
          advice. Generated {result.generatedAt ? new Date(result.generatedAt).toLocaleString() : ""} by
          {` ${result.engine.provider} (${result.engine.deepModel})`}.
        </p>
      </header>

      {/* 01 — Executive Summary */}
      <section className="report-block" aria-label="Executive Summary">
        <span className="report-marker">01</span>
        <div>
          <h2>Executive Summary</h2>
          <ReportBody>{result.executiveSummary}</ReportBody>
        </div>
      </section>

      {/* 02 — Investment Thesis */}
      <section className="report-block" aria-label="Investment Thesis">
        <span className="report-marker">02</span>
        <div>
          <h2>Investment Thesis</h2>
          <ReportBody>{result.investmentThesis}</ReportBody>
        </div>
      </section>

      {/* 03 — Market & Technical */}
      <section className="report-block" aria-label="Market and Technical">
        <span className="report-marker">03</span>
        <div>
          <h2>Market &amp; Technical</h2>
          <ReportBody>{result.reports.marketAndTechnical}</ReportBody>
        </div>
      </section>

      {/* 04 — Fundamentals */}
      <section className="report-block" aria-label="Fundamentals">
        <span className="report-marker">04</span>
        <div>
          <h2>Fundamentals</h2>
          <ReportBody>{result.reports.fundamentals}</ReportBody>
        </div>
      </section>

      {/* 05 — News & Sentiment */}
      <section className="report-block" aria-label="News and Sentiment">
        <span className="report-marker">05</span>
        <div>
          <h2>News &amp; Sentiment</h2>
          <div className="news-sentiment">
            <div>
              <div className="sub-section-label">News</div>
              <ReportBody>{result.reports.news}</ReportBody>
            </div>
            <div>
              <div className="sub-section-label">Sentiment</div>
              <ReportBody>{result.reports.sentiment}</ReportBody>
            </div>
          </div>
        </div>
      </section>

      {/* 06 — Bull vs Bear */}
      <DebateSection bull={result.reports.bullCase} bear={result.reports.bearCase} />

      {/* 07 — Research Manager & Trader Plan */}
      <section className="report-block" aria-label="Research Manager and Trader Plan">
        <span className="report-marker">07</span>
        <div>
          <h2>Research Manager &amp; Trader</h2>
          <div className="research-trader">
            <div>
              <div className="sub-section-label">Research Manager</div>
              <ReportBody>{result.reports.researchManager}</ReportBody>
            </div>
            <div>
              <div className="sub-section-label">Trader Plan</div>
              <ReportBody>{result.reports.traderPlan}</ReportBody>
            </div>
          </div>
        </div>
      </section>

      {/* 08 — Risk Council */}
      <RiskCouncil
        aggressive={result.reports.risk.aggressive}
        neutral={result.reports.risk.neutral}
        conservative={result.reports.risk.conservative}
      />

      {/* 09 — Portfolio Manager */}
      <section className="report-block" aria-label="Portfolio Manager">
        <span className="report-marker">09</span>
        <div>
          <h2>Portfolio Manager</h2>
          <ReportBody>{result.reports.portfolioManager}</ReportBody>
        </div>
      </section>

      {/* 10 — Final View */}
      <section className="report-block report-final-view" aria-label="Final View">
        <span className="report-marker">10</span>
        <div>
          <h2>Final View</h2>
          <dl>
            <div><dt>Recommendation</dt><dd>{result.recommendation}</dd></div>
            {result.priceTarget !== null && <div><dt>Price Target</dt><dd>${typeof result.priceTarget === "number" ? result.priceTarget.toLocaleString() : result.priceTarget}</dd></div>}
            {result.timeHorizon !== null && <div><dt>Time Horizon</dt><dd>{result.timeHorizon}</dd></div>}
            <div><dt>Generated</dt><dd>{result.generatedAt ? new Date(result.generatedAt).toLocaleString() : ""}</dd></div>
          </dl>
        </div>
      </section>

      <Link className="text-link" to="/app">Back to workspace</Link>
    </main>
  );
}

export function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<AiAnalysisRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);

  useEffect(() => {
    if (!id) { setError("Missing analysis id."); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        const next = await getAiAnalysisRun(id, controller.signal);
        if (cancelled) return;
        setRun(next);
        setError(null);
        setConnectionInterrupted(false);
        if (next.status === "queued" || next.status === "running") timer = setTimeout(load, POLL_MS);
      } catch (nextError) {
        if (cancelled || controller.signal.aborted) return;
        if (nextError instanceof AiAnalysisApiError && nextError.status === 401) {
          navigate(`/auth?next=${encodeURIComponent(`/report/${id}`)}`, { replace: true });
          return;
        }
        if (isTerminalPollError(nextError)) {
          setError(reportError(nextError));
          setConnectionInterrupted(false);
          return;
        }
        // Keep the last known run visible and continue polling after transient
        // network/timeout/5xx failures so a paid analysis can still complete.
        setError(null);
        setConnectionInterrupted(true);
        timer = setTimeout(load, RETRY_POLL_MS);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, navigate]);

  if (error && !run) return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Error</div><h1>Report <em>unavailable.</em></h1><p className="report-disclaimer" role="alert">{error}</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;
  if (!run) return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Loading</div><h1>Loading <em>research.</em></h1><p className="report-disclaimer">{connectionInterrupted ? "Connection interrupted. Retrying…" : "Fetching the current analysis state…"}</p></main></Shell>;

  if (run.status === "queued" || run.status === "running") {
    const pct = Math.round((run.progressStep / Math.max(run.progressTotal, 1)) * 100);
    return <Shell><main className="report-page page"><div className="section-kicker">{run.symbol} / {run.company}</div><h1>Agents are <em>researching.</em></h1><p className="report-disclaimer">{run.status === "queued" ? "Queued for analysis" : run.progressStage ? `Current stage: ${run.progressStage.replaceAll("-", " ")}` : "Analysis in progress"} · {run.progressStep}/{run.progressTotal} · {pct}%</p><div className="settings-list"><div><span>Status</span><b>{run.status}</b></div><div><span>Credits remaining</span><b>{run.creditsRemaining}</b></div><div><span>Run ID</span><b>{run.runId.slice(0, 8)}…</b></div></div>{connectionInterrupted ? <p className="muted" role="status">Connection interrupted. Retrying…</p> : <p className="muted">This page updates automatically.</p>}</main></Shell>;
  }

  if (run.status === "failed") return <Shell><main className="report-page page"><div className="section-kicker">{run.symbol} / Analysis failed</div><h1>The run did not <em>complete.</em></h1><p className="report-disclaimer">{run.creditRefunded ? "The analysis credit was refunded." : "The run failed before a result was available."}</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;

  if (run.status !== "completed" || !run.result) {
    return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Invalid state</div><h1>Report <em>unavailable.</em></h1><p className="report-disclaimer">The backend returned an unexpected analysis state.</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;
  }

  return <Shell><CompletedReport run={run} /></Shell>;
}