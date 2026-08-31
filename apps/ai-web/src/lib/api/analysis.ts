import {
  aiAnalysisCatalogResponseSchema,
  aiAnalysisHistoryResponseSchema,
  aiAnalysisRunResponseSchema,
  aiAnalysisViewerResponseSchema,
  type AiAnalysisCatalogResponse,
  type AiAnalysisHistoryResponse,
  type AiAnalysisRunResponse,
  type AiAnalysisViewerResponse,
} from "@stock-autotrader/contracts";
import { API_BASE_URL } from "../config/env";

const REQUEST_TIMEOUT_MS = 10_000;

type Schema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

export class AiAnalysisApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "AiAnalysisApiError";
    this.status = status;
    this.code = code;
  }
}

function apiPath(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function errorCode(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return fallback;
  const value = (body as { error?: unknown }).error;
  return typeof value === "string" && value.trim() ? value : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new AiAnalysisApiError("invalid_response", response.status);
  }
}

async function request<T>(path: string, schema: Schema<T>, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timeout = globalThis.setTimeout(abort, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiPath(path), {
      ...init,
      cache: path.endsWith("/catalog") ? "default" : "no-store",
      credentials: "include",
      headers: {
        accept: "application/json",
        ...init.headers,
      },
      signal: controller.signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw new AiAnalysisApiError(errorCode(body, `http_${response.status}`), response.status);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AiAnalysisApiError("invalid_response", response.status);
    return parsed.data;
  } catch (error) {
    if (error instanceof AiAnalysisApiError) throw error;
    if (externalSignal?.aborted) throw error;
    if (controller.signal.aborted) throw new AiAnalysisApiError("request_timeout");
    throw new AiAnalysisApiError("network_unavailable");
  } finally {
    externalSignal?.removeEventListener("abort", abort);
    globalThis.clearTimeout(timeout);
  }
}

export function getAiAnalysisCatalog(signal?: AbortSignal): Promise<AiAnalysisCatalogResponse> {
  return request("/api/ai-analysis/catalog", aiAnalysisCatalogResponseSchema, { signal });
}

export function getAiAnalysisViewer(signal?: AbortSignal): Promise<AiAnalysisViewerResponse> {
  return request("/api/ai-analysis/viewer", aiAnalysisViewerResponseSchema, { signal });
}

export function startAiAnalysis(symbol: string, idempotencyKey: string, signal?: AbortSignal): Promise<AiAnalysisRunResponse> {
  return request("/api/ai-analysis/runs", aiAnalysisRunResponseSchema, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ symbol }),
    signal,
  });
}

export function getAiAnalysisRun(runId: string, signal?: AbortSignal): Promise<AiAnalysisRunResponse> {
  return request(`/api/ai-analysis/runs/${encodeURIComponent(runId)}`, aiAnalysisRunResponseSchema, { signal });
}

export function getAiAnalysisHistory(cursor?: string | null, signal?: AbortSignal): Promise<AiAnalysisHistoryResponse> {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/ai-analysis/history?${params}`, aiAnalysisHistoryResponseSchema, { signal });
}
