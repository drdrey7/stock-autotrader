const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

type PublicApiFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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

function publicApiOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "https:"
      || origin.pathname !== "/"
      || origin.search
      || origin.hash
      || origin.username
      || origin.password
    ) return null;
    return origin;
  } catch {
    return null;
  }
}

export async function proxyPublicApiRequest(
  request: Request,
  configuredOrigin: string | undefined,
  fetcher: PublicApiFetcher = fetch,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }

  const origin = publicApiOrigin(configuredOrigin);
  if (!origin) return jsonResponse({ error: "preview_api_not_configured" }, 500);

  const incomingUrl = new URL(request.url);
  const target = new URL(origin.origin);
  target.pathname = incomingUrl.pathname;
  target.search = incomingUrl.search;

  // Construct a fresh request envelope. Only Accept is copied; in particular,
  // browser Authorization and Cookie headers never reach the production API.
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
  try {
    const upstream = await fetcher(target, {
      method,
      headers,
      redirect: "error",
      credentials: "omit",
    });
    const responseHeaders = new Headers(upstream.headers);
    // The public API is read-only. Do not let an upstream response establish a
    // browser session on the preview origin.
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
