import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEarnings } from "./useEarnings";
import { useSentiment } from "./useSentiment";
import { useXPosts } from "./useXPosts";

function SentimentProbe() {
  useSentiment();
  return null;
}

function XProbe() {
  useXPosts();
  return null;
}

function EarningsProbe() {
  useEarnings();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") {
      return new Response(JSON.stringify({ sentiment: null }), { status: 200 });
    }
    if (url.startsWith("/api/x/posts")) {
      return new Response(JSON.stringify({ posts: [], count: 0 }), { status: 200 });
    }
    if (url.startsWith("/api/earnings")) {
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps Morning Briefing data isolated from X and Earnings", async () => {
  render(<SentimentProbe/>);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    "/api/status",
    expect.objectContaining({ headers: { accept: "application/json" } }),
  ));
  const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  expect(urls).toEqual(["/api/status"]);
});

it("keeps X data isolated from Morning Briefing and Earnings", async () => {
  render(<XProbe/>);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(1));
  const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  expect(urls).toEqual(["/api/x/posts?limit=50"]);
});

it("keeps Earnings data isolated from Morning Briefing and X", async () => {
  render(<EarningsProbe/>);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(1));
  const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/^\/api\/earnings\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
});
