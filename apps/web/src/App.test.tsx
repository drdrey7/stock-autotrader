import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("public application", () => {
  it("renders the clean landing headline", () => {
    render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /Data\. Analysis\. Opportunity\./i })).toBeInTheDocument();
    expect(screen.getAllByText("Demo Data").length).toBeGreaterThan(0);
  });

  it("renders scanner candidates through the dynamic app route", () => {
    render(<MemoryRouter initialEntries={["/scanner"]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Market scanner" })).toBeInTheDocument();
    expect(screen.getAllByText("NVDA").length).toBeGreaterThan(0);
  });
});

