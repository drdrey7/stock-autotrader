import { isCoreUniverseSymbol } from "@stock-autotrader/contracts";
import type { Env } from "../index";
import { readStockDetailApi } from "./read-model";

const DETAIL_CACHE_CONTROL = "public, max-age=30";

function json(data: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Content-Type, Accept",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleStockDetailApi(
  rawSymbol: string,
  env: Env,
  now = new Date(),
): Promise<Response> {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!isCoreUniverseSymbol(symbol)) {
    return json({ error: "stock_not_found" }, 404, "no-store");
  }

  try {
    const detail = await readStockDetailApi(env, symbol, now);
    return json(detail, 200, DETAIL_CACHE_CONTROL);
  } catch (error) {
    if (error instanceof Error && error.message === "stock_not_found") {
      return json({ error: "stock_not_found" }, 404, "no-store");
    }

    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      route: "stock-detail",
      symbol,
      status: "store-unavailable",
      error: detail.slice(0, 240),
    }));
    return json({ error: "stock_detail_store_unavailable" }, 503, "no-store");
  }
}
