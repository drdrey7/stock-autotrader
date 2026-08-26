import { proxyProductionApiRequest, type ProductionApiBinding } from "./preview-api-proxy";

export interface PreviewEnv {
  ASSETS: Fetcher;
  ENVIRONMENT: "preview";
  PRODUCTION_API: Fetcher;
  DB: D1Database;
}

type JsonObject = Record<string, unknown>;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const PREVIEW_IV_SYMBOL = "COIN";
const PREVIEW_IV_AS_OF = "2026-08-26";
const PREVIEW_IV = {
  bear: 150,
  base: 190,
  bull: 230,
  method: "Automatic IV V2 · preview fixture",
  methods: ["P/E", "P/FCF"] as const,
  confidence: "Medium" as const,
};

function jsonResponse(body: unknown, status = 200, method = "GET"): Response {
  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

async function responseObject(response: Response): Promise<JsonObject | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? body as JsonObject : null;
  } catch {
    return null;
  }
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function upsidePct(value: number, price: unknown): number | null {
  const usablePrice = finitePositive(price);
  return usablePrice === null ? null : ((value / usablePrice) - 1) * 100;
}

function withCoinDetailPreviewIv(body: JsonObject): JsonObject {
  if (body.symbol !== PREVIEW_IV_SYMBOL) return body;
  const valuation = body.valuation;
  if (typeof valuation !== "object" || valuation === null || Array.isArray(valuation)) return body;

  const valuationObject = valuation as JsonObject;
  // Once the production Worker serves Automatic IV V2, never replace real data.
  if (valuationObject.automatic !== null && valuationObject.automatic !== undefined) return body;

  const quote = typeof body.quote === "object" && body.quote !== null && !Array.isArray(body.quote)
    ? body.quote as JsonObject
    : {};
  const price = quote.price;
  const automatic = {
    ...PREVIEW_IV,
    methods: [...PREVIEW_IV.methods],
    asOf: PREVIEW_IV_AS_OF,
    bearUpsidePct: upsidePct(PREVIEW_IV.bear, price),
    baseUpsidePct: upsidePct(PREVIEW_IV.base, price),
    bullUpsidePct: upsidePct(PREVIEW_IV.bull, price),
  };
  const selectedIntrinsicValue = {
    low: PREVIEW_IV.bear,
    base: PREVIEW_IV.base,
    high: PREVIEW_IV.bull,
    method: PREVIEW_IV.method,
    asOf: PREVIEW_IV_AS_OF,
    upsidePct: upsidePct(PREVIEW_IV.base, price),
  };
  const freshness = typeof body.freshness === "object" && body.freshness !== null && !Array.isArray(body.freshness)
    ? { ...(body.freshness as JsonObject), valuationAsOf: PREVIEW_IV_AS_OF }
    : body.freshness;

  return {
    ...body,
    valuation: {
      ...valuationObject,
      automatic,
      selectedIntrinsicValue,
    },
    freshness,
  };
}

function withCoinScreenerPreviewIv(body: JsonObject): JsonObject {
  if (!Array.isArray(body.rows)) return body;
  let changed = false;
  const rows = body.rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const rowObject = row as JsonObject;
    if (rowObject.symbol !== PREVIEW_IV_SYMBOL || rowObject.intrinsicValue !== null) return row;
    changed = true;
    return {
      ...rowObject,
      intrinsicValue: {
        low: PREVIEW_IV.bear,
        base: PREVIEW_IV.base,
        high: PREVIEW_IV.bull,
        method: PREVIEW_IV.method,
        asOf: PREVIEW_IV_AS_OF,
        distancePct: upsidePct(PREVIEW_IV.base, rowObject.price),
      },
    };
  });
  return changed ? { ...body, rows } : body;
}

async function proxyWithPreviewIv(
  request: Request,
  productionApi: ProductionApiBinding,
): Promise<Response> {
  const upstream = await proxyProductionApiRequest(request, productionApi);
  if (request.method.toUpperCase() === "HEAD" || !upstream.ok) return upstream;

  const pathname = new URL(request.url).pathname;
  const supportsFixture = pathname === "/api/screener"
    || pathname === `/api/stocks/${PREVIEW_IV_SYMBOL}/detail`;
  if (!supportsFixture) return upstream;

  const body = await responseObject(upstream);
  if (body === null) return upstream;
  const decorated = pathname === "/api/screener"
    ? withCoinScreenerPreviewIv(body)
    : withCoinDetailPreviewIv(body);
  return jsonResponse(decorated, upstream.status, request.method);
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

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxyWithPreviewIv(request, env.PRODUCTION_API);
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