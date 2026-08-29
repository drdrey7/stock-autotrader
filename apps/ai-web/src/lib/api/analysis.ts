import { api } from "./client";
export type AnalysisRequest = { symbol: string };
export type AnalysisSummary = { id: string; symbol: string; status: "queued" | "running" | "complete" | "failed"; createdAt: string };
export const analysisApi = { create: (input: AnalysisRequest) => api<AnalysisSummary>("/api/ai-analysis", { method: "POST", body: JSON.stringify(input) }), get: (id: string) => api<AnalysisSummary>(`/api/ai-analysis/${encodeURIComponent(id)}`), list: () => api<AnalysisSummary[]>("/api/ai-analysis") };
