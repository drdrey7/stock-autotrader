import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EarningsDetail from "./EarningsDetail";
import { eventWithViewMetadata, type EarningsCompany } from "./data/earnings-view";

function earningsItem(partial: Record<string, unknown> = {}): EarningsCompany {
  return eventWithViewMetadata({
    symbol: "AAPL",
    company: "Apple",
    timing: "AMC",
    status: "reported",
    epsEstimate: 1.9,
    epsActual: 2.0,
    epsActualAdjusted: 2.0,
    epsActualAdjustedSource: "finnhub-adjusted",
    epsSurprisePct: 5.26,
    epsResult: "Beat",
    revenueEstimate: 100_000_000_000,
    revenueActual: 102_000_000_000,
    revenueResult: "Beat",
    overallResult: "Beat",
    epsActualGaap: 1.95,
    revenueActualOfficial: 102_000_000_000,
    secForm: "10-Q",
    secFiledAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  }) as EarningsCompany;
}

afterEach(() => cleanup());

describe("EarningsDetail financial education", () => {
  it("covers the market and official earnings vocabulary consistently", () => {
    render(<EarningsDetail item={earningsItem()} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Learn what Market Earnings means" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Learn what EPS means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Consensus EPS means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Adjusted EPS means" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Learn what Revenue means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Consensus Revenue means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Market Revenue Actual means" })).toBeInTheDocument();

    expect(screen.getAllByRole("button", { name: "Learn what Surprise means" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Learn what Beat / Miss means" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Learn what Overall Market Result means" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Learn what SEC / EDGAR means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what GAAP EPS means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what GAAP Revenue means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what SEC Form means" })).toBeInTheDocument();

    expect(screen.queryByText("How to read these numbers")).not.toBeInTheDocument();
  });

  it("uses the neutral Market EPS explanation when adjusted basis is not known", () => {
    render(
      <EarningsDetail
        item={earningsItem({ epsActualAdjusted: null, epsActualAdjustedSource: null })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Learn what Market EPS Actual means" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Learn what Adjusted EPS means" })).not.toBeInTheDocument();
  });

  it("explains revenue in beginner language and keeps interpretation guidance", () => {
    render(<EarningsDetail item={earningsItem()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Learn what Revenue means" }));

    const hint = screen.getByRole("dialog", { name: "Revenue" });
    expect(hint).toHaveTextContent("selling its products or services");
    expect(hint).toHaveTextContent("Usually:");
    expect(hint).toHaveTextContent("Higher and growing revenue is generally positive");
  });

  it("explains why an overall earnings result can be mixed", () => {
    render(<EarningsDetail item={earningsItem({ overallResult: "Mixed" })} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Learn what Overall Market Result means" }));

    const hint = screen.getByRole("dialog", { name: "Overall Market Result" });
    expect(hint).toHaveTextContent("EPS and revenue outcomes");
    expect(hint).toHaveTextContent("Mixed means EPS and revenue did not tell the same story");
  });

  it("shows casual interpretation guidance inside an earnings hint", () => {
    render(<EarningsDetail item={earningsItem()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Learn what Consensus EPS means" }));

    const hint = screen.getByRole("dialog", { name: "Consensus EPS" });
    expect(hint).toHaveTextContent("Wall Street's shared estimate");
    expect(hint).toHaveTextContent("Usually:");
    expect(hint).toHaveTextContent("Reporting above consensus is generally positive");
  });

  it("closes an open hint with Escape before closing the earnings drawer", () => {
    const onClose = vi.fn();
    render(<EarningsDetail item={earningsItem()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Learn what EPS means" }));
    const hint = screen.getByRole("dialog", { name: "EPS" });
    fireEvent.keyDown(hint, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "EPS" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Earnings Detail" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
