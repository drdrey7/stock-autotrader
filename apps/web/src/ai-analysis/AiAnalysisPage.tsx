import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Coins, RotateCcw, Sparkles } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { AiAnalysisApiError, startAiAnalysis } from "./api";
import { AnalysisJourney } from "./AnalysisJourney";
import { AnalysisReport } from "./AnalysisReport";
import { useAiAnalysisCatalog, useAiAnalysisRun, useAiAnalysisViewer } from "./hooks";
import { clearPendingAnalysisKey, pendingAnalysisKey } from "./idempotency";
import { StockSelector, type AiAnalysisStock } from "./StockSelector";
import "./ai-analysis.css";

function creditsLabel(credits: number): string {
  return `${credits} analysis ${credits === 1 ? "credit" : "credits"}`;
}

function loginState(returnTo: string): { returnTo: string } {
  return { returnTo };
}

function replayContext(state: unknown): { requested: boolean; symbol: string | null } {
  const requested = typeof state === "object" && state !== null
    && "replayJourney" in state
    && (state as { replayJourney?: unknown }).replayJourney === true;
  if (!requested || !("symbol" in (state as object))) return { requested, symbol: null };
  const symbol = (state as { symbol?: unknown }).symbol;
  return {
    requested,
    symbol: typeof symbol === "string" && /^[A-Z][A-Z0-9-]{0,11}$/.test(symbol) ? symbol : null,
  };
}

function startErrorMessage(error: AiAnalysisApiError): string {
  if (error.status === 401 || error.status === 403) return "Log in again to run this analysis.";
  if (error.status === 402 || /credit/i.test(error.code)) return "You do not have an analysis credit available.";
  if (error.status === 400 || /symbol/i.test(error.code)) return "Choose a valid Core Universe stock.";
  if (error.status === 409) return "This analysis is already being prepared. Please try again shortly.";
  return "We couldn’t start the analysis. Please try again.";
}

function CreditPill({ credits }: { credits: number | null }) {
  return (
    <span className="ai-credit-pill" aria-label={credits === null ? "Analysis credits unavailable" : creditsLabel(credits)}>
      <Coins size={16} aria-hidden="true" />
      {credits === null ? "Credits unavailable" : creditsLabel(credits)}
    </span>
  );
}

