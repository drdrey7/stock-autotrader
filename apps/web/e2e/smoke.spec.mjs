import { test, expect } from "@playwright/test";

const routes = [
  { path: "/", label: "Dashboard" },
  { path: "/x", label: "X Pulse" },
  { path: "/earnings", label: "Earnings" },
  { path: "/methodology", label: "Methodology" },
  { path: "/status", label: "Status" },
  { path: "/disclaimer", label: "Disclaimer" },
];

for (const route of routes) {
  test(`${route.label} loads without a fatal shell error`, async ({ page, isMobile }) => {
    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response?.ok()).toBeTruthy();

    if (isMobile) {
      // Below the breakpoint the sidebar is replaced by a compact top bar whose
      // hamburger opens the drawer; navigation is not on screen until then.
      await expect(page.locator(".shell-topbar .shell-brand")).toBeVisible();
      await expect(page.getByRole("button", { name: /open main menu/i })).toBeVisible();
    } else {
      await expect(page.locator(".shell-sidebar .shell-brand")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary navigation" }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: route.label }).first()).toHaveAttribute("aria-current", "page");
    }

    await expect(page.locator("body")).not.toContainText("Page unavailable");
  });
}

test.describe("desktop shell", () => {
  test.skip(({ isMobile }) => isMobile, "Desktop-only");

  test("primary navigation works without a full-page reload", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await page.getByRole("link", { name: "X Pulse" }).first().click();
    await expect(page).toHaveURL(/\/x$/);
    await expect(page.getByRole("link", { name: "X Pulse" }).first()).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "Earnings" }).first().click();
    await expect(page).toHaveURL(/\/earnings$/);
    await expect(page.getByRole("link", { name: "Earnings" }).first()).toHaveAttribute("aria-current", "page");
  });
});

test.describe("mobile shell", () => {
  test.skip(({ isMobile }) => !isMobile, "Mobile-only");

  test("drawer opens, navigates and closes with the correct aria state", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const hamburger = page.getByRole("button", { name: /open main menu/i });
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");

    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");

    const drawer = page.locator("#shell-mobile-nav");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Earnings" })).toBeVisible();

    await drawer.getByRole("link", { name: "Earnings" }).click();
    await expect(page).toHaveURL(/\/earnings$/);
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).not.toBeVisible();
  });

  test("Escape and the explicit close button dismiss the drawer", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /open main menu/i }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /open main menu/i })).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: /open main menu/i }).click();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(page.getByRole("button", { name: /open main menu/i })).toHaveAttribute("aria-expanded", "false");
  });
});
