import { describe, expect, it, vi } from "vitest";
import { handlePreviewRequest } from "./preview-worker";

const previewEnv = (assetResponse = new Response("branch asset")) => ({
  ENVIRONMENT: "preview" as const,
  PUBLIC_API_ORIGIN: "https://stock-autotrader-web.barroso-labs.workers.dev",
  ASSETS: { fetch: vi.fn(async () => assetResponse) },
});

describe("preview Worker", () => {
  it("serves normal frontend asset paths from the branch build", async () => {
    const env = previewEnv();
    const response = await handlePreviewRequest(new Request("https://preview.example/"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("branch asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("routes same-origin API reads through the public API proxy", async () => {
    const env = previewEnv();
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://stock-autotrader-web.barroso-labs.workers.dev/api/status");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      return new Response('{"ok":true}', { status: 200 });
    });

    const response = await handlePreviewRequest(
      new Request("https://preview.example/api/status", { headers: { cookie: "blocked=1" } }),
      env,
      upstream,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("has no scheduled entrypoint", async () => {
    const moduleSource = await import("./preview-worker");
    expect("scheduled" in moduleSource.default).toBe(false);
  });
});
