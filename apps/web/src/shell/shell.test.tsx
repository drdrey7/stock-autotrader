import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { findActiveNavItem, isNavItemActive, shellNavGroups } from "./navigation";

/**
 * The shell is what renders the sidebar and mobile drawer around any routed
 * page. Testing it with a trivial child keeps the drawer/sidebar behaviour
 * isolated from the Morning Briefing data fetching and lazy page loading.
 *
 * jsdom applies no CSS, so both the desktop sidebar and the mobile top bar are
 * always present in the DOM. Breakpoint-dependent *visibility* is therefore not
 * asserted here — the drawer's open/closed accessibility state (`aria-hidden`,
 * `inert`) is, which is what the interaction logic depends on.
 */
function renderShell(path = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <h1>Shell content</h1>
      </AppShell>
    </MemoryRouter>,
  );
}

const hamburger = () => screen.getByRole("button", { name: /main menu/i });
const drawer = () => document.getElementById("shell-mobile-nav") as HTMLElement;
const sidebarNav = () => screen.getByRole("navigation", { name: "Primary navigation" });
const sidebarLink = (name: string) => within(sidebarNav()).getByRole("link", { name });

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
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop sidebar navigation", () => {
  it("renders every primary and secondary destination as a link", () => {
    renderShell();
    for (const group of shellNavGroups) {
      for (const item of group.items) {
        expect(sidebarLink(item.label)).toHaveAttribute("href", item.to);
      }
    }
    expect(sidebarNav()).toBeInTheDocument();
  });

  it("marks the active destination on direct load", () => {
    renderShell("/earnings");
    expect(sidebarLink("Earnings")).toHaveAttribute("aria-current", "page");
    expect(sidebarLink("Earnings")).toHaveClass("is-active");
    expect(sidebarLink("Dashboard")).not.toHaveAttribute("aria-current");
    expect(sidebarLink("X Pulse")).not.toHaveAttribute("aria-current");
  });

  it("treats the home route as the Dashboard destination", () => {
    renderShell("/");
    expect(sidebarLink("Dashboard")).toHaveAttribute("aria-current", "page");
  });

  it("exposes the single source of truth through the active-item helpers", () => {
    const dashboard = shellNavGroups[0]!.items[0]!;
    expect(isNavItemActive(dashboard, "/")).toBe(true);
    expect(isNavItemActive(dashboard, "/dashboard")).toBe(true);
    expect(isNavItemActive(dashboard, "/x")).toBe(false);
    expect(findActiveNavItem("/x")?.label).toBe("X Pulse");
    expect(findActiveNavItem("/earnings")?.label).toBe("Earnings");
    expect(findActiveNavItem("/unknown")).toBeUndefined();
  });
});

describe("mobile navigation drawer", () => {
  it("opens and closes with the hamburger and keeps aria-expanded in sync", () => {
    renderShell();
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();

    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes from the explicit close button", () => {
    renderShell();
    fireEvent.click(hamburger());
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape", () => {
    renderShell();
    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when the backdrop is clicked", () => {
    renderShell();
    fireEvent.click(hamburger());
    expect(document.querySelector(".shell-drawer-backdrop")).toHaveClass("is-open");
    fireEvent.click(document.querySelector(".shell-drawer-backdrop")!);
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a destination is chosen and applies the active state", () => {
    renderShell("/dashboard");
    fireEvent.click(hamburger());
    fireEvent.click(within(drawer()).getByRole("link", { name: "Earnings" }));
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
    expect(sidebarLink("Earnings")).toHaveAttribute("aria-current", "page");
  });

  it("moves focus into the drawer when it opens and back to the hamburger on close", () => {
    renderShell();
    fireEvent.click(hamburger());
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(hamburger()).toHaveFocus();
  });

  it("keeps the closed drawer out of the accessibility tree", () => {
    renderShell();
    expect(document.querySelector(".shell-drawer-backdrop")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".shell-drawer-backdrop")).toHaveAttribute("inert", "");
    expect(screen.getAllByRole("navigation", { name: "Primary navigation" })).toHaveLength(1);

    fireEvent.click(hamburger());
    expect(document.querySelector(".shell-drawer-backdrop")).not.toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("navigation", { name: "Primary navigation" })).toHaveLength(2);
  });

  it("makes the background inert while the drawer is open", () => {
    renderShell();
    const main = document.querySelector("main.shell-main") as HTMLElement;
    expect(main).not.toHaveAttribute("inert", "");
    fireEvent.click(hamburger());
    expect(main).toHaveAttribute("inert", "");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(main).not.toHaveAttribute("inert", "");
  });

  it("closes the drawer when the viewport crosses into the desktop breakpoint", () => {
    const changeListeners: Record<string, (event: { matches: boolean }) => void> = {};
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (event: string, cb: (e: { matches: boolean }) => void) => { changeListeners[event] = cb; },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    renderShell();
    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("main.shell-main")).toHaveAttribute("inert", "");

    act(() => { changeListeners["change"]?.({ matches: true }); });
    expect(hamburger()).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("main.shell-main")).not.toHaveAttribute("inert", "");
  });

  it("locks body scroll while the drawer is open", () => {
    renderShell();
    fireEvent.click(hamburger());
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
  });
});

describe("theme toggle", () => {
  it("switches light/dark and persists the choice", () => {
    renderShell();
    const toggle = screen.getAllByRole("button", { name: "Switch to dark mode" })[0]!;
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("morning-briefing-theme")).toBe("dark");
    expect(screen.getAllByRole("button", { name: "Switch to light mode" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Switch to light mode" })[0]!);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("defaults to light and still renders when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    renderShell();
    expect(screen.getByRole("heading", { name: "Shell content" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
