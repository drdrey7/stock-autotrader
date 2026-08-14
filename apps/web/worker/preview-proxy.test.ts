import { describe, expect, it } from "vitest";
import { proxyPublicApiRequest } from "../preview-api-proxy";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function fakeFetcher(response: Response, calls: FetchCall[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return response;
  };
}

describe("Worker preview API proxy", () => {
  it("proxies GET paths and query strings without client credentials", async () => {
    const calls: FetchCall[] = [];
    const response = await proxyPublicApiRequest(
      new Request("https://preview.example/api/earnings?status=scheduled", {
        headers: { accept: "application/json", authorization: "Bearer pr-secret", cookie: "session=secret" },
      }),
      "https://stock-autotrader-web.barroso-labs.workers.dev",
      fakeFetcher(new Response('{"events":[]}', { headers: { "content-type": "application/json", "set-cookie": "preview=bad" } }), calls),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"events":[]}');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(String(calls[0]?.input)).toBe("https://stock-autotrader-web.barroso-labs.workers.dev/api/earnings?status=scheduled");
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(calls[0]?.init).not.toHaveProperty("credentials");
    const forwardedHeaders = new Headers(calls[0]?.init?.headers);
    expect(forwardedHeaders.get("accept")).toBe("application/json");
    expect(forwardedHeaders.get("authorization")).toBeNull();
    expect(forwardedHeaders.get("cookie")).toBeNull();
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("supports HEAD without forwarding a response body", async () => {
    const calls: FetchCall[] = [];
    const response = await proxyPublicApiRequest(
      new Request("https://preview.example/api/status", { method: "HEAD" }),
      "https://stock-autotrader-web.barroso-labs.workers.dev",
      fakeFetcher(new Response("status", { status: 200 }), calls),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(calls[0]?.init).toMatchObject({ method: "HEAD" });
  });

  it("rejects every mutating method before making an upstream request", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const calls: FetchCall[] = [];
      const response = await proxyPublicApiRequest(
        new Request("https://preview.example/api/status", { method }),
        "https://stock-autotrader-web.barroso-labs.workers.dev",
        fakeFetcher(new Response("unexpected"), calls),
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
      expect(calls, method).toHaveLength(0);
    }
  });

  it("fails closed when the public API origin is absent or not an HTTPS origin", async () => {
    for (const configuredOrigin of [undefined, "", "http://api.example", "https://api.example/path"]) {
      const calls: FetchCall[] = [];
      const response = await proxyPublicApiRequest(
        new Request("https://preview.example/api/status"),
        configuredOrigin,
        fakeFetcher(new Response("unexpected"), calls),
      );
      expect(response.status).toBe(500);
      expect(calls).toHaveLength(0);
    }
  });

  it("fails closed when the upstream rejects an unexpected redirect", async () => {
    const response = await proxyPublicApiRequest(
      new Request("https://preview.example/api/status"),
      "https://stock-autotrader-web.barroso-labs.workers.dev",
      async () => { throw new TypeError("redirect disallowed"); },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "preview_api_unavailable" });
  });
});
