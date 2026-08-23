import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";
import { handleAiAnalysisApi } from "./api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../migrations/0028_ai_analysis.sql");
const migrationSql = readFileSync(migrationPath, "utf8");
const ENGINE_VERSION = "v0.3.1+01477f9afb7a47b849ed4c9259d3a9a4738d9fda";
const COMMIT = "01477f9afb7a47b849ed4c9259d3a9a4738d9fda";
const BASE_NOW = new Date("2026-08-23T12:00:00.000Z");

class SqliteD1Statement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  executeBatch() {
    const statement = this.owner.sqlite.prepare(this.sql);
    if (statement.columns().length > 0) {
      return { success: true, results: statement.all(...this.values), meta: { changes: 0 } };
    }
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.owner.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.owner.sqlite.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.failNextBatchContaining = null;
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements) {
    if (
      this.failNextBatchContaining
      && statements.some((statement) => statement.sql.includes(this.failNextBatchContaining))
    ) {
      this.failNextBatchContaining = null;
      throw new Error("injected D1 batch failure");
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.executeBatch());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

class FakeQueue {
  constructor() {
    this.messages = [];
    this.fail = false;
  }

  async send(body, options) {
    if (this.fail) throw new Error("queue unavailable");
    this.messages.push({ body, options });
    await Promise.resolve();
    return { outcome: "success" };
  }
}

const databases = [];

afterEach(() => {
  while (databases.length > 0) databases.pop().close();
});

function setupDatabase(existingUsers = []) {
  const db = new SqliteD1();
  databases.push(db);
  db.sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE earnings_universe (
      symbol TEXT PRIMARY KEY NOT NULL,
      company TEXT NOT NULL,
      source TEXT NOT NULL,
      active INTEGER NOT NULL,
      universe_version INTEGER NOT NULL
    );
  `);
  const insertUser = db.sqlite.prepare("INSERT INTO user (id) VALUES (?)");
  for (const userId of existingUsers) insertUser.run(userId);
  const insertUniverse = db.sqlite.prepare(`
    INSERT INTO earnings_universe (symbol, company, source, active, universe_version)
    VALUES (?, ?, 'core', 1, 1)
  `);
  for (const symbol of CORE_UNIVERSE) insertUniverse.run(symbol, `${symbol} Incorporated`);
  db.sqlite.exec(migrationSql);
  return db;
}

function insertUser(db, userId) {
  db.sqlite.prepare("INSERT INTO user (id) VALUES (?)").run(userId);
}

function setCredits(db, userId, remaining, used = 0, granted = remaining + used) {
  db.sqlite.prepare(`
    UPDATE user_ai_entitlements
    SET credits_remaining = ?, credits_used = ?, credits_granted = ?
    WHERE user_id = ?
  `).run(remaining, used, granted, userId);
}

function count(db, table) {
  return Number(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function resultFixture(symbol, generatedAt = "2026-08-23T12:05:00.000Z") {
  return {
    schemaVersion: 1,
    symbol,
    analysisDate: generatedAt.slice(0, 10),
    generatedAt,
    engine: {
      name: "TradingAgents",
      version: "0.3.1",
      commit: COMMIT,
      provider: "google",
      quickModel: "gemini-test-quick",
      deepModel: "gemini-test-deep",
    },
    recommendation: "BUY",
    executiveSummary: "Stored executive summary.",
    investmentThesis: "Stored investment thesis.",
    priceTarget: null,
    timeHorizon: null,
    reports: {
      marketAndTechnical: "Technical report.",
      sentiment: "Sentiment report.",
      news: "News report.",
      fundamentals: "Fundamentals report.",
      bullCase: "Bull case.",
      bearCase: "Bear case.",
      researchManager: "Research manager conclusion.",
      traderPlan: "Trader plan.",
      risk: {
        aggressive: "Aggressive risk view.",
        neutral: "Neutral risk view.",
        conservative: "Conservative risk view.",
      },
      portfolioManager: "Portfolio manager conclusion.",
    },
  };
}

function transitionToCompleted(db, analysisId, completedAt, fixture = null) {
  const analysis = db.sqlite.prepare("SELECT symbol, status FROM ai_analyses WHERE id = ?").get(analysisId);
  if (analysis.status === "dispatching") {
    db.sqlite.prepare("UPDATE ai_analyses SET status = 'queued', updated_at = ? WHERE id = ?")
      .run(completedAt, analysisId);
  }
  if (analysis.status !== "running") {
    db.sqlite.prepare(`
      UPDATE ai_analyses
      SET status = 'running', started_at = COALESCE(started_at, ?),
          attempt_count = attempt_count + 1, execution_token = ?,
          execution_message_id = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(completedAt, crypto.randomUUID(), crypto.randomUUID(), completedAt, completedAt, analysisId);
  }
  const validUntil = new Date(new Date(completedAt).getTime() + 5 * 24 * 60 * 60 * 1_000).toISOString();
  db.sqlite.prepare(`
    UPDATE ai_analyses
    SET status = 'completed', engine = 'TradingAgents', engine_version = ?,
        result_schema_version = 1, result_json = ?, completed_at = ?, valid_until = ?,
        heartbeat_at = ?, safe_error_code = NULL, safe_error_message = NULL, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(
    ENGINE_VERSION,
    JSON.stringify(fixture ?? resultFixture(analysis.symbol, completedAt)),
    completedAt,
    validUntil,
    completedAt,
    completedAt,
    analysisId,
  );
}

function seedCompletedCanonical(db, symbol, completedAt) {
  const id = crypto.randomUUID();
  const createdAt = new Date(new Date(completedAt).getTime() - 60_000).toISOString();
  db.sqlite.prepare(`
    INSERT INTO ai_analyses (
      id, symbol, status, analysis_date, engine, engine_version,
      result_schema_version, created_at, attempt_count, updated_at
    ) VALUES (?, ?, 'dispatching', ?, 'TradingAgents', ?, 1, ?, 0, ?)
  `).run(id, symbol, completedAt.slice(0, 10), ENGINE_VERSION, createdAt, createdAt);
  transitionToCompleted(db, id, completedAt);
  return id;
}

function acquireCompletedForUser(db, userId, analysisId, requestedAt, creditCost = 0) {
  const symbol = db.sqlite.prepare("SELECT symbol FROM ai_analyses WHERE id = ?").get(analysisId).symbol;
  const runId = crypto.randomUUID();
  db.sqlite.prepare(`
    INSERT INTO user_ai_analysis_runs (
      id, user_id, analysis_id, symbol, idempotency_key, status,
      credit_cost, requested_at, acquired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(runId, userId, analysisId, symbol, crypto.randomUUID(), creditCost, requestedAt, requestedAt, requestedAt, requestedAt);
  return runId;
}

function envFor(db, queue) {
  return {
    DB: db,
    AI_ANALYSIS_QUEUE: queue,
    ASSETS: { fetch: async () => new Response("asset") },
    BETTER_AUTH_SECRET: "test-secret-with-sufficient-length-for-tests",
    BETTER_AUTH_URL: "https://app.test",
  };
}

function dependenciesFor(userId, now = BASE_NOW) {
  return {
    authenticate: async () => userId ? { id: userId } : null,
    now: () => new Date(now),
  };
}

function postRequest(symbol, idempotencyKey = crypto.randomUUID(), extraHeaders = {}) {
  return new Request("https://app.test/api/ai-analysis/runs", {
    method: "POST",
    headers: {
      origin: "https://app.test",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...extraHeaders,
    },
    body: JSON.stringify({ symbol }),
  });
}

async function postRun(db, queue, userId, symbol, idempotencyKey, now = BASE_NOW) {
  return handleAiAnalysisApi(
    postRequest(symbol, idempotencyKey),
    envFor(db, queue),
    dependenciesFor(userId, now),
  );
}

async function responseJson(response) {
  return response.json();
}

describe("0028 AI Analysis migration invariants", () => {
  it("backfills existing accounts and gives every newly inserted account one credit", () => {
    const db = setupDatabase(["existing-user"]);
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_granted, credits_used FROM user_ai_entitlements WHERE user_id = ?")
      .get("existing-user")).toMatchObject({ credits_remaining: 1, credits_granted: 1, credits_used: 0 });

    insertUser(db, "new-user");
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_granted, credits_used FROM user_ai_entitlements WHERE user_id = ?")
      .get("new-user")).toMatchObject({ credits_remaining: 1, credits_granted: 1, credits_used: 0 });
  });

  it("atomically debits on a plain run insert, never goes negative, and refunds a terminal failure once", () => {
    const db = setupDatabase(["user-1"]);
    const analysisId = crypto.randomUUID();
    db.sqlite.prepare(`
      INSERT INTO ai_analyses (id, symbol, status, analysis_date, engine, engine_version, created_at, updated_at)
      VALUES (?, 'MSFT', 'dispatching', '2026-08-23', 'TradingAgents', ?, ?, ?)
    `).run(analysisId, ENGINE_VERSION, BASE_NOW.toISOString(), BASE_NOW.toISOString());
    db.sqlite.prepare(`
      INSERT INTO user_ai_analysis_runs (
        id, user_id, analysis_id, symbol, idempotency_key, status,
        requested_at, created_at, updated_at
      ) VALUES (?, 'user-1', ?, 'MSFT', ?, 'queued', ?, ?, ?)
    `).run(crypto.randomUUID(), analysisId, crypto.randomUUID(), BASE_NOW.toISOString(), BASE_NOW.toISOString(), BASE_NOW.toISOString());
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'user-1'").get())
      .toMatchObject({ credits_remaining: 0, credits_used: 1 });

    const secondId = crypto.randomUUID();
    db.sqlite.prepare(`
      INSERT INTO ai_analyses (id, symbol, status, analysis_date, engine, engine_version, created_at, updated_at)
      VALUES (?, 'NVDA', 'dispatching', '2026-08-23', 'TradingAgents', ?, ?, ?)
    `).run(secondId, ENGINE_VERSION, BASE_NOW.toISOString(), BASE_NOW.toISOString());
    expect(() => db.sqlite.prepare(`
      INSERT INTO user_ai_analysis_runs (
        id, user_id, analysis_id, symbol, idempotency_key, status,
        requested_at, created_at, updated_at
      ) VALUES (?, 'user-1', ?, 'NVDA', ?, 'queued', ?, ?, ?)
    `).run(crypto.randomUUID(), secondId, crypto.randomUUID(), BASE_NOW.toISOString(), BASE_NOW.toISOString(), BASE_NOW.toISOString()))
      .toThrow(/ai_credit_exhausted/u);

    db.sqlite.prepare(`UPDATE ai_analyses SET status = 'failed', safe_error_code = 'engine_failed', updated_at = ? WHERE id = ?`)
      .run("2026-08-23T12:01:00.000Z", analysisId);
    db.sqlite.prepare(`UPDATE ai_analyses SET status = 'failed', updated_at = ? WHERE id = ?`)
      .run("2026-08-23T12:02:00.000Z", analysisId);
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'user-1'").get())
      .toMatchObject({ credits_remaining: 1, credits_used: 0 });
    expect(db.sqlite.prepare("SELECT status, credit_refunded_at FROM user_ai_analysis_runs WHERE analysis_id = ?").get(analysisId))
      .toMatchObject({ status: "failed", credit_refunded_at: "2026-08-23T12:01:00.000Z" });
  });

  it("rejects duplicate active canonicals and illegal resurrection of terminal rows", () => {
    const db = setupDatabase();
    const insert = (id) => db.sqlite.prepare(`
      INSERT INTO ai_analyses (id, symbol, status, analysis_date, engine, engine_version, created_at, updated_at)
      VALUES (?, 'MSFT', 'dispatching', '2026-08-23', 'TradingAgents', ?, ?, ?)
    `).run(id, ENGINE_VERSION, BASE_NOW.toISOString(), BASE_NOW.toISOString());
    const first = crypto.randomUUID();
    insert(first);
    expect(() => insert(crypto.randomUUID())).toThrow(/UNIQUE constraint failed/u);
    db.sqlite.prepare("UPDATE ai_analyses SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(BASE_NOW.toISOString(), first);
    expect(() => db.sqlite.prepare("UPDATE ai_analyses SET status = 'queued', updated_at = ? WHERE id = ?")
      .run(BASE_NOW.toISOString(), first)).toThrow(/invalid_ai_analysis_status_transition/u);
  });
});

describe("AI Analysis Worker API", () => {
  it("serves the exact public Core catalog and protects every viewer route with no-store", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    const catalog = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/catalog"),
      envFor(db, queue),
      dependenciesFor(null),
    );
    expect(catalog.status).toBe(200);
    const catalogBody = await responseJson(catalog);
    expect(catalogBody.stocks).toHaveLength(50);
    expect(catalogBody.stocks.map((stock) => stock.symbol)).toEqual(CORE_UNIVERSE);
    expect(catalogBody.stocks[0].company).toBe(`${CORE_UNIVERSE[0]} Incorporated`);

    const viewer = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/viewer"),
      envFor(db, queue),
      dependenciesFor(null),
    );
    expect(viewer.status).toBe(401);
    expect(viewer.headers.get("cache-control")).toBe("no-store");
    expect(viewer.headers.get("vary")).toBe("Cookie");
  });

  it("rejects cross-site, non-JSON, malformed idempotency, and non-Core requests before writes", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    const env = envFor(db, queue);
    const dependencies = dependenciesFor("user-1");

    const crossSite = postRequest("MSFT", crypto.randomUUID(), { origin: "https://evil.test" });
    expect((await handleAiAnalysisApi(crossSite, env, dependencies)).status).toBe(403);
    expect((await handleAiAnalysisApi(new Request("https://app.test/api/ai-analysis/runs", {
      method: "POST",
      headers: { origin: "https://app.test", "content-type": "text/plain", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ symbol: "MSFT" }),
    }), env, dependencies)).status).toBe(415);
    expect((await handleAiAnalysisApi(postRequest("MSFT", "short"), env, dependencies)).status).toBe(400);
    expect((await handleAiAnalysisApi(postRequest("NOTCORE", crypto.randomUUID()), env, dependencies)).status).toBe(400);
    expect(count(db, "user_ai_analysis_runs")).toBe(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("blocks a zero-credit account without creating a canonical or Queue message", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    setCredits(db, "user-1", 0);
    const response = await postRun(db, queue, "user-1", "MSFT", crypto.randomUUID());
    expect(response.status).toBe(402);
    expect(await responseJson(response)).toEqual({ error: "insufficient_ai_credits" });
    expect(count(db, "ai_analyses")).toBe(0);
    expect(count(db, "ai_analysis_dispatches")).toBe(0);
    expect(count(db, "user_ai_analysis_runs")).toBe(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("consumes once and returns one logical run/job for retries and differing active keys", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    const key = crypto.randomUUID();
    const first = await postRun(db, queue, "user-1", "MSFT", key);
    expect(first.status).toBe(202);
    const firstBody = await responseJson(first);
    expect(firstBody).toMatchObject({ symbol: "MSFT", status: "queued", creditsRemaining: 0 });
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).toEqual({
      body: JSON.stringify({ schemaVersion: 1, analysisId: db.sqlite.prepare("SELECT id FROM ai_analyses").get().id }),
      options: { contentType: "text" },
    });

    const retry = await postRun(db, queue, "user-1", "MSFT", key);
    expect(retry.status).toBe(202);
    expect((await responseJson(retry)).runId).toBe(firstBody.runId);
    const differingKey = await postRun(db, queue, "user-1", "MSFT", crypto.randomUUID());
    expect((await responseJson(differingKey)).runId).toBe(firstBody.runId);
    expect(count(db, "ai_analyses")).toBe(1);
    expect(count(db, "user_ai_analysis_runs")).toBe(1);
    expect(queue.messages).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'user-1'").get())
      .toMatchObject({ credits_remaining: 0, credits_used: 1 });

    const analysisId = db.sqlite.prepare("SELECT id FROM ai_analyses").get().id;
    transitionToCompleted(db, analysisId, "2026-08-23T12:05:00.000Z");
    const completedRetry = await postRun(db, queue, "user-1", "MSFT", key, new Date("2026-08-23T12:06:00.000Z"));
    expect(completedRetry.status).toBe(200);
    expect(await responseJson(completedRetry)).toMatchObject({ runId: firstBody.runId, status: "completed", creditsRemaining: 0 });
    expect(count(db, "ai_analyses")).toBe(1);
    expect(queue.messages).toHaveLength(1);
  });

  it("exposes queued/running/completed states, history/checkmarks, ownership, and charges no reads", async () => {
    const db = setupDatabase(["owner", "other"]);
    const queue = new FakeQueue();
    const created = await postRun(db, queue, "owner", "MSFT", crypto.randomUUID());
    const createdBody = await responseJson(created);
    const analysisId = db.sqlite.prepare("SELECT analysis_id FROM user_ai_analysis_runs WHERE id = ?").get(createdBody.runId).analysis_id;

    const runningAt = "2026-08-23T12:01:00.000Z";
    db.sqlite.prepare(`
      UPDATE ai_analyses
      SET status = 'running', started_at = ?, attempt_count = 1,
          execution_token = ?, execution_message_id = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ?
    `).run(runningAt, crypto.randomUUID(), crypto.randomUUID(), runningAt, runningAt, analysisId);
    const running = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/runs/${createdBody.runId}`),
      envFor(db, queue),
      dependenciesFor("owner"),
    );
    expect(await responseJson(running)).toMatchObject({ status: "running", creditsRemaining: 0 });

    transitionToCompleted(db, analysisId, "2026-08-23T12:05:00.000Z");
    const completed = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/runs/${createdBody.runId}`),
      envFor(db, queue),
      dependenciesFor("owner"),
    );
    const completedBody = await responseJson(completed);
    expect(completedBody).toMatchObject({ status: "completed", creditRefunded: false, result: { recommendation: "BUY" } });

    const history = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/history"),
      envFor(db, queue),
      dependenciesFor("owner"),
    );
    expect(await responseJson(history)).toMatchObject({
      items: [{ runId: createdBody.runId, symbol: "MSFT", recommendation: "BUY" }],
      nextCursor: null,
    });
    const viewer = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/viewer"),
      envFor(db, queue),
      dependenciesFor("owner"),
    );
    expect(await responseJson(viewer)).toEqual({ schemaVersion: 1, creditsRemaining: 0, ownedSymbols: ["MSFT"] });
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'owner'").get())
      .toMatchObject({ credits_remaining: 0, credits_used: 1 });

    const forbidden = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/runs/${createdBody.runId}`),
      envFor(db, queue),
      dependenciesFor("other"),
    );
    expect(forbidden.status).toBe(404);
  });

  it("paginates multiple historical acquisitions of the same symbol with an opaque stable cursor", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    const runIds = [];
    for (const completedAt of [
      "2026-08-10T12:00:00.000Z",
      "2026-08-15T12:00:00.000Z",
      "2026-08-20T12:00:00.000Z",
    ]) {
      const analysisId = seedCompletedCanonical(db, "MSFT", completedAt);
      runIds.push(acquireCompletedForUser(db, "user-1", analysisId, completedAt));
    }

    const first = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/history?limit=2"),
      envFor(db, queue),
      dependenciesFor("user-1"),
    );
    const firstBody = await responseJson(first);
    expect(firstBody.items.map((item) => item.runId)).toEqual([runIds[2], runIds[1]]);
    expect(firstBody.items.map((item) => item.symbol)).toEqual(["MSFT", "MSFT"]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/history?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`),
      envFor(db, queue),
      dependenciesFor("user-1"),
    );
    const secondBody = await responseJson(second);
    expect(secondBody.items.map((item) => item.runId)).toEqual([runIds[0]]);
    expect(secondBody.nextCursor).toBeNull();
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'user-1'").get())
      .toMatchObject({ credits_remaining: 1, credits_used: 0 });

    const invalidLimit = await handleAiAnalysisApi(
      new Request("https://app.test/api/ai-analysis/history?limit=2.5"),
      envFor(db, queue),
      dependenciesFor("user-1"),
    );
    expect(invalidLimit.status).toBe(400);
    expect(await responseJson(invalidLimit)).toEqual({ error: "invalid_history_limit" });
  });

  it("refunds known Queue-send failures and definitive runner failures exactly once", async () => {
    const db = setupDatabase(["dispatch-user", "runner-user"]);
    const failedQueue = new FakeQueue();
    failedQueue.fail = true;
    const dispatchFailure = await postRun(db, failedQueue, "dispatch-user", "MSFT", crypto.randomUUID());
    expect(dispatchFailure.status).toBe(503);
    expect(db.sqlite.prepare("SELECT status FROM ai_analyses WHERE symbol = 'MSFT'").get().status).toBe("failed");
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'dispatch-user'").get())
      .toMatchObject({ credits_remaining: 1, credits_used: 0 });

    const queue = new FakeQueue();
    await postRun(db, queue, "runner-user", "NVDA", crypto.randomUUID());
    const analysisId = db.sqlite.prepare("SELECT id FROM ai_analyses WHERE symbol = 'NVDA'").get().id;
    db.sqlite.prepare(`
      UPDATE ai_analyses
      SET status = 'running', started_at = ?, attempt_count = 1, execution_token = ?,
          execution_message_id = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ?
    `).run(BASE_NOW.toISOString(), crypto.randomUUID(), crypto.randomUUID(), BASE_NOW.toISOString(), BASE_NOW.toISOString(), analysisId);
    db.sqlite.prepare(`UPDATE ai_analyses SET status = 'failed', safe_error_code = 'engine_failed', updated_at = ? WHERE id = ?`)
      .run("2026-08-23T12:10:00.000Z", analysisId);
    db.sqlite.prepare(`UPDATE ai_analyses SET status = 'failed', updated_at = ? WHERE id = ?`)
      .run("2026-08-23T12:11:00.000Z", analysisId);
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'runner-user'").get())
      .toMatchObject({ credits_remaining: 1, credits_used: 0 });
  });

  it("implements Case A newer canonical reuse, Case B fresh same-user work, and Case C global sharing", async () => {
    const db = setupDatabase(["case-user", "other-user"]);
    const queue = new FakeQueue();
    setCredits(db, "case-user", 3);
    const old = seedCompletedCanonical(db, "MSFT", "2026-08-20T12:00:00.000Z");
    acquireCompletedForUser(db, "case-user", old, "2026-08-20T12:01:00.000Z");
    const newer = seedCompletedCanonical(db, "MSFT", "2026-08-22T12:00:00.000Z");

    const caseA = await postRun(db, queue, "case-user", "MSFT", crypto.randomUUID());
    expect(caseA.status).toBe(201);
    const caseABody = await responseJson(caseA);
    expect(caseABody).toMatchObject({ status: "completed", completedAt: "2026-08-22T12:00:00.000Z" });
    expect(db.sqlite.prepare("SELECT analysis_id FROM user_ai_analysis_runs WHERE id = ?").get(caseABody.runId).analysis_id).toBe(newer);
    expect(queue.messages).toHaveLength(0);

    const caseB = await postRun(db, queue, "case-user", "MSFT", crypto.randomUUID());
    expect(caseB.status).toBe(202);
    const caseBBody = await responseJson(caseB);
    const freshId = db.sqlite.prepare("SELECT analysis_id FROM user_ai_analysis_runs WHERE id = ?").get(caseBBody.runId).analysis_id;
    expect(freshId).not.toBe(newer);
    expect(queue.messages).toHaveLength(1);
    transitionToCompleted(db, freshId, "2026-08-23T12:05:00.000Z");

    const caseC = await postRun(db, queue, "other-user", "MSFT", crypto.randomUUID(), new Date("2026-08-24T12:00:00.000Z"));
    expect(caseC.status).toBe(201);
    const caseCBody = await responseJson(caseC);
    expect(db.sqlite.prepare("SELECT analysis_id FROM user_ai_analysis_runs WHERE id = ?").get(caseCBody.runId).analysis_id).toBe(freshId);
    expect(queue.messages).toHaveLength(1);
  });

  it("does not reuse a canonical at the exact five-day expiry boundary", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    seedCompletedCanonical(db, "MSFT", "2026-08-18T12:00:00.000Z");
    const response = await postRun(db, queue, "user-1", "MSFT", crypto.randomUUID(), BASE_NOW);
    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    expect(count(db, "ai_analyses")).toBe(2);
  });

  it("serializes three same-symbol users into one canonical, one Queue send, and three independent debits", async () => {
    const db = setupDatabase(["user-a", "user-b", "user-c"]);
    const queue = new FakeQueue();
    const responses = await Promise.all([
      postRun(db, queue, "user-a", "MSFT", crypto.randomUUID()),
      postRun(db, queue, "user-b", "MSFT", crypto.randomUUID()),
      postRun(db, queue, "user-c", "MSFT", crypto.randomUUID()),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);
    expect(count(db, "ai_analyses")).toBe(1);
    expect(count(db, "ai_analysis_dispatches")).toBe(1);
    expect(count(db, "user_ai_analysis_runs")).toBe(3);
    expect(queue.messages).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT SUM(credits_remaining) AS remaining, SUM(credits_used) AS used FROM user_ai_entitlements").get())
      .toMatchObject({ remaining: 0, used: 3 });

    const analysisId = db.sqlite.prepare("SELECT id FROM ai_analyses").get().id;
    db.sqlite.prepare(`
      UPDATE ai_analyses
      SET status = 'running', started_at = ?, attempt_count = 1, execution_token = ?,
          execution_message_id = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ?
    `).run(BASE_NOW.toISOString(), crypto.randomUUID(), crypto.randomUUID(), BASE_NOW.toISOString(), BASE_NOW.toISOString(), analysisId);
    db.sqlite.prepare("UPDATE ai_analyses SET status = 'failed', safe_error_code = 'engine_failed', updated_at = ? WHERE id = ?")
      .run("2026-08-23T12:10:00.000Z", analysisId);
    expect(db.sqlite.prepare("SELECT SUM(credits_remaining) AS remaining, SUM(credits_used) AS used FROM user_ai_entitlements").get())
      .toMatchObject({ remaining: 3, used: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM user_ai_analysis_runs WHERE status = 'failed' AND credit_refunded_at IS NOT NULL").get().count)
      .toBe(3);
  });

  it("rejects reuse of one idempotency key for a different symbol without charging", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    setCredits(db, "user-1", 2);
    const key = crypto.randomUUID();
    await postRun(db, queue, "user-1", "MSFT", key);
    const conflict = await postRun(db, queue, "user-1", "NVDA", key);
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: "idempotency_key_conflict" });
    expect(db.sqlite.prepare("SELECT credits_remaining, credits_used FROM user_ai_entitlements WHERE user_id = 'user-1'").get())
      .toMatchObject({ credits_remaining: 1, credits_used: 1 });
    expect(count(db, "user_ai_analysis_runs")).toBe(1);
  });

  it("heals send-success/post-send-D1-marker failure from the authenticated read path", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    db.failNextBatchContaining = "SET status = 'sent'";
    const response = await postRun(db, queue, "user-1", "MSFT", crypto.randomUUID());
    expect(response.status).toBe(503);
    expect(queue.messages).toHaveLength(1);
    const row = db.sqlite.prepare(`
      SELECT run.id AS run_id, analysis.id AS analysis_id, analysis.status, dispatch.status AS dispatch_status
      FROM user_ai_analysis_runs AS run
      JOIN ai_analyses AS analysis ON analysis.id = run.analysis_id
      JOIN ai_analysis_dispatches AS dispatch ON dispatch.analysis_id = analysis.id
    `).get();
    expect(row).toMatchObject({ status: "dispatching", dispatch_status: "sending" });

    const healed = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/runs/${row.run_id}`),
      envFor(db, queue),
      dependenciesFor("user-1", new Date(BASE_NOW.getTime() + 61_000)),
    );
    expect(healed.status).toBe(200);
    expect(await responseJson(healed)).toMatchObject({ status: "queued", runId: row.run_id });
    expect(queue.messages).toHaveLength(2);
    expect(db.sqlite.prepare("SELECT status FROM ai_analyses WHERE id = ?").get(row.analysis_id).status).toBe("queued");
  });

  it("fails closed instead of exposing malformed stored result JSON", async () => {
    const db = setupDatabase(["user-1"]);
    const queue = new FakeQueue();
    const created = await postRun(db, queue, "user-1", "MSFT", crypto.randomUUID());
    const body = await responseJson(created);
    const analysisId = db.sqlite.prepare("SELECT analysis_id FROM user_ai_analysis_runs WHERE id = ?").get(body.runId).analysis_id;
    transitionToCompleted(db, analysisId, "2026-08-23T12:05:00.000Z", {});
    const response = await handleAiAnalysisApi(
      new Request(`https://app.test/api/ai-analysis/runs/${body.runId}`),
      envFor(db, queue),
      dependenciesFor("user-1"),
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "ai_analysis_result_unavailable" });
  });
});
