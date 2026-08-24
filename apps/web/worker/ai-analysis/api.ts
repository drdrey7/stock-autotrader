import {
  aiAnalysisCatalogResponseSchema,
  aiAnalysisHistoryResponseSchema,
  aiAnalysisResultV1Schema,
  aiAnalysisRunResponseSchema,
  aiAnalysisViewerResponseSchema,
  isCoreUniverseSymbol,
  type AiAnalysisHistoryResponse,
  type AiAnalysisResultV1,
  type AiAnalysisRunResponse,
} from "@stock-autotrader/contracts";
import type { Env } from "../index";
import {
  acquireAnalysis,
  AiAnalysisCatalogUnavailableError,
  AiAnalysisDispatchUnavailableError,
  AiAnalysisIdempotencyConflictError,
  dispatchAnalysis,
  InsufficientAiCreditsError,
  readActiveCoreCompany,
  readCatalog,
  readHistoryPage,
  readRunForUser,
  readViewerState,
  type HistoryCursor,
  type StoredRunView,
} from "./storage";
import {
  readAuthenticatedAiUser,
  type AuthenticatedAiUser,
} from "./session";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RUN_REQUEST_BYTES = 4_096;

class InvalidStoredAiAnalysisResultError extends Error {
  constructor() {
    super("invalid_stored_ai_analysis_result");
    this.name = "InvalidStoredAiAnalysisResultError";
  }
}

class InvalidHistoryCursorError extends Error {
  constructor() {
    super("invalid_ai_analysis_history_cursor");
    this.name = "InvalidHistoryCursorError";
  }
}

export interface AiAnalysisApiDependencies {
  authenticate(request: Request, env: Env): Promise<AuthenticatedAiUser | null>;
  now(): Date;
}

const defaultDependencies: AiAnalysisApiDependencies = {
  authenticate: readAuthenticatedAiUser,
  now: () => new Date(),
};

function jsonResponse(
  data: unknown,
  status: number,
  visibility: "public" | "private",
  head = false,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": visibility === "private" ? "no-store" : "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (visibility === "private") {
    headers.set("vary", "Cookie");
  } else {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-allow-headers", "Accept, Content-Type");
  }
  return new Response(head ? null : JSON.stringify(data), { status, headers });
}

function privateJson(data: unknown, status = 200, head = false): Response {
  return jsonResponse(data, status, "private", head);
}

function publicJson(data: unknown, status = 200, head = false): Response {
  return jsonResponse(data, status, "public", head);
}

function methodNotAllowed(allow: string): Response {
  const response = privateJson({ error: "method_not_allowed" }, 405);
  response.headers.set("allow", allow);
  return response;
}

function parseResultJson(resultJson: string | null, symbol: string): AiAnalysisResultV1 {
  if (!resultJson) throw new InvalidStoredAiAnalysisResultError();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(resultJson);
  } catch {
    throw new InvalidStoredAiAnalysisResultError();
  }
  const parsed = aiAnalysisResultV1Schema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.symbol !== symbol) {
    throw new InvalidStoredAiAnalysisResultError();
  }
  return parsed.data;
}

function parseStoredResult(run: StoredRunView): AiAnalysisResultV1 {
  return parseResultJson(run.resultJson, run.symbol);
}

function runResponse(run: StoredRunView): AiAnalysisRunResponse {
  const base = {
    schemaVersion: 1 as const,
    runId: run.runId,
    symbol: run.symbol,
    company: run.company,
    requestedAt: run.requestedAt,
    creditsRemaining: run.creditsRemaining,
  };
  if (run.analysisStatus === "completed") {
    if (!run.completedAt) throw new InvalidStoredAiAnalysisResultError();
    return aiAnalysisRunResponseSchema.parse({
      ...base,
      status: "completed",
      completedAt: run.completedAt,
      creditRefunded: false,
      result: parseStoredResult(run),
    });
  }
  if (run.analysisStatus === "failed") {
    return aiAnalysisRunResponseSchema.parse({
      ...base,
      status: "failed",
      completedAt: null,
      creditRefunded: run.creditRefundedAt !== null,
      result: null,
    });
  }
  return aiAnalysisRunResponseSchema.parse({
    ...base,
    status: run.analysisStatus === "running" ? "running" : "queued",
    completedAt: null,
    creditRefunded: false,
    result: null,
  });
}

