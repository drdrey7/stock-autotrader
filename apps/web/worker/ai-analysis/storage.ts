import {
  aiAnalysisEngineName,
  aiAnalysisOwnedSymbolsLimit,
  aiAnalysisResultSchemaVersion,
  aiAnalysisProgressTotal,
  CORE_UNIVERSE,
  CORE_UNIVERSE_VERSION,
  type AiAnalysisCatalogResponse,
  type AiAnalysisProgressStage,
} from "@stock-autotrader/contracts";

export const AI_ANALYSIS_ENGINE = aiAnalysisEngineName;
export const AI_ANALYSIS_ENGINE_VERSION = "v0.3.1+01477f9afb7a47b849ed4c9259d3a9a4738d9fda" as const;
export const AI_ANALYSIS_RESULT_SCHEMA_VERSION = aiAnalysisResultSchemaVersion;

export interface AiAnalysisQueuePayload {
  schemaVersion: 1;
  analysisId: string;
}

const ACTIVE_ANALYSIS_STATUSES = "'dispatching', 'queued', 'running'";

export type StoredAnalysisStatus = "dispatching" | "queued" | "running" | "completed" | "failed";
export type StoredRunStatus = "queued" | "running" | "completed" | "failed";

export interface StoredRunView {
  runId: string;
  analysisId: string;
  symbol: string;
  company: string;
  requestedAt: string;
  startedAt: string | null;
  progressStage: AiAnalysisProgressStage | null;
  progressStep: number;
  progressTotal: typeof aiAnalysisProgressTotal;
  progressUpdatedAt: string | null;
  reused: boolean;
  runStatus: StoredRunStatus;
  analysisStatus: StoredAnalysisStatus;
  completedAt: string | null;
  resultJson: string | null;
  creditRefundedAt: string | null;
  creditsRemaining: number;
}

export interface Acquisition {
  run: StoredRunView;
  createdRun: boolean;
  createdCanonical: boolean;
}

export interface ViewerState {
  creditsRemaining: number;
  ownedSymbols: string[];
}

export interface HistoryRow {
  runId: string;
  symbol: string;
  company: string;
  requestedAt: string;
  startedAt: string | null;
  status: StoredRunStatus;
  progressStage: AiAnalysisProgressStage | null;
  progressStep: number;
  progressTotal: typeof aiAnalysisProgressTotal;
  progressUpdatedAt: string | null;
  completedAt: string | null;
  resultJson: string | null;
  reused: boolean;
}

export interface HistoryCursor {
  acquiredAt: string;
  runId: string;
}

export interface HistoryPage {
  rows: HistoryRow[];
  hasMore: boolean;
}

interface StoredRunDbRow {
  run_id: string;
  analysis_id: string;
  symbol: string;
  company: string;
  requested_at: string;
  run_status: StoredRunStatus;
  analysis_status: StoredAnalysisStatus;
  started_at: string | null;
  progress_stage: AiAnalysisProgressStage | null;
  progress_step: number;
  progress_total: typeof aiAnalysisProgressTotal;
  progress_updated_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  credit_refunded_at: string | null;
  credit_cost: number;
  credits_remaining: number;
}

interface RunInsertRow {
  run_id: string;
  analysis_id: string;
}

interface CandidateInsertRow {
  analysis_id: string;
}

interface EntitlementRow {
  credits_remaining: number;
}

interface OwnedSymbolRow {
  symbol: string;
}

interface CatalogDbRow {
  symbol: string;
  company: string;
}

