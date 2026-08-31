import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getViewer: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock("../ai-analysis/api", () => ({
  getAiAnalysisViewer: apiMocks.getViewer,
  getAiAnalysisHistory: apiMocks.getHistory,
}));

vi.mock("./billing-api", () => ({
  getBillingStatus: vi.fn().mockResolvedValue({ configured: true, creditsConfigured: true, subscription: null }),
  createCreditCheckout: vi.fn(),
}));

import { AiAnalysisAccount } from "./AiAnalysisAccount";

const firstRun = "11111111-1111-4111-8111-111111111111";
const secondRun = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  apiMocks.getViewer.mockResolvedValue({ schemaVersion: 1, creditsRemaining: 2, ownedSymbols: ["AAPL"] });
  apiMocks.getHistory.mockResolvedValue({
    schemaVersion: 1,
    items: [
      { runId: firstRun, symbol: "AAPL", company: "Apple Inc.", status: "completed", requestedAt: "2026-08-20T14:00:00.000Z", startedAt: "2026-08-20T14:01:00.000Z", recommendation: "BUY", completedAt: "2026-08-20T15:00:00.000Z", progressStage: "portfolio", progressStep: 12, progressTotal: 12, progressUpdatedAt: "2026-08-20T15:00:00.000Z", reused: false },
      { runId: secondRun, symbol: "AAPL", company: "Apple Inc.", status: "completed", requestedAt: "2026-08-18T14:00:00.000Z", startedAt: "2026-08-18T14:01:00.000Z", recommendation: "HOLD", completedAt: "2026-08-18T15:00:00.000Z", progressStage: "portfolio", progressStep: 12, progressTotal: 12, progressUpdatedAt: "2026-08-18T15:00:00.000Z", reused: false },
    ],
    nextCursor: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Investor Hub AI Analysis account section", () => {
  it("shows credits and preserves multiple exact reports for the same symbol", async () => {
    render(<MemoryRouter><AiAnalysisAccount /></MemoryRouter>);

    expect(await screen.findByText("2", { selector: "strong" })).toBeInTheDocument();
    const reportLinks = await screen.findAllByRole("link", { name: /Open AAPL (BUY|HOLD) report from/ });
    expect(reportLinks).toHaveLength(2);
    expect(reportLinks[0]).toHaveAttribute("href", `/ai-analysis/runs/${firstRun}`);
    expect(reportLinks[1]).toHaveAttribute("href", `/ai-analysis/runs/${secondRun}`);
    expect(screen.getByText("BUY")).toBeInTheDocument();
    expect(screen.getByText("HOLD")).toBeInTheDocument();
  });

  it("appends paginated results without collapsing repeated symbols", async () => {
    apiMocks.getHistory
      .mockResolvedValueOnce({
        schemaVersion: 1,
        items: [{ runId: firstRun, symbol: "AAPL", company: "Apple Inc.", status: "completed", requestedAt: "2026-08-20T14:00:00.000Z", startedAt: "2026-08-20T14:01:00.000Z", recommendation: "BUY", completedAt: "2026-08-20T15:00:00.000Z", progressStage: "portfolio", progressStep: 12, progressTotal: 12, progressUpdatedAt: "2026-08-20T15:00:00.000Z", reused: false }],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        items: [{ runId: secondRun, symbol: "AAPL", company: "Apple Inc.", status: "completed", requestedAt: "2026-08-18T14:00:00.000Z", startedAt: "2026-08-18T14:01:00.000Z", recommendation: "SELL", completedAt: "2026-08-18T15:00:00.000Z", progressStage: "portfolio", progressStep: 12, progressTotal: 12, progressUpdatedAt: "2026-08-18T15:00:00.000Z", reused: false }],
        nextCursor: null,
      });

    render(<MemoryRouter><AiAnalysisAccount /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Load more reports" }));

    await waitFor(() => expect(screen.getAllByRole("link", { name: /Open AAPL (BUY|SELL) report from/ })).toHaveLength(2));
    expect(apiMocks.getHistory).toHaveBeenLastCalledWith("next-page", expect.any(AbortSignal));
  });

  it("handles zero credits and an empty history", async () => {
    apiMocks.getViewer.mockResolvedValue({ schemaVersion: 1, creditsRemaining: 0, ownedSymbols: [] });
    apiMocks.getHistory.mockResolvedValue({ schemaVersion: 1, items: [], nextCursor: null });
    render(<MemoryRouter><AiAnalysisAccount /></MemoryRouter>);

    expect(await screen.findByText("You have no analysis credits available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No completed reports yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New analysis/ })).toHaveAttribute("href", "/ai-analysis");
  });
});