function requestOriginIsSame(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          // Reject as soon as the limit is exceeded; never buffer the whole
          // oversized body into memory.
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readRequestedSymbol(request: Request): Promise<string | null> {
  // Content-Length is a fast rejection, not the only authority: chunked or
  // missing content-length bodies are still bounded by reading the stream.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RUN_REQUEST_BYTES) return null;
  const text = await readBoundedBody(request, MAX_RUN_REQUEST_BYTES);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "symbol") return null;
  const symbolValue = Reflect.get(value, "symbol");
  if (typeof symbolValue !== "string") return null;
  const symbol = symbolValue.trim().toUpperCase();
  return isCoreUniverseSymbol(symbol) ? symbol : null;
}

function encodeCursor(cursor: HistoryCursor): string {
  return btoa(JSON.stringify({ a: cursor.acquiredAt, i: cursor.runId }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(value: string | null): HistoryCursor | null {
  if (value === null) return null;
  if (value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new InvalidHistoryCursorError();
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const parsed: unknown = JSON.parse(atob(padded));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new InvalidHistoryCursorError();
    }
    const acquiredAt = Reflect.get(parsed, "a");
    const runId = Reflect.get(parsed, "i");
    if (
      typeof acquiredAt !== "string"
      || !Number.isFinite(Date.parse(acquiredAt))
      || typeof runId !== "string"
      || !UUID_PATTERN.test(runId)
    ) {
      throw new InvalidHistoryCursorError();
    }
    return { acquiredAt, runId };
  } catch (error) {
    if (error instanceof InvalidHistoryCursorError) throw error;
    throw new InvalidHistoryCursorError();
  }
}

function safeLog(operation: string, error: unknown): void {
  console.error(JSON.stringify({
    component: "ai-analysis-api",
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
  }));
}

async function authenticate(
  request: Request,
  env: Env,
  dependencies: AiAnalysisApiDependencies,
): Promise<AuthenticatedAiUser | Response> {
  try {
    const user = await dependencies.authenticate(request, env);
    return user ?? privateJson({ error: "authentication_required" }, 401);
  } catch (error) {
    safeLog("authenticate", error);
    return privateJson({ error: "ai_analysis_auth_unavailable" }, 503);
  }
}

async function handleCatalog(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD, OPTIONS");
  }
  try {
    const catalog = aiAnalysisCatalogResponseSchema.parse(await readCatalog(env.DB));
    return publicJson(catalog, 200, request.method === "HEAD");
  } catch (error) {
    safeLog("catalog", error);
    const response = publicJson({ error: "ai_analysis_catalog_unavailable" }, 503, request.method === "HEAD");
    response.headers.set("cache-control", "no-store");
    return response;
  }
}

async function handleViewer(request: Request, env: Env, user: AuthenticatedAiUser): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  try {
    const state = await readViewerState(env.DB, user.id);
    const response = aiAnalysisViewerResponseSchema.parse({ schemaVersion: 1, ...state });
    return privateJson(response, 200, request.method === "HEAD");
  } catch (error) {
    safeLog("viewer", error);
    return privateJson({ error: "ai_analysis_store_unavailable" }, 503, request.method === "HEAD");
  }
}

