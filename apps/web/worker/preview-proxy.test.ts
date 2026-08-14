import { describe, expect, it } from "vitest";
import { proxyProductionApiRequest, type ProductionApiBinding } from "../preview-api-proxy";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function fakeService(response: Response, calls: FetchCall[]): ProductionApiBinding {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      return response;
    },
  };
}

describe("Worker preview API service binding proxy", () => {
  it("proxies GET paths and query strings without client credentials", async () => {
    const calls: FetchCall[] = [];
    const response = await proxyProductionApiRequest(
      new Request("https://preview.example/api/earnings?status=scheduled", {
        headers: { accept: "application/json", authorization: "Bearer pr-secret", cookie: "session=secret" },
      }),
      fakeService(new Response('{"events":[]}', { headers: { "content-type": "application/json", "set-cookie": "preview=bad" } }), calls),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"events":[]}');
    expect(response.headers.get("set-cookie")).toBeNull();
    const downstream = calls[0]?.input as Request;
    expect(downstream.url).toBe("https://stock-autotrader-web/api/earnings?status=scheduled");
    expect(downstream.method).toBe("GET");
    expect(downstream.headers.get("accept")).toBe("application/json");
    expect(downstream.headers.get("authorization")).toBeNull();
    expect(downstream.headers.get("cookie")).toBeNull();
    expect(calls[0]?.init).toBeUndefined();
  });

  it("supports HEAD without forwarding a response body", async () => {
    const calls: FetchCall[] = [];
    const response = await proxyProductionApiRequest(
      new Request("https://preview.example/api/status", { method: "HEAD" }),
      fakeService(new Response("status", { status: 200 }), calls),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect((calls[0]?.input as Request).method).toBe("HEAD");
  });

  it("rejects every mutating method before making a service-binding request", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const calls: FetchCall[] = [];
      const response = await proxyProductionApiRequest(
        new Request("https://preview.example/api/status", { method }),
        fakeService(new Response("unexpected"), calls),
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
      expect(calls, method).toHaveLength(0);
    }
  });

  it("fails closed when the production service binding rejects the request", async () => {
    const response = await proxyProductionApiRequest(
      new Request("https://preview.example/api/status"),
      { fetch: async () => { throw new TypeError("service unavailable"); } },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "preview_api_unavailable" });
  });
});
