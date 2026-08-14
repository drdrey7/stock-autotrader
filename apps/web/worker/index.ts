import {
  briefingCalendarDateSchema,
  briefingEditionTypeSchema,
} from "@stock-autotrader/contracts";
import { handleIngest } from "./ingest";
import {
  readBriefingByDateAndType,
  readBriefingStatus,
  readLatestBriefing,
} from "./daily-briefings";
import { readXPosts } from "./x-posts";
import { readMarketContext, runMarketContextJob, runSentimentJob } from "./market-context";
import { EarningsQueryError, readEarningsApi, runEarningsJob } from "./earnings";
import { jobsForProductionCron } from "./cron-dispatcher";
import {
  buildDashboard,
  buildSources,
  emptyMarketData,
  readCandidateBySymbol,
  readMarketData,
  readPortfolioAndPositions,
  readStrategies,
  unavailableBriefingStatus,
  unavailableSources,
} from "./dashboard";

/**
 * Stock Autotrader public read-only API (PR #2).
 * Serves sanitized public data from D1. No mutations, no admin, no broker routes.
 * Non-API requests fall through to Workers Assets (the SPA).
 * The read model itself (buildDashboard, buildSources and the scoped table
 * readers) lives in ./dashboard — this file is routing only.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INGEST_SECRET?: string;
  ENVIRONMENT?: string;
  FINNHUB_API_KEY?: string;
  SEC_USER_AGENT?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Content-Type, Accept",
      "x-content-type-options": "nosniff",
    },
  });

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.ENVIRONMENT !== "production") {
      console.info("scheduled job ignored outside production", env.ENVIRONMENT ?? "unset");
      return;
    }
    const scheduledTime = new Date(controller.scheduledTime);
    const jobs = jobsForProductionCron(controller.cron, scheduledTime);
    if (jobs.length === 0) {
      console.warn("unknown cron trigger", controller.cron);
      return;
    }
    await Promise.all(jobs.map(async (job) => {
      if (job === "earnings-monitor") {
        await runEarningsJob(env, scheduledTime, "monitor");
        return;
      }
      if (job === "market-context") {
        await runMarketContextJob(env, scheduledTime);
        return;
      }
      if (job === "sentiment") {
        await runSentimentJob(env, scheduledTime);
        return;
      }
      await runEarningsJob(env, scheduledTime, "calendar");
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Protected publication endpoint (PR #3) — accepts POST before the GET-only gate.
    if (pathname === "/ingest/events") return handleIngest(request, env);

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (pathname === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }
    if (pathname === "/api/status") {
      try {
        const [dashboard, briefing, marketContext] = await Promise.all([
          buildDashboard(env),
          readBriefingStatus(env.DB),
          readMarketContext(env.DB),
        ]);
        const sources = await buildSources(env, { briefing, dashboard, marketContext });
        return json({
          ...dashboard,
          market: {
            indices: marketContext.indices,
            provider: marketContext.provider,
            latestSourceTimestamp: marketContext.latestSourceTimestamp,
            latestCollectedAt: marketContext.latestCollectedAt,
          },
          briefing,
          sources,
          sentiment: marketContext.sentiment,
        });
      } catch (err) {
        console.error("status error", err);
        try {
          // Keep the public contract shape under degradation: sources stay
          // present, every source fail-closed to Unavailable.
          return json({ ...await buildDashboard(env), briefing: unavailableBriefingStatus(), sources: unavailableSources(), sentiment: null });
        } catch {
          return json({ error: "Internal error" }, 500);
        }
      }
    }
    if (pathname === "/api/briefs/latest") {
      const requestedEditionType = new URL(request.url).searchParams.get("editionType");
      const editionType = requestedEditionType === null
        ? undefined
        : briefingEditionTypeSchema.safeParse(requestedEditionType);
      if (requestedEditionType !== null && !editionType?.success) {
        return json({ error: "invalid_edition_type" }, 400);
      }
      try {
        const briefing = await readLatestBriefing(
          env.DB,
          editionType?.success ? editionType.data : undefined,
        );
        return briefing
          ? json(briefing)
          : json({ error: "brief_not_found", message: "No Daily Briefing is available." }, 404);
      } catch {
        return json({ error: "brief_store_unavailable" }, 503);
      }
    }
    const briefingMatch = pathname.match(/^\/api\/briefs\/([^/]+)\/([^/]+)$/);
    if (briefingMatch) {
      const editionDate = briefingMatch[1]!;
      const editionTypeResult = briefingEditionTypeSchema.safeParse(briefingMatch[2]);
      const dateResult = briefingCalendarDateSchema.safeParse(editionDate);
      if (!dateResult.success || !editionTypeResult.success) {
        return json({ error: "invalid_briefing_identifier" }, 400);
      }
      try {
        const briefing = await readBriefingByDateAndType(env.DB, editionDate, editionTypeResult.data);
        return briefing
          ? json(briefing)
          : json({ error: "brief_not_found", message: "No Daily Briefing is available." }, 404);
      } catch {
        return json({ error: "brief_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/x/posts") {
      try {
        const params = new URL(request.url).searchParams;
        const author = params.get("author") ?? undefined;
        const symbol = params.get("symbol") ?? undefined;
        const rawLimit = Number.parseInt(params.get("limit") ?? "50", 10);
        const posts = await readXPosts(env.DB, {
          author,
          symbol: symbol?.toUpperCase(),
          limit: Number.isFinite(rawLimit) ? rawLimit : 50,
        });
        return json({ posts, count: posts.length });
      } catch (err) {
        console.error("x posts error", err);
        return json({ error: "x_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/market-data") {
      try {
        return json(await readMarketData(env.DB));
      } catch (err) {
        console.error("market data error", err);
        return json(emptyMarketData);
      }
    }
    if (pathname === "/api/market-context") {
      return json(await readMarketContext(env.DB));
    }
    const stockMatch = pathname.match(/^\/api\/stocks\/([A-Za-z0-9.-]+)$/);
    if (stockMatch) {
      const symbol = stockMatch[1]?.toUpperCase();
      if (!symbol) return json({ error: "Not found" }, 404);
      try {
        const stock = await readCandidateBySymbol(env.DB, symbol);
        if (!stock) return json({ error: "Not found" }, 404);
        return json({
          symbol: stock.symbol,
          company: stock.company,
          sector: stock.sector,
          marketCap: stock.marketCap,
          price: stock.price,
          quantScore: stock.quantScore,
          strategyId: stock.strategyId,
          strategyVersion: stock.strategyVersion,
          strategy: stock.strategy,
          status: stock.status,
          direction: stock.direction,
          earningsDate: stock.earningsDate,
          earningsProximityDays: stock.earningsProximityDays,
          reasons: stock.reasons,
        });
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }
    if (pathname === "/api/earnings") {
      try {
        return json(await readEarningsApi(env, new URL(request.url).searchParams));
      } catch (error) {
        console.error("earnings api error", error);
        return error instanceof EarningsQueryError
          ? json({ error: "invalid_earnings_query" }, 400)
          : json({ error: "earnings_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/portfolio/shadow") {
      try {
        return json(await readPortfolioAndPositions(env.DB));
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }
    if (pathname === "/api/strategies") {
      try {
        return json(await readStrategies(env.DB));
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }

    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
