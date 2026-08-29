import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiAnalysisCatalogResponse,
  AiAnalysisRunResponse,
  AiAnalysisViewerResponse,
} from "@stock-autotrader/contracts";
import {
  AiAnalysisApiError,
  getAiAnalysisCatalog,
  getAiAnalysisRun,
  getAiAnalysisViewer,
} from "./api";

interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: AiAnalysisApiError | null;
  reload: () => void;
}

export function useAiAnalysisCatalog(): Loadable<AiAnalysisCatalogResponse> {
  const [data, setData] = useState<AiAnalysisCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AiAnalysisApiError | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  const reload = useCallback(() => setRequestVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getAiAnalysisCatalog(controller.signal)
      .then((next) => setData(next))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof AiAnalysisApiError ? reason : new AiAnalysisApiError("catalog_unavailable"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [requestVersion]);

  return { data, loading, error, reload };
}

export interface ViewerState extends Loadable<AiAnalysisViewerResponse> {
  setCreditsRemaining: (creditsRemaining: number) => void;
  markOwned: (symbol: string) => void;
}

export function useAiAnalysisViewer(enabled: boolean): ViewerState {
  const [data, setData] = useState<AiAnalysisViewerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AiAnalysisApiError | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  const reload = useCallback(() => setRequestVersion((value) => value + 1), []);
  const setCreditsRemaining = useCallback((creditsRemaining: number) => {
    setData((current) => current ? { ...current, creditsRemaining } : current);
  }, []);
  const markOwned = useCallback((symbol: string) => {
    setData((current) => {
      if (!current || current.ownedSymbols.includes(symbol)) return current;
      return { ...current, ownedSymbols: [...current.ownedSymbols, symbol] };
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getAiAnalysisViewer(controller.signal)
      .then(setData)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof AiAnalysisApiError ? reason : new AiAnalysisApiError("viewer_unavailable"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, requestVersion]);

  return { data, loading, error, reload, setCreditsRemaining, markOwned };
}

export interface RunPollingState {
  run: AiAnalysisRunResponse | null;
  loading: boolean;
  error: AiAnalysisApiError | null;
  connectionInterrupted: boolean;
  retry: () => void;
}

const ACTIVE_REFRESH_MS = 1_800;
const HIDDEN_REFRESH_MS = 15_000;
const RETRY_REFRESH_MS = 3_500;

export function useAiAnalysisRun(runId: string | undefined, enabled: boolean): RunPollingState {
  const [run, setRun] = useState<AiAnalysisRunResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(runId && enabled));
  const [error, setError] = useState<AiAnalysisApiError | null>(null);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const timerRef = useRef<number | undefined>(undefined);
  const activeControllerRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => setRequestVersion((value) => value + 1), []);

  useEffect(() => {
    setRun(null);
    setError(null);
    setConnectionInterrupted(false);
    setLoading(Boolean(runId && enabled));
  }, [runId, enabled]);

  useEffect(() => {
    if (!runId || !enabled) return;
    let disposed = false;
    let requestSequence = 0;

    const clearTimer = () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };

    const schedule = (delay: number, load: () => Promise<void>) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => void load(), delay);
    };

    const load = async (): Promise<void> => {
      const sequence = ++requestSequence;
      activeControllerRef.current?.abort();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      try {
        const next = await getAiAnalysisRun(runId, controller.signal);
        if (disposed || controller.signal.aborted || sequence !== requestSequence) return;
        setRun(next);
        setLoading(false);
        setError(null);
        setConnectionInterrupted(false);
        if (next.status === "queued" || next.status === "running") {
          schedule(document.visibilityState === "visible" ? ACTIVE_REFRESH_MS : HIDDEN_REFRESH_MS, load);
        }
      } catch (reason) {
        if (disposed || controller.signal.aborted || sequence !== requestSequence) return;
        const apiError = reason instanceof AiAnalysisApiError
          ? reason
          : new AiAnalysisApiError("analysis_unavailable");
        setLoading(false);
        if (apiError.status === 401 || apiError.status === 403 || apiError.status === 404) {
          setError(apiError);
          setConnectionInterrupted(false);
          return;
        }
        setConnectionInterrupted(true);
        schedule(RETRY_REFRESH_MS, load);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimer();
        void load();
      }
    };

    void load();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      requestSequence += 1;
      clearTimer();
      activeControllerRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, requestVersion, runId]);

  return { run, loading, error, connectionInterrupted, retry };
}
