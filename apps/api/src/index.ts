import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import type {
  BotEvent,
  Candidate,
  DashboardData,
  EarningsEvent,
  ResearchResult,
  ShadowPosition,
  StrategySummary,
} from "@stock-autotrader/contracts";
import { z } from "zod";
import {
  analysisSchema,
  candidateSchema,
  dashboardSchema,
  decisionReasonSchema,
  earningsSchema,
  eventSchema,
  idSchema,
  positionSchema,
  researchSchema,
  scanSchema,
  statusSchema,
  strategySchema,
  symbolSchema,
} from "./schemas";
import { openApiDocument } from "./openapi";

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
};

function json(value: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...securityHeaders,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(value), { status, headers });
}

const notFound = (origin?: string) =>
  json(
    { error: { code: "NOT_FOUND", message: "Public resource not found" } },
    404,
    origin,
  );
const invalid = (origin?: string) =>
  json(
    {
      error: {
        code: "INVALID_INPUT",
        message: "Invalid public resource identifier",
      },
    },
    400,
    origin,
  );

function matchingOrigin(request: Request, allowed: string): string | undefined {
  const origin = request.headers.get("Origin");
  return origin && origin === allowed ? origin : undefined;
}

function demoRoute(path: string, origin?: string): Response | undefined {
  if (path === "/api/dashboard") return json(demoData, 200, origin);
  if (path === "/api/status")
    return json(statusSchema.parse(demoData.status), 200, origin);
  if (path === "/api/scans/latest")
    return json(
      scanSchema.parse({
        id: "demo-scan-latest",
        scanType: "SMOKE",
        status: "COMPLETED",
        universe: demoData.scan.universe,
        passedFilters: demoData.scan.passedFilters,
        candidates: demoData.scan.candidates,
        setups: demoData.scan.setups,
        dataSource: "demo-fixture",
        dataAsOf: demoData.status.lastDataUpdate,
        startedAt: demoData.status.latestScan,
        completedAt: demoData.status.latestScan,
        demo: true,
      }),
      200,
      origin,
    );
  if (path === "/api/candidates")
    return json(
      z.array(candidateSchema).parse(demoData.candidates),
      200,
      origin,
    );
  if (path === "/api/strategies")
    return json(
      z.array(strategySchema).parse(demoData.strategies),
      200,
      origin,
    );
  if (path === "/api/research" || path === "/api/backtests")
    return json(demoData.research, 200, origin);
  if (path === "/api/portfolio/shadow")
    return json(
      { ...demoData.portfolio, positions: demoData.positions, simulated: true },
      200,
      origin,
    );
  if (path === "/api/trades/shadow")
    return json({ simulated: true, trades: [] }, 200, origin);
  if (path === "/api/earnings") return json(demoData.earnings, 200, origin);
  if (path === "/api/activity") return json(demoData.events, 200, origin);
  const stockMatch = path.match(/^\/api\/stocks\/([^/]+)(\/analysis)?$/);
  if (stockMatch) {
    const parsed = symbolSchema.safeParse(stockMatch[1]?.toUpperCase());
    if (!parsed.success) return invalid(origin);
    const stock = demoData.candidates.find(
      (item) => item.symbol === parsed.data,
    );
    if (!stock) return notFound(origin);
    if (stockMatch[2]) {
      return json(
        analysisSchema.parse({
          id: `demo-${stock.symbol.toLowerCase()}`,
          symbol: stock.symbol,
          strategyId: stock.strategyId,
          strategyVersion: stock.strategyVersion,
          quantFactors: { quantScore: stock.quantScore, trend: stock.trend },
          marketStructure: { direction: stock.direction },
          publicSummary: `${stock.status} generated from the published demo factors.`,
          aiAssessment: null,
          dataSource: "demo-fixture",
          dataAsOf: stock.updatedAt,
          createdAt: stock.updatedAt,
          updatedAt: stock.updatedAt,
          reasons: stock.reasons,
        }),
        200,
        origin,
      );
    }
    return json(candidateSchema.parse(stock), 200, origin);
  }
  const strategyMatch = path.match(/^\/api\/strategies\/([^/]+)$/);
  if (strategyMatch) {
    const parsed = idSchema.safeParse(strategyMatch[1]);
    if (!parsed.success) return invalid(origin);
    const strategy = demoData.strategies.find(
      (item) => item.id === parsed.data,
    );
    return strategy
      ? json(strategySchema.parse(strategy), 200, origin)
      : notFound(origin);
  }
  const scanMatch = path.match(/^\/api\/scans\/([^/]+)$/);
  if (scanMatch)
    return idSchema.safeParse(scanMatch[1]).success
      ? json(
          scanSchema.parse({
            id: scanMatch[1],
            scanType: "SMOKE",
            status: "COMPLETED",
            universe: demoData.scan.universe,
            passedFilters: demoData.scan.passedFilters,
            candidates: demoData.scan.candidates,
            setups: demoData.scan.setups,
            dataSource: "demo-fixture",
            dataAsOf: demoData.status.lastDataUpdate,
            startedAt: demoData.status.latestScan,
            completedAt: demoData.status.latestScan,
            demo: true,
          }),
          200,
          origin,
        )
      : invalid(origin);
  return undefined;
}

