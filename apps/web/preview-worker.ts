import { isCoreUniverseSymbol } from "@stock-autotrader/contracts";
import { proxyProductionApiRequest, type ProductionApiBinding } from "./preview-api-proxy";
import { previewStockDetailFixture } from "./preview-stock-detail-fixture";

export interface PreviewEnv {
  ASSETS: Fetcher;
  ENVIRONMENT: "preview";
  PRODUCTION_API: Fetcher;
}

type JsonObject = Record<string, unknown>;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200, method = "GET"): Response {
  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...jsonHeaders, allow: "GET, HEAD" },
  });
}

function previewStockDetailResponse(request: Request, pathname: string): Response | null {
  const match = pathname.match(/^\/api\/stocks\/([^/]+)\/detail$/);
  if (!match) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();

  let symbol: string;
  try {
    symbol = decodeURIComponent(match[1] ?? "").trim().toUpperCase();
  } catch {
    return jsonResponse({ error: "stock_not_found" }, 404, request.method);
  }

  if (!isCoreUniverseSymbol(symbol)) {
    return jsonResponse({ error: "stock_not_found" }, 404, request.method);
  }

  const fixture = previewStockDetailFixture(symbol);
  if (!fixture) {
    // The branch preview deliberately fixtures only the stocks used for visual
    // acceptance. Do not fall through to production, whose pre-merge Worker
    // does not know the new /detail endpoint and would create a false 404.
    return jsonResponse({ error: "preview_stock_detail_fixture_unavailable" }, 503, request.method);
  }

  const response = jsonResponse(fixture, 200, request.method);
  response.headers.set("x-stock-detail-preview-fixture", "1");
  return response;
}

async function responseObject(response: Response): Promise<JsonObject | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? body as JsonObject : null;
  } catch {
    return null;
  }
}

async function diagnostics(productionApi: ProductionApiBinding): Promise<JsonObject> {
  const requests = [
    ["status", "/api/status"],
    ["marketContext", "/api/market-context"],
    ["earnings", "/api/earnings"],
    ["x", "/api/x/posts?limit=5"],
    ["briefing", "/api/briefs/latest"],
  ] as const;
  const responses = await Promise.all(requests.map(([, path]) =>
    proxyProductionApiRequest(new Request(`https://preview.local${path}`), productionApi)));
  const bodies = await Promise.all(responses.map(responseObject));
  const statusResponse = responses[0]!;
  const marketResponse = responses[1]!;
  const earningsResponse = responses[2]!;
  const xResponse = responses[3]!;
  const briefingResponse = responses[4]!;
  const statusBody = bodies[0] ?? null;
  const marketBody = bodies[1] ?? null;
  const earningsBody = bodies[2] ?? null;
  const xBody = bodies[3] ?? null;
  const briefingBody = bodies[4] ?? null;
  const count = (body: JsonObject | null, key: string): number => {
    const value = body?.[key];
    return Array.isArray(value) ? value.length : 0;
  };

  return {
    environment: "preview",
    upstream: "stock-autotrader-web",
    endpoints: {
      status: { http: statusResponse.status, data: statusResponse.ok && statusBody !== null },
      marketContext: { http: marketResponse.status, count: count(marketBody, "indices") },
      earnings: { http: earningsResponse.status, count: count(earningsBody, "events") },
      x: { http: xResponse.status, count: count(xBody, "posts") },
      briefing: { http: briefingResponse.status, available: briefingResponse.ok && briefingBody !== null },
    },
  };
}

export async function handlePreviewRequest(
  request: Request,
  env: PreviewEnv,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  const stockDetailFixture = previewStockDetailResponse(request, pathname);
  if (stockDetailFixture) return stockDetailFixture;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxyProductionApiRequest(request, env.PRODUCTION_API);
  }
  if (pathname === "/__preview/diagnostics") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return jsonResponse(await diagnostics(env.PRODUCTION_API), 200, request.method);
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request: Request, env: PreviewEnv): Promise<Response> {
    return handlePreviewRequest(request, env);
  },
};
