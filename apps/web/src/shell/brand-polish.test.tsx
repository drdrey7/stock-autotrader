import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("sidebar brand polish", () => {
  it("renders the desktop wordmark as two deliberate lines without the tagline", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell><main>content</main></AppShell>
      </MemoryRouter>,
    );

    const desktopBrand = document.querySelector(".shell-sidebar .brand-logo");
    expect(desktopBrand).toHaveClass("is-stacked");
    expect(desktopBrand?.querySelector("strong")).toHaveTextContent("HOW ARETHE MARKETS");
    expect(desktopBrand?.querySelector("strong br")).toBeInTheDocument();
    expect(desktopBrand?.querySelector("small")).toBeNull();
  });

  it("keeps the mobile wordmark compact instead of forcing the desktop stack", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell><main>content</main></AppShell>
      </MemoryRouter>,
    );

    const mobileBrand = document.querySelector(".shell-topbar .brand-logo");
    expect(mobileBrand).toHaveClass("is-compact");
    expect(mobileBrand).not.toHaveClass("is-stacked");
    expect(mobileBrand?.querySelector("strong br")).toBeNull();
    expect(mobileBrand?.querySelector("strong")).toHaveTextContent("HOW ARE THE MARKETS");
  });
});
