import { ArrowUpRight, Search } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AiAnalysisCatalogResponse, AiAnalysisHistoryResponse, AiAnalysisViewerResponse } from "@stock-autotrader/contracts";
import { Shell } from "../components/layout/Shell";
import { clearPendingAnalysisKey, pendingAnalysisKey } from "../lib/analysis/idempotency";
import {
  AiAnalysisApiError,
  getAiAnalysisCatalog,
  getAiAnalysisHistory,
  getAiAnalysisViewer,
  startAiAnalysis,
} from "../lib/api/analysis";

function messageFor(error: unknown): string {
  if (error instanceof AiAnalysisApiError) {
    if (error.status === 401) return "Sign in to run an analysis.";
    if (error.status === 402 || error.code === "insufficient_ai_credits") return "You do not have enough analysis credits.";
    if (error.code === "invalid_symbol") return "Choose a company from the supported stock universe.";
    if (error.status === 503) return "Analysis is temporarily unavailable. No credit has been charged unless a run was created.";
    return error.code.replaceAll("_", " ");
  }
  return "Could not reach the analysis service.";
}

export function AppPage() {
  const [catalog, setCatalog] = useState<AiAnalysisCatalogResponse | null>(null);
  const [viewer, setViewer] = useState<AiAnalysisViewerResponse | null>(null);
  const [history, setHistory] = useState<AiAnalysisHistoryResponse | null>(null);
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getAiAnalysisCatalog(controller.signal),
      getAiAnalysisViewer(controller.signal),
      getAiAnalysisHistory(null, controller.signal),
    ]).then(([nextCatalog, nextViewer, nextHistory]) => {
      setCatalog(nextCatalog);
      setViewer(nextViewer);
      setHistory(nextHistory);
      setMessage(null);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (error instanceof AiAnalysisApiError && error.status === 401) {
        navigate("/auth?next=/app", { replace: true });
        return;
      }
      setMessage(messageFor(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [navigate]);

  const symbols = useMemo(() => new Set(catalog?.stocks.map((stock) => stock.symbol) ?? []), [catalog]);
  const normalizedSymbol = symbol.trim().toUpperCase();
  const canSubmit = !submitting && !!catalog && symbols.has(normalizedSymbol) && (viewer?.creditsRemaining ?? 0) > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) {
      setMessage((viewer?.creditsRemaining ?? 0) < 1 ? "You do not have enough analysis credits." : "Choose a supported ticker.");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    const key = pendingAnalysisKey(normalizedSymbol);
    try {
      const run = await startAiAnalysis(normalizedSymbol, key);
      clearPendingAnalysisKey(key);
      setViewer((current) => current ? { ...current, creditsRemaining: run.creditsRemaining } : current);
      navigate(`/report/${run.runId}`);
    } catch (error) {
      if (error instanceof AiAnalysisApiError && error.status === 401) {
        clearPendingAnalysisKey(key);
        navigate("/auth?next=/app");
        return;
      }
      // Clear the pending key only for definitive 4xx client errors (except 409).
      // Keep it for network/timeout (null status), 5xx, 409, and unexpected 2xx
      // parse failures so a retry reuses the same idempotency key instead of
      // minting a second, credit-consuming acquisition.
      if (
        error instanceof AiAnalysisApiError
        && error.status !== null
        && error.status >= 400
        && error.status < 500
        && error.status !== 409
      ) {
        clearPendingAnalysisKey(key);
      }
      setMessage(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  };

  return <Shell><main className="workspace page">
    <div className="section-kicker">Workspace / Overview</div>
    <div className="workspace-head"><div><h1>Research, <em>focused.</em></h1><p>Choose a company and start a multi-agent analysis.</p></div><span className="credit-chip">Credits / {loading ? "—" : viewer?.creditsRemaining ?? "—"}</span></div>

    <section className="workspace-card">
      <label htmlFor="workspace-symbol">Start an analysis</label>
      <form className="workspace-form" onSubmit={submit}>
        <div className="ticker-input"><Search size={18}/><input id="workspace-symbol" list="supported-stocks" autoCapitalize="characters" autoComplete="off" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="Enter ticker symbol…"/><span>US</span></div>
        <datalist id="supported-stocks">{catalog?.stocks.map((stock) => <option key={stock.symbol} value={stock.symbol}>{stock.company}</option>)}</datalist>
        <button className="primary-button" type="submit" disabled={!canSubmit}>{submitting ? "Starting…" : "Run Analysis"} <ArrowUpRight size={17}/></button>
      </form>
      {message && <p className="muted" role="alert">{message}</p>}
    </section>

    {history?.items.length ? <section className="settings-list" aria-label="Recent reports">
      {history.items.map((item) => <Link key={item.runId} to={`/report/${item.runId}`}><span>{item.symbol} · {item.company}</span><b>{item.status}{item.recommendation ? ` · ${item.recommendation}` : ""}</b></Link>)}
    </section> : <section className="empty-report"><div className="empty-orb"/><h2>{loading ? "Loading reports…" : "No reports yet."}</h2><p>Your completed research will appear here.</p></section>}

    <Link className="text-link" to="/account">Manage your account <ArrowUpRight size={15}/></Link>
  </main></Shell>;
}
