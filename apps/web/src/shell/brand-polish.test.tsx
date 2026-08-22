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
  it("renders the desktop wordmark as two deliberate lines without truncation or tagline", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell><main>content</main></AppShell>
      </MemoryRouter>,
    );

    const desktopBrand = document.querySelector(".shell-sidebar .brand-logo");
    const desktopWordmark = desktopBrand?.querySelector("strong") as HTMLElement | null;
    expect(desktopBrand).toHaveClass("is-stacked");
    expect(desktopWordmark).toHaveTextContent("HOW ARETHE MARKETS");
    expect(desktopWordmark?.querySelector("br")).toBeInTheDocument();
    expect(desktopWordmark).toHaveStyle({
      overflow: "visible",
      textOverflow: "clip",
      whiteSpace: "normal",
    });
    expect(desktopBrand?.querySelector("small")).toBeNull();
  });

  it("keeps the complete mobile wordmark visible in a compact two-line layout", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell><main>content</main></AppShell>
      </MemoryRouter>,
    );

    const mobileBrand = document.querySelector(".shell-topbar .brand-logo");
    const mobileWordmark = mobileBrand?.querySelector("strong") as HTMLElement | null;
    expect(mobileBrand).toHaveClass("is-compact");
    expect(mobileBrand).toHaveClass("is-stacked");
    expect(mobileWordmark).toHaveTextContent("HOW ARETHE MARKETS");
    expect(mobileWordmark?.querySelector("br")).toBeInTheDocument();
    expect(mobileWordmark).toHaveStyle({
      overflow: "visible",
      textOverflow: "clip",
      whiteSpace: "normal",
    });
  });
});
