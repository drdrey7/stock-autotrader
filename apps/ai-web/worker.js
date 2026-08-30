const ALLOWED_API_PREFIXES = ["/api/auth/", "/api/ai-analysis/"];
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isAllowedApiPath(pathname) {
  return ALLOWED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function proxyApi(request, env) {
  const url = new URL(request.url);
  if (!isAllowedApiPath(url.pathname)) return new Response(null, { status: 404 });
  if (!env.AI_BACKEND || !env.AI_BACKEND_ORIGIN) {
    return new Response(JSON.stringify({ error: "ai_backend_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // The public AI Web owns CSRF validation for browser-originated writes. The
  // service-bound request is then rewritten to the backend's canonical origin
  // so Better Auth and the AI Analysis API keep their existing same-origin
  // security model without trusting a second public origin directly.
  if (STATE_CHANGING_METHODS.has(request.method) && !sameOrigin(request)) {
    return new Response(JSON.stringify({ error: "cross_site_request_rejected" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const backendOrigin = new URL(env.AI_BACKEND_ORIGIN).origin;
  const target = new URL(url.pathname + url.search, backendOrigin);
  const headers = new Headers(request.headers);
  headers.set("origin", backendOrigin);
  const referer = headers.get("referer");
  if (referer) headers.set("referer", new URL(url.pathname + url.search, backendOrigin).toString());
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");

  const upstreamRequest = new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  const upstream = await env.AI_BACKEND.fetch(upstreamRequest);
  const response = new Response(upstream.body, upstream);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return proxyApi(request, env);

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
  },
};