function RunPage({
  runId,
  authenticated,
  sessionPending,
  viewer,
}: {
  runId: string;
  authenticated: boolean;
  sessionPending: boolean;
  viewer: ReturnType<typeof useAiAnalysisViewer>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const replay = useMemo(() => replayContext(location.state), [location.state]);
  const [journeyStarted, setJourneyStarted] = useState(replay.requested);
  const [journeyComplete, setJourneyComplete] = useState(false);
  const { markOwned, setCreditsRemaining } = viewer;
  const { run, loading, error, connectionInterrupted, retry } = useAiAnalysisRun(
    runId,
    authenticated && !sessionPending,
  );

  useEffect(() => {
    setJourneyStarted(replay.requested);
    setJourneyComplete(false);
  }, [replay.requested, runId]);

  useEffect(() => {
    if (run?.status === "queued" || run?.status === "running") setJourneyStarted(true);
    if (run) setCreditsRemaining(run.creditsRemaining);
    if (run?.status === "completed") markOwned(run.symbol);
  }, [markOwned, run, setCreditsRemaining]);

  const finishJourney = useCallback(() => {
    setJourneyComplete(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate]);

  if (sessionPending) {
    return <div className="ai-status-card" role="status">Checking your account…</div>;
  }

  if (!authenticated) {
    return (
      <div className="ai-status-card ai-auth-required">
        <Sparkles size={26} aria-hidden="true" />
        <div>
          <h1>Log in to open this analysis</h1>
          <p>Your reports are private to your Investor Hub account.</p>
        </div>
        <Link className="ai-primary-action" to="/account" state={loginState(location.pathname)}>
          Log in
        </Link>
      </div>
    );
  }

  if (loading && !run) {
    if (replay.requested && replay.symbol) {
      return <AnalysisJourney status="queued" symbol={replay.symbol} onComplete={finishJourney} />;
    }
    return <div className="ai-status-card" role="status" aria-live="polite">Opening your analysis…</div>;
  }

  if (error && !run) {
    const notFound = error.status === 404;
    return (
      <div className="ai-status-card" role="alert">
        <h1>{notFound ? "Analysis not found" : "Analysis unavailable"}</h1>
        <p>{notFound ? "This report is unavailable or does not belong to this account." : "We couldn’t open this analysis right now."}</p>
        {!notFound ? <button className="ai-secondary-action" type="button" onClick={retry}>Try again</button> : null}
      </div>
    );
  }

  if (!run) return null;

  if (run.status === "failed") {
    return (
      <div className="ai-status-card ai-analysis-failed" role="alert">
        <h1>Analysis could not be completed</h1>
        <p>No report was created.{run.creditRefunded ? " Your analysis credit has been restored." : ""}</p>
        <Link className="ai-primary-action" to={`/ai-analysis?symbol=${encodeURIComponent(run.symbol)}`}>
          Try a new analysis
        </Link>
      </div>
    );
  }

  const showJourney = run.status === "queued"
    || run.status === "running"
    || (run.status === "completed" && journeyStarted && !journeyComplete);

  if (showJourney) {
    return (
      <>
        {connectionInterrupted ? (
          <p className="ai-connection-note" role="status">Connection interrupted. We’ll keep trying.</p>
        ) : null}
        <AnalysisJourney key={run.runId} status={run.status} symbol={run.symbol} onComplete={finishJourney} />
      </>
    );
  }

  return run.status === "completed" ? <AnalysisReport result={run.result} company={run.company} /> : null;
}

function SelectionPage({
  authenticated,
  sessionPending,
  viewer,
}: {
  authenticated: boolean;
  sessionPending: boolean;
  viewer: ReturnType<typeof useAiAnalysisViewer>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const catalog = useAiAnalysisCatalog();
  const [selected, setSelected] = useState<AiAnalysisStock | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const startControllerRef = useRef<AbortController | null>(null);
  const querySymbol = useMemo(
    () => new URLSearchParams(location.search).get("symbol")?.trim().toUpperCase() ?? null,
    [location.search],
  );

  useEffect(() => {
    if (!catalog.data || !querySymbol) return;
    const stock = catalog.data.stocks.find((candidate) => candidate.symbol === querySymbol) ?? null;
    setSelected(stock);
  }, [catalog.data, querySymbol]);

  useEffect(() => () => startControllerRef.current?.abort(), []);

  const ownedSymbols = useMemo(
    () => new Set(viewer.data?.ownedSymbols ?? []),
    [viewer.data?.ownedSymbols],
  );

  const selectStock = useCallback((stock: AiAnalysisStock | null) => {
    setSelected(stock);
    setStartError(null);
    navigate(
      stock ? `/ai-analysis?symbol=${encodeURIComponent(stock.symbol)}` : "/ai-analysis",
      { replace: true },
    );
  }, [navigate]);

  const start = async () => {
    if (!selected || !authenticated || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    const key = pendingAnalysisKey(selected.symbol);
    const controller = new AbortController();
    startControllerRef.current = controller;
    try {
      const run = await startAiAnalysis(selected.symbol, key, controller.signal);
      clearPendingAnalysisKey(key);
      viewer.setCreditsRemaining(run.creditsRemaining);
      navigate(`/ai-analysis/runs/${encodeURIComponent(run.runId)}`, {
        state: { replayJourney: true, symbol: selected.symbol },
      });
    } catch (reason) {
      if (controller.signal.aborted) return;
      const apiError = reason instanceof AiAnalysisApiError
        ? reason
        : new AiAnalysisApiError("analysis_unavailable");
      if (apiError.status !== null) clearPendingAnalysisKey(key);
      setStartError(startErrorMessage(apiError));
    } finally {
      startingRef.current = false;
      if (!controller.signal.aborted) setStarting(false);
    }
  };

  const credits = viewer.data?.creditsRemaining ?? null;
  const hasCredit = credits !== null && credits > 0;
  const alreadyOwned = selected ? ownedSymbols.has(selected.symbol) : false;
  const returnTo = selected ? `/ai-analysis?symbol=${encodeURIComponent(selected.symbol)}` : "/ai-analysis";

  return (
    <>
      <header className="ai-page-heading">
        <div>
          <span className="ai-kicker">TradingAgents research</span>
          <h1>AI Analysis</h1>
          <p>Select one of the 50 Core Universe stocks and follow a multi-agent research team to its final report.</p>
        </div>
        {authenticated ? <CreditPill credits={credits} /> : null}
      </header>

      <section className="ai-selection-card" aria-labelledby="ai-selection-title">
        <div className="ai-selection-copy">
          <span className="ai-selection-step" aria-hidden="true">1</span>
          <div>
            <h2 id="ai-selection-title">Choose a stock</h2>
            <p>Browse the existing Core Universe by ticker or company name.</p>
          </div>
        </div>

        {catalog.loading && !catalog.data ? <div className="ai-inline-status" role="status">Loading Core Universe stocks…</div> : null}
        {catalog.error && !catalog.data ? (
          <div className="ai-inline-error" role="alert">
            <p>We couldn’t load the stock list.</p>
            <button className="ai-secondary-action" type="button" onClick={catalog.reload}>Try again</button>
          </div>
        ) : null}
        {catalog.data ? (
          <StockSelector
            stocks={catalog.data.stocks}
            selected={selected}
            ownedSymbols={ownedSymbols}
            onSelect={selectStock}
          />
        ) : null}

        {selected ? (
          <div className="ai-run-panel">
            <div>
              <span className="ai-selection-step" aria-hidden="true">2</span>
              <div>
                <strong>{alreadyOwned ? `Run a fresh ${selected.symbol} analysis` : `Analyze ${selected.symbol}`}</strong>
                <p>{alreadyOwned ? "You already have a report for this stock. A fresh analysis costs 1 credit." : "Running an analysis costs 1 credit."}</p>
              </div>
            </div>

            {sessionPending ? (
              <button className="ai-primary-action" type="button" disabled>Checking your account…</button>
            ) : !authenticated ? (
              <Link className="ai-primary-action" to="/account" state={loginState(returnTo)}>
                Log in to run analysis
              </Link>
            ) : viewer.loading && !viewer.data ? (
              <button className="ai-primary-action" type="button" disabled>Checking your credit…</button>
            ) : viewer.error && !viewer.data ? (
              <button className="ai-secondary-action" type="button" onClick={viewer.reload}>Reload credits</button>
            ) : (
              <button
                className="ai-primary-action"
                type="button"
                disabled={!hasCredit || starting}
                onClick={() => void start()}
              >
                {starting
                  ? "Starting analysis…"
                  : hasCredit
                    ? `${alreadyOwned ? "Run fresh analysis" : "Run Analysis"} · 1 credit`
                    : "No credits available"}
              </button>
            )}
          </div>
        ) : null}

        {startError ? <p className="ai-start-error" role="alert">{startError}</p> : null}
      </section>

      <section className="ai-how-it-works" aria-labelledby="ai-how-title">
        <span className="ai-kicker">What happens next</span>
        <h2 id="ai-how-title">One research path, several competing views</h2>
        <p>Specialist analysts review market, sentiment, news and fundamentals before researchers debate the case and a portfolio manager reaches the final conclusion.</p>
      </section>
    </>
  );
}

export default function AiAnalysisPage() {
  const { runId } = useParams<{ runId: string }>();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const authenticated = Boolean(session?.user);
  const viewer = useAiAnalysisViewer(authenticated && !sessionPending);

  return (
    <section className="ai-analysis-page">
      <div className="ai-analysis-shell">
        {runId ? (
          <>
            <div className="ai-run-toolbar">
              <Link to="/ai-analysis"><ArrowLeft size={16} aria-hidden="true" /> New analysis</Link>
              {authenticated ? <CreditPill credits={viewer.data?.creditsRemaining ?? null} /> : null}
            </div>
            <RunPage
              runId={runId}
              authenticated={authenticated}
              sessionPending={sessionPending}
              viewer={viewer}
            />
          </>
        ) : (
          <SelectionPage authenticated={authenticated} sessionPending={sessionPending} viewer={viewer} />
        )}

        <footer className="ai-page-footer">
          <RotateCcw size={14} aria-hidden="true" /> Historical reports remain available in your Investor Hub without using another credit.
        </footer>
      </div>
    </section>
  );
}
