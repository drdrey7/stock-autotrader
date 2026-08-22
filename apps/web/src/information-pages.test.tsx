import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DailyBriefingNotFoundPage, DailyBriefingStatusPage } from "./information-pages";

afterEach(cleanup);

describe("information pages", () => {
  it("keeps the public status content available after the legacy CSS split", () => {
    render(
      <MemoryRouter>
        <DailyBriefingStatusPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "System status" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "What is included" })).toBeInTheDocument();
    expect(screen.getByText(/public, read-only research interface/i)).toBeInTheDocument();
  });

  it("keeps the 404 recovery action routed to the dashboard", () => {
    render(
      <MemoryRouter>
        <DailyBriefingNotFoundPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open terminal/i })).toHaveAttribute("href", "/dashboard");
  });
});
