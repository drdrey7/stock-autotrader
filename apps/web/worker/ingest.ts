import { z } from "zod";
import type { Env } from "./index";

/**
 * Protected publication layer (PR #3).
 * POST /ingest/events — batch of normalized public events signed with HMAC-SHA256.
 * - Authentication: X-Ingest-Signature: sha256=<hex> over the raw body, keyed by INGEST_SECRET.
 * - Replay protection: X-Ingest-Timestamp must be within a 5-minute window.
 * - Idempotency: each event_id is applied at most once (ingest_events ledger).
 * - Strict schemas: invalid events are rejected with 400; nothing is passed through.
 */

const EVENT_TYPES = [
  "SCAN_STARTED",
  "SCAN_COMPLETED",
  "SIGNAL_SURFACED",
  "SIGNAL_UPDATED",
  "SIGNAL_REJECTED",
  "SHADOW_POSITION_OPENED",
  "SHADOW_POSITION_UPDATED",
  "SHADOW_POSITION_CLOSED",
  "EARNINGS_UPDATED",
  "SYSTEM_STATUS",
] as const;

const reasonSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  outcome: z.enum(["pass", "reject", "info"]),
  observed: z.string().max(200).optional(),
  threshold: z.string().max(200).optional(),
});

const candidateSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  company: z.string().min(1).max(200),
  sector: z.string().max(100).optional().nullable(),
  marketCap: z.number().int().nonnegative().optional().nullable(),
  price: z.number().nonnegative().optional().nullable(),
  quantScore: z.number().int().min(0).max(100),
  strategyId: z.string().min(1).max(64),
  strategyVersion: z.string().min(1).max(32),
  strategy: z.string().min(1).max(64),
  trend: z.string().max(32),
  momentum: z.number().optional().nullable(),
  relativeStrength: z.number().optional().nullable(),
  relativeVolume: z.number().optional().nullable(),
  breakout: z.string().max(64).optional().nullable(),
  earningsDate: z.string().max(20).optional().nullable(),
  earningsProximityDays: z.number().int().optional().nullable(),
  status: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]),
  direction: z.enum(["Long"]),
  riskFlags: z.array(z.string().max(200)).default([]),
  updatedAt: z.string().max(40),
  reasons: z.array(reasonSchema).default([]),
});

const scanCompletedSchema = z.object({
  scannedAt: z.string().max(40),
  universe: z.number().int().nonnegative(),
  passedFilters: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  setups: z.number().int().nonnegative(),
  watch: z.number().int().nonnegative(),
  results: z.array(candidateSchema).max(500).default([]),
});

const positionSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  strategy: z.string().min(1).max(64),
  entryPrice: z.number().nonnegative(),
  currentPrice: z.number().nonnegative(),
  stopPrice: z.number().nonnegative(),
  quantity: z.number().int().positive(),
  riskAmount: z.number().nonnegative(),
  unrealizedPnl: z.number(),
  returnPct: z.number(),
  rMultiple: z.number(),
  openedAt: z.string().max(40),
  updatedAt: z.string().max(40),
});

const earningsSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  company: z.string().min(1).max(200),
  date: z.string().max(20),
  timing: z.enum(["BMO", "AMC", "TBD"]),
  eventSignal: z.enum(["Confirmed", "Pending", "Risk Window"]),
  engineRelevant: z.boolean(),
  signal: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]).nullable(),
  strategy: z.string().max(64).nullable(),
  hasPosition: z.boolean(),
  tracked: z.boolean(),
  updatedAt: z.string().max(40),
});