async function handleCreateRun(
  request: Request,
  env: Env,
  user: AuthenticatedAiUser,
  dependencies: AiAnalysisApiDependencies,
): Promise<Response> {
  if (!requestOriginIsSame(request)) return privateJson({ error: "cross_site_request_rejected" }, 403);
  if (!isJsonRequest(request)) return privateJson({ error: "json_content_type_required" }, 415);

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return privateJson({ error: "invalid_idempotency_key" }, 400);
  }
  const symbol = await readRequestedSymbol(request);
  if (!symbol) return privateJson({ error: "invalid_symbol" }, 400);

  let acquiredRunId: string | null = null;
  try {
    // Membership comes from the checked-in Core config; the active Core row is
    // also required so response company names use the existing D1 source.
    if (!await readActiveCoreCompany(env.DB, symbol)) {
      throw new AiAnalysisCatalogUnavailableError();
    }
    // Dispatch must be possible before any credit is debited. When the Queue
    // binding is absent this is a definitive, request-time state: respond 503
    // without creating a run, a canonical analysis, or an outbox row.
    if (!env.AI_ANALYSIS_QUEUE) {
      return privateJson({ error: "ai_analysis_dispatch_unavailable" }, 503);
    }
    const now = dependencies.now();
    const acquisition = await acquireAnalysis(env.DB, {
      userId: user.id,
      symbol,
      idempotencyKey,
      now,
    });
    acquiredRunId = acquisition.run.runId;

    if (acquisition.run.analysisStatus === "dispatching") {
      await dispatchAnalysis(env.DB, env.AI_ANALYSIS_QUEUE, acquisition.run.analysisId, now);
      const refreshed = await readRunForUser(env.DB, user.id, acquisition.run.runId);
      if (refreshed) acquisition.run = refreshed;
    }

    const body = runResponse(acquisition.run);
    const status = acquisition.createdRun
      ? (body.status === "completed" ? 201 : 202)
      : (body.status === "queued" || body.status === "running" ? 202 : 200);
    return privateJson(body, status);
  } catch (error) {
    if (error instanceof InsufficientAiCreditsError) {
      return privateJson({ error: "insufficient_ai_credits" }, 402);
    }
    if (error instanceof AiAnalysisIdempotencyConflictError) {
      return privateJson({ error: "idempotency_key_conflict" }, 409);
    }
    if (error instanceof AiAnalysisCatalogUnavailableError) {
      return privateJson({ error: "ai_analysis_catalog_unavailable" }, 503);
    }
    if (error instanceof AiAnalysisDispatchUnavailableError) {
      safeLog(error.uncertain ? "dispatch-persistence" : "dispatch-send", error);
      return privateJson(
        error.uncertain && acquiredRunId !== null
          ? { error: "ai_analysis_dispatch_unavailable", runId: acquiredRunId }
          : { error: "ai_analysis_dispatch_unavailable" },
        503,
      );
    }
    if (error instanceof InvalidStoredAiAnalysisResultError) {
      safeLog("stored-result", error);
      return privateJson({ error: "ai_analysis_result_unavailable" }, 503);
    }
    safeLog("create-run", error);
    return privateJson({ error: "ai_analysis_store_unavailable" }, 503);
  }
}

async function handleReadRun(
  request: Request,
  env: Env,
  user: AuthenticatedAiUser,
  runId: string,
  dependencies: AiAnalysisApiDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  if (!UUID_PATTERN.test(runId)) return privateJson({ error: "analysis_run_not_found" }, 404);
  try {
    let run = await readRunForUser(env.DB, user.id, runId);
    if (!run) return privateJson({ error: "analysis_run_not_found" }, 404);
    // Heal the unavoidable Queue/D1 ambiguity window. If send() persisted a
    // message but the post-send D1 marker failed, a stale outbox claim is
    // reclaimable here; the same logical analysisId may be physically sent
    // again, while the runner's canonical CAS prevents duplicate execution.
    if (run.analysisStatus === "dispatching") {
      if (!env.AI_ANALYSIS_QUEUE) {
        return privateJson({ error: "ai_analysis_dispatch_unavailable" }, 503);
      }
      await dispatchAnalysis(env.DB, env.AI_ANALYSIS_QUEUE, run.analysisId, dependencies.now());
      run = await readRunForUser(env.DB, user.id, runId) ?? run;
    }
    return privateJson(runResponse(run), 200, request.method === "HEAD");
  } catch (error) {
    if (error instanceof AiAnalysisDispatchUnavailableError) {
      safeLog(error.uncertain ? "read-dispatch-persistence" : "read-dispatch-send", error);
      return privateJson(
        error.uncertain ? { error: "ai_analysis_dispatch_unavailable", runId } : { error: "ai_analysis_dispatch_unavailable" },
        503,
      );
    }
    if (error instanceof InvalidStoredAiAnalysisResultError) {
      safeLog("stored-result", error);
      return privateJson({ error: "ai_analysis_result_unavailable" }, 503);
    }
    safeLog("read-run", error);
    return privateJson({ error: "ai_analysis_store_unavailable" }, 503);
  }
}

