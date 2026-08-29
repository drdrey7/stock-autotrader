import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

const API_PREFIXES = ["/api/auth/", "/api/ai-analysis/"];
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BACKEND_ORIGIN = "https://stock-autotrader-web.barroso-labs.workers.dev";

function isAllowedPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function json(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * The public app owns a deliberately tiny proxy surface. The backend service
 * binding is never exposed to arbitrary /api paths, and browser cookies stay
 * on the AI Web origin. The canonical backend origin is used only inside the
 * service-bound request so the existing Better Auth origin policy remains
 * fail-closed without adding a wildcard trusted origin.
 */
export const ALL: APIRoute = async ({ request }) => {
  const incoming = new URL(request.url);
  if (!isAllowedPath(incoming.pathname)) return json({ error: "not_found" }, 404);
  if (STATE_CHANGING_METHODS.has(request.method) && !sameOrigin(request)) {
    return json({ error: "cross_site_request_rejected" }, 403);
  }

  const backend = env.AI_BACKEND;
  if (!backend) return json({ error: "ai_web_backend_unavailable" }, 503);

  const headers = new Headers(request.headers);
  // The service binding target is the existing Worker. Rewriting Origin to
  // that request envelope lets its existing same-origin CSRF check run while
  // the browser's host-only session cookie remains scoped to AI Web.
  headers.set("origin", BACKEND_ORIGIN);
  headers.delete("host");

  const target = new URL(`${BACKEND_ORIGIN}${incoming.pathname}`);
  target.search = incoming.search;
  try {
    const upstream = await backend.fetch(new Request(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    }));
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.delete("access-control-allow-origin");
    responseHeaders.delete("access-control-allow-credentials");
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return json({ error: "ai_web_backend_unavailable" }, 502);
  }
};
