import { useEffect, useState } from "react";
import { fetchJson, isWithinWindow } from "./api-client";

type StatusResponse = {
  sentiment?: {
    provider: string;
    score: number;
    rating: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
    asOf: string;
  } | null;
  sources?: {
    sentiment?: {
      state?: "Live" | "Cached" | "Stale" | "Error" | "Unavailable";
    } | null;
  } | null;
};

export type Sentiment = NonNullable<StatusResponse["sentiment"]>;

// Backend now computes market-aware sentiment freshness and exposes it via
// sources.sentiment.state (timezone/holiday aware). 72h remains only as a
// conservative fallback for a backend that does not expose sources yet.
const SENTIMENT_GATE_MS = 72 * 60 * 60_000;
const SENTIMENT_POLL_MS = 5 * 60_000;

function sentimentFromStatus(status: StatusResponse | null): Sentiment | null {
  const sentiment = status?.sentiment;
  if (!sentiment) return null;
  if (typeof sentiment.score !== "number" || sentiment.score < 0 || sentiment.score > 100) return null;
  const ratings = ["extreme_fear", "fear", "neutral", "greed", "extreme_greed"] as const;
  if (!ratings.includes(sentiment.rating)) return null;
  // Market-aware freshness: the Worker classifies the reading each poll.
  // Live = current, Cached = last-known-good still valid. Stale/Error/
  // Unavailable must not render a number as if it were current.
  const state = status?.sources?.sentiment?.state;
  if (state === "Stale" || state === "Error" || state === "Unavailable") return null;
  if (state === "Live" || state === "Cached") return sentiment;
  if (!isWithinWindow(sentiment.asOf, SENTIMENT_GATE_MS)) return null;
  return sentiment;
}

export function useSentiment(): Sentiment | null {
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    const refresh = async () => {
      const currentRequest = ++requestId;
      const status = await fetchJson<StatusResponse>("/api/status");
      if (cancelled || currentRequest !== requestId) return;
      const next = sentimentFromStatus(status);
      const explicitState = status?.sources?.sentiment?.state;
      setSentiment((previous) => {
        // An explicit backend classification always wins: a Stale/Error/
        // Unavailable reading must clear the card even if a previous value is
        // still within the conservative 72h fallback window (the session gate
        // is 2.5h). Retention only applies on the fallback path (backend
        // without sources.sentiment.state).
        if (explicitState) return next;
        const retained = previous && isWithinWindow(previous.asOf, SENTIMENT_GATE_MS) ? previous : null;
        return next ?? retained;
      });
    };

    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, SENTIMENT_POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return sentiment;
}