type CandidateRow = {
  symbol: string;
  company: string;
  sector: string;
  market_cap: number;
  price: number;
  quant_score: number;
  strategy_id: string;
  strategy_version: string;
  strategy_name: string;
  trend: Candidate["trend"];
  momentum: number;
  relative_strength: number;
  relative_volume: number;
  earnings_date: string | null;
  status: Candidate["status"];
  direction: Candidate["direction"];
  updated_at: string;
  earnings_proximity_days: number | null;
  reasons_json: string;
};
function reasonsFromJson(value: string): Candidate["reasons"] {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        outcome: z.enum(["pass", "reject", "info"]),
        code: z.string(),
        label: z.string(),
        observed_value: z.string().nullable(),
        threshold_value: z.string().nullable(),
      }),
    )
    .parse(JSON.parse(value));
  return z.array(decisionReasonSchema).parse(
    rows.map((reason) => ({
      id: reason.id,
      outcome: reason.outcome,
      code: reason.code,
      label: reason.label,
      ...(reason.observed_value !== null
        ? { observed: reason.observed_value }
        : {}),
      ...(reason.threshold_value !== null
        ? { threshold: reason.threshold_value }
        : {}),
    })),
  );
}
function candidateFromRow(row: CandidateRow): Candidate {
  return {
    symbol: row.symbol,
    company: row.company,
    sector: row.sector,
    marketCap: row.market_cap,
    price: row.price,
    quantScore: row.quant_score,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    strategy: row.strategy_name,
    trend: row.trend,
    momentum: row.momentum,
    relativeStrength: row.relative_strength,
    relativeVolume: row.relative_volume,
    earningsDate: row.earnings_date,
    earningsProximityDays: row.earnings_proximity_days,
    status: row.status,
    direction: row.direction,
    updatedAt: row.updated_at,
    reasons: reasonsFromJson(row.reasons_json),
  };
}