async function handleHistory(
  request: Request,
  env: Env,
  user: AuthenticatedAiUser,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  try {
    const params = new URL(request.url).searchParams;
    const cursor = decodeCursor(params.get("cursor"));
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return privateJson({ error: "invalid_history_limit" }, 400);
    }
    const page = await readHistoryPage(env.DB, user.id, cursor, limit);
    // History is a list: degrade per row instead of failing closed for the whole
    // page. Omit an unreadable stored result so the remaining reports and the
    // cursor stay usable, and the user can still page past the bad row.
    const items: AiAnalysisHistoryResponse["items"] = [];
    for (const row of page.rows) {
      try {
        items.push({
          runId: row.runId,
          symbol: row.symbol,
          company: row.company,
          recommendation: parseResultJson(row.resultJson, row.symbol).recommendation,
          completedAt: row.completedAt,
        });
      } catch {
        // Unreadable stored result — skip this row only.
      }
    }
    const last = page.rows.at(-1);
    const response: AiAnalysisHistoryResponse = aiAnalysisHistoryResponseSchema.parse({
      schemaVersion: 1,
      items,
      nextCursor: page.hasMore && last
        ? encodeCursor({ acquiredAt: last.acquiredAt, runId: last.runId })
        : null,
    });
    return privateJson(response, 200, request.method === "HEAD");
  } catch (error) {
    if (error instanceof InvalidHistoryCursorError) {
      return privateJson({ error: "invalid_history_cursor" }, 400);
    }
    if (error instanceof InvalidStoredAiAnalysisResultError) {
      safeLog("history-result", error);
      return privateJson({ error: "ai_analysis_result_unavailable" }, 503);
    }
    safeLog("history", error);
    return privateJson({ error: "ai_analysis_store_unavailable" }, 503);
  }
}

export async function handleAiAnalysisApi(
  request: Request,
  env: Env,
  dependencies: AiAnalysisApiDependencies = defaultDependencies,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "OPTIONS") {
    if (pathname === "/api/ai-analysis/catalog") {
      const response = new Response(null, { status: 204 });
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
      response.headers.set("access-control-allow-headers", "Accept, Content-Type");
      return response;
    }
    return request.headers.has("origin") && !requestOriginIsSame(request)
      ? privateJson({ error: "cross_site_request_rejected" }, 403)
      : new Response(null, { status: 204, headers: { allow: "GET, HEAD, POST, OPTIONS" } });
  }

  if (pathname === "/api/ai-analysis/catalog") return handleCatalog(request, env);

  const runMatch = pathname.match(/^\/api\/ai-analysis\/runs\/([^/]+)$/u);
  const isProtectedRoute = pathname === "/api/ai-analysis/viewer"
    || pathname === "/api/ai-analysis/runs"
    || pathname === "/api/ai-analysis/history"
    || runMatch !== null;
  if (!isProtectedRoute) return privateJson({ error: "not_found" }, 404);

  const user = await authenticate(request, env, dependencies);
  if (user instanceof Response) return user;

  if (pathname === "/api/ai-analysis/viewer") return handleViewer(request, env, user);
  if (pathname === "/api/ai-analysis/history") return handleHistory(request, env, user);
  if (pathname === "/api/ai-analysis/runs") {
    return request.method === "POST"
      ? handleCreateRun(request, env, user, dependencies)
      : methodNotAllowed("POST");
  }
  if (runMatch) return handleReadRun(request, env, user, runMatch[1]!, dependencies);
  return privateJson({ error: "not_found" }, 404);
}