const systemStatusSchema = z.object({
  engine: z.enum(["online", "offline", "delayed"]),
  nextScan: z.string().max(40).nullable().optional(),
  lastDataUpdate: z.string().max(40).nullable().optional(),
  apiHealth: z.enum(["healthy", "degraded"]),
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SCAN_STARTED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: z.object({ scheduledAt: z.string().max(40), universe: z.number().int().nonnegative() }) }),
  z.object({ type: z.literal("SCAN_COMPLETED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: scanCompletedSchema }),
  z.object({ type: z.enum(["SIGNAL_SURFACED", "SIGNAL_UPDATED", "SIGNAL_REJECTED"]), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: candidateSchema }),
  z.object({ type: z.literal("SHADOW_POSITION_OPENED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: positionSchema }),
  z.object({ type: z.literal("SHADOW_POSITION_UPDATED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: positionSchema }),
  z.object({ type: z.literal("SHADOW_POSITION_CLOSED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: z.object({ symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/), strategy: z.string().min(1).max(64), closedAt: z.string().max(40), exitReason: z.string().max(200) }) }),
  z.object({ type: z.literal("EARNINGS_UPDATED"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: z.object({ items: z.array(earningsSchema).max(500) }) }),
  z.object({ type: z.literal("SYSTEM_STATUS"), event_id: z.string().min(8).max(80), timestamp: z.string().max(40), payload: systemStatusSchema }),
]);

type IngestEvent = z.infer<typeof eventSchema>;

export { eventSchema };
export type { IngestEvent };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyRequest(request: Request, body: string, secret: string): Promise<boolean> {
  const sig = request.headers.get("X-Ingest-Signature") ?? "";
  const ts = request.headers.get("X-Ingest-Timestamp") ?? "";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  if (Math.abs(Date.now() - t) > 5 * 60 * 1000) return false;
  const expected = `sha256=${await hmacHex(secret, body)}`;
  return constantTimeEqual(sig, expected);
}

function buildStatements(event: IngestEvent): [string, unknown[]][] {
  const stmts: [string, unknown[]][] = [];
  const p = event.payload as Record<string, unknown>;

  const insertBotEvent = (type: string, message: string, symbol: string | null) =>
    ["INSERT INTO bot_events (event_id, event_type, message, severity, symbol, strategy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [event.event_id, type, message, "info", symbol, null, event.timestamp]] as [string, unknown[]];

  switch (event.type) {
    case "SCAN_STARTED": {
      stmts.push(insertBotEvent("SCAN_STARTED", `Scan started (universe ${p.universe})`, null));
      break;
    }
    case "SCAN_COMPLETED": {
      const sc = event.payload;
      stmts.push(
        ["INSERT INTO scans (scanned_at, universe, passed_filters, candidates, setups, watch) VALUES (?, ?, ?, ?, ?, ?)",
          [sc.scannedAt, sc.universe, sc.passedFilters, sc.candidates, sc.setups, sc.watch]],
        insertBotEvent("SCAN_COMPLETED", `Scan completed: ${sc.candidates} candidates, ${sc.setups} setups`, null),
      );
      // candidates are inserted with an explicit scan_id lookup after the batch — see applyEvents.
      for (const c of sc.results) {
        stmts.push(
          ["INSERT INTO scan_candidates (scan_id, symbol, company, sector, market_cap, price, quant_score, strategy_id, strategy, strategy_version, trend, momentum, relative_strength, relative_volume, breakout, earnings_date, earnings_proximity_days, status, direction, risk_flags, updated_at) SELECT (SELECT MAX(id) FROM scans), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
            [c.symbol, c.company, c.sector ?? null, c.marketCap ?? null, c.price ?? null, c.quantScore, c.strategyId, c.strategy, c.strategyVersion, c.trend, c.momentum ?? null, c.relativeStrength ?? null, c.relativeVolume ?? null, c.breakout ?? null, c.earningsDate ?? null, c.earningsProximityDays ?? null, c.status, c.direction, JSON.stringify(c.riskFlags), c.updatedAt]],
        );
        for (const r of c.reasons) {
          stmts.push(
            ["INSERT INTO decision_reasons (candidate_id, reason_code, reason_label, outcome, observed, threshold) SELECT id, ?, ?, ?, ?, ? FROM scan_candidates WHERE symbol = ? AND strategy_id = ? AND scan_id = (SELECT MAX(id) FROM scans)",
              [r.code, r.label, r.outcome, r.observed ?? null, r.threshold ?? null, c.symbol, c.strategyId]],
          );
        }
      }
      break;
    }
    case "SIGNAL_SURFACED":
    case "SIGNAL_UPDATED":
    case "SIGNAL_REJECTED": {
      const c = event.payload;
      stmts.push(
        // Remove any previous candidate + its reasons for this symbol/strategy (FK-safe).
        ["DELETE FROM decision_reasons WHERE candidate_id IN (SELECT id FROM scan_candidates WHERE symbol = ? AND strategy_id = ?)", [c.symbol, c.strategyId]],
        ["DELETE FROM scan_candidates WHERE symbol = ? AND strategy_id = ?", [c.symbol, c.strategyId]],
        ["INSERT INTO scan_candidates (scan_id, symbol, company, sector, market_cap, price, quant_score, strategy_id, strategy, strategy_version, trend, momentum, relative_strength, relative_volume, breakout, earnings_date, earnings_proximity_days, status, direction, risk_flags, updated_at) SELECT (SELECT MAX(id) FROM scans), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
          [c.symbol, c.company, c.sector ?? null, c.marketCap ?? null, c.price ?? null, c.quantScore, c.strategyId, c.strategy, c.strategyVersion, c.trend, c.momentum ?? null, c.relativeStrength ?? null, c.relativeVolume ?? null, c.breakout ?? null, c.earningsDate ?? null, c.earningsProximityDays ?? null, c.status, c.direction, JSON.stringify(c.riskFlags), c.updatedAt]],
      );
      for (const r of c.reasons) {
        stmts.push(
          ["INSERT INTO decision_reasons (candidate_id, reason_code, reason_label, outcome, observed, threshold) SELECT id, ?, ?, ?, ?, ? FROM scan_candidates WHERE symbol = ? AND strategy_id = ? ORDER BY id DESC LIMIT 1",
            [r.code, r.label, r.outcome, r.observed ?? null, r.threshold ?? null, c.symbol, c.strategyId]],
        );
      }
      stmts.push(insertBotEvent(event.type, `${c.symbol} ${c.status === "Rejected" ? "rejected" : "signal updated"}`, c.symbol));
      break;
    }
    case "SHADOW_POSITION_OPENED": {
      const pos = event.payload;
      stmts.push(
        ["INSERT INTO shadow_positions (symbol, strategy, entry_price, current_price, stop_price, quantity, risk_amount, unrealized_pnl, return_pct, r_multiple, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [pos.symbol, pos.strategy, pos.entryPrice, pos.currentPrice, pos.stopPrice, pos.quantity, pos.riskAmount, pos.unrealizedPnl, pos.returnPct, pos.rMultiple, pos.openedAt, pos.updatedAt]],
        insertBotEvent("SHADOW_POSITION_OPENED", `Shadow position opened: ${pos.symbol}`, pos.symbol),
      );
      break;
    }
    case "SHADOW_POSITION_UPDATED": {
      const pos = event.payload;
      stmts.push(
        ["UPDATE shadow_positions SET current_price = ?, stop_price = ?, unrealized_pnl = ?, return_pct = ?, r_multiple = ?, updated_at = ? WHERE symbol = ? AND strategy = ?",
          [pos.currentPrice, pos.stopPrice, pos.unrealizedPnl, pos.returnPct, pos.rMultiple, pos.updatedAt, pos.symbol, pos.strategy]],
        insertBotEvent("SHADOW_POSITION_UPDATED", `Shadow position updated: ${pos.symbol}`, pos.symbol),
      );
      break;
    }
    case "SHADOW_POSITION_CLOSED": {
      const c = event.payload;
      stmts.push(
        ["DELETE FROM shadow_positions WHERE symbol = ? AND strategy = ?", [c.symbol, c.strategy]],
        insertBotEvent("SHADOW_POSITION_CLOSED", `Shadow position closed: ${c.symbol} (${c.exitReason})`, c.symbol),
      );
      break;
    }
    case "EARNINGS_UPDATED": {
      const items = event.payload.items;
      for (const e of items) {
        stmts.push(
          ["INSERT INTO earnings (symbol, company, date, timing, event_signal, engine_relevant, signal, strategy, has_position, tracked, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (symbol, date) DO UPDATE SET company = excluded.company, timing = excluded.timing, event_signal = excluded.event_signal, engine_relevant = excluded.engine_relevant, signal = excluded.signal, strategy = excluded.strategy, has_position = excluded.has_position, tracked = excluded.tracked, updated_at = excluded.updated_at",
            [e.symbol, e.company, e.date, e.timing, e.eventSignal, e.engineRelevant ? 1 : 0, e.signal, e.strategy, e.hasPosition ? 1 : 0, e.tracked ? 1 : 0, e.updatedAt]],
        );
      }
      stmts.push(insertBotEvent("EARNINGS_UPDATED", `Earnings updated: ${items.length} events`, null));
      break;
    }
    case "SYSTEM_STATUS": {
      const s = event.payload;
      const hasNextScan = Object.prototype.hasOwnProperty.call(s, "nextScan");
      const hasLastDataUpdate = Object.prototype.hasOwnProperty.call(s, "lastDataUpdate");
      stmts.push(
        ["INSERT INTO app_meta (key, value) VALUES ('engine', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [s.engine]],
        ["INSERT INTO app_meta (key, value) VALUES ('apiHealth', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [s.apiHealth]],
        insertBotEvent("SYSTEM_STATUS", `System status: engine ${s.engine}, api ${s.apiHealth}`, null),
      );
      if (hasNextScan) {
        stmts.splice(
          stmts.length - 1,
          0,
          ["INSERT INTO app_meta (key, value) VALUES ('nextScan', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [s.nextScan ?? ""]],
        );
      }
      if (hasLastDataUpdate) {
        stmts.splice(
          stmts.length - 1,
          0,
          ["INSERT INTO app_meta (key, value) VALUES ('lastDataUpdate', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [s.lastDataUpdate ?? ""]],
        );
      }
      break;
    }
  }
  return stmts;
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = env.INGEST_SECRET;
  if (!secret) return json({ error: "Ingest not configured" }, 503);

  const raw = await request.text();
  if (!raw) return json({ error: "Empty body" }, 400);
  if (!(await verifyRequest(request, raw, secret))) return json({ error: "Unauthorized" }, 401);

  let body: { events?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 500) {
    return json({ error: "events must be a non-empty array (max 500)" }, 400);
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const rejected: { event_id: string; reason: string }[] = [];

  for (const rawEvent of body.events) {
    let event: IngestEvent;
    try {
      event = eventSchema.parse(rawEvent);
    } catch {
      const id = (rawEvent as { event_id?: string })?.event_id ?? "unknown";
      rejected.push({ event_id: id, reason: "invalid schema" });
      continue;
    }

    // Idempotency ledger: claim the event_id atomically.
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_events (event_id, event_type, received_at, status) VALUES (?, ?, ?, 'applied')",
    ).bind(event.event_id, event.type, new Date().toISOString()).run();

    if (claim.meta.changes === 0) {
      skipped.push(event.event_id);
      await env.DB.prepare(
        "INSERT INTO ingest_log (event_id, event_type, status, detail, created_at) VALUES (?, ?, 'skipped_duplicate', NULL, ?)",
      ).bind(event.event_id, event.type, new Date().toISOString()).run();
      continue;
    }

    try {
      const stmts = buildStatements(event);
      if (stmts.length > 0) {
        await env.DB.batch(stmts.map(([sql, args]) => env.DB.prepare(sql).bind(...args)));
      }
      applied.push(event.event_id);
    } catch (err) {
      // Roll back the claim so a transient failure can be retried.
      await env.DB.prepare("DELETE FROM ingest_events WHERE event_id = ?").bind(event.event_id).run();
      await env.DB.prepare(
        "INSERT INTO ingest_log (event_id, event_type, status, detail, created_at) VALUES (?, ?, 'error', ?, ?)",
      ).bind(event.event_id, event.type, String(err).slice(0, 400), new Date().toISOString()).run();
      return json({ error: "Failed to apply event", event_id: event.event_id }, 500);
    }
  }

  return json({ applied, skipped, rejected });
}

export { EVENT_TYPES };