async function loadCandidates(env: Env): Promise<Candidate[]> {
  const result = await env.DB.prepare(
    "SELECT sc.symbol, s.company, COALESCE(s.sector,'Unknown') AS sector, COALESCE(s.market_cap,0) AS market_cap, sc.price, sc.quant_score, sc.strategy_id, sc.strategy_version, st.name AS strategy_name, sc.trend, sc.momentum, sc.relative_strength, sc.relative_volume, e.event_date AS earnings_date, CASE WHEN e.event_date IS NULL THEN NULL ELSE CAST(julianday(e.event_date)-julianday(date(sc.updated_at)) AS INTEGER) END AS earnings_proximity_days, sc.status, sc.direction, sc.updated_at, COALESCE((SELECT json_group_array(json_object('id',ordered.id,'outcome',ordered.outcome,'code',ordered.code,'label',ordered.label,'observed_value',ordered.observed_value,'threshold_value',ordered.threshold_value)) FROM (SELECT dr.id,dr.outcome,dr.code,dr.label,dr.observed_value,dr.threshold_value FROM decision_reasons dr WHERE dr.analysis_id=(SELECT a.id FROM analyses a WHERE a.symbol=sc.symbol AND a.strategy_id=sc.strategy_id AND a.strategy_version=sc.strategy_version AND a.data_as_of<=sc.updated_at ORDER BY a.data_as_of DESC LIMIT 1) ORDER BY dr.sort_order,dr.id) ordered),'[]') AS reasons_json FROM scan_candidates sc JOIN stocks s ON s.symbol=sc.symbol JOIN strategies st ON st.id=sc.strategy_id LEFT JOIN earnings e ON e.id=(SELECT id FROM earnings ee WHERE ee.symbol=sc.symbol ORDER BY CASE WHEN ee.event_date>=date((SELECT data_as_of FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1)) THEN 0 ELSE 1 END, ABS(julianday(ee.event_date)-julianday(date((SELECT data_as_of FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1)))) LIMIT 1) WHERE sc.scan_id=(SELECT id FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1) ORDER BY sc.quant_score DESC,sc.symbol,sc.strategy_id LIMIT 500",
  ).all<CandidateRow>();
  return z.array(candidateSchema).parse(result.results.map(candidateFromRow));
}

async function loadStrategies(env: Env): Promise<StrategySummary[]> {
  const result = await env.DB.prepare(
    "SELECT st.id,st.name,st.version,st.description,st.lifecycle_state,st.enabled,st.universe,st.holding_period,st.parameters_json,(SELECT COUNT(*) FROM scan_candidates sc WHERE sc.strategy_id=st.id AND sc.scan_id=(SELECT id FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1) AND sc.status IN ('Strong Setup','Watch')) AS signals_today,(SELECT COUNT(*) FROM shadow_positions p WHERE p.strategy_id=st.id AND p.status='OPEN' AND p.portfolio_id=(SELECT id FROM shadow_portfolios WHERE status='ACTIVE' ORDER BY started_at DESC LIMIT 1)) AS open_positions FROM strategies st WHERE st.enabled=1 ORDER BY st.name",
  ).all<{
    id: string;
    name: string;
    version: string;
    description: string;
    lifecycle_state: StrategySummary["state"];
    enabled: number;
    universe: string;
    holding_period: string;
    parameters_json: string;
    signals_today: number;
    open_positions: number;
  }>();
  const strategies = result.results.map(
    (row): StrategySummary => ({
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      state: row.lifecycle_state,
      enabled: row.enabled === 1,
      universe: row.universe,
      holdingPeriod: row.holding_period,
      signalsToday: row.signals_today,
      openPositions: row.open_positions,
      parameters: JSON.parse(
        row.parameters_json,
      ) as StrategySummary["parameters"],
    }),
  );
  return z.array(strategySchema).parse(strategies);
}

