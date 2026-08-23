import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAnalysisResultV1, AiAnalysisRunResponse } from "@stock-autotrader/contracts";

const authMocks = vi.hoisted(() => ({ useSession: vi.fn() }));
const apiMocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  getViewer: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: authMocks.useSession },
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getAiAnalysisCatalog: apiMocks.getCatalog,
    getAiAnalysisViewer: apiMocks.getViewer,
    startAiAnalysis: apiMocks.start,
    getAiAnalysisRun: apiMocks.getRun,
  };
});

import AiAnalysisPage from "./AiAnalysisPage";

const runId = "11111111-1111-4111-8111-111111111111";
const baseRun = {
  schemaVersion: 1 as const,
  runId,
  symbol: "AAPL",
  company: "Apple Inc.",
  requestedAt: "2026-08-20T14:00:00.000Z",
  creditsRemaining: 1,
};

const result: AiAnalysisResultV1 = {
  schemaVersion: 1,
  symbol: "AAPL",
  analysisDate: "2026-08-20",
  generatedAt: "2026-08-20T15:00:00.000Z",
  engine: {
    name: "TradingAgents",
    version: "0.3.1",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "test-provider",
    quickModel: "quick-model",
    deepModel: "deep-model",
  },
  recommendation: "BUY",
  executiveSummary: null,
  investmentThesis: null,
  priceTarget: 250,
  timeHorizon: "12 months",
  reports: {
    marketAndTechnical: "## Momentum\n\nConstructive trend.",
    sentiment: null,
    news: null,
    fundamentals: null,
    bullCase: "Bull case text.",
    bearCase: "Bear case text.",
    researchManager: null,
    traderPlan: null,
    risk: { aggressive: null, neutral: null, conservative: null },
    portfolioManager: "Final portfolio conclusion.",
  },
};

const queuedRun: AiAnalysisRunResponse = {
  ...baseRun,
  status: "queued",
  completedAt: null,
  creditRefunded: false,
  result: null,
};

const completedRun: AiAnalysisRunResponse = {
  ...baseRun,
  status: "completed",
  completedAt: "2026-08-20T15:00:00.000Z",
  creditRefunded: false,
  result,
};

function renderPage(entry = "/ai-analysis") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/ai-analysis" element={<AiAnalysisPage />} />
        <Route path="/ai-analysis/runs/:runId" element={<AiAnalysisPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  authMocks.useSession.mockReturnValue({ data: null, isPending: false, error: null });
  apiMocks.getCatalog.mockResolvedValue({
    schemaVersion: 1,
    universeVersion: 1,
    stocks: [
      { symbol: "AAPL", company: "Apple Inc." },
      { symbol: "NVDA", company: "NVIDIA Corporation" },
    ],
  });
  apiMocks.getViewer.mockResolvedValue({ schemaVersion: 1, creditsRemaining: 2, ownedSymbols: ["AAPL"] });
  apiMocks.start.mockResolvedValue(queuedRun);
  apiMocks.getRun.mockResolvedValue(completedRun);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("99999999-9999-4999-8999-999999999999");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("AI Analysis page", () => {
  it("lets a visitor search the exact catalog and gates the run behind login", async () => {
    renderPage();
    const input = await screen.findByRole("combobox", { name: "Choose a Core Universe stock" });
    fireEvent.change(input, { target: { value: "NVIDIA" } });
    fireEvent.click(screen.getByRole("option", { name: /NVDA NVIDIA Corporation/ }));

    const login = screen.getByRole("link", { name: "Log in to run analysis" });
    expect(login).toHaveAttribute("href", "/account");
    expect(apiMocks.getViewer).not.toHaveBeenCalled();
    expect(apiMocks.start).not.toHaveBeenCalled();
  });

  it("disables the action when an authenticated viewer has no credit", async () => {
    authMocks.useSession.mockReturnValue({ data: { user: { id: "user-1" } }, isPending: false, error: null });
    apiMocks.getViewer.mockResolvedValue({ schemaVersion: 1, creditsRemaining: 0, ownedSymbols: [] });
    renderPage("/ai-analysis?symbol=AAPL");

    expect(await screen.findByRole("button", { name: "No credits available" })).toBeDisabled();
    expect(screen.getByLabelText("0 analysis credits")).toBeInTheDocument();
  });

  it("starts the real journey immediately while the first status request is pending", async () => {
    authMocks.useSession.mockReturnValue({ data: { user: { id: "user-1" } }, isPending: false, error: null });
    apiMocks.getRun.mockReturnValue(new Promise(() => undefined));
    renderPage("/ai-analysis?symbol=AAPL");

    fireEvent.click(await screen.findByRole("button", { name: /Run fresh analysis · 1 credit/ }));

    expect(await screen.findByRole("heading", { name: "Analyzing AAPL" })).toBeInTheDocument();
    expect(screen.queryByText("Opening your analysis…")).not.toBeInTheDocument();
    expect(screen.getByText("Market & technical research")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/queue|worker|poll|LangGraph|provider payload/i);
    expect(apiMocks.start).toHaveBeenCalledWith(
      "AAPL",
      "99999999-9999-4999-8999-999999999999",
      expect.any(AbortSignal),
    );
  });

  it("opens an exact historical completed report directly without replaying the journey", async () => {
    authMocks.useSession.mockReturnValue({ data: { user: { id: "user-1" } }, isPending: false, error: null });
    renderPage(`/ai-analysis/runs/${runId}`);

    expect(await screen.findByRole("heading", { name: "Apple Inc." })).toBeInTheDocument();
    expect(screen.getByText("Final portfolio conclusion.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Analyzing AAPL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The decision in brief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Why the team reached this view" })).not.toBeInTheDocument();
    expect(apiMocks.start).not.toHaveBeenCalled();
  });

  it("keeps another account from learning whether a run exists", async () => {
    authMocks.useSession.mockReturnValue({ data: { user: { id: "user-1" } }, isPending: false, error: null });
    const { AiAnalysisApiError } = await import("./api");
    apiMocks.getRun.mockRejectedValue(new AiAnalysisApiError("not_found", 404));
    renderPage(`/ai-analysis/runs/${runId}`);

    expect(await screen.findByRole("heading", { name: "Analysis not found" })).toBeInTheDocument();
    expect(screen.getByText("This report is unavailable or does not belong to this account.")).toBeInTheDocument();
  });
});
