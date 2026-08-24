import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Coins, FileText, RefreshCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  AiAnalysisHistoryItem,
  AiAnalysisRecommendation,
  AiAnalysisViewerResponse,
} from "@stock-autotrader/contracts";
import { getAiAnalysisHistory, getAiAnalysisViewer } from "../ai-analysis/api";

const historyDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "America/New_York",
  timeZoneName: "short",
  year: "numeric",
});

function recommendationTone(recommendation: AiAnalysisRecommendation): string {
  if (recommendation === "BUY" || recommendation === "OVERWEIGHT") return "positive";
  if (recommendation === "SELL" || recommendation === "UNDERWEIGHT") return "negative";
  return "neutral";
}

function formatCompletedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : historyDateFormatter.format(date);
}

interface HistoryState {
  items: AiAnalysisHistoryItem[];
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
}

const initialHistoryState: HistoryState = {
  items: [],
  nextCursor: null,
  loading: true,
  error: false,
};

/** Account-owned credits and immutable links to each completed analysis run. */
export function AiAnalysisAccount() {
  const [viewer, setViewer] = useState<AiAnalysisViewerResponse | null>(null);
  const [viewerLoading, setViewerLoading] = useState(true);
  const [viewerError, setViewerError] = useState(false);
  const [history, setHistory] = useState<HistoryState>(initialHistoryState);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const moreControllerRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(() => setRequestVersion((version) => version + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setViewerLoading(true);
    setViewerError(false);
    setHistory(initialHistoryState);

    void getAiAnalysisViewer(controller.signal)
      .then(setViewer)
      .catch(() => {
        if (!controller.signal.aborted) setViewerError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setViewerLoading(false);
      });

    void getAiAnalysisHistory(null, controller.signal)
      .then((response) => {
        setHistory({
          items: response.items,
          nextCursor: response.nextCursor,
          loading: false,
          error: false,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory((current) => ({ ...current, loading: false, error: true }));
        }
      });

    return () => controller.abort();
  }, [requestVersion]);

  useEffect(() => () => moreControllerRef.current?.abort(), []);

  const loadMore = async () => {
    if (!history.nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const controller = new AbortController();
    moreControllerRef.current?.abort();
    moreControllerRef.current = controller;
    try {
      const response = await getAiAnalysisHistory(history.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      // Do not collapse by symbol: every run is an exact, independently useful report.
      setHistory((current) => ({
        items: [...current.items, ...response.items],
        nextCursor: response.nextCursor,
        loading: false,
        error: false,
      }));
    } catch {
      if (!controller.signal.aborted) {
        setHistory((current) => ({ ...current, error: true }));
      }
    } finally {
      loadingMoreRef.current = false;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const credits = viewer?.creditsRemaining;
  const initialLoadFailed = !history.loading && history.error && history.items.length === 0;

  return (
    <section className="investor-ai" aria-labelledby="investor-ai-title">
      <div className="investor-ai-heading">
        <div>
          <p className="investor-hub-kicker">AI research</p>
          <h2 id="investor-ai-title">Analysis credits & reports</h2>
          <p>Open any completed report again without using another credit.</p>
        </div>
        <Link className="investor-hub-primary-link" to="/ai-analysis">
          New analysis <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>

      <div className="investor-ai-credit-card" aria-live="polite">
        <span className="investor-ai-credit-icon" aria-hidden="true"><Coins size={19} /></span>
        <div>
          <span>Available credits</span>
          {viewerLoading && !viewer ? <strong>Checking…</strong> : null}
          {!viewerLoading && viewer ? <strong>{viewer.creditsRemaining}</strong> : null}
          {!viewerLoading && !viewer ? <strong>Unavailable</strong> : null}
        </div>
        {credits === 0 ? <p>You have no analysis credits available.</p> : null}
        {viewerError ? (
          <button className="investor-hub-text-button" type="button" onClick={reload}>
            <RefreshCcw size={13} aria-hidden="true" /> Retry
          </button>
        ) : null}
      </div>

      <div className="investor-ai-history-heading">
        <h3>Analysis history</h3>
        {history.items.length ? <span>{history.items.length} {history.items.length === 1 ? "report" : "reports"}</span> : null}
      </div>

      {history.loading ? (
        <div className="investor-ai-history-state" role="status">Loading your reports…</div>
      ) : initialLoadFailed ? (
        <div className="investor-ai-history-state" role="alert">
          <p>We couldn’t load your reports.</p>
          <button className="investor-hub-secondary-button" type="button" onClick={reload}>Try again</button>
        </div>
      ) : history.items.length === 0 ? (
        <div className="investor-ai-history-state investor-ai-empty">
          <FileText size={24} aria-hidden="true" />
          <div>
            <h3>No completed reports yet</h3>
            <p>Your AI Analysis reports will appear here.</p>
          </div>
        </div>
      ) : (
        <>
          <ol className="investor-ai-history-list">
            {history.items.map((item) => (
              <li key={item.runId}>
                <Link to={`/ai-analysis/runs/${encodeURIComponent(item.runId)}`} aria-label={`Open ${item.symbol} ${item.recommendation} report from ${formatCompletedAt(item.completedAt)}`}>
                  <span className="investor-ai-history-symbol">
                    <strong>{item.symbol}</strong>
                    <span>{item.company}</span>
                  </span>
                  <time dateTime={item.completedAt}>{formatCompletedAt(item.completedAt)}</time>
                  <span className={`investor-ai-recommendation is-${recommendationTone(item.recommendation)}`}>
                    {item.recommendation}
                  </span>
                  <ArrowRight className="investor-ai-history-arrow" size={16} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
          {history.error ? <p className="investor-hub-error" role="alert">More reports couldn’t be loaded. Try again.</p> : null}
          {history.nextCursor ? (
            <button
              className="investor-hub-secondary-button investor-ai-load-more"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more reports"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