async function loadEarnings(env: Env): Promise<EarningsEvent[]> {
  const result = await env.DB.prepare(
    "SELECT e.symbol,s.company,e.event_date,e.timing,e.event_status,COALESCE((SELECT json_group_array(name) FROM (SELECT DISTINCT st.name AS name FROM scan_candidates sc JOIN strategies st ON st.id=sc.strategy_id WHERE sc.symbol=e.symbol AND sc.scan_id=(SELECT id FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1))),'[]') AS strategies_json FROM earnings e JOIN stocks s ON s.symbol=e.symbol ORDER BY ABS(julianday(e.event_date)-julianday('now')),e.event_date LIMIT 100",
  ).all<{
    symbol: string;
    company: string;
    event_date: string;
    timing: EarningsEvent["timing"];
    event_status: string;
    strategies_json: string;
  }>();
  return z.array(earningsSchema).parse(
    result.results.map((row) => ({
      symbol: row.symbol,
      company: row.company,
      date: row.event_date,
      timing: row.timing,
      eventSignal:
        row.event_status === "CONFIRMED"
          ? "Confirmed"
          : row.event_status === "RISK_WINDOW"
            ? "Risk Window"
            : "Pending",
      strategies: z.array(z.string()).parse(JSON.parse(row.strategies_json)),
      tracked: true,
    })),
  );
}

async function loadEvents(env: Env): Promise<BotEvent[]> {
  const result = await env.DB.prepare(
    "SELECT id,event_type,severity,public_message,symbol,strategy_id,occurred_at FROM bot_events ORDER BY occurred_at DESC LIMIT 100",
  ).all<{
    id: string;
    event_type: string;
    severity: BotEvent["severity"];
    public_message: string;
    symbol: string | null;
    strategy_id: string | null;
    occurred_at: string;
  }>();
  return z.array(eventSchema).parse(
    result.results.map((row) => ({
      id: row.id,
      type: row.event_type,
      message: row.public_message,
      ...(row.symbol ? { symbol: row.symbol } : {}),
      ...(row.strategy_id ? { strategyId: row.strategy_id } : {}),
      severity: row.severity,
      createdAt: row.occurred_at,
    })),
  );
}

async function loadResearch(env: Env): Promise<ResearchResult[]> {
  const result = await env.DB.prepare(
    "SELECT b.id,b.strategy_id,s.name AS strategy,b.stage,b.period_start,b.period_end,b.metrics_json,b.completed_at FROM backtests b JOIN strategies s ON s.id=b.strategy_id ORDER BY b.completed_at DESC LIMIT 100",
  ).all<{
    id: string;
    strategy_id: string;
    strategy: string;
    stage: ResearchResult["stage"];
    period_start: string;
    period_end: string;
    metrics_json: string;
    completed_at: string | null;
  }>();
  return z.array(researchSchema).parse(
    result.results.map((row) => ({
      id: row.id,
      strategyId: row.strategy_id,
      strategy: row.strategy,
      stage: row.stage,
      period: `${row.period_start} – ${row.period_end}`,
      status: row.completed_at ? "Complete" : "Pending",
      metrics: JSON.parse(row.metrics_json) as Record<string, number | null>,
    })),
  );
}

async function loadPositions(env: Env): Promise<ShadowPosition[]> {
  const result = await env.DB.prepare(
    "SELECT p.symbol,s.name AS strategy,p.entry_price,p.current_price,p.stop_price,p.quantity,p.initial_risk,p.unrealized_pnl,p.r_multiple,p.opened_at FROM shadow_positions p JOIN strategies s ON s.id=p.strategy_id WHERE p.status='OPEN' AND p.portfolio_id=(SELECT id FROM shadow_portfolios WHERE status='ACTIVE' ORDER BY started_at DESC LIMIT 1) ORDER BY p.opened_at DESC",
  ).all<{
    symbol: string;
    strategy: string;
    entry_price: number;
    current_price: number;
    stop_price: number;
    quantity: number;
    initial_risk: number;
    unrealized_pnl: number;
    r_multiple: number;
    opened_at: string;
  }>();
  return z.array(positionSchema).parse(
    result.results.map((row) => ({
      symbol: row.symbol,
      strategy: row.strategy,
      entryPrice: row.entry_price,
      currentPrice: row.current_price,
      stopPrice: row.stop_price,
      quantity: row.quantity,
      riskAmount: row.initial_risk,
      unrealizedPnl: row.unrealized_pnl,
      rMultiple: row.r_multiple,
      openedAt: row.opened_at,
    })),
  );
}

