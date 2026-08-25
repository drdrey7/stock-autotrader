import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FinancialInfoHint from "./FinancialInfoHint";

afterEach(() => cleanup());

describe("FinancialInfoHint", () => {
  it("is closed by default and opens with the matching glossary content", () => {
    render(<FinancialInfoHint term="marketCap" />);

    const trigger = screen.getByRole("button", { name: "Learn what Market Cap means" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Market Cap" })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Market Cap" });
    expect(dialog).toHaveTextContent("The total value of all the company's shares combined.");
    expect(dialog).toHaveTextContent("Usually:");
    expect(dialog).toHaveTextContent("There isn't a better or worse number here");
  });

  it("moves focus into the dialog when it opens", () => {
    render(<FinancialInfoHint term="marketCap" />);

    fireEvent.click(screen.getByRole("button", { name: "Learn what Market Cap means" }));

    expect(screen.getByRole("dialog", { name: "Market Cap" })).toHaveFocus();
  });

  it("closes with Escape and restores focus to the trigger", () => {
    render(<FinancialInfoHint term="sma200w" />);
    const trigger = screen.getByRole("button", { name: "Learn what 200W SMA means" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "200W SMA" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when the user interacts outside the popover", () => {
    render(
      <div>
        <FinancialInfoHint term="intrinsicValue" />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Learn what Intrinsic Value means" }));
    expect(screen.getByRole("dialog", { name: "Intrinsic Value" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog", { name: "Intrinsic Value" })).not.toBeInTheDocument();
  });

  it("does not trigger a parent action", () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <FinancialInfoHint term="marketCap" />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Learn what Market Cap means" }));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
