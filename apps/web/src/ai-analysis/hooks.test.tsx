import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAnalysisRunResponse } from "@stock-autotrader/contracts";

const apiMocks = vi.hoisted(() => ({ getRun: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getAiAnalysisRun: apiMocks.getRun };
});

import { useAiAnalysisRun } from "./hooks";

const runId = "11111111-1111-4111-8111-111111111111";
const queued: AiAnalysisRunResponse = {
  schemaVersion: 1,
  runId,
  symbol: "AAPL",
  company: "Apple Inc.",
  analysisId: "33333333-3333-4333-8333-333333333333",
  requestedAt: "2026-08-20T14:00:00.000Z",
  startedAt: null,
  progressStage: null,
  progressStep: 0,
  progressTotal: 12 as const,
  progressUpdatedAt: null,
  reused: false,
  creditsRemaining: 1,
  status: "queued",
  completedAt: null,
  creditRefunded: false,
  result: null,
};

function Harness() {
  const state = useAiAnalysisRun(runId, true);
  return <output>{state.run?.status ?? (state.loading ? "loading" : "empty")}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useAiAnalysisRun", () => {
  it("polls sequentially and never overlaps requests", async () => {
    let resolveFirst!: (value: AiAnalysisRunResponse) => void;
    const first = new Promise<AiAnalysisRunResponse>((resolve) => { resolveFirst = resolve; });
    apiMocks.getRun
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...queued, status: "running" });

    render(<Harness />);
    expect(apiMocks.getRun).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(apiMocks.getRun).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst(queued); await first; });
    expect(screen.getByText("queued")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_800); });
    expect(apiMocks.getRun).toHaveBeenCalledTimes(2);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("aborts an in-flight request when the page unmounts", () => {
    apiMocks.getRun.mockReturnValue(new Promise(() => undefined));
    const view = render(<Harness />);
    const signal = apiMocks.getRun.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