async function loadStatus(env: Env): Promise<DashboardData["status"]> {
  const latest = await env.DB.prepare(
    "SELECT completed_at,data_as_of FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1",
  ).first<{ completed_at: string; data_as_of: string }>();
  const now = new Date();
  const latestScan = latest?.completed_at ?? null;
  const stale = latest
    ? now.getTime() - new Date(latest.completed_at).getTime() >
      36 * 60 * 60 * 1000
    : true;
  return statusSchema.parse({
    engine: latest ? (stale ? "delayed" : "online") : "offline",
    latestScan,
    nextScan: null,
    lastDataUpdate: latest?.data_as_of ?? null,
    apiHealth: "healthy",
  });
}

async function d1Route(
  path: string,
  env: Env,
  origin?: string,
): Promise<Response | undefined> {
  if (path === "/api/status") return json(await loadStatus(env), 200, origin);
  if (path === "/api/candidates")
    return json(await loadCandidates(env), 200, origin);
  if (path === "/api/strategies")
    return json(await loadStrategies(env), 200, origin);
  if (path === "/api/earnings")
    return json(await loadEarnings(env), 200, origin);
  if (path === "/api/activity") return json(await loadEvents(env), 200, origin);
  if (path === "/api/research" || path === "/api/backtests")
    return json(await loadResearch(env), 200, origin);
  if (path === "/api/trades/shadow") {
    const trades = await env.DB.prepare(
      "SELECT id,symbol,strategy_id,strategy_version,entry_price,exit_price,stop_price,quantity,initial_risk,realized_pnl,r_multiple,entry_at,exit_at,exit_reason FROM shadow_trades ORDER BY entry_at DESC LIMIT 250",
    ).all();
    return json({ simulated: true, trades: trades.results }, 200, origin);
  }
  if (path === "/api/portfolio/shadow") {
    const portfolio = await env.DB.prepare(
      "SELECT initial_capital,equity,max_positions,max_open_risk_pct,max_gross_exposure_pct FROM shadow_portfolios WHERE status='ACTIVE' ORDER BY started_at DESC LIMIT 1",
    ).first<{
      initial_capital: number;
      equity: number;
      max_positions: number;
      max_open_risk_pct: number;
      max_gross_exposure_pct: number;
    }>();
    const positions = await loadPositions(env);
    const initialCapital = portfolio?.initial_capital ?? 5000;
    const equity = portfolio?.equity ?? initialCapital;
    return json(
      {
        initialCapital,
        equity,
        returnPct: (equity / initialCapital - 1) * 100,
        openPositions: positions.length,
        openRiskPct:
          (positions.reduce((sum, item) => sum + item.riskAmount, 0) /
            Math.max(equity, 1)) *
          100,
        grossExposurePct:
          (positions.reduce(
            (sum, item) => sum + item.currentPrice * item.quantity,
            0,
          ) /
            Math.max(equity, 1)) *
          100,
        maxPositions: portfolio?.max_positions ?? 4,
        maxOpenRiskPct: (portfolio?.max_open_risk_pct ?? 0.02) * 100,
        maxGrossExposurePct: (portfolio?.max_gross_exposure_pct ?? 1) * 100,
        positions,
        simulated: true,
      },
      200,
      origin,
    );
  }
  if (path === "/api/scans/latest") {
    const scan = await env.DB.prepare(
      "SELECT id,scan_type,status,universe_count,passed_filters_count,candidates_count,setups_count,data_source,data_as_of,started_at,completed_at FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1",
    ).first();
    return scan
      ? json(
          scanSchema.parse({
            id: scan.id,
            scanType: scan.scan_type,
            status: scan.status,
            universe: scan.universe_count,
            passedFilters: scan.passed_filters_count,
            candidates: scan.candidates_count,
            setups: scan.setups_count,
            dataSource: scan.data_source,
            dataAsOf: scan.data_as_of,
            startedAt: scan.started_at,
            completedAt: scan.completed_at,
            demo: false,
          }),
          200,
          origin,
        )
      : notFound(origin);
  }
  const strategyMatch = path.match(/^\/api\/strategies\/([^/]+)$/);
  if (strategyMatch) {
    const parsed = idSchema.safeParse(strategyMatch[1]);
    if (!parsed.success) return invalid(origin);
    const strategy = (await loadStrategies(env)).find(
      (item) => item.id === parsed.data,
    );
    return strategy ? json(strategy, 200, origin) : notFound(origin);
  }
  const stockMatch = path.match(/^\/api\/stocks\/([^/]+)(\/analysis)?$/);
  if (stockMatch) {
    const parsed = symbolSchema.safeParse(stockMatch[1]?.toUpperCase());
    if (!parsed.success) return invalid(origin);
    if (stockMatch[2]) {
      const analysis = await env.DB.prepare(
        "SELECT id,symbol,strategy_id,strategy_version,quant_factors_json,market_structure_json,public_summary,ai_assessment_json,data_source,data_as_of,created_at,updated_at FROM analyses WHERE symbol=? ORDER BY data_as_of DESC LIMIT 1",
      )
        .bind(parsed.data)
        .first<{
          id: string;
          symbol: string;
          strategy_id: string | null;
          strategy_version: string | null;
          quant_factors_json: string;
          market_structure_json: string;
          public_summary: string;
          ai_assessment_json: string | null;
          data_source: string;
          data_as_of: string;
          created_at: string;
          updated_at: string;
        }>();
      if (!analysis) return notFound(origin);
      const reasons = await env.DB.prepare(
        "SELECT id,outcome,code,label,observed_value,threshold_value FROM decision_reasons WHERE analysis_id=? ORDER BY sort_order",
      )
        .bind(analysis.id)
        .all<{
          id: string;
          outcome: "pass" | "reject" | "info";
          code: string;
          label: string;
          observed_value: string | null;
          threshold_value: string | null;
        }>();
      return json(
        analysisSchema.parse({
          id: analysis.id,
          symbol: analysis.symbol,
          strategyId: analysis.strategy_id,
          strategyVersion: analysis.strategy_version,
          quantFactors: JSON.parse(analysis.quant_factors_json),
          marketStructure: JSON.parse(analysis.market_structure_json),
          publicSummary: analysis.public_summary,
          aiAssessment: analysis.ai_assessment_json
            ? JSON.parse(analysis.ai_assessment_json)
            : null,
          dataSource: analysis.data_source,
          dataAsOf: analysis.data_as_of,
          createdAt: analysis.created_at,
          updatedAt: analysis.updated_at,
          reasons: reasons.results.map((reason) => ({
            id: reason.id,
            outcome: reason.outcome,
            code: reason.code,
            label: reason.label,
            ...(reason.observed_value !== null
              ? { observed: reason.observed_value }
              : {}),
            ...(reason.threshold_value !== null
              ? { threshold: reason.threshold_value }
              : {}),
          })),
        }),
        200,
        origin,
      );
    }
    const stock = (await loadCandidates(env)).find(
      (item) => item.symbol === parsed.data,
    );
    return stock ? json(stock, 200, origin) : notFound(origin);
  }
  const scanMatch = path.match(/^\/api\/scans\/([^/]+)$/);
  if (scanMatch) {
    const parsed = idSchema.safeParse(scanMatch[1]);
    if (!parsed.success) return invalid(origin);
    const scan = await env.DB.prepare(
      "SELECT id,scan_type,status,universe_count,passed_filters_count,candidates_count,setups_count,data_source,data_as_of,started_at,completed_at FROM scans WHERE id=?",
    )
      .bind(parsed.data)
      .first();
    return scan
      ? json(
          scanSchema.parse({
            id: scan.id,
            scanType: scan.scan_type,
            status: scan.status,
            universe: scan.universe_count,
            passedFilters: scan.passed_filters_count,
            candidates: scan.candidates_count,
            setups: scan.setups_count,
            dataSource: scan.data_source,
            dataAsOf: scan.data_as_of,
            startedAt: scan.started_at,
            completedAt: scan.completed_at,
            demo: false,
          }),
          200,
          origin,
        )
      : notFound(origin);
  }
  if (path === "/api/dashboard") {
    const [
      status,
      candidates,
      strategies,
      earnings,
      events,
      positions,
      research,
      scanRow,
      portfolioRow,
    ] = await Promise.all([
      loadStatus(env),
      loadCandidates(env),
      loadStrategies(env),
      loadEarnings(env),
      loadEvents(env),
      loadPositions(env),
      loadResearch(env),
      env.DB.prepare(
        "SELECT universe_count,passed_filters_count,candidates_count,setups_count FROM scans WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1",
      ).first<{
        universe_count: number;
        passed_filters_count: number;
        candidates_count: number;
        setups_count: number;
      }>(),
      env.DB.prepare(
        "SELECT initial_capital,equity,max_positions,max_open_risk_pct,max_gross_exposure_pct FROM shadow_portfolios WHERE status='ACTIVE' ORDER BY started_at DESC LIMIT 1",
      ).first<{
        initial_capital: number;
        equity: number;
        max_positions: number;
        max_open_risk_pct: number;
        max_gross_exposure_pct: number;
      }>(),
    ]);
    const initialCapital = portfolioRow?.initial_capital ?? 5000;
    const equity = portfolioRow?.equity ?? initialCapital;
    const dashboard: DashboardData = {
      demo: false,
      status,
      scan: {
        universe: scanRow?.universe_count ?? 0,
        passedFilters: scanRow?.passed_filters_count ?? 0,
        candidates: scanRow?.candidates_count ?? candidates.length,
        setups: scanRow?.setups_count ?? 0,
      },
      portfolio: {
        initialCapital,
        equity,
        returnPct: (equity / initialCapital - 1) * 100,
        openPositions: positions.length,
        openRiskPct:
          (positions.reduce((sum, item) => sum + item.riskAmount, 0) /
            Math.max(equity, 1)) *
          100,
        grossExposurePct:
          (positions.reduce(
            (sum, item) => sum + item.currentPrice * item.quantity,
            0,
          ) /
            Math.max(equity, 1)) *
          100,
        maxPositions: portfolioRow?.max_positions ?? 4,
        maxOpenRiskPct: (portfolioRow?.max_open_risk_pct ?? 0.02) * 100,
        maxGrossExposurePct: (portfolioRow?.max_gross_exposure_pct ?? 1) * 100,
      },
      strategies,
      candidates,
      events,
      earnings,
      positions,
      research,
    };
    return json(dashboardSchema.parse(dashboard), 200, origin);
  }
  return undefined;
}

export function handleDemoRequest(request: Request): Response {
  const url = new URL(request.url);
  return demoRoute(url.pathname) ?? notFound();
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = matchingOrigin(request, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin ?? "null",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Accept",
          "Access-Control-Max-Age": "86400",
          ...securityHeaders,
        },
      });
    if (request.method !== "GET")
      return json(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "This public API is read-only",
          },
        },
        405,
        origin,
      );
    if (url.pathname === "/healthz") return json({ status: "ok" }, 200, origin);
    if (url.pathname === "/openapi.json")
      return json(openApiDocument, 200, origin);
    try {
      const response =
        env.DEMO_MODE === "true"
          ? demoRoute(url.pathname, origin)
          : await d1Route(url.pathname, env, origin);
      return response ?? notFound(origin);
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "public_api_failure",
          path: url.pathname,
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      return json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Public data is temporarily unavailable",
          },
        },
        503,
        origin,
      );
    }
  },
} satisfies ExportedHandler<Env>;
