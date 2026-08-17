import { useEffect, useState } from "react";
import { fetchJson, isWithinWindow } from "./api-client";

type StatusResponse = {
  sentiment?: {
    provider: string;
    score: number;
    rating: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
    asOf: string;
  } | null;
};

export type Sentiment = NonNullable<StatusResponse["sentiment"]>;

const SENTIMENT_GATE_MS = 72 * 60 * 60_000;

function sentimentFromStatus(status: StatusResponse | null): Sentiment | null {
  const sentiment = status?.sentiment;
  if (!sentiment) return null;
  if (typeof sentiment.score !== "number" || sentiment.score < 0 || sentiment.score > 100) return null;
  const ratings = ["extreme_fear", "fear", "neutral", "greed", "extreme_greed"] as const;
  if (!ratings.includes(sentiment.rating)) return null;
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
      setSentiment((previous) => {
        const retained = previous && isWithinWindow(previous.asOf, SENTIMENT_GATE_MS) ? previous : null;
        return next ?? retained;
      });
    };

    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
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