export async function readActiveCoreCompany(
  db: D1Database,
  symbol: string,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT company
    FROM earnings_universe
    WHERE symbol = ? AND source = 'core' AND active = 1
    LIMIT 1
  `).bind(symbol).first<{ company: string }>();
  const company = row?.company?.trim();
  return company ? company : null;
}

interface HistoryDbRow {
  run_id: string;
  symbol: string;
  company: string;
  requested_at: string;
  started_at: string | null;
  status: StoredRunStatus;
  progress_stage: AiAnalysisProgressStage | null;
  progress_step: number;
  progress_total: typeof aiAnalysisProgressTotal;
  progress_updated_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  credit_cost: number;
}

interface DispatchClaimRow {
  analysis_id: string;
}

export class InsufficientAiCreditsError extends Error {
  constructor() {
    super("insufficient_ai_credits");
    this.name = "InsufficientAiCreditsError";
  }
}

export class AiAnalysisIdempotencyConflictError extends Error {
  constructor() {
    super("ai_analysis_idempotency_conflict");
    this.name = "AiAnalysisIdempotencyConflictError";
  }
}

export class AiAnalysisCatalogUnavailableError extends Error {
  constructor() {
    super("ai_analysis_catalog_unavailable");
    this.name = "AiAnalysisCatalogUnavailableError";
  }
}

export class AiAnalysisDispatchUnavailableError extends Error {
  constructor(readonly uncertain = false) {
    super("ai_analysis_dispatch_unavailable");
    this.name = "AiAnalysisDispatchUnavailableError";
  }
}

function toStoredRun(row: StoredRunDbRow): StoredRunView {
  return {
    runId: row.run_id,
    analysisId: row.analysis_id,
    symbol: row.symbol,
    company: row.company,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    progressStage: row.progress_stage,
    progressStep: Number(row.progress_step),
    progressTotal: aiAnalysisProgressTotal,
    progressUpdatedAt: row.progress_updated_at,
    reused: Number(row.credit_cost) === 0,
    runStatus: row.run_status,
    analysisStatus: row.analysis_status,
    completedAt: row.completed_at,
    resultJson: row.result_json,
    creditRefundedAt: row.credit_refunded_at,
    creditsRemaining: Number(row.credits_remaining),
  };
}

const RUN_VIEW_SQL = `
  SELECT
    run.id AS run_id,
    run.analysis_id,
    run.symbol,
    COALESCE(universe.company, run.symbol) AS company,
    run.requested_at,
    run.status AS run_status,
    analysis.status AS analysis_status,
    analysis.started_at,
    analysis.progress_stage,
    analysis.progress_step,
    analysis.progress_total,
    analysis.progress_updated_at,
    analysis.completed_at,
    analysis.result_json,
    run.credit_refunded_at,
    run.credit_cost,
    entitlement.credits_remaining
  FROM user_ai_analysis_runs AS run
  JOIN ai_analyses AS analysis ON analysis.id = run.analysis_id
  JOIN user_ai_entitlements AS entitlement ON entitlement.user_id = run.user_id
  LEFT JOIN (
    SELECT symbol, company
    FROM earnings_universe
    WHERE source = 'core' AND active = 1
    GROUP BY symbol
  ) AS universe ON universe.symbol = run.symbol
`;

export async function readRunForUser(
  db: D1Database,
  userId: string,
  runId: string,
): Promise<StoredRunView | null> {
  const row = await db.prepare(`${RUN_VIEW_SQL}
    WHERE run.user_id = ? AND run.id = ?
    LIMIT 1
  `).bind(userId, runId).first<StoredRunDbRow>();
  return row ? toStoredRun(row) : null;
}

async function readRunByIdempotency(
  db: D1Database,
  userId: string,
  idempotencyKey: string,
): Promise<StoredRunView | null> {
  const row = await db.prepare(`${RUN_VIEW_SQL}
    WHERE run.user_id = ? AND run.idempotency_key = ?
    LIMIT 1
  `).bind(userId, idempotencyKey).first<StoredRunDbRow>();
  return row ? toStoredRun(row) : null;
}

async function readActiveRunForSymbol(
  db: D1Database,
  userId: string,
  symbol: string,
): Promise<StoredRunView | null> {
  const row = await db.prepare(`${RUN_VIEW_SQL}
    WHERE run.user_id = ?
      AND run.symbol = ?
      AND run.status IN ('queued', 'running')
    ORDER BY run.requested_at DESC, run.id DESC
    LIMIT 1
  `).bind(userId, symbol).first<StoredRunDbRow>();
  return row ? toStoredRun(row) : null;
}

async function existingAcquisition(
  db: D1Database,
  userId: string,
  symbol: string,
  idempotencyKey: string,
): Promise<Acquisition | null> {
  const byKey = await readRunByIdempotency(db, userId, idempotencyKey);
  if (byKey) {
    if (byKey.symbol !== symbol) throw new AiAnalysisIdempotencyConflictError();
    return { run: byKey, createdRun: false, createdCanonical: false };
  }

  const active = await readActiveRunForSymbol(db, userId, symbol);
  return active ? { run: active, createdRun: false, createdCanonical: false } : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function returnedRunId(result: D1Result<CandidateInsertRow | RunInsertRow> | undefined): string | null {
  const row = result?.results?.[0];
  return row && "run_id" in row && typeof row.run_id === "string" ? row.run_id : null;
}

/**
 * Atomically chooses/creates a canonical analysis and acquires it for one
 * user. D1 batch() is a single transaction. The run INSERT is intentionally
 * plain: uniqueness failures roll the BEFORE-trigger debit and any speculative
 * canonical/outbox back together.
 */
export async function acquireAnalysis(
  db: D1Database,
  input: {
    userId: string;
    symbol: string;
    idempotencyKey: string;
    now: Date;
  },
  retryBudget = 1,
): Promise<Acquisition> {
  const preexisting = await existingAcquisition(db, input.userId, input.symbol, input.idempotencyKey);
  if (preexisting) return preexisting;

  const now = input.now.toISOString();
  const analysisDate = now.slice(0, 10);
  const candidateAnalysisId = crypto.randomUUID();
  const candidateRunId = crypto.randomUUID();

  const insertCanonical = db.prepare(`
    INSERT INTO ai_analyses (
      id, symbol, status, analysis_date, engine, engine_version,
      result_schema_version, result_json, created_at, started_at,
      completed_at, valid_until, attempt_count, execution_token,
      execution_message_id, heartbeat_at, safe_error_code,
      safe_error_message, updated_at
    )
    SELECT
      ?, ?, 'dispatching', ?, ?, ?, 1, NULL, ?, NULL,
      NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM ai_analyses AS active
      WHERE active.symbol = ?
        AND active.status IN (${ACTIVE_ANALYSIS_STATUSES})
    )
      AND NOT EXISTS (
        SELECT 1
        FROM ai_analyses AS reusable
        WHERE reusable.symbol = ?
          AND reusable.status = 'completed'
          AND reusable.valid_until > ?
      )
    RETURNING id AS analysis_id
  `).bind(
    candidateAnalysisId,
    input.symbol,
    analysisDate,
    AI_ANALYSIS_ENGINE,
    AI_ANALYSIS_ENGINE_VERSION,
    now,
    now,
    input.symbol,
    input.symbol,
    now,
  );

  const insertRun = db.prepare(`
    INSERT INTO user_ai_analysis_runs (
      id, user_id, analysis_id, symbol, idempotency_key, status,
      credit_cost, requested_at, acquired_at, credit_refunded_at,
      created_at, updated_at
    )
    SELECT
      ?, ?, analysis.id, ?, ?,
      CASE
        WHEN analysis.status = 'completed' THEN 'completed'
        WHEN analysis.status = 'running' THEN 'running'
        ELSE 'queued'
      END,
      CASE WHEN analysis.status = 'completed' THEN 0 ELSE 1 END,
      ?,
      CASE WHEN analysis.status = 'completed' THEN ? ELSE NULL END,
      NULL,
      ?,
      ?
    FROM ai_analyses AS analysis
    WHERE analysis.id = COALESCE(
      (
        SELECT reusable.id
        FROM ai_analyses AS reusable
        WHERE reusable.symbol = ?
          AND reusable.status = 'completed'
          AND reusable.valid_until > ?
        ORDER BY reusable.completed_at DESC, reusable.id DESC
        LIMIT 1
      ),
      (
        SELECT active.id
        FROM ai_analyses AS active
        WHERE active.symbol = ?
          AND active.status IN (${ACTIVE_ANALYSIS_STATUSES})
        ORDER BY active.created_at ASC, active.id ASC
        LIMIT 1
      )
    )
    RETURNING id AS run_id, analysis_id
  `).bind(
    candidateRunId,
    input.userId,
    input.symbol,
    input.idempotencyKey,
    now,
    now,
    now,
    now,
    input.symbol,
    now,
    input.symbol,
  );

  try {
    const results = await db.batch<CandidateInsertRow | RunInsertRow>([insertCanonical, insertRun]);
    const runId = returnedRunId(results[1]);
    if (!runId) {
      if (retryBudget > 0) return acquireAnalysis(db, input, retryBudget - 1);
      throw new Error("ai_analysis_acquisition_target_missing");
    }
    const run = await readRunForUser(db, input.userId, runId);
    if (!run) throw new Error("ai_analysis_acquisition_read_failed");
    return {
      run,
      createdRun: true,
      createdCanonical: run.analysisId === candidateAnalysisId,
    };
  } catch (error) {
    // The race winner may have consumed the last credit before this request's
    // BEFORE trigger ran. Resolve logical idempotency before classifying the
    // trigger error as insufficient balance.
    const raced = await existingAcquisition(db, input.userId, input.symbol, input.idempotencyKey);
    if (raced) return raced;

    const message = messageOf(error);
    if (message.includes("ai_credit_exhausted")) throw new InsufficientAiCreditsError();
    if (
      retryBudget > 0
      && (message.includes("UNIQUE constraint failed") || message.includes("acquisition_target_missing"))
    ) {
      return acquireAnalysis(db, input, retryBudget - 1);
    }
    throw error;
  }
}

export async function readViewerState(db: D1Database, userId: string): Promise<ViewerState> {
  const [entitlement, symbols] = await Promise.all([
    db.prepare(`
      SELECT credits_remaining
      FROM user_ai_entitlements
      WHERE user_id = ?
      LIMIT 1
    `).bind(userId).first<EntitlementRow>(),
    db.prepare(`
      SELECT DISTINCT symbol
      FROM user_ai_analysis_runs
      WHERE user_id = ? AND status = 'completed'
      ORDER BY symbol ASC
      LIMIT ${aiAnalysisOwnedSymbolsLimit}
    `).bind(userId).all<OwnedSymbolRow>(),
  ]);
  if (!entitlement) throw new Error("ai_analysis_entitlement_missing");
  return {
    creditsRemaining: Number(entitlement.credits_remaining),
    ownedSymbols: (symbols.results ?? []).map((row) => row.symbol),
  };
}

export async function readCatalog(db: D1Database): Promise<AiAnalysisCatalogResponse> {
  const result = await db.prepare(`
    SELECT symbol, company
    FROM earnings_universe
    WHERE source = 'core' AND active = 1
  `).all<CatalogDbRow>();
  const companyBySymbol = new Map(
    (result.results ?? [])
      .filter((row) => typeof row.company === "string" && row.company.trim().length > 0)
      .map((row) => [row.symbol, row.company.trim()]),
  );
  if (CORE_UNIVERSE.some((symbol) => !companyBySymbol.has(symbol))) {
    throw new AiAnalysisCatalogUnavailableError();
  }
  return {
    schemaVersion: 1,
    universeVersion: CORE_UNIVERSE_VERSION,
    stocks: CORE_UNIVERSE.map((symbol) => ({
      symbol,
      company: companyBySymbol.get(symbol)!,
    })),
  };
}

export async function readHistoryPage(
  db: D1Database,
  userId: string,
  cursor: HistoryCursor | null,
  limit = 100,
): Promise<HistoryPage> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const cursorPredicate = cursor
    ? "AND (run.requested_at < ? OR (run.requested_at = ? AND run.id < ?))"
    : "";
  const statement = db.prepare(`
    SELECT
      run.id AS run_id,
      run.symbol,
      COALESCE(universe.company, run.symbol) AS company,
      run.requested_at,
      analysis.started_at,
      run.status,
      analysis.progress_stage,
      analysis.progress_step,
      analysis.progress_total,
      analysis.progress_updated_at,
      analysis.completed_at,
      analysis.result_json,
      run.credit_cost
    FROM user_ai_analysis_runs AS run
    JOIN ai_analyses AS analysis ON analysis.id = run.analysis_id
    LEFT JOIN (
      SELECT symbol, company
      FROM earnings_universe
      WHERE source = 'core' AND active = 1
      GROUP BY symbol
    ) AS universe ON universe.symbol = run.symbol
    WHERE run.user_id = ?
      AND run.status IN ('queued', 'running', 'completed', 'failed')
      ${cursorPredicate}
    ORDER BY run.requested_at DESC, run.id DESC
    LIMIT ?
  `);
  const bound = cursor
    ? statement.bind(userId, cursor.acquiredAt, cursor.acquiredAt, cursor.runId, boundedLimit + 1)
    : statement.bind(userId, boundedLimit + 1);
  const result = await bound.all<HistoryDbRow>();
  const rows = result.results ?? [];
  return { rows: rows.slice(0, boundedLimit).map((row) => ({
    runId: row.run_id,
    symbol: row.symbol,
    company: row.company,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    status: row.status,
    progressStage: row.progress_stage,
    progressStep: Number(row.progress_step),
    progressTotal: aiAnalysisProgressTotal,
    progressUpdatedAt: row.progress_updated_at,
    completedAt: row.completed_at,
    resultJson: row.result_json,
    reused: Number(row.credit_cost) === 0,
  })), hasMore: rows.length > boundedLimit };
}

export type DispatchResult = "not-needed" | "claimed-elsewhere" | "sent";

// The send timeout must be strictly shorter than the dispatch claim lease
// (60s) so a stalled send resolves to the uncertain path instead of holding
// the request open past the claim.
const QUEUE_SEND_TIMEOUT_MS = 5_000;
const QUEUE_SEND_TIMED_OUT = Symbol("queue_send_timed_out");

async function sendWithTimeout(queue: Queue<string>, payload: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.send(payload, { contentType: "text" }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(QUEUE_SEND_TIMED_OUT), QUEUE_SEND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Claims the transactional outbox row before sending. The Queue promise is
 * awaited because the caller must know whether dispatch was accepted. Queues
 * are at-least-once: analysisId is the logical idempotency key consumed by the
 * runner; a crash after send and before the D1 sent marker can still produce a
 * duplicate physical message.
 */
export async function dispatchAnalysis(
  db: D1Database,
  queue: Queue<string>,
  analysisId: string,
  now: Date,
): Promise<DispatchResult> {
  const claimToken = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + 60_000).toISOString();
  const claim = await db.prepare(`
    UPDATE ai_analysis_dispatches
    SET status = 'sending',
        claim_token = ?,
        claim_expires_at = ?,
        attempt_count = attempt_count + 1,
        last_error_code = NULL,
        updated_at = ?
    WHERE analysis_id = ?
      AND (
        status = 'pending'
        OR (status = 'sending' AND claim_expires_at <= ?)
      )
      AND EXISTS (
        SELECT 1
        FROM ai_analyses AS analysis
        WHERE analysis.id = ai_analysis_dispatches.analysis_id
          AND analysis.status = 'dispatching'
      )
    RETURNING analysis_id
  `).bind(
    claimToken,
    claimExpiresAt,
    claimedAt,
    analysisId,
    claimedAt,
  ).first<DispatchClaimRow>();

  if (!claim) {
    const state = await db.prepare(`
      SELECT analysis.status AS analysis_status, dispatch.status AS dispatch_status
      FROM ai_analyses AS analysis
      JOIN ai_analysis_dispatches AS dispatch ON dispatch.analysis_id = analysis.id
      WHERE analysis.id = ?
      LIMIT 1
    `).bind(analysisId).first<{ analysis_status: StoredAnalysisStatus; dispatch_status: string }>();
    return state?.analysis_status === "dispatching" && state.dispatch_status === "sending"
      ? "claimed-elsewhere"
      : "not-needed";
  }

  const queuePayload: AiAnalysisQueuePayload = { schemaVersion: 1, analysisId };
  const payload = JSON.stringify(queuePayload);
  try {
    await sendWithTimeout(queue, payload);
  } catch (sendError) {
    if (sendError === QUEUE_SEND_TIMED_OUT) {
      // A send timeout does NOT prove the message was not enqueued. Do not mark
      // the analysis failed and do not refund the credit. The outbox claim stays
      // 'sending' for its 60s lease, so a later re-dispatch can reclaim it and
      // the analysis/run remain valid while reconciliation happens. The client
      // keeps the run id and can poll or re-dispatch via the read path.
      throw new AiAnalysisDispatchUnavailableError(true);
    }
    // A definitive pre-enqueue failure can use the failed/refund path because
    // the send did not dispatch a message we can prove.
    try {
      await db.batch([
        db.prepare(`
          UPDATE ai_analysis_dispatches
          SET status = 'failed',
              claim_token = NULL,
              claim_expires_at = NULL,
              last_error_code = 'queue_send_failed',
              updated_at = ?
          WHERE analysis_id = ?
            AND status = 'sending'
            AND claim_token = ?
        `).bind(claimedAt, analysisId, claimToken),
        db.prepare(`
          UPDATE ai_analyses
          SET status = 'failed',
              safe_error_code = 'dispatch_failed',
              safe_error_message = 'Analysis could not be started.',
              updated_at = ?
          WHERE id = ? AND status = 'dispatching'
        `).bind(claimedAt, analysisId),
      ]);
    } catch {
      // The sanitized API error is the same; leaving a stale claim permits an
      // idempotent retry after D1 recovers rather than guessing write outcome.
    }
    throw new AiAnalysisDispatchUnavailableError(false);
  }

  try {
    await db.batch([
      db.prepare(`
        UPDATE ai_analysis_dispatches
        SET status = 'sent',
            claim_token = NULL,
            claim_expires_at = NULL,
            sent_at = ?,
            last_error_code = NULL,
            updated_at = ?
        WHERE analysis_id = ?
          AND status = 'sending'
          AND claim_token = ?
      `).bind(claimedAt, claimedAt, analysisId, claimToken),
      db.prepare(`
        UPDATE ai_analyses
        SET status = 'queued',
            updated_at = ?
        WHERE id = ?
          AND status = 'dispatching'
          AND EXISTS (
            SELECT 1
            FROM ai_analysis_dispatches AS dispatch
            WHERE dispatch.analysis_id = ai_analyses.id
              AND dispatch.status = 'sent'
              AND dispatch.sent_at = ?
          )
      `).bind(claimedAt, analysisId, claimedAt),
    ]);
  } catch {
    // send() may already have persisted the message. Do not mark the analysis
    // failed/refund here; the stale outbox claim and runner CAS heal ambiguity.
    throw new AiAnalysisDispatchUnavailableError(true);
  }
  return "sent";
}
