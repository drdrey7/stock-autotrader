const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

export interface ProductionApiBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const jsonResponse = (
  body: Record<string, string>,
  status: number,
  headers: HeadersInit = {},
): Response => new Response(JSON.stringify(body), {
  status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  },
});

function serviceBindingUrl(request: Request): URL {
  const incoming = new URL(request.url);
  const target = new URL("https://stock-autotrader-web");
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

export async function proxyProductionApiRequest(
  request: Request,
  productionApi: ProductionApiBinding,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }

  // Service-binding routing is controlled by the binding name. The URL is
  // only a valid downstream request envelope and carries no client origin,
  // credentials, cookies or body.
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
  const downstream = new Request(serviceBindingUrl(request), {
    method,
    headers,
    redirect: "error",
  });

  try {
    const upstream = await productionApi.fetch(downstream);
    const responseHeaders = new Headers(upstream.headers);
    // Do not let the production Worker establish a browser session on the
    // preview origin.
    responseHeaders.delete("set-cookie");
    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return jsonResponse({ error: "preview_api_unavailable" }, 502);
  }
}
