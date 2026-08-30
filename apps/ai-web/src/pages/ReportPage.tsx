import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AiAnalysisRunResponse } from "@stock-autotrader/contracts";
import { Shell } from "../components/layout/Shell";
import { AiAnalysisApiError, getAiAnalysisRun } from "../lib/api/analysis";

const POLL_MS = 3_000;

function reportError(error: unknown): string {
  if (error instanceof AiAnalysisApiError) {
    if (error.status === 404) return "This analysis could not be found.";
    if (error.status === 503) return "The analysis service is temporarily unavailable. This page will not fabricate a result.";
    return error.code.replaceAll("_", " ");
  }
  return "Could not load this analysis.";
}

function ReportText({ children }: { children: string | null | undefined }) {
  return <p style={{ whiteSpace: "pre-wrap" }}>{children || "No content was returned for this section."}</p>;
}

export function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<AiAnalysisRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        if (next.status === "queued" || next.status === "running") timer = setTimeout(load, POLL_MS);
      } catch (nextError) {
        if (cancelled || controller.signal.aborted) return;
        if (nextError instanceof AiAnalysisApiError && nextError.status === 401) {
          navigate(`/auth?next=${encodeURIComponent(`/report/${id}`)}`, { replace: true });
          return;
        }
        setError(reportError(nextError));
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, navigate]);

  if (error) return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Error</div><h1>Report <em>unavailable.</em></h1><p className="report-disclaimer" role="alert">{error}</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;
  if (!run) return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Loading</div><h1>Loading <em>research.</em></h1><p className="report-disclaimer">Fetching the current analysis state…</p></main></Shell>;

  if (run.status === "queued" || run.status === "running") {
    const pct = Math.round((run.progressStep / Math.max(run.progressTotal, 1)) * 100);
    return <Shell><main className="report-page page"><div className="section-kicker">{run.symbol} / {run.company}</div><h1>Agents are <em>researching.</em></h1><p className="report-disclaimer">{run.status === "queued" ? "Queued for analysis" : run.progressStage ? `Current stage: ${run.progressStage.replaceAll("-", " ")}` : "Analysis in progress"} · {run.progressStep}/{run.progressTotal} · {pct}%</p><div className="settings-list"><div><span>Status</span><b>{run.status}</b></div><div><span>Credits remaining</span><b>{run.creditsRemaining}</b></div><div><span>Run ID</span><b>{run.runId.slice(0, 8)}…</b></div></div><p className="muted">This page updates automatically.</p></main></Shell>;
  }

  if (run.status === "failed") return <Shell><main className="report-page page"><div className="section-kicker">{run.symbol} / Analysis failed</div><h1>The run did not <em>complete.</em></h1><p className="report-disclaimer">{run.creditRefunded ? "The analysis credit was refunded." : "The run failed before a result was available."}</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;

  if (run.status !== "completed" || !run.result) {
    return <Shell><main className="report-page page"><div className="section-kicker">Analysis / Invalid state</div><h1>Report <em>unavailable.</em></h1><p className="report-disclaimer">The backend returned an unexpected analysis state.</p><Link className="text-link" to="/app">Back to workspace</Link></main></Shell>;
  }

  const result = run.result;
  const sections = [
    ["Executive Summary", result.executiveSummary],
    ["Investment Thesis", result.investmentThesis],
    ["Bull Case", result.reports.bullCase],
    ["Bear Case", result.reports.bearCase],
    ["Fundamentals", result.reports.fundamentals],
    ["Market & Technical", result.reports.marketAndTechnical],
    ["News", result.reports.news],
    ["Sentiment", result.reports.sentiment],
    ["Research Manager", result.reports.researchManager],
    ["Trader Plan", result.reports.traderPlan],
    ["Risk · Aggressive", result.reports.risk.aggressive],
    ["Risk · Neutral", result.reports.risk.neutral],
    ["Risk · Conservative", result.reports.risk.conservative],
    ["Portfolio Manager", result.reports.portfolioManager],
  ] as const;

  return <Shell><main className="report-page page">
    <div className="section-kicker">{run.symbol} / {run.company} / {result.analysisDate}</div>
    <h1>{result.recommendation}<br/><em>{result.priceTarget ? `Target ${result.priceTarget}` : "Structured research"}</em></h1>
    <p className="report-disclaimer">AI-generated research for informational purposes only. Not financial advice.{result.timeHorizon ? ` Time horizon: ${result.timeHorizon}` : ""}</p>
    {sections.map(([title, content], index) => <section className="report-block" key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{title}</h2><ReportText>{content}</ReportText></div></section>)}
    <section className="report-block report-final-view">
      <span>{String(sections.length + 1).padStart(2, "0")}</span>
      <div>
        <h2>Final View</h2>
        <dl>
          <div><dt>Recommendation</dt><dd>{result.recommendation}</dd></div>
          {result.priceTarget !== null && <div><dt>Price Target</dt><dd>{result.priceTarget}</dd></div>}
          {result.timeHorizon !== null && <div><dt>Time Horizon</dt><dd>{result.timeHorizon}</dd></div>}
        </dl>
      </div>
    </section>
    <Link className="text-link" to="/app">Back to workspace</Link>
  </main></Shell>;
}
