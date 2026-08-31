import { useEffect, useState, type ReactNode } from "react";
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

/**
 * Collapsible report section. Long sections collapse so the report reads as a
 * scannable hierarchy; the reader expands only what they need. Executive
 * Summary and Final View pass `defaultOpen` so the verdict is always visible.
 */
function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="report-block report-section" open={defaultOpen}>
      <summary className="report-section-summary">
        <span className="report-marker">{id}</span>
        <span className="report-section-title">{title}</span>
        <span className="report-section-caret" aria-hidden="true" />
      </summary>
      <div className="report-section-body">{children}</div>
    </details>
  );
}

function RecommendationBadge({ value }: { value: AiAnalysisResultV1["recommendation"] }) {
  const tone = value.toLowerCase().includes("buy") || value === "OVERWEIGHT"
    ? "positive"
    : value === "SELL" || value === "UNDERWEIGHT"
      ? "negative"
      : "neutral";
  return <span className={`rec-badge rec-badge-${tone}`}>{value}</span>;
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

      {/* 01 — Executive Summary (open) */}
      <CollapsibleSection id="01" title="Executive Summary" defaultOpen>
        <ReportBody>{result.executiveSummary}</ReportBody>
      </CollapsibleSection>

      {/* 02 — Investment Thesis */}
      <CollapsibleSection id="02" title="Investment Thesis">
        <ReportBody>{result.investmentThesis}</ReportBody>
      </CollapsibleSection>

      {/* 03 — Market & Technical */}
      <CollapsibleSection id="03" title="Market &amp; Technical">
        <ReportBody>{result.reports.marketAndTechnical}</ReportBody>
      </CollapsibleSection>

      {/* 04 — Fundamentals */}
      <CollapsibleSection id="04" title="Fundamentals">
        <ReportBody>{result.reports.fundamentals}</ReportBody>
      </CollapsibleSection>

      {/* 05 — News & Sentiment */}
      <CollapsibleSection id="05" title="News &amp; Sentiment">
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
      </CollapsibleSection>

      {/* 06 — Bull vs Bear */}
      <CollapsibleSection id="06" title="Bull vs Bear">
        <div className="debate-panels">
          <div className="debate-panel debate-panel-bull">
            <div className="debate-panel-label">Bull case</div>
            <ReportBody>{result.reports.bullCase}</ReportBody>
          </div>
          <div className="debate-panel debate-panel-bear">
            <div className="debate-panel-label">Bear case</div>
            <ReportBody>{result.reports.bearCase}</ReportBody>
          </div>
        </div>
      </CollapsibleSection>

      {/* 07 — Research Manager & Trader Plan */}
      <CollapsibleSection id="07" title="Research Manager &amp; Trader">
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
      </CollapsibleSection>

      {/* 08 — Risk Council */}
      <CollapsibleSection id="08" title="Risk Council">
        <div className="risk-council">
          <div className="risk-panel">
            <div className="risk-panel-label">Aggressive</div>
            <ReportBody>{result.reports.risk.aggressive}</ReportBody>
          </div>
          <div className="risk-panel">
            <div className="risk-panel-label">Neutral</div>
            <ReportBody>{result.reports.risk.neutral}</ReportBody>
          </div>
          <div className="risk-panel">
            <div className="risk-panel-label">Conservative</div>
            <ReportBody>{result.reports.risk.conservative}</ReportBody>
          </div>
        </div>
      </CollapsibleSection>

      {/* 09 — Portfolio Manager */}
      <CollapsibleSection id="09" title="Portfolio Manager">
        <ReportBody>{result.reports.portfolioManager}</ReportBody>
      </CollapsibleSection>

      {/* 10 — Final View (open) */}
      <CollapsibleSection id="10" title="Final View" defaultOpen>
        <div className="report-final-view">
          <dl>
            <div><dt>Recommendation</dt><dd>{result.recommendation}</dd></div>
            {result.priceTarget !== null && <div><dt>Price Target</dt><dd>${typeof result.priceTarget === "number" ? result.priceTarget.toLocaleString() : result.priceTarget}</dd></div>}
            {result.timeHorizon !== null && <div><dt>Time Horizon</dt><dd>{result.timeHorizon}</dd></div>}
            <div><dt>Generated</dt><dd>{result.generatedAt ? new Date(result.generatedAt).toLocaleString() : ""}</dd></div>
          </dl>
        </div>
      </CollapsibleSection>

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