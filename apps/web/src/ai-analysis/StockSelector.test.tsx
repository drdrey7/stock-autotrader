import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StockSelector, type AiAnalysisStock } from "./StockSelector";

const stocks: AiAnalysisStock[] = [
  { symbol: "AAPL", company: "Apple Inc." },
  { symbol: "MSFT", company: "Microsoft Corporation" },
  { symbol: "NVDA", company: "NVIDIA Corporation" },
];

function ControlledSelector({ onSelection = vi.fn() }: { onSelection?: (stock: AiAnalysisStock | null) => void }) {
  const [selected, setSelected] = useState<AiAnalysisStock | null>(null);
  return (
    <StockSelector
      stocks={stocks}
      selected={selected}
      ownedSymbols={new Set(["AAPL"])}
      onSelect={(stock) => {
        setSelected(stock);
        onSelection(stock);
      }}
    />
  );
}

afterEach(cleanup);

describe("StockSelector", () => {
  it("searches the exact catalog by company name and selects an option", () => {
    const onSelection = vi.fn();
    render(<ControlledSelector onSelection={onSelection} />);
    const input = screen.getByRole("combobox", { name: "Choose a Core Universe stock" });
    fireEvent.change(input, { target: { value: "micro" } });

    const listbox = screen.getByRole("listbox", { name: "Core Universe stocks" });
    expect(within(listbox).getByRole("option", { name: /MSFT Microsoft Corporation/ })).toBeInTheDocument();
    expect(within(listbox).queryByText("Apple Inc.")).not.toBeInTheDocument();

    fireEvent.click(within(listbox).getByRole("option", { name: /MSFT Microsoft Corporation/ }));
    expect(onSelection).toHaveBeenCalledWith(stocks[1]);
    expect(input).toHaveValue("MSFT — Microsoft Corporation");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows ownership as a checkmark without inventing a report date", () => {
    render(<ControlledSelector />);
    fireEvent.focus(screen.getByRole("combobox"));
    const apple = screen.getByRole("option", { name: /AAPL Apple Inc. Previously analyzed/ });
    expect(within(apple).getByText("Previously analyzed")).toHaveClass("ai-visually-hidden");
    expect(apple).not.toHaveTextContent(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });

  it("supports keyboard navigation and selection", () => {
    const onSelection = vi.fn();
    render(<ControlledSelector onSelection={onSelection} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute("aria-activedescendant", "ai-analysis-stock-NVDA");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelection).toHaveBeenCalledWith(stocks[2]);
  });

  it("keeps a new search term when editing an existing selection", () => {
    render(<ControlledSelector />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("option", { name: /AAPL Apple Inc/ }));
    fireEvent.change(input, { target: { value: "NVIDIA" } });

    expect(input).toHaveValue("NVIDIA");
    expect(screen.getByRole("option", { name: /NVDA NVIDIA Corporation/ })).toBeInTheDocument();
  });
});
