import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyBriefingXSearchPage } from "./x-search-page";

describe("DailyBriefingXSearchPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders collected posts as X-style cards with stock badges", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        posts: [
          {
            id: "post-aaa",
            author: "@nolimitgains",
            text: "$NVDA reclaiming the 20D with volume expansion.",
            created_at: "2026-08-12T10:15:00Z",
            url: "https://x.com/nolimitgains/status/post-aaa",
            symbol: "NVDA",
            company: "NVIDIA Corporation",
            universe: "Both",
            price: "$183.10",
            change: "-3.84%",
            collected_at: "2026-08-12T10:20:00Z",
          },
        ],
        count: 1,
      }),
    } as Response);

    render(
      <MemoryRouter>
        <DailyBriefingXSearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/@nolimitgains/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/NVDA/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/NVIDIA Corporation/i)).toBeInTheDocument();
    expect(screen.getByText("$183.10 (-3.84%)")).toBeInTheDocument();
    expect(screen.queryByText(/-3\.84%%/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open post on x/i })).toHaveAttribute(
      "href",
      "https://x.com/nolimitgains/status/post-aaa",
    );
  });

  it("shows the empty state when no posts exist", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ posts: [], count: 0 }),
    } as Response);

    render(
      <MemoryRouter>
        <DailyBriefingXSearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no posts collected yet/i)).toBeInTheDocument();
    });
  });

  it("shows an error state when the feed is unavailable", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "x_store_unavailable" }),
    } as Response);

    render(
      <MemoryRouter>
        <DailyBriefingXSearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/x feed unavailable/i)).toBeInTheDocument();
    });
  });
});
